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
import { z } from 'zod';

/** UTC ISO-8601, e.g. `2026-08-09T06:00:00.000Z`. Always store UTC. */
export const Timestamp = z.iso.datetime();

/** SQLite has no boolean type. */
export const SqlBool = z.union([z.literal(0), z.literal(1)]);

export const nowIso = (): string => new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The job lifecycle. Diagram in `docs/architecture.md`; the legal edges between
 * these values live in exactly one place, `src/store/state.ts`.
 */
export const JobState = z.enum([
  'DISCOVERED',
  'SCORED',
  'MATCHED',
  'REJECTED',
  'NEEDS_CONTACT',
  'EXPIRED',
  'DRAFTED',
  'AUTO_SEND',
  'PENDING_APPROVAL',
  'REJECTED_BY_USER',
  'SENT',
  'FOLLOW_UP_SENT',
  'REPLIED',
  'BOUNCED',
  'CLOSED',
]);
export type JobState = z.infer<typeof JobState>;

/** Applicant-tracking system a company's postings live on. */
export const AtsType = z.enum(['greenhouse', 'lever', 'ashby', 'workable', 'none']);
export type AtsType = z.infer<typeof AtsType>;

/** Which adapter produced a job row. Matches `JobSource.name`. */
export const JobSourceName = z.enum([
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'gmail-alert',
  'hackernews',
  'manual',
]);
export type JobSourceName = z.infer<typeof JobSourceName>;

/**
 * Where a contact's email came from. This — not a paid verifier — is what decides
 * auto-send eligibility (decision 006).
 */
export const ContactSource = z.enum(['posting', 'team_page', 'github', 'pattern']);
export type ContactSource = z.infer<typeof ContactSource>;

export const ContactConfidence = z.enum(['high', 'medium', 'low']);
export type ContactConfidence = z.infer<typeof ContactConfidence>;

/**
 * Invariant 3: only `posting` and `team_page` are ever `high`, and only `high`
 * contacts can auto-send. Pattern guesses are always low.
 */
export const confidenceForSource = (source: ContactSource): ContactConfidence =>
  source === 'posting' || source === 'team_page' ? 'high' : source === 'github' ? 'medium' : 'low';

/** Pipeline stages, in execution order. `track` runs on its own 4h schedule. */
export const StageName = z.enum([
  'ingest',
  'prefilter',
  'score',
  'contacts',
  'draft',
  'send',
  'track',
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
});
export type Job = z.infer<typeof Job>;

/**
 * Keyed on `(job_id, prompt_version)` so changing the rubric never destroys score
 * history — bump the version, re-score, compare distributions (decision 008).
 */
export const JobScore = z.object({
  job_id: z.number().int().positive(),
  prompt_version: z.number().int().positive(),
  fit_score: z.number().int().min(0).max(100),
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
  /** 09:00 + jitter. Never the pipeline's own run time. */
  scheduled_send_at: Timestamp.nullable(),
  sent_at: Timestamp.nullable(),
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

export const NewCompany = Company.omit({ id: true, created_at: true, updated_at: true });
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
});
export type NewJob = z.infer<typeof NewJob>;

export const NewContact = Contact.omit({ id: true, created_at: true, confidence: true });
export type NewContact = z.infer<typeof NewContact>;

/**
 * What a `JobSource` adapter emits. Company identity arrives as a domain + name;
 * the ingest stage resolves it to a `company_id`. No separate normalise stage exists —
 * adapters emit canonical rows (see `docs/architecture.md`).
 */
export const RawJob = z.object({
  company_name: z.string().min(1),
  company_domain: z.string().min(3),
  ats_type: AtsType.default('none'),
  ats_slug: z.string().nullable().default(null),
  source: JobSourceName,
  source_id: z.string().nullable().default(null),
  url: z.url(),
  title: z.string().min(1),
  location: z.string().default(''),
  description: z.string().default(''),
  posted_at: Timestamp.nullable().default(null),
});
export type RawJob = z.infer<typeof RawJob>;

/**
 * The scorer's structured output. Nothing else about the Anthropic response is trusted.
 */
export const ScoreResult = z.object({
  fit_score: z.number().int().min(0).max(100),
  reasoning: z.string().min(1),
  hook: z.string().min(1),
});
export type ScoreResult = z.infer<typeof ScoreResult>;
