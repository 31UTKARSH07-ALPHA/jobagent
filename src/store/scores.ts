/**
 * `job_scores` reads and writes.
 *
 * Rows are keyed on `(job_id, prompt_version)` so changing the rubric never destroys
 * score history (decision 008). Nothing here ever updates an existing row: a re-run with
 * the same prompt version is a no-op, and a *changed* rubric is a new version that sits
 * beside the old one so the two distributions can be compared before thresholds move.
 */
import type { Db } from './db.ts';
import { JobScore, nowIso, type ScoreResult } from './schema.ts';

/** True when this job has already been scored under this rubric version. */
export function hasScore(db: Db, jobId: number, promptVersion: number): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM job_scores WHERE job_id = ? AND prompt_version = ?')
    .get(jobId, promptVersion);
  return row !== undefined;
}

/** This job’s score under one specific rubric version. */
export function getScore(db: Db, jobId: number, promptVersion: number): JobScore | null {
  const row = db
    .prepare('SELECT * FROM job_scores WHERE job_id = ? AND prompt_version = ?')
    .get(jobId, promptVersion);
  return row === undefined ? null : JobScore.parse(row);
}

/**
 * The highest-versioned score for a job — what the digest and the drafter want, since
 * they care about the current rubric, not the history.
 */
export function latestScore(db: Db, jobId: number): JobScore | null {
  const row = db
    .prepare('SELECT * FROM job_scores WHERE job_id = ? ORDER BY prompt_version DESC LIMIT 1')
    .get(jobId);
  return row === undefined ? null : JobScore.parse(row);
}

/**
 * Persist a score. Returns false when a row for `(job_id, prompt_version)` already
 * existed — the caller re-ran, and the earlier score stands.
 *
 * `fitScore` is passed in rather than read off `result`: the model rates factors and
 * `src/match/score.ts` owns the arithmetic (decision 012).
 */
export function insertScore(
  db: Db,
  jobId: number,
  promptVersion: number,
  fitScore: number,
  result: ScoreResult,
  model: string,
): boolean {
  const { changes } = db
    .prepare(
      `INSERT INTO job_scores (job_id, prompt_version, fit_score, level_fit, location_fit,
                               stack_fit, domain_fit, reasoning, hook, model, scored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (job_id, prompt_version) DO NOTHING`,
    )
    .run(
      jobId,
      promptVersion,
      fitScore,
      result.level_fit,
      result.location_fit,
      result.stack_fit,
      result.domain_fit,
      result.reasoning,
      result.hook,
      model,
      nowIso(),
    );
  return Number(changes) === 1;
}

/** The model's half of a stored row, so a resumed run can finish without re-asking. */
export const factorsOf = (score: JobScore): ScoreResult => ({
  level_fit: score.level_fit,
  location_fit: score.location_fit,
  stack_fit: score.stack_fit,
  domain_fit: score.domain_fit,
  reasoning: score.reasoning,
  hook: score.hook,
});

export type ScoreDistribution = {
  promptVersion: number;
  total: number;
  min: number;
  max: number;
  median: number;
  /** Counts per 10-point band, `0`–`9` … `90`–`100`. Index = band start / 10. */
  bands: number[];
};

/**
 * The numbers the calibration gate needs (decision 008): three days of scoring, then look
 * at the real spread before committing to a MATCHED threshold.
 */
export function scoreDistribution(db: Db, promptVersion: number): ScoreDistribution | null {
  const rows = db
    .prepare('SELECT fit_score FROM job_scores WHERE prompt_version = ? ORDER BY fit_score')
    .all(promptVersion) as { fit_score: number }[];

  if (rows.length === 0) return null;

  const scores = rows.map((r) => r.fit_score);
  const bands = Array<number>(10).fill(0);
  for (const s of scores) bands[Math.min(Math.floor(s / 10), 9)]!++;

  const mid = Math.floor(scores.length / 2);
  const median =
    scores.length % 2 === 1 ? scores[mid]! : Math.round((scores[mid - 1]! + scores[mid]!) / 2);

  return {
    promptVersion,
    total: scores.length,
    min: scores[0]!,
    max: scores[scores.length - 1]!,
    median,
    bands,
  };
}

/**
 * SQL for a job's **current** score: the one written under the highest `prompt_version`.
 *
 * Not `MAX(fit_score)`. The two read the same on a job scored once and diverge exactly where
 * it matters — a job whose rubric has since been tightened. Lakkshions It scored **100 under
 * v2 and 84 under v4**, and a gate reading the maximum cleared a title-only posting to
 * auto-send on the strength of a rubric that decision 023 replaced precisely because it
 * over-scored postings with no description.
 *
 * `job_scores` is keyed on `prompt_version` to keep history for comparison (decision 008);
 * history is not an alternative opinion to choose the best of. The digest has always taken
 * the newest score, and this is that rule, written once, for every caller.
 *
 * Correlates on `j.id`, so the query it lands in must expose the jobs table as `j`.
 */
export const CURRENT_FIT_SCORE = `(
  SELECT s.fit_score FROM job_scores s
   WHERE s.job_id = j.id
   ORDER BY s.prompt_version DESC
   LIMIT 1
)`;
