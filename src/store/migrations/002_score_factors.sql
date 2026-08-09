-- The scorer stops choosing a holistic 0-100 number and instead rates four narrow factors
-- 0-10; `fit_score` becomes arithmetic done in src/match/score.ts. Decision 012.
--
-- The factor columns are NOT NULL, which SQLite cannot add to an existing table, so the
-- table is rebuilt. The rows this drops were produced by the rubric being replaced, and
-- they are re-derivable — re-running `--stage=score` scores whatever is in DISCOVERED.
-- There is no production data anywhere; scoring first ran on 2026-08-10.

DROP INDEX job_scores_fit_idx;
DROP TABLE job_scores;

CREATE TABLE job_scores (
  job_id         INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- bump to re-score without destroying history (decision 008)
  prompt_version INTEGER NOT NULL,
  -- computed from the four factors, never taken from the model (decision 012)
  fit_score      INTEGER NOT NULL CHECK (fit_score BETWEEN 0 AND 100),
  level_fit      INTEGER NOT NULL CHECK (level_fit BETWEEN 0 AND 10),
  location_fit   INTEGER NOT NULL CHECK (location_fit BETWEEN 0 AND 10),
  stack_fit      INTEGER NOT NULL CHECK (stack_fit BETWEEN 0 AND 10),
  domain_fit     INTEGER NOT NULL CHECK (domain_fit BETWEEN 0 AND 10),
  reasoning      TEXT NOT NULL,
  hook           TEXT NOT NULL,
  model          TEXT NOT NULL,
  scored_at      TEXT NOT NULL,
  PRIMARY KEY (job_id, prompt_version)
) STRICT;

CREATE INDEX job_scores_fit_idx ON job_scores(prompt_version, fit_score);
