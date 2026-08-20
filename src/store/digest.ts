/**
 * What the digest stage reads and writes.
 *
 * A digest item is a job, its company's name, and its score — three tables, one row per
 * thing the morning message talks about.
 */
import type { Db } from './db.ts';
import { Job, JobScore, nowIso } from './schema.ts';
import { MATCH_THRESHOLD } from '../match/score.ts';

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
        WHERE j.state = 'MATCHED'
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
        ORDER BY s.fit_score DESC, j.first_seen_at
        ${limit === undefined ? '' : 'LIMIT ?'}`,
    )
    .all(...(limit === undefined ? [threshold] : [threshold, limit])) as Record<string, unknown>[];

  // `SELECT j.*, s.*` collides on job_id/prompt_version only, and both schemas are parsed
  // from the same flat row — Zod ignores the extra keys each one does not want.
  return rows.map((row) => ({
    job: Job.parse(row),
    company: String(row['company_name']),
    score: JobScore.parse(row),
  }));
}

/** Mark jobs as reported. Called only after the message is actually out. */
export function markDigested(db: Db, jobIds: number[]): void {
  const at = nowIso();
  const stmt = db.prepare('UPDATE jobs SET digested_at = ? WHERE id = ? AND digested_at IS NULL');
  for (const id of jobIds) stmt.run(at, id);
}
