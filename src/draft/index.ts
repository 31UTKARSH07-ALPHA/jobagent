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
import { latestScore } from '../store/scores.ts';
import { nowIso, type Job, type JobScore, type Profile } from '../store/schema.ts';
import { loadProfile } from '../match/profile.ts';
import { groqDrafter, type Drafter, type DraftResult } from './compose.ts';
import { createGmailDraft, type DraftWriter } from './gmail-draft.ts';

/**
 * Drafts written in one run.
 *
 * A reading limit, like `MAX_ITEMS_PER_DIGEST`: these exist to be reviewed one at a time over
 * breakfast, and a morning that produces thirty of them produces none that get read. The rest
 * keep their state and are drafted tomorrow, costing nothing.
 */
export const MAX_DRAFTS_PER_RUN = 8;

/** A job ready to be written about, with everything the composer needs. */
type Draftable = { job: Job; company: string; contactId: number; email: string; score: JobScore };

/**
 * Jobs in `DRAFTED` with a contact and no `outreach` row yet, best score first.
 *
 * Same ordering as the digest, and for the same reason (decision 027): 57 of 90 scores tie at
 * exactly 84, so within a tie the newest posting wins — an internship found five days ago may
 * already be closed.
 */
export function draftableJobs(ctx: StageContext, limit = MAX_DRAFTS_PER_RUN): Draftable[] {
  const rows = ctx.db
    .prepare(
      `SELECT j.id AS job_id, c.name AS company, k.id AS contact_id, k.email
         FROM jobs j
         JOIN companies c ON c.id = j.company_id
         JOIN contacts k ON k.company_id = j.company_id
        WHERE j.state = 'DRAFTED'
          AND k.mx_valid = 1
          AND NOT EXISTS (SELECT 1 FROM outreach o WHERE o.job_id = j.id)
        GROUP BY j.id
        ORDER BY (SELECT MAX(s.fit_score) FROM job_scores s WHERE s.job_id = j.id) DESC,
                 j.first_seen_at DESC
        LIMIT ?`,
    )
    .all(limit) as { job_id: number; company: string; contact_id: number; email: string }[];

  return rows.flatMap((row) => {
    const job = getJob(ctx.db, row.job_id);
    const score = latestScore(ctx.db, row.job_id);
    // A job with no score cannot be written about — the hook comes from the score, and it is
    // the only part of an alert-sourced posting anything has ever read in full.
    if (job === null || score === null) return [];
    return [{ job, company: row.company, contactId: row.contact_id, email: row.email, score }];
  });
}

export type DraftDeps = {
  drafter?: Drafter;
  writeDraft?: DraftWriter;
  profile?: Profile;
  profilePath?: string;
};

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
  const jobs = draftableJobs(ctx);

  if (jobs.length === 0) {
    ctx.log('nothing waiting with a contact');
    return;
  }
  ctx.log(`drafting ${jobs.length} with ${drafter.model}`);

  for (const item of jobs) {
    if (ctx.signal.aborted) {
      ctx.log('out of time — the rest are drafted next run');
      ctx.count('out_of_time');
      break;
    }

    try {
      const draft = await drafter.compose(item.job, item.company, item.score, profile, ctx.signal);

      if (ctx.dryRun) {
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

// ─────────────────────────────────────────────────────────────────────────────
// CLI — read one draft before trusting the stage to write eight
//
//   node src/draft/index.ts --job=5          compose it, print it, write nothing
// ─────────────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const { openDb, DEFAULT_DB_PATH } = await import('../store/db.ts');
  const { values } = parseArgs({
    options: {
      job: { type: 'string' },
      db: { type: 'string', default: DEFAULT_DB_PATH },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || values.job === undefined) {
    console.log('usage: node src/draft/index.ts --job=<id> [--db=<path>]');
    process.exit(values.help ? 0 : 2);
  }

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
