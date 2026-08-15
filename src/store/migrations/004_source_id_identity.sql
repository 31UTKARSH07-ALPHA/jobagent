-- A source's own id for a posting is its identity. Use it before any similarity heuristic.
--
-- `dedup_key` hashes domain + title + location, which is the only thing that can match the
-- same role *across* sources — a Greenhouse posting and the LinkedIn alert about it. But
-- within one source it is too strict: LinkedIn mailed job 4449869353 twice on 2026-08-16,
-- writing the location as "Bengaluru" in one email and "Bengaluru, Karnataka, India" in the
-- other. Same posting, two hashes, two rows — and a duplicate costs a 67-second scoring call
-- and shows the same job twice in the morning digest. See decision 021.
--
-- The index is not UNIQUE on purpose: `source_id` is nullable, and a partial unique index
-- would make an ingest run *fail* on a duplicate rather than absorb it. Ingest must never
-- fail on data it can simply recognise.

CREATE INDEX jobs_source_id_idx ON jobs(source, source_id);

-- Repair the rows that already exist. Keep the earliest of each duplicate set: it is the one
-- with the truthful `first_seen_at`, and any downstream row points at it.
--
-- Deliberately conservative — a job that has been scored, or that anything in `outreach`
-- refers to, is left alone. Losing an audit trail to tidy up a duplicate is a bad trade, and
-- the scorer skips jobs that already carry a score anyway.
DELETE FROM jobs
WHERE source_id IS NOT NULL
  AND source_id <> ''
  AND id NOT IN (SELECT MIN(id) FROM jobs WHERE source_id IS NOT NULL AND source_id <> ''
                 GROUP BY source, source_id)
  AND id NOT IN (SELECT job_id FROM job_scores)
  AND id NOT IN (SELECT job_id FROM outreach);
