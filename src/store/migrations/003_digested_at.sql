-- When this job appeared in a match digest. NULL = never reported.
--
-- This is what makes the digest stage idempotent (invariant 4): running the pipeline twice
-- in a morning must not send the same job twice. It is deliberately not a job state — being
-- told about a job changes nothing about the job, and the state machine already has one
-- terminal path per real outcome.
--
-- Phase 2 shows drafts in the digest as well; those will need their own marker on
-- `outreach`, because a job can legitimately be reported once as a match and again as a
-- draft awaiting approval.

ALTER TABLE jobs ADD COLUMN digested_at TEXT;

CREATE INDEX jobs_digest_idx ON jobs(state, digested_at);
