-- Approval, and the offset of the last Telegram update we have acted on.
--
-- `approved_at` is a column rather than a job state on purpose. The state machine has
-- `PENDING_APPROVAL → SENT`, and approving is not sending: an approved item joins the 09:00
-- queue and leaves at its jittered slot like any other (`docs/architecture.md`). A separate
-- APPROVED state would add an edge that means "waiting, but differently" and would fork the
-- one code path that decision 007 exists to keep single.
--
-- `approval_asked_at` stops the bot asking twice about the same draft every ten minutes.
ALTER TABLE outreach ADD COLUMN approved_at TEXT;
ALTER TABLE outreach ADD COLUMN approval_asked_at TEXT;

-- Telegram's getUpdates is a cursor: it returns everything after an offset and forgets what
-- has been acknowledged. The cursor has to outlive the process, and this project's rule is
-- that state lives in SQLite rather than in a file beside it.
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
