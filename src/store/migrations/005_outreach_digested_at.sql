-- When this draft was shown in a digest. NULL = never shown.
--
-- Migration 003 predicted this column and said why: "a job can legitimately be reported once
-- as a match and again as a draft awaiting approval". Phase 2 made it necessary rather than
-- hypothetical. `jobs.digested_at` reports a job once, ever — so a job reported as a match on
-- Monday and drafted on Thursday would have its draft written and never shown to anybody.
-- With a 67-job backlog against 8 drafts a run, that is most drafts.
--
-- Same idiom as `jobs.digested_at` and for the same reason: set only after Telegram has
-- accepted the message, so a failed send leaves the drafts unreported and tomorrow retries.

ALTER TABLE outreach ADD COLUMN digested_at TEXT;

CREATE INDEX outreach_digest_idx ON outreach(digested_at);
