CREATE TABLE applications (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
) STRICT;

ALTER TABLE outreach ADD COLUMN application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL;
ALTER TABLE outreach ADD COLUMN recipient_override TEXT;
ALTER TABLE outreach ADD COLUMN local_subject TEXT;
ALTER TABLE outreach ADD COLUMN local_body TEXT;
ALTER TABLE outreach ADD COLUMN archived_at TEXT;
ALTER TABLE outreach ADD COLUMN follow_up_at TEXT;
ALTER TABLE outreach ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outreach ADD COLUMN edit_pending INTEGER NOT NULL DEFAULT 0 CHECK (edit_pending IN (0,1));
