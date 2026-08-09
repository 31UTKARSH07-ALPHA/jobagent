/**
 * What the digest stage reads and writes.
 *
 * A digest item is a job, its company's name, and its score — three tables, one row per
 * thing the morning message talks about.
 */
import type { Db } from './db.ts';
import { Job, JobScore, nowIso } from './schema.ts';

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
 * Restricted to `prompt_version` so a rubric bump does not resurface jobs already reported —
 * their old score row is still there, but it is not the current one.
 */
export function pendingDigestItems(
  db: Db,
  promptVersion: number,
  limit?: number,
): DigestItem[] {
  const rows = db
    .prepare(
      `SELECT j.*, c.name AS company_name, s.*
         FROM jobs j
         JOIN companies c ON c.id = j.company_id
         JOIN job_scores s ON s.job_id = j.id AND s.prompt_version = ?
        WHERE j.state = 'MATCHED' AND j.digested_at IS NULL
        ORDER BY s.fit_score DESC, j.first_seen_at
        ${limit === undefined ? '' : 'LIMIT ?'}`,
    )
    .all(...(limit === undefined ? [promptVersion] : [promptVersion, limit])) as Record<
    string,
    unknown
  >[];

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
