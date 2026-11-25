-- A deletion intent blocks reconciliation while Gmail removes the unsent draft.
-- Keep the outreach row so the same role isn't drafted again.
ALTER TABLE outreach ADD COLUMN delete_requested_at TEXT;
