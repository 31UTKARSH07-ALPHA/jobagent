/**
 * The scoring stage: every `DISCOVERED` job against the parsed resume.
 *
 *   node src/main.ts --stage=score       score everything waiting
 *   node src/match/score.ts --job=12     score one job, print it, write nothing
 *   node src/match/score.ts --distribution
 *
 * One Groq call per job, validated against `ScoreResult`. The score row is written and the
 * state advanced in a single transaction, so a crash leaves a job either fully scored or
 * fully unscored — never a score with a stale state.
 *
 * Two things here are deliberately conservative:
 *
 * - **A job already scored under this `PROMPT_VERSION` is never re-sent to the model.**
 *   If a previous run wrote the score but died before the transition, the stored score is
 *   reused to finish the job (invariant 4).
 * - **A per-job failure is counted, not thrown.** One malformed JD must not cost the run
 *   the other forty; the row stays `DISCOVERED` and tomorrow retries it for free.
 */
import { parseArgs } from 'node:util';
import { complete } from '../llm/groq.ts';
import { modelFor } from '../llm/models.ts';
import { openDb, DEFAULT_DB_PATH, transaction } from '../store/db.ts';
import { getJob } from '../store/jobs.ts';
import { factorsOf, getScore, insertScore, latestScore, scoreDistribution } from '../store/scores.ts';
import { jobIdsInState, transition } from '../store/state.ts';
import { ScoreResult, type Job, type JobState, type Profile } from '../store/schema.ts';
import { loadProfile } from './profile.ts';
import type { StageContext } from '../stage.ts';

/**
 * Bump this when the rubric below changes in a way that could move scores. Old rows are
 * kept, so the two distributions can be compared before thresholds are touched
 * (decision 008). Never edit the prompt without bumping it.
 */
export const PROMPT_VERSION = 4;

/**
 * `fit_score >= MATCH_THRESHOLD` → MATCHED, below → REJECTED (terminal).
 *
 * **Still a placeholder.** Decision 008: run scoring for three days, then look at
 * `--distribution` before believing this number.
 */
export const MATCH_THRESHOLD = 70;

/**
 * Ceiling on model calls per run. The free tier has a daily token allowance, and once
 * Gmail alerts land the DISCOVERED queue will be much bigger than today's five rows.
 * Whatever does not fit stays `DISCOVERED` and is scored by the next run — the state
 * machine already makes that free, so there is no queue to build.
 */
export const MAX_SCORES_PER_RUN = 60;

/** Long JDs are mostly boilerplate — benefits, EEO statements. The top is the job. */
const MAX_DESCRIPTION_CHARS = 6_000;

/**
 * The prompt asks for four narrow ratings, never an overall verdict.
 *
 * Each factor is a question with an observable answer — "does this posting demand years of
 * experience" is checkable against the text; "how good a fit is this, out of 100" is not,
 * and the model answered it differently every time (decision 012).
 */
const SYSTEM = `You rate one job posting against one candidate on four separate factors. You never
give an overall verdict — something else combines your ratings. Rate only what you are asked.

Judge the fit for THIS candidate: not how prestigious the company is, and not how good the
posting is in the abstract. Judge on what the candidate has actually built and shipped, not
on the keywords they listed.

level_fit — can this candidate, a final-year student with internship experience, hold this role?
  10  explicitly an internship, new-grad, graduate or trainee role
   7  entry-level: "0-1 years", SDE-1, junior, no experience bar stated
   4  asks for ~2 years, or is ambiguous about seniority
   1  asks for 3+ years
   0  senior/staff/lead, or requires a degree the candidate does not have (e.g. PhD)
  The stated experience requirement beats the title. "3+ years" is not early-career even if
  the title says "Junior".

location_fit — can the candidate work this job from India?
  10  in India, or remote with no country restriction
   6  remote but the region is vague, or hybrid in India
   3  remote restricted to a region the candidate is not in
   0  onsite in another country, with no remote or relocation offered
  A posting that names a foreign office and never mentions remote is 0, whatever a "remote"
  checkbox elsewhere claims. Location "not stated" with no clue in the description is 6.

If the posting has no description, say so in "reasoning" and rate stack_fit and domain_fit on
what the title alone implies — "AI Engineering Intern" is real evidence of an ML stack,
"Software Development Intern (Full Stack)" of a web one, and a bare "Intern" almost none. Do
NOT discount your ratings for the missing description: that is handled after you, in
arithmetic. Rate the title honestly, including low when the title says little.

stack_fit — how much of the posting's core technology has this candidate actually used?
  10  the posting's main languages and tools are the ones they have built with
   6  adjacent: same layer of the stack, different tools
   3  same field, little concrete overlap
   0  a technology area they have never touched (e.g. kernel/driver work, embedded, Rust)

domain_fit — how much do the problems overlap?
  10  the same problems they have solved — retrieval, search, backend APIs, distributed systems
   6  neighbouring problems in the same discipline
   3  software, but a different discipline
   0  not a software or ML engineering role at all

reasoning — two or three sentences, concrete. Name the specific thing that matched and the
specific thing that did not. A human reads this every morning; no filler.

hook — one specific detail from the candidate's OWN work that a cold email to this company
could open with, and why it is relevant to this posting. Keep their quantified numbers
exactly as written ("p95 8ms", "460+ problems"). It must be a real detail from the profile,
never a generality like "passionate about AI". If nothing genuinely connects, say so plainly
in one line rather than inventing a link.`;

/**
 * How the four factors become one number.
 *
 * Level and location carry the most weight because they are the two things that make a
 * posting flatly impossible rather than merely a stretch.
 */
export const WEIGHTS = {
  level_fit: 0.3,
  location_fit: 0.25,
  stack_fit: 0.25,
  domain_fit: 0.2,
} as const;

/**
 * Ratings at or below this on `level_fit` / `location_fit` mean the job cannot happen at
 * all, and no amount of stack overlap should push it over the MATCHED threshold.
 */
const BLOCKER_AT_OR_BELOW = 1;
/** Ceiling applied when a blocker is present. Comfortably below `MATCH_THRESHOLD`. */
const BLOCKED_CEILING = 30;

/**
 * The factors → `fit_score`. Pure arithmetic: same ratings, same score, forever.
 *
 * The two gates are the "hard rules" that used to be prose in the prompt. Prose the model
 * agreed with and then ignored; code cannot ignore it.
 */
/**
 * `titleOnly` is deliberately **required**, not defaulted.
 *
 * It had a default when v4 landed, and the `--job` inspection path quietly omitted it —
 * printing 100 for a description-free posting whose real score is 84, on the one screen whose
 * whole purpose is letting a human check the scorer before trusting it. A default turns a
 * missed call site into a wrong number; a required parameter turns it into a compile error.
 */
export function fitScore(r: ScoreResult, titleOnly: boolean): number {
  const weighted =
    r.level_fit * WEIGHTS.level_fit +
    r.location_fit * WEIGHTS.location_fit +
    r.stack_fit * WEIGHTS.stack_fit +
    r.domain_fit * WEIGHTS.domain_fit;

  let score = Math.round(weighted * 10);

  // No job description: discount the whole result rather than the inputs, so the ratings
  // still rank postings against each other.
  if (titleOnly) score = Math.min(Math.round(score * EVIDENCE_PENALTY), TITLE_ONLY_CEILING);

  // Last, because it is a hard ceiling and not a discount: a job that cannot happen must
  // not be lifted over the threshold by anything.
  const blocked = r.level_fit <= BLOCKER_AT_OR_BELOW || r.location_fit <= BLOCKER_AT_OR_BELOW;
  return blocked ? Math.min(score, BLOCKED_CEILING) : score;
}

/**
 * A description shorter than this is no evidence at all — a title, a company and a city.
 * Alert-email postings are all like this by construction (decision 016).
 */
export const MIN_DESCRIPTION_CHARS = 200;

/**
 * The evidence discount for a posting with no description, and its hard ceiling.
 *
 * **This replaces a clamp that flattened the score into a constant.** Decision 016 held
 * `stack_fit` and `domain_fit` to 6 without a JD, for a good reason: on 2026-08-11 three
 * Naukri postings came back 10/10/10/10 → 100, tying Stripe's fully-described internship.
 *
 * But measured on 2026-08-20 across 32 title-only postings, that clamp had over-corrected
 * into a flat line — **31 of 32 scored exactly 82**:
 *
 *     level 10 · location 10 · stack 6 · domain 6  ->  82   ×31
 *
 * An internship title in Bengaluru always earns 10 for level and 10 for location, so with the
 * other two pinned at 6 the score was arithmetic with no inputs left. It stopped ranking
 * anything, `MATCH_THRESHOLD` stopped meaning anything, and 27 of 29 postings "matched".
 * Worse, the clamped 6 was what got *stored*, so the model's real opinion — 9 for "AI
 * Engineering Intern", 3 for a bare "Intern" — was discarded and cannot be recovered.
 *
 * So the discount moves off the factors and onto the total. The model now rates what the
 * title implies (see SYSTEM) and those ratings are stored as given; the missing description
 * costs a flat 15% of the result instead of the ability to tell postings apart.
 *
 * The ceiling is what decision 016 actually needed. 10/10/10/10 × 0.85 is 85, and Phase 3
 * auto-sends above 85, so the ceiling sits one point below: a posting nobody has read still
 * cannot mail itself, which was the point.
 */
export const EVIDENCE_PENALTY = 0.85;
export const TITLE_ONLY_CEILING = 84;

export const isTitleOnly = (job: Pick<Job, 'description'>): boolean =>
  job.description.trim().length < MIN_DESCRIPTION_CHARS;

/** `level 10 · location 8 · stack 6 · domain 4` — for logs and, later, the digest. */
export const factorLine = (r: ScoreResult): string =>
  `level ${r.level_fit} · location ${r.location_fit} · stack ${r.stack_fit} · domain ${r.domain_fit}`;

/**
 * The profile as prompt text.
 *
 * Contact details are omitted on purpose: phone number, email and personal links are worth
 * nothing to a rubric and there is no reason to send them to a third-party API.
 */
export function profileForPrompt(p: Profile): string {
  return [
    `Candidate: ${p.name}`,
    '',
    p.summary,
    '',
    'Education:',
    ...p.education.map(
      (e) => `- ${e.degree} — ${e.institution} (${e.dates})${e.score ? `, ${e.score}` : ''}`,
    ),
    '',
    'Skills:',
    ...p.skills.map((g) => `- ${g.category}: ${g.items.join(', ')}`),
    `- Problem domains: ${p.domains.join(', ')}`,
    '',
    'Projects:',
    ...p.projects.flatMap((x) => [
      `- ${x.name} [${x.tech.join(', ')}]: ${x.summary}`,
      ...x.highlights.map((h) => `    • ${h}`),
    ]),
    '',
    'Experience:',
    ...p.experience.map((x) => `- ${x.role} @ ${x.company} (${x.dates}): ${x.summary}`),
    '',
    'Achievements:',
    ...p.achievements.map((a) => `- ${a}`),
    '',
    `Roles being targeted: ${p.target_roles.join(', ')}`,
  ].join('\n');
}

/** The posting as prompt text. Truncated, because the tail of a JD is boilerplate. */
export function jobForPrompt(job: Job, companyName: string): string {
  const description =
    job.description.length > MAX_DESCRIPTION_CHARS
      ? `${job.description.slice(0, MAX_DESCRIPTION_CHARS)}\n[…truncated]`
      : job.description;

  return [
    `Company: ${companyName}`,
    `Title: ${job.title}`,
    `Location: ${job.location || '(not stated)'}`,
    `Posted: ${job.posted_at ?? '(not stated)'}`,
    '',
    'Description:',
    description || '(the posting had no description — judge on the title and location)',
  ].join('\n');
}

/**
 * A scorer, and the model that gets recorded against its output.
 *
 * Bundled together so `job_scores.model` is always honest about what produced the row —
 * including in tests, where a fake scorer records itself rather than borrowing Groq's name.
 */
export type Scorer = {
  model: string;
  score: (job: Job, companyName: string, profile: Profile) => Promise<ScoreResult>;
};

export const groqScorer: Scorer = {
  model: modelFor('score').id,
  score: (job, companyName, profile) =>
    complete(ScoreResult, 'job_score', {
      job: 'score',
      system: SYSTEM,
      messages: [
        { role: 'user', content: `${profileForPrompt(profile)}\n\n---\n\nPosting:\n\n${jobForPrompt(job, companyName)}` },
      ],
      maxTokens: 1024,
      // A score decides a terminal state. The same posting scored 55 and 92 at Groq's
      // default temperature of 1.0 — see decision 012.
      temperature: 0,
    }),
};

/** The one place the threshold turns into a state. */
export const stateForScore = (score: number): Extract<JobState, 'MATCHED' | 'REJECTED'> =>
  score >= MATCH_THRESHOLD ? 'MATCHED' : 'REJECTED';

type JobWithCompany = Job & { company_name: string };

function discoveredJobs(ctx: StageContext, limit: number): JobWithCompany[] {
  const ids = jobIdsInState(ctx.db, 'DISCOVERED', limit);
  return ids.flatMap((id) => {
    const job = getJob(ctx.db, id);
    if (job === null) return [];
    const row = ctx.db.prepare('SELECT name FROM companies WHERE id = ?').get(job.company_id) as
      | { name: string }
      | undefined;
    return [{ ...job, company_name: row?.name ?? '(unknown company)' }];
  });
}

export type ScoreDeps = {
  scorer?: Scorer;
  profile?: Profile;
  /** Overrides where the profile is read from. `PROFILE_PATH` when unset. */
  profilePath?: string;
};

export async function runScore(ctx: StageContext, deps: ScoreDeps = {}): Promise<void> {
  let profile: Profile;
  try {
    profile = deps.profile ?? loadProfile(deps.profilePath);
  } catch (err) {
    // Not fatal to the run: ingest still ran, and the rows wait in DISCOVERED.
    ctx.log(err instanceof Error ? err.message : String(err));
    return;
  }

  const scorer = deps.scorer ?? groqScorer;
  const waiting = jobIdsInState(ctx.db, 'DISCOVERED').length;
  const jobs = discoveredJobs(ctx, MAX_SCORES_PER_RUN);

  if (jobs.length === 0) {
    ctx.log('nothing waiting in DISCOVERED');
    return;
  }
  ctx.log(
    `scoring ${jobs.length} of ${waiting} waiting with ${scorer.model} (rubric v${PROMPT_VERSION})` +
      (waiting > jobs.length ? ` — ${waiting - jobs.length} left for the next run` : ''),
  );

  for (const job of jobs) {
    // Each job is a paced Groq call, so the loop is the natural place to give up. Whatever
    // is already scored stays scored; the rest are still DISCOVERED and cost nothing to
    // retry tomorrow (invariant 4).
    if (ctx.signal.aborted) {
      ctx.log('out of time — remaining jobs stay DISCOVERED for the next run');
      ctx.count('out_of_time');
      break;
    }

    try {
      // A score row already here means a previous run died between the insert and the
      // transition. Reuse it rather than paying for the same judgement twice.
      const existing = getScore(ctx.db, job.id, PROMPT_VERSION);
      const titleOnly = isTitleOnly(job);
      const result = existing
        ? factorsOf(existing)
        : await scorer.score(job, job.company_name, profile);

      if (existing) ctx.count('reused_score');
      if (titleOnly && !existing) ctx.count('title_only');

      const fit = fitScore(result, titleOnly);
      const next = stateForScore(fit);

      transaction(ctx.db, () => {
        if (!existing) insertScore(ctx.db, job.id, PROMPT_VERSION, fit, result, scorer.model);
        transition(ctx.db, job.id, 'DISCOVERED', 'SCORED');
        transition(ctx.db, job.id, 'SCORED', next);
      });

      ctx.count('scored');
      ctx.count(next === 'MATCHED' ? 'matched' : 'rejected');
      ctx.log(
        `${String(fit).padStart(3)} ${next === 'MATCHED' ? '✓' : '·'} ${job.company_name} — ` +
          `${job.title}  [${factorLine(result)}]`,
      );
    } catch (err) {
      // The row stays DISCOVERED. Tomorrow's run picks it up with no bookkeeping.
      ctx.count('failed');
      ctx.log(`job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — prompt iteration and the calibration gate
// ─────────────────────────────────────────────────────────────────────────────

function printDistribution(dbPath: string): number {
  const db = openDb(dbPath);
  const dist = scoreDistribution(db, PROMPT_VERSION);
  db.close();

  if (dist === null) {
    console.log(`no scores yet under rubric v${PROMPT_VERSION}`);
    return 0;
  }

  const widest = Math.max(...dist.bands);
  console.log(`rubric v${dist.promptVersion} — ${dist.total} scores`);
  console.log(`min ${dist.min}  median ${dist.median}  max ${dist.max}\n`);
  dist.bands.forEach((n, i) => {
    const bar = '█'.repeat(widest === 0 ? 0 : Math.round((n / widest) * 32));
    const label = `${i * 10}-${i === 9 ? 100 : i * 10 + 9}`.padStart(6);
    console.log(`${label} ${String(n).padStart(4)} ${bar}`);
  });
  console.log(
    `\nMATCHED threshold is currently ${MATCH_THRESHOLD} (a placeholder — decision 008).`,
  );
  return 0;
}

/**
 * Score every job that has no score under the current `PROMPT_VERSION`, whatever state it is
 * in, and **without touching state**.
 *
 * This is the mechanism decision 008 assumed when it keyed `job_scores` on `prompt_version`:
 * bump the rubric, re-score, compare distributions before moving a threshold. It exists so
 * that a rubric change never requires editing the database by hand.
 *
 * State is deliberately left alone. A job that was MATCHED and now scores below the threshold
 * cannot legally go back to REJECTED (`src/store/state.ts` has no such edge, by design — it
 * may already have a draft written about it). Those cases are printed as disagreements for a
 * human to look at, which is the honest outcome rather than a silent demotion.
 */
async function rescore(dbPath: string, limit: number): Promise<number> {
  const db = openDb(dbPath);
  const profile = loadProfile();

  const rows = db
    .prepare(
      `SELECT j.id FROM jobs j
        WHERE j.state <> 'EXPIRED'
          AND NOT EXISTS (
            SELECT 1 FROM job_scores s WHERE s.job_id = j.id AND s.prompt_version = ?
          )
        ORDER BY j.id
        LIMIT ?`,
    )
    .all(PROMPT_VERSION, limit) as { id: number }[];

  if (rows.length === 0) {
    console.log(`every job already has a rubric v${PROMPT_VERSION} score`);
    db.close();
    return 0;
  }

  console.log(`re-scoring ${rows.length} job(s) under rubric v${PROMPT_VERSION}\n`);
  const disagreements: string[] = [];

  for (const { id } of rows) {
    const job = getJob(db, id);
    if (job === null) continue;
    const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(job.company_id) as
      | { name: string }
      | undefined;

    const previous = latestScore(db, id);

    try {
      const raw = await groqScorer.score(job, company?.name ?? '(unknown)', profile);
      const result = raw;
      const fit = fitScore(result, isTitleOnly(job));
      insertScore(db, id, PROMPT_VERSION, fit, result, groqScorer.model);

      const was = previous === null ? '—' : `${previous.fit_score} (v${previous.prompt_version})`;
      const arrow = previous === null || previous.fit_score === fit ? ' ' : fit > previous.fit_score ? '↑' : '↓';
      console.log(
        `  ${String(fit).padStart(3)} ${arrow} was ${was.padEnd(10)} ${job.title.slice(0, 46).padEnd(46)} [${factorLine(result)}]`,
      );

      const shouldBe = stateForScore(fit);
      if (
        (job.state === 'MATCHED' && shouldBe === 'REJECTED') ||
        (job.state === 'REJECTED' && shouldBe === 'MATCHED')
      ) {
        disagreements.push(`  job ${id} is ${job.state} but v${PROMPT_VERSION} says ${shouldBe} (${fit}) — ${job.title}`);
      }
    } catch (err) {
      console.error(`  job ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (disagreements.length > 0) {
    console.log(`\n${disagreements.length} job(s) whose state no longer matches their score:`);
    console.log(disagreements.join('\n'));
    console.log('\nState is not changed by a re-score — see the note on `rescore` in this file.');
  }

  db.close();
  console.log();
  return printDistribution(dbPath);
}

async function scoreOne(dbPath: string, jobId: number): Promise<number> {
  const db = openDb(dbPath);
  const job = getJob(db, jobId);
  if (job === null) {
    console.error(`no job ${jobId} in ${dbPath}`);
    db.close();
    return 2;
  }
  const row = db.prepare('SELECT name FROM companies WHERE id = ?').get(job.company_id) as
    | { name: string }
    | undefined;
  db.close();

  const result = await groqScorer.score(job, row?.name ?? '(unknown)', loadProfile());
  // The evidence discount has to be applied here too. It was missed when v4 landed, and this
  // path printed 100 for a description-free LinkedIn posting whose real score is 84 — on the
  // one screen whose entire job is letting a human check the scorer before trusting it.
  const titleOnly = isTitleOnly(job);
  const fit = fitScore(result, titleOnly);
  console.log(`${row?.name} — ${job.title}  [${job.location}]`);
  console.log(`\nfactors    ${factorLine(result)}${titleOnly ? '   (no description: total discounted)' : ''}`);
  console.log(`fit_score  ${fit}  → ${stateForScore(fit)}`);
  console.log(`reasoning  ${result.reasoning}`);
  console.log(`hook       ${result.hook}`);
  console.log('\n(nothing written — this is the prompt-iteration path)');
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      job: { type: 'string' },
      distribution: { type: 'boolean', default: false },
      rescore: { type: 'boolean', default: false },
      limit: { type: 'string', default: String(MAX_SCORES_PER_RUN) },
      db: { type: 'string', default: DEFAULT_DB_PATH },
    },
  });

  if (values.distribution) return printDistribution(values.db);
  if (values.job !== undefined) return scoreOne(values.db, Number(values.job));
  if (values.rescore) return rescore(values.db, Number(values.limit));

  console.error('usage: node src/match/score.ts --job=<id> | --distribution | --rescore [--db=<path>]');
  console.error('       --rescore  score every job missing a score at the current PROMPT_VERSION,');
  console.error('                  without changing any state. For the calibration gate.');
  console.error('       (to score everything waiting: node src/main.ts --stage=score)');
  return 2;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
