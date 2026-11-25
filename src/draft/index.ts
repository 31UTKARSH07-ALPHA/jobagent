/**
 * The draft stage: a `DRAFTED` job with a contact → a real Gmail draft, waiting in his
 * account for Phase 3 to send.
 *
 * **Nothing is sent here and nothing can be.** The stage calls `drafts.create` and stores the
 * id it returns; `drafts.send` belongs to Phase 3 and lives behind the gate. That split is
 * invariant 1, and it is what makes an ambiguous failure recoverable — on a timeout, ask
 * Gmail whether the draft still exists: gone means it sent (decision 007).
 *
 * `outreach` has `UNIQUE(job_id)`, so a job can have exactly one draft, ever. That constraint
 * is the backstop behind every other precaution in this file, and this stage leans on it for
 * idempotency rather than reimplementing it: re-running the pipeline skips any job that
 * already has a row (invariant 4).
 */
import { parseArgs } from 'node:util';
import type { StageContext } from '../stage.ts';
import { getJob } from '../store/jobs.ts';
import { tryTransition } from '../store/state.ts';
import { CURRENT_FIT_SCORE, latestScore } from '../store/scores.ts';
import { MATCH_THRESHOLD, PROMPT_VERSION } from '../match/score.ts';
import { isUnpaid } from '../ingest/filter.ts';
import { internshipRecommendationExclusion } from '../ingest/compensation.ts';
import { nowIso, type Job, type JobScore, type Profile } from '../store/schema.ts';
import { loadProfile } from '../match/profile.ts';
import { groqDrafter, type Drafter, type DraftResult } from './compose.ts';
import { dailyCap, sendingDays, SUPPRESSED_BY_SIBLING } from '../send/gate.ts';
import {
  createGmailDraft,
  updateGmailDraft,
  type DraftUpdater,
  type DraftWriter,
} from './gmail-draft.ts';

/**
 * Hard ceiling on drafts per run, whatever the ramp says.
 *
 * The real limit is `dailyCap()` — drafting more than can be sent just fills the Drafts
 * folder with a backlog he has to read past. This is the backstop for the top of the ramp.
 */
export const MAX_DRAFTS_PER_RUN = 8;

/**
 * Which contacts are worth writing to **at all, for now**.
 *
 * Utkarsh's call, 2026-08-28: send only to addresses published on a company's own site, and
 * revisit guesses once there is evidence either way. 34 of 62 contacts are pattern guesses at
 * `careers@`, and a guess that is wrong costs a bounce against the personal Gmail account he
 * uses for everything — while a guess that is *right* still lands in a shared inbox that may
 * ignore unsolicited mail. Neither outcome is worth spending reputation on before the
 * published addresses have shown whether cold email works at all.
 *
 * This gates **drafting**, not just sending, on purpose: the drafts are his review queue, and
 * a queue full of emails he has decided not to send is a queue he stops reading.
 *
 * Set back to `['high', 'medium', 'low']` to turn guesses on — that is the whole switch, and
 * the open question it answers is in `agenthandoff.md`.
 */
export const DRAFTABLE_CONFIDENCE: readonly string[] = ['high', 'medium'];

/** A job ready to be written about, with everything the composer needs. */
type Draftable = {
  job: Job;
  companyId: number;
  company: string;
  contactId: number;
  email: string;
  /** The contact's name when the cascade found one — most are role addresses with none. */
  contactName: string | null;
  score: JobScore;
};

/**
 * Jobs in `DRAFTED` with a contact and no `outreach` row yet, best score first.
 *
 * Same ordering as the digest, and for the same reason (decision 027): 57 of 90 scores tie at
 * exactly 84, so within a tie the newest posting wins — an internship found five days ago may
 * already be closed.
 */
export function draftableJobs(ctx: StageContext, limit?: number): Draftable[] {
  // Draft exactly what may be sent. At 3/day in week one, drafting eight would queue five a
  // day he cannot send and would have to scroll past (decision 038).
  const cap = Math.min(limit ?? dailyCap(sendingDays(ctx.db)), MAX_DRAFTS_PER_RUN);
  const rows = ctx.db
    .prepare(
      // A name is only ever used to greet somebody when the *posting* named them. Every
      // other rung yields a role mailbox, and inventing a first name for one is worse than
      // the company greeting it would replace.
      `SELECT j.id AS job_id, j.company_id, c.name AS company, k.id AS contact_id, k.email,
              CASE WHEN k.source = 'posting' THEN k.name END AS contact_name
         FROM jobs j
         JOIN companies c ON c.id = j.company_id
         -- The company's best *live* address, chosen the same way the contacts stage chooses
         -- it. A plain join on company_id was fine while every company had exactly one
         -- contact row; retiring a bounced address (decision 047) means a company can now
         -- have two, and a bare-column GROUP BY would have picked between them arbitrarily —
         -- including picking the dead one.
         JOIN contacts k ON k.id = (
              SELECT id FROM contacts
               WHERE company_id = j.company_id
                 AND mx_valid = 1
                 AND dead_at IS NULL
                 AND confidence IN (${DRAFTABLE_CONFIDENCE.map(() => '?').join(', ')})
               ORDER BY CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id
               LIMIT 1)
        WHERE j.state = 'DRAFTED'
          AND NOT EXISTS (SELECT 1 FROM outreach o WHERE o.job_id = j.id)
          -- The newest score has to still agree this is a match. MATCHED was set by whichever
          -- rubric was current at the time and there is no edge back out of it, so a rubric
          -- change leaves jobs sitting in a live state that the current rubric rejects. The
          -- digest has guarded against this since decision 027; drafting never did, and
          -- drafting is the one that produces an email. Found by the v5 re-score, which left
          -- six DRAFTED jobs scoring 47–65 against a threshold of 70 (decision 045).
          AND ${CURRENT_FIT_SCORE} >= ?
          -- One live conversation per company: a second role where we have already written
          -- is skipped, not queued (decision 038). Ordering by score means the role that
          -- survives is the better one.
          AND NOT ${SUPPRESSED_BY_SIBLING}
        ORDER BY ${CURRENT_FIT_SCORE} DESC,
                 j.first_seen_at DESC
        LIMIT ?`,
    )
    // Over-fetch, because the unpaid filter below runs in JS and a row it drops must not cost
    // the day a draft. `LIMIT cap` then filtering would silently write two emails on a
    // three-a-day ramp. The bound stays finite so a large backlog is not all read into memory.
    .all(...DRAFTABLE_CONFIDENCE, MATCH_THRESHOLD, cap + OVERFETCH_FOR_FILTERS) as {
    job_id: number;
    company_id: number;
    company: string;
    contact_id: number;
    email: string;
    contact_name: string | null;
  }[];

  return rows
    .flatMap((row) => {
      const job = getJob(ctx.db, row.job_id);
      const score = latestScore(ctx.db, row.job_id);
      // A job with no score cannot be written about — the hook comes from the score, and it is
      // the only part of an alert-sourced posting anything has ever read in full.
      if (job === null || score === null) return [];
      return [
        {
          job,
          companyId: row.company_id,
          company: row.company,
          contactId: row.contact_id,
          email: row.email,
          contactName: row.contact_name,
          score,
        },
      ];
    })
    // A posting that says in its own title that it does not pay is not one to apply for, and
    // the digest has held these back since decision 027 — but only the digest did. Two were
    // sitting in `DRAFTED` at 84 with live addresses on 2026-09-08, one of them `high`
    // confidence, and `draftableJobs` was returning it. **The stage that writes the email had
    // the weaker guard**, which is exactly the shape decision 045 found in the score check.
    // Filtered here rather than in SQL so `isUnpaid` stays the one definition: SQLite has no
    // REGEXP and a LIKE list would be a second, drifting copy (the same reasoning as the
    // digest's own filter).
    .filter((item) => !internshipRecommendationExclusion(item.job))
    // One company, one draft a day (decision 038) — applied **before** the cap, not after.
    // `runDraft` has always skipped a company's second role, but it did so downstream of
    // `LIMIT cap`, so two roles at one firm inside the top three cost the day a draft rather
    // than being replaced. Measured 2026-09-08: a cap of 3 produced 2 drafts because 8byte
    // held two of the slots. The same shape as the unpaid filter above — a JS rule downstream
    // of a SQL limit quietly shrinks the batch — which is why both live here now.
    //
    // Rows arrive best-score-first, so the role that survives is the better one, exactly as
    // 038 intended.
    .filter((item, i, all) => all.findIndex((other) => other.companyId === item.companyId) === i)
    .slice(0, cap);
}

/**
 * Extra rows to read so a JS-side filter cannot shrink the day's batch.
 *
 * Only `isUnpaid` filters after the query, and it drops a vanishing fraction of postings — two
 * in 156 — so a handful of spare rows covers it. It is not a correctness bound: if every spare
 * row were also unpaid the run simply drafts fewer, which is the same outcome as the filter
 * being in SQL.
 */
export const OVERFETCH_FOR_FILTERS = 5;

/**
 * Retire `DRAFTED` jobs the pipeline will never act on.
 *
 * `DRAFTED` had no edge out except the gate, so a job the draft stage permanently refuses sat
 * in a live state for ever — counted in every backlog number, re-examined every morning, never
 * written about. Six were in exactly that position after the v5 re-score (decision 045) left
 * them at 47–65 against a threshold of 70, and two more are internships that say in their own
 * title that they do not pay.
 *
 * Two reasons to expire, and the difference between them is the whole care in this function:
 *
 * - **Unpaid** — permanent. The title will not change, and no rubric bump can rescue it.
 * - **Below the threshold under the *current* rubric.** The version check is load-bearing.
 *   `EXPIRED` is terminal, and a rubric bump moves scores a long way: CoinDCX went from 47 to
 *   84 between v4 and v5 (046). Expiring on a score the next re-score is about to replace
 *   would discard a good posting on the strength of an obsolete opinion, which is decision 041
 *   with the consequences pointing the other way. **A job whose newest score predates the
 *   current `PROMPT_VERSION` is left alone** until the re-score reaches it.
 *
 * Never touches a job with an `outreach` row: something is written, and possibly sent, and
 * that is the gate's business rather than this sweep's.
 */
export function expireUnactionable(ctx: StageContext): void {
  const rows = ctx.db
    .prepare(
      `SELECT j.id, j.title, s.fit_score, s.prompt_version
         FROM jobs j
         LEFT JOIN job_scores s ON s.job_id = j.id
                               AND s.prompt_version = (SELECT MAX(prompt_version)
                                                         FROM job_scores WHERE job_id = j.id)
        WHERE j.state = 'DRAFTED'
          AND NOT EXISTS (SELECT 1 FROM outreach o WHERE o.job_id = j.id)`,
    )
    .all() as { id: number; title: string; fit_score: number | null; prompt_version: number | null }[];

  for (const row of rows) {
    const unpaid = isUnpaid(row.title);
    const currentlyRejected =
      row.prompt_version === PROMPT_VERSION && row.fit_score !== null && row.fit_score < MATCH_THRESHOLD;

    if (!unpaid && !currentlyRejected) continue;

    // `EXPIRED` is terminal, and the state machine has no path back on purpose. `dryRun` is
    // documented as "everything except irreversible outside effects", and a DB write is
    // normally inside that line — ingest and scoring both write on a dry run. A transition
    // that cannot be undone without a hand-edit is the exception: this project has needed
    // exactly three of those in its life and each one is recorded in `agenthandoff.md`.
    if (ctx.dryRun) {
      ctx.count('would_expire');
      ctx.log(`would expire "${row.title}"`);
      continue;
    }

    tryTransition(ctx.db, row.id, 'DRAFTED', 'EXPIRED');
    ctx.count(unpaid ? 'expired_unpaid' : 'expired_below_threshold');
    ctx.log(
      unpaid
        ? `expired "${row.title}" — the posting says it does not pay`
        : `expired "${row.title}" — ${row.fit_score} under the current rubric, below ${MATCH_THRESHOLD}`,
    );
  }
}

export type DraftDeps = {
  drafter?: Drafter;
  writeDraft?: DraftWriter;
  profile?: Profile;
  profilePath?: string;
};

/** The draft stage: write today’s allowance of emails into Gmail as drafts. */
export async function runDraft(ctx: StageContext, deps: DraftDeps = {}): Promise<void> {
  let profile: Profile;
  try {
    profile = deps.profile ?? loadProfile(deps.profilePath);
  } catch (err) {
    // Not fatal: the jobs stay in DRAFTED and the next run picks them up.
    ctx.log(err instanceof Error ? err.message : String(err));
    return;
  }

  const drafter = deps.drafter ?? groqDrafter;
  const write = deps.writeDraft ?? createGmailDraft;

  // Before reading the queue, not after: a job this retires is one the queue would have
  // skipped anyway, and clearing it first keeps the backlog number honest.
  expireUnactionable(ctx);

  const jobs = draftableJobs(ctx);

  if (jobs.length === 0) {
    ctx.log('nothing waiting with a contact');
    return;
  }
  ctx.log(`drafting ${jobs.length} with ${drafter.model}`);

  // `draftableJobs` already keeps one role per company, so this should never fire. Kept as a
  // backstop because it costs nothing and the consequence of it being wrong is two cold emails
  // to the same company in one morning (decision 038).
  const writtenTo = new Set<number>();

  for (const item of jobs) {
    if (ctx.signal.aborted) {
      ctx.log('out of time — the rest are drafted next run');
      ctx.count('out_of_time');
      break;
    }

    if (writtenTo.has(item.companyId)) {
      ctx.count('suppressed_sibling');
      ctx.log(`${item.company}: skipping "${item.job.title}" — already writing to them today`);
      continue;
    }

    try {
      const draft = await drafter.compose(
        item.job,
        item.company,
        item.score,
        profile,
        ctx.signal,
        item.contactName,
      );

      if (ctx.dryRun) {
        // Counted against the company here as well as on the real path, or the dry run
        // reports both roles at a two-role company and a real run writes one. A preview that
        // overstates by a sibling is the kind of number that gets believed.
        writtenTo.add(item.companyId);
        ctx.count('would_draft');
        ctx.log(`would draft to ${item.email} — ${draft.subject}`);
        continue;
      }

      // The Gmail draft is created *before* the row is written, deliberately. If this throws,
      // there is no `outreach` row and the job is simply drafted again tomorrow. The reverse
      // order would leave a row claiming a draft that does not exist, and `UNIQUE(job_id)`
      // would then stop the retry that would have fixed it.
      // No `From` header. `data/profile.json` holds his college address, the authorised
      // account is his personal Gmail, and Gmail only honours a `From` that is a verified
      // alias — which cannot even be checked without `gmail.settings.basic`, a scope this
      // project deliberately does not hold (decision 015). Left off, Gmail fills in the
      // account's own address, which is the address that can actually receive the reply.
      const created = await write(
        { to: item.email, subject: draft.subject, body: draft.body },
        ctx.signal,
      );

      ctx.db
        .prepare(
          `INSERT INTO outreach (job_id, contact_id, subject, body, gmail_draft_id,
                                 gmail_message_id, gmail_thread_id, drafted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.job.id,
          item.contactId,
          draft.subject,
          draft.body,
          created.draftId,
          created.messageId,
          created.threadId,
          nowIso(),
        );

      writtenTo.add(item.companyId);
      ctx.count('drafted');
      ctx.log(`${item.company} → ${item.email}: ${draft.subject}`);
    } catch (err) {
      // The job stays in DRAFTED with no outreach row, so tomorrow tries again. A company
      // that fails every day is what the health check is for (decision 026).
      const message = err instanceof Error ? err.message : String(err);
      ctx.count('failed');
      ctx.fault(`${item.company} — ${item.job.title}: ${message}`);
    }
  }
}

/**
 * Rewrite drafts that already exist, in place.
 *
 * The out-of-band path for a prompt change, and the exact counterpart of `score.ts
 * --rescore` (decision 008's mechanism, applied to the other model call). Without it, an
 * improvement to the drafting prompt leaves every email written before it sitting in the
 * folder as the worst ones in the account — and `UNIQUE(job_id)` means the stage will never
 * revisit them, because they already have a row.
 *
 * Never touches a sent email, and never touches state. `outreach.digested_at` is left alone:
 * rewriting the text of a draft is not a reason to announce it again.
 */
export async function redraft(
  dbPath: string,
  opts: { limit?: number; deps?: DraftDeps & { updateDraft?: DraftUpdater } } = {},
): Promise<number> {
  const { openDb } = await import('../store/db.ts');
  const db = openDb(dbPath);
  const profile = opts.deps?.profile ?? loadProfile(opts.deps?.profilePath);
  const drafter = opts.deps?.drafter ?? groqDrafter;
  const update = opts.deps?.updateDraft ?? updateGmailDraft;

  const rows = db
    .prepare(
      `SELECT o.id, o.job_id, o.gmail_draft_id, c.name AS company, k.email,
              CASE WHEN k.source = 'posting' THEN k.name END AS contact_name
         FROM outreach o
         JOIN jobs j ON j.id = o.job_id
         JOIN companies c ON c.id = j.company_id
         JOIN contacts k ON k.id = o.contact_id
        WHERE o.sent_at IS NULL
          AND o.delete_requested_at IS NULL AND o.edit_pending = 0 AND o.archived_at IS NULL
          AND o.approved_at IS NULL
          AND o.gmail_draft_id IS NOT NULL
        ORDER BY o.id
        ${opts.limit === undefined ? '' : 'LIMIT ?'}`,
    )
    .all(...(opts.limit === undefined ? [] : [opts.limit])) as {
    id: number;
    job_id: number;
    gmail_draft_id: string;
    company: string;
    email: string;
    contact_name: string | null;
  }[];

  console.log(`rewriting ${rows.length} unsent draft(s)\n`);
  let rewritten = 0;

  for (const row of rows) {
    const job = getJob(db, row.job_id);
    const score = latestScore(db, row.job_id);
    if (job === null || score === null) continue;

    try {
      const draft = await drafter.compose(job, row.company, score, profile, undefined, row.contact_name);
      await update(row.gmail_draft_id, { to: row.email, subject: draft.subject, body: draft.body });

      db.prepare('UPDATE outreach SET subject = ?, body = ? WHERE id = ?').run(
        draft.subject,
        draft.body,
        row.id,
      );
      rewritten++;
      console.log(`✓ ${row.company} — ${draft.body.split('\n')[0]}`);
    } catch (err) {
      // The old draft stays exactly as it was, which is the safe failure: a worse email is
      // better than a half-rewritten one.
      console.error(`✗ ${row.company}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  db.close();
  console.log(`\n${rewritten} of ${rows.length} rewritten`);
  return rewritten === rows.length ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — read one draft before trusting the stage to write eight
//
//   node src/draft/index.ts --job=5          compose it, print it, write nothing
//   node src/draft/index.ts --redraft        rewrite every unsent draft in place
// ─────────────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  // A hand-typed CLI gets the same `.env` the scheduled runs are given.
  (await import('../env.ts')).loadEnv();

  const { openDb, DEFAULT_DB_PATH } = await import('../store/db.ts');
  const { values } = parseArgs({
    options: {
      job: { type: 'string' },
      redraft: { type: 'boolean', default: false },
      db: { type: 'string', default: DEFAULT_DB_PATH },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || (values.job === undefined && !values.redraft)) {
    console.log('usage: node src/draft/index.ts (--job=<id> | --redraft) [--db=<path>]');
    process.exit(values.help ? 0 : 2);
  }

  if (values.redraft) process.exit(await redraft(values.db));

  const db = openDb(values.db);
  const jobId = Number(values.job);
  const job = getJob(db, jobId);
  const score = latestScore(db, jobId);
  if (job === null || score === null) {
    console.error(`job ${jobId} has no posting or no score`);
    process.exit(2);
  }

  const company = (db.prepare('SELECT name FROM companies WHERE id = ?').get(job.company_id) as
    | { name: string }
    | undefined)?.name ?? '(unknown)';

  const draft: DraftResult = await groqDrafter.compose(job, company, score, loadProfile());
  console.log(`To:      ${company}`);
  console.log(`Subject: ${draft.subject}\n`);
  console.log(draft.body);
  process.exit(0);
}
