/**
 * Single source of truth for every shape in the system.
 *
 * Rule: schema first, then the code that uses it. Never hand-write an interface that
 * duplicates something here — derive it with `z.infer`.
 *
 * These describe **rows as SQLite stores them**: timestamps are UTC ISO strings,
 * booleans are 0/1 integers, JSON columns are parsed before validation.
 * The DDL that matches them lives in `src/store/migrations/`.
 */
import { z } from "zod";

/** UTC ISO-8601, e.g. `2026-08-09T06:00:00.000Z`. Always store UTC. */
export const Timestamp = z.iso.datetime();

/** SQLite has no boolean type. */
export const SqlBool = z.union([z.literal(0), z.literal(1)]);

/** The current time as a UTC ISO string — the only format stored. */
export const nowIso = (): string => new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The job lifecycle. Diagram in `docs/architecture.md`; the legal edges between
 * these values live in exactly one place, `src/store/state.ts`.
 */
export const JobState = z.enum([
  "DISCOVERED",
  "SCORED",
  "MATCHED",
  "REJECTED",
  "NEEDS_CONTACT",
  "EXPIRED",
  "DRAFTED",
  "AUTO_SEND",
  "PENDING_APPROVAL",
  "REJECTED_BY_USER",
  "SENT",
  "FOLLOW_UP_SENT",
  "REPLIED",
  "BOUNCED",
  "CLOSED",
]);
export type JobState = z.infer<typeof JobState>;

/** Applicant-tracking system a company's postings live on. */
export const AtsType = z.enum([
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "none",
]);
export type AtsType = z.infer<typeof AtsType>;

/** Which adapter produced a job row. Matches `JobSource.name`. */
export const JobSourceName = z.enum([
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "gmail-alert",
  "hackernews",
  "manual",
]);
export type JobSourceName = z.infer<typeof JobSourceName>;

/**
 * Where a contact's email came from. This — not a paid verifier — is what decides
 * auto-send eligibility (decision 006).
 */
export const ContactSource = z.enum([
  "posting",
  "team_page",
  "github",
  "pattern",
]);
export type ContactSource = z.infer<typeof ContactSource>;

export const ContactConfidence = z.enum(["high", "medium", "low"]);
export type ContactConfidence = z.infer<typeof ContactConfidence>;

/**
 * Invariant 3: only `posting` and `team_page` are ever `high`, and only `high`
 * contacts can auto-send. Pattern guesses are always low.
 *
 * This is the **ceiling** a rung permits, not the confidence a contact ends up with. An
 * address published on a company's site but hosted somewhere else is capped one rung lower —
 * that rule needs the company's domain, so it lives in `confidenceFor` in
 * `src/contacts/cascade.ts` and is what the stage actually stores (decision 047).
 */
export const confidenceForSource = (
  source: ContactSource,
): ContactConfidence =>
  source === "posting" || source === "team_page"
    ? "high"
    : source === "github"
      ? "medium"
      : "low";

/** Pipeline stages, in execution order. `track` runs on its own 4h schedule. */
export const StageName = z.enum([
  "ingest",
  "prefilter",
  "score",
  "contacts",
  "draft",
  "digest",
  /** The hourly fast lane's instant ping for a strong match. Not part of the daily run. */
  "alert",
  /** Asks about drafts awaiting a decision, and acts on the taps. Runs beside `send`. */
  "approve",
  "send",
  "track",
]);
export type StageName = z.infer<typeof StageName>;

// ─────────────────────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────────────────────

/** Deduped on normalised domain — one row per real company, not per posting. */
export const Company = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  /** Normalised: lowercase, no scheme, no `www.`. The dedup key for companies. */
  domain: z.string().min(3),
  ats_type: AtsType,
  /** Board identifier, e.g. `anthropic` in `boards.greenhouse.io/anthropic`. */
  ats_slug: z.string().nullable(),
  careers_url: z.url().nullable(),
  /** Scraped by the contact cascade; also the highest-confidence email source. */
  team_url: z.url().nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type Company = z.infer<typeof Company>;

export const Job = z.object({
  id: z.number().int().positive(),
  company_id: z.number().int().positive(),
  /** `sha256(company_domain + normalise(title) + normalise(location))`. See architecture.md. */
  dedup_key: z.string().length(64),
  source: JobSourceName,
  /** The posting's id at its source, when it has one. */
  source_id: z.string().nullable(),
  url: z.url(),
  title: z.string().min(1),
  location: z.string(),
  description: z.string(),
  posted_at: Timestamp.nullable(),
  state: JobState,
  /** Only ever written by `src/store/state.ts`. */
  state_changed_at: Timestamp,
  /** NEEDS_CONTACT retries the cascade every 3 days, 3 attempts, then EXPIRED. */
  contact_attempts: z.number().int().min(0),
  last_contact_attempt_at: Timestamp.nullable(),
  first_seen_at: Timestamp,
  /** Bumped on every ingest that still sees the posting. Staleness → EXPIRED. */
  last_seen_at: Timestamp,
  /** When this job was reported in a digest. null = not reported yet. */
  digested_at: Timestamp.nullable(),
});
export type Job = z.infer<typeof Job>;

/**
 * Keyed on `(job_id, prompt_version)` so changing the rubric never destroys score
 * history — bump the version, re-score, compare distributions (decision 008).
 */
export const JobScore = z.object({
  job_id: z.number().int().positive(),
  prompt_version: z.number().int().positive(),
  /** Computed from the five factors below by `fitScore()`, not chosen by the model. */
  fit_score: z.number().int().min(0).max(100),
  /** The model's factor ratings, kept so a surprising score can be taken apart. */
  level_fit: z.number().int().min(0).max(10),
  location_fit: z.number().int().min(0).max(10),
  stack_fit: z.number().int().min(0).max(10),
  domain_fit: z.number().int().min(0).max(10),
  /**
   * Null on every row written before rubric v6, and there is nothing honest to backfill it
   * with — the model was never asked. Readers take the newest row per job (041), so a mix of
   * versions is normal rather than a migration that has not finished.
   */
  employer_fit: z.number().int().min(0).max(10).nullable(),
  /** Why the scorer landed there. Shown in the digest. */
  reasoning: z.string(),
  /** One concrete, specific detail the draft stage opens the email with. */
  hook: z.string(),
  model: z.string(),
  scored_at: Timestamp,
});
export type JobScore = z.infer<typeof JobScore>;

/** Scoped to a company, not a job — that is what makes the free-tier cascade viable. */
export const Contact = z.object({
  id: z.number().int().positive(),
  company_id: z.number().int().positive(),
  email: z.email(),
  name: z.string().nullable(),
  title: z.string().nullable(),
  source: ContactSource,
  confidence: ContactConfidence,
  /** Free MX check via `dns/promises`. null = not checked yet. */
  mx_valid: SqlBool.nullable(),
  /** The page the address was read off, for asking later where a bad one came from. */
  found_at: z.string().nullable(),
  /**
   * When a send proved this mailbox does not exist. null = still believed.
   *
   * `mx_valid` answers a question about the domain and cannot answer this one — see
   * `src/contacts/verify.ts`. A bounce is the only free evidence about a *mailbox* there is,
   * so a dead address is remembered rather than re-derived (decision 047).
   */
  dead_at: Timestamp.nullable(),
  dead_reason: z.string().nullable(),
  created_at: Timestamp,
});
export type Contact = z.infer<typeof Contact>;

/**
 * One row per job, ever. `UNIQUE(job_id)` in the DDL is the hard backstop against
 * double-sending (invariant 2) — keep it.
 */
export const Outreach = z.object({
  id: z.number().int().positive(),
  job_id: z.number().int().positive(),
  contact_id: z.number().int().positive(),
  subject: z.string().min(1),
  body: z.string().min(1),
  /** Set at `drafts.create`. Presence of this + absence of the draft in Gmail = it sent. */
  gmail_draft_id: z.string().nullable(),
  gmail_message_id: z.string().nullable(),
  gmail_thread_id: z.string().nullable(),
  drafted_at: Timestamp,
  /** When the draft was shown in a digest for review. null = not shown yet. */
  digested_at: Timestamp.nullable(),
  /** When he tapped Approve. Not a state: an approved item still waits for its slot. */
  approved_at: Timestamp.nullable(),
  /** When the bot last asked about this draft, so it does not ask again every ten minutes. */
  approval_asked_at: Timestamp.nullable(),
  delete_requested_at: Timestamp.nullable().optional(),
  application_id: z.number().int().positive().nullable(),
  recipient_override: z.string().email().nullable(),
  local_subject: z.string().nullable(),
  local_body: z.string().nullable(),
  archived_at: Timestamp.nullable(),
  follow_up_at: Timestamp.nullable(),
  revision: z.number().int().nonnegative(),
  edit_pending: SqlBool,
  /** 09:00 + jitter. Never the pipeline's own run time. */
  scheduled_send_at: Timestamp.nullable(),
  sent_at: Timestamp.nullable(),
  /**
   * Why delivery failed, when it did — `unknown-mailbox`, `blocked`, `temporary`, `other`.
   * The distinction is the only spam signal available to a sender: a wrong address is the
   * cascade's fault, a policy block is the account's. Migration 006.
   */
  bounce_reason: z.string().nullable(),
  /** Last time the tracker looked at this row. */
  tracked_at: Timestamp.nullable(),
  followup_sent_at: Timestamp.nullable(),
  replied_at: Timestamp.nullable(),
  bounced_at: Timestamp.nullable(),
  closed_at: Timestamp.nullable(),
});
export type Outreach = z.infer<typeof Outreach>;

/** One row per pipeline execution. Errors land here and never abort the run. */
export const RunError = z.object({
  stage: StageName,
  message: z.string(),
  at: Timestamp,
});
export type RunError = z.infer<typeof RunError>;

export const Run = z.object({
  id: z.number().int().positive(),
  started_at: Timestamp,
  finished_at: Timestamp.nullable(),
  dry_run: SqlBool,
  /** Free-form per-stage counters, e.g. `{ ingest: { discovered: 41 } }`. JSON column. */
  stats: z.record(z.string(), z.record(z.string(), z.number())),
  /** JSON column. Non-empty here does not mean the run failed. */
  errors: z.array(RunError),
});
export type Run = z.infer<typeof Run>;

// ─────────────────────────────────────────────────────────────────────────────
// Insert shapes — what stages hand to the store, before ids and defaults exist
// ─────────────────────────────────────────────────────────────────────────────

export const NewCompany = Company.omit({
  id: true,
  created_at: true,
  updated_at: true,
});
export type NewCompany = z.infer<typeof NewCompany>;

export const NewJob = Job.omit({
  id: true,
  dedup_key: true,
  state: true,
  state_changed_at: true,
  contact_attempts: true,
  last_contact_attempt_at: true,
  first_seen_at: true,
  last_seen_at: true,
  digested_at: true,
});
export type NewJob = z.infer<typeof NewJob>;

export const NewContact = Contact.omit({
  id: true,
  created_at: true,
  confidence: true,
});
export type NewContact = z.infer<typeof NewContact>;

/**
 * What a `JobSource` adapter emits. Company identity arrives as a domain + name;
 * the ingest stage resolves it to a `company_id`. No separate normalise stage exists —
 * adapters emit canonical rows (see `docs/architecture.md`).
 */
export const RawJob = z.object({
  company_name: z.string().min(1),
  company_domain: z.string().min(3),
  ats_type: AtsType.default("none"),
  ats_slug: z.string().nullable().default(null),
  source: JobSourceName,
  source_id: z.string().nullable().default(null),
  url: z.url(),
  title: z.string().min(1),
  location: z.string().default(""),
  description: z.string().default(""),
  posted_at: Timestamp.nullable().default(null),
});
export type RawJob = z.infer<typeof RawJob>;

/**
 * The scorer's structured output. Nothing else about the model response is trusted —
 * this schema both generates the JSON Schema sent to Groq and validates what comes back.
 *
 * Note what is **not** here: `fit_score`. The model rates five narrow factors 0–10 and
 * `src/match/score.ts` does the arithmetic. Asking for one holistic 0–100 number produced
 * 55, 78 and 90 on three runs of the identical posting — decision 012.
 */
export const ScoreResult = z.object({
  /** Can a final-year student take this role at all? 0 = needs years of experience. */
  level_fit: z.number().int().min(0).max(10),
  /** India, or genuinely remote-global? 0 = onsite abroad with no remote option. */
  location_fit: z.number().int().min(0).max(10),
  /** Overlap between the posting's core tech and what the candidate has actually built. */
  stack_fit: z.number().int().min(0).max(10),
  /** Overlap in problem domain — retrieval, backend, distributed systems, ML. */
  domain_fit: z.number().int().min(0).max(10),
  /**
   * Is this a real engineering employer, and is this posting theirs? 0 = a job board or
   * aggregator reposting somebody else's role.
   *
   * The factor that breaks the tie at 84. Level and location are both 10 for every
   * internship in Bengaluru and the stack matches by construction, so this is the only one
   * of the five that actually varies across the postings worth ranking (decision 051).
   */
  employer_fit: z.number().int().min(0).max(10),
  reasoning: z.string().min(1),
  hook: z.string().min(1),
});
export type ScoreResult = z.infer<typeof ScoreResult>;

// ─────────────────────────────────────────────────────────────────────────────
// Profile — the resume, parsed once, in a shape the scorer and drafter can use
// ─────────────────────────────────────────────────────────────────────────────

export const ProfileProject = z.object({
  name: z.string(),
  /** One or two sentences. What it is and what was hard about it. */
  summary: z.string(),
  tech: z.array(z.string()),
  /** Concrete, quantified results. These become email hooks — keep the numbers. */
  highlights: z.array(z.string()),
});
export type ProfileProject = z.infer<typeof ProfileProject>;

/**
 * A verified correction to what the resume PDF claims, and the tripwires that keep it applied.
 *
 * Decision 034 checked every quantified claim the pipeline can put in an email against the
 * repository it describes, and two did not survive: a "5× write reduction" his own `CHANGES.md`
 * measured at **1.08**, and two projects called "Distributed" where one is a single-host Docker
 * cluster and the other has no network at all. The corrections were hand-edited into
 * `data/profile.json` — which is generated and gitignored, so `profile.ts` silently restored
 * the originals on the next extraction (decision 053).
 *
 * This file is the durable form of that, and it is **committed**: the PDF is one source of
 * truth about the resume and this is the source of truth about the *artifacts*.
 */
export const ProfileCorrections = z.object({
  /** Why this file exists at all, for whoever finds it next. */
  why: z.string().min(1),
  /**
   * Per-project overrides. `match` is a case-insensitive substring of the project's name that
   * survives the model's paraphrasing — "typeahead", not the full title, because the extractor
   * rewords the heading on every run.
   */
  projects: z.array(
    z.object({
      match: z.string().min(1),
      decision: z.string().min(1),
      why: z.string().min(1),
      name: z.string().min(1),
      summary: z.string().min(1),
      highlights: z.array(z.string()),
    }),
  ),
  /**
   * Claims that must never appear in a saved profile. Checked **after** the overrides are
   * applied, so a hit means the model put a corrected claim somewhere the overrides do not
   * reach — and extraction fails rather than writing it.
   *
   * `in` scopes the check, and the scoping is load-bearing: "distributed systems" is a
   * legitimate entry under skills, domains and target_roles — he studies it — and 034's
   * objection was only ever to two *projects* claiming to be distributed.
   */
  forbidden: z.array(
    z.object({
      pattern: z.string().min(1),
      in: z.enum(['projects', 'anywhere']),
      decision: z.string().min(1),
      why: z.string().min(1),
    }),
  ),
});
export type ProfileCorrections = z.infer<typeof ProfileCorrections>;

export const ProfileExperience = z.object({
  company: z.string(),
  role: z.string(),
  /** Free text as written on the resume, e.g. "May 2025 – Aug 2025". */
  dates: z.string(),
  summary: z.string(),
});
export type ProfileExperience = z.infer<typeof ProfileExperience>;

/**
 * An array, not one object: dual-degree programmes are normal in India — this resume
 * lists Scaler School of Technology and BITS Pilani concurrently, and an earlier
 * single-object version of this schema silently dropped one of them.
 */
export const ProfileEducation = z.object({
  institution: z.string(),
  degree: z.string(),
  /** As written, e.g. "2024 – 2027" or "2024 – Present". */
  dates: z.string(),
  location: z.string(),
  /** CGPA/percentage exactly as written. Empty when absent. */
  score: z.string(),
});
export type ProfileEducation = z.infer<typeof ProfileEducation>;

/**
 * Skills keep the resume's own grouping ("Languages", "AI & Data", "Cloud & DevOps")
 * rather than being forced into fixed buckets. A fixed `languages` + `frameworks` pair
 * dropped the entire AI stack — LangChain, Cohere, Qdrant — which is the most relevant
 * part of this resume for the roles being targeted.
 */
export const ProfileSkillGroup = z.object({
  category: z.string(),
  items: z.array(z.string()),
});
export type ProfileSkillGroup = z.infer<typeof ProfileSkillGroup>;

/**
 * Lives in `data/profile.json`, which is gitignored — it holds a phone number and an
 * email address and must never reach the public repo.
 */
export const Profile = z.object({
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  links: z.array(z.string()),
  education: z.array(ProfileEducation),
  /** Two or three sentences, written to be read by the scorer. */
  summary: z.string(),
  skills: z.array(ProfileSkillGroup),
  /** Problem domains rather than tools — "RAG", "distributed systems", "browser automation". */
  domains: z.array(z.string()),
  projects: z.array(ProfileProject),
  experience: z.array(ProfileExperience),
  /** Competitive programming, awards, anything quantified. Real email-hook material. */
  achievements: z.array(z.string()),
  /** Roles this person should be matched against. Drives the scoring rubric. */
  target_roles: z.array(z.string()),
  extracted_at: Timestamp,
  /** Which model produced this, so a bad parse is traceable. */
  model: z.string(),
});
export type Profile = z.infer<typeof Profile>;

/** What the model returns — the metadata fields are added by us afterwards. */
export const ProfileExtraction = Profile.omit({ extracted_at: true, model: true });
export type ProfileExtraction = z.infer<typeof ProfileExtraction>;

// ─────────────────────────────────────────────────────────────────────────────
// Startup prospecting — a separate feature with its own tables (decision 056)
//
// Nothing below is read by the job pipeline, and nothing above is written by it. DDL in
// `src/store/migrations/011_startups.sql`; the code in `src/startups/`.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a startup was found. */
export const StartupSource = z.enum(['yc', 'peakxv']);
export type StartupSource = z.infer<typeof StartupSource>;

/**
 * Where a founder's address came from — the startup equivalent of `ContactSource`, and the
 * same idea: provenance is the only evidence there is about whether a mailbox exists.
 */
export const StartupContactSource = z.enum(['published', 'github', 'guess']);
export type StartupContactSource = z.infer<typeof StartupContactSource>;

export const Startup = z.object({
  id: z.number().int().positive(),
  source: StartupSource,
  source_id: z.string().min(1),
  name: z.string().min(1),
  website: z.string().nullable(),
  domain: z.string().nullable(),
  location: z.string(),
  batch: z.string(),
  team_size: z.number().int().nullable(),
  one_liner: z.string(),
  description: z.string(),
  /** JSON column. */
  tags: z.array(z.string()),
  github_url: z.string().nullable(),
  source_url: z.url(),
  details_fetched_at: Timestamp.nullable(),
  contacts_checked_at: Timestamp.nullable(),
  updates_fetched_at: Timestamp.nullable(),
  /** The demo he built for this startup. The email links it in its opening lines (058). */
  demo_url: z.string().nullable(),
  first_seen_at: Timestamp,
  last_seen_at: Timestamp,
});
export type Startup = z.infer<typeof Startup>;

export const StartupRole = z.object({
  id: z.number().int().positive(),
  startup_id: z.number().int().positive(),
  source_id: z.string().min(1),
  title: z.string().min(1),
  location: z.string(),
  job_type: z.string(),
  min_experience: z.string(),
  /** As printed by the source. `parseSalary` in `src/startups/fit.ts` reads it for ranking. */
  salary: z.string(),
  url: z.url(),
  first_seen_at: Timestamp,
  last_seen_at: Timestamp,
  /** From the job's own page, read when the role is first briefed (migration 012). */
  description: z.string(),
  interview_process: z.string(),
  hiring_manager: z.string().nullable(),
  detail_fetched_at: Timestamp.nullable(),
  /** When this role was announced on Telegram. Migration 014. */
  notified_at: Timestamp.nullable(),
});
export type StartupRole = z.infer<typeof StartupRole>;

/**
 * Something a startup shipped or was written about, with its date — what the brief shows as
 * "what they are working on now". The date is the point: a 2023 launch is history.
 */
export const StartupUpdateKind = z.enum(['launch', 'news', 'hn']);
export type StartupUpdateKind = z.infer<typeof StartupUpdateKind>;

export const StartupUpdate = z.object({
  id: z.number().int().positive(),
  startup_id: z.number().int().positive(),
  kind: StartupUpdateKind,
  title: z.string().min(1),
  summary: z.string(),
  url: z.string().min(1),
  published_at: Timestamp.nullable(),
  created_at: Timestamp,
});
export type StartupUpdate = z.infer<typeof StartupUpdate>;

export const StartupPerson = z.object({
  id: z.number().int().positive(),
  startup_id: z.number().int().positive(),
  name: z.string().min(1),
  title: z.string(),
  created_at: Timestamp,
});
export type StartupPerson = z.infer<typeof StartupPerson>;

export const StartupContact = z.object({
  id: z.number().int().positive(),
  startup_id: z.number().int().positive(),
  person_id: z.number().int().positive().nullable(),
  email: z.email(),
  /** The founder's name as the source listed it. Null for a role address like `hello@`. */
  name: z.string().nullable(),
  source: StartupContactSource,
  confidence: ContactConfidence,
  rank: z.number().int(),
  found_at: z.string(),
  dead_at: Timestamp.nullable(),
  created_at: Timestamp,
});
export type StartupContact = z.infer<typeof StartupContact>;

export const StartupOutreach = z.object({
  id: z.number().int().positive(),
  startup_id: z.number().int().positive(),
  contact_id: z.number().int().positive(),
  role_id: z.number().int().positive().nullable(),
  subject: z.string().min(1),
  body: z.string().min(1),
  gmail_draft_id: z.string().min(1),
  drafted_at: Timestamp,
  /** Read back from Gmail's `SENT` label by `--status`. This module never sends. */
  sent_at: Timestamp.nullable(),
  checked_at: Timestamp.nullable(),
});
export type StartupOutreach = z.infer<typeof StartupOutreach>;

/** One YC company from the public directory mirror, as much of it as is read. */
export const YcIndexCompany = z.object({
  name: z.string(),
  slug: z.string(),
  website: z.string().nullable().catch(null),
  all_locations: z.string().nullable().catch(null),
  long_description: z.string().nullable().catch(null),
  one_liner: z.string().nullable().catch(null),
  team_size: z.number().nullable().catch(null),
  tags: z.array(z.string()).catch([]),
  industries: z.array(z.string()).catch([]),
  regions: z.array(z.string()).catch([]),
  batch: z.string().nullable().catch(null),
  status: z.string().nullable().catch(null),
  stage: z.string().nullable().catch(null),
  isHiring: z.boolean().catch(false),
  url: z.string(),
});
export type YcIndexCompany = z.infer<typeof YcIndexCompany>;

/** The founders and open roles embedded in a YC company page. */
export const YcCompanyPage = z.object({
  company: z.object({
    github_url: z.string().nullable().catch(null),
    founders: z
      .array(z.object({ full_name: z.string(), title: z.string().nullable().catch(null), is_active: z.boolean().catch(true) }))
      .catch([]),
  }),
  /** Launch YC posts — the company announcing its own product. */
  launches: z
    .array(
      z.object({
        title: z.string(),
        tagline: z.string().nullable().catch(null),
        body: z.string().nullable().catch(null),
        created_at: z.string().nullable().catch(null),
        ycdc_launch_url: z.string().nullable().catch(null),
        slug: z.string().nullable().catch(null),
      }),
    )
    .catch([]),
  /** Press YC links from the company page. Titles arrive HTML-escaped. */
  newsItems: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        date: z.string().nullable().catch(null),
      }),
    )
    .catch([]),
  jobPostings: z
    .array(
      z.object({
        id: z.union([z.number(), z.string()]).transform(String),
        title: z.string(),
        url: z.string(),
        location: z.string().nullable().catch(null),
        type: z.string().nullable().catch(null),
        role: z.string().nullable().catch(null),
        salaryRange: z.string().nullable().catch(null),
        minExperience: z.string().nullable().catch(null),
        visa: z.string().nullable().catch(null),
      }),
    )
    .catch([]),
});
export type YcCompanyPage = z.infer<typeof YcCompanyPage>;

/** A YC job's own page: the parts the listing on the company page leaves out. */
export const YcJobPage = z.object({
  job: z.object({
    description: z.string().nullable().catch(null),
    interview_process: z.string().nullable().catch(null),
    hiringManager: z
      .object({ first_name: z.string().nullable().catch(null), last_name: z.string().nullable().catch(null) })
      .nullable()
      .catch(null),
  }),
});
export type YcJobPage = z.infer<typeof YcJobPage>;

/** Demo ideas for one startup — one Groq call, kept so a second look costs nothing. */
export const StartupIdeas = z.object({
  startup_id: z.number().int().positive(),
  body: z.string().min(1),
  model: z.string(),
  created_at: Timestamp,
});
export type StartupIdeas = z.infer<typeof StartupIdeas>;
