/**
 * What the digest stage reads and writes.
 *
 * A digest item is a job, its company's name, and its score — three tables, one row per
 * thing the morning message talks about.
 */
import type { Db } from './db.ts';
import { Job, JobScore, nowIso } from './schema.ts';
import { MATCH_THRESHOLD } from '../match/score.ts';
import { isUnpaid } from '../ingest/filter.ts';

export type DigestItem = {
  job: Job;
  /** Company name; the digest never shows a bare domain. */
  company: string;
  score: JobScore;
};

/**
 * Matched jobs that have never been reported, best first.
 *
 * `digested_at IS NULL` is the whole idempotency story: a second run in the same morning
 * finds nothing, because the first run marked what it sent (invariant 4).
 *
 * **State is filtered by what it is not.** This asked for `state = 'MATCHED'` until the
 * contacts stage arrived and moved 67 jobs to `DRAFTED` and 10 to `NEEDS_CONTACT` — at which
 * point 52 undigested matches would have vanished from the next morning's digest with no
 * error anywhere, which is this project's signature failure. Excluding the states that mean
 * "no longer a live match" fails in the safe direction: a state added to the machine later
 * shows up in the digest rather than silently disappearing from it.
 *
 * **Each job's highest `prompt_version`, not a pinned one.** Pinning the current version looked
 * tidier and quietly broke on the first rubric bump: a job scored under v2 and matched but not
 * yet reported would stop joining, and would never be reported at all. Taking the latest score
 * per job means a bump changes what the digest *says* about a job, never whether it appears.
 */
export function pendingDigestItems(
  db: Db,
  limit?: number,
  threshold: number = MATCH_THRESHOLD,
): DigestItem[] {
  const rows = db
    .prepare(
      `SELECT j.*, c.name AS company_name, s.*
         FROM jobs j
         JOIN companies c ON c.id = j.company_id
         JOIN job_scores s ON s.job_id = j.id
        WHERE j.state NOT IN ('DISCOVERED', 'SCORED', 'REJECTED', 'EXPIRED', 'REJECTED_BY_USER')
          AND j.digested_at IS NULL
          AND s.prompt_version = (
            SELECT MAX(prompt_version) FROM job_scores WHERE job_id = j.id
          )
          -- The newest score has to still agree that this is a match. MATCHED was set by
          -- whichever rubric was current when the job was scored, and the state machine has
          -- no edge back out of it: REJECTED is terminal, so there is deliberately no path
          -- from MATCHED to it. A rubric change therefore leaves jobs sitting in MATCHED
          -- that the current rubric would reject -- after v4, most of a 33-job backlog --
          -- and reporting those is exactly the useless-suggestions failure the rubric change
          -- was made to prevent (decision 023).
          AND s.fit_score >= ?
        -- Newest first within a tie, which is the opposite of what this used to do.
        -- 57 of 90 v4 scores land on exactly 84 (024), and with a 46-job backlog against
        -- MAX_ITEMS_PER_DIGEST of 10 that tie decides five days of digests. Oldest-first sent
        -- a posting found today to the back of that queue — and an internship found five days
        -- ago may well be closed (decision 027).
        ORDER BY s.fit_score DESC, j.first_seen_at DESC
        ${limit === undefined ? '' : 'LIMIT ?'}`,
    )
    .all(...(limit === undefined ? [threshold] : [threshold, limit])) as Record<string, unknown>[];

  // `SELECT j.*, s.*` collides on job_id/prompt_version only, and both schemas are parsed
  // from the same flat row — Zod ignores the extra keys each one does not want.
  return (
    rows
      .map((row) => ({
        job: Job.parse(row),
        company: String(row['company_name']),
        score: JobScore.parse(row),
      }))
      // Unpaid postings are rejected at ingest from now on, but the ones already stored have
      // to be held back too, and REJECTED is terminal so their state cannot be walked back
      // (027). Filtered here rather than in SQL so `isUnpaid` stays the only definition —
      // SQLite has no REGEXP, and a LIKE list would be a second, drifting copy.
      .filter((item) => !isUnpaid(item.job.title))
  );
}

/** Mark jobs as reported. Called only after the message is actually out. */
export function markDigested(db: Db, jobIds: number[]): void {
  const at = nowIso();
  const stmt = db.prepare('UPDATE jobs SET digested_at = ? WHERE id = ? AND digested_at IS NULL');
  for (const id of jobIds) stmt.run(at, id);
}
