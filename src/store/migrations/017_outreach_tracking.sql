ALTER TABLE outreach ADD COLUMN send_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(send_confirmed IN (0,1));
ALTER TABLE applications ADD COLUMN recipient TEXT;
CREATE TABLE outreach_outcomes (
  outreach_id INTEGER PRIMARY KEY REFERENCES outreach(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK(outcome IN ('Awaiting Response','Replied','Interested','Interview Scheduled','Not Interested','No Response','Bounced')),
  recorded_at TEXT NOT NULL
) STRICT;
CREATE TABLE outreach_followups (
  id INTEGER PRIMARY KEY,
  outreach_id INTEGER NOT NULL REFERENCES outreach(id) ON DELETE CASCADE,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('Open','Snoozed','Completed')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT,
  completed_at TEXT
) STRICT;
CREATE INDEX outreach_followups_message ON outreach_followups(outreach_id);
CREATE TABLE outreach_activity (
  id INTEGER PRIMARY KEY,
  outreach_id INTEGER NOT NULL REFERENCES outreach(id) ON DELETE CASCADE,
  followup_id INTEGER REFERENCES outreach_followups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual','integration','system','legacy')),
  detail TEXT
) STRICT;
CREATE INDEX outreach_activity_message ON outreach_activity(outreach_id);
-- Existing follow-up dates have no creation timestamp. Preserve the dates without inventing one.
INSERT INTO outreach_followups(outreach_id,due_date,status)
SELECT id,substr(follow_up_at,1,10),'Open' FROM outreach WHERE follow_up_at IS NOT NULL;
INSERT INTO outreach_activity(outreach_id,kind,at,source)
SELECT id,'Draft created',drafted_at,'legacy' FROM outreach
UNION ALL SELECT id,'Approved',approved_at,'legacy' FROM outreach WHERE approved_at IS NOT NULL
UNION ALL SELECT id,'Sent',sent_at,'legacy' FROM outreach WHERE sent_at IS NOT NULL
UNION ALL SELECT id,'Reply recorded',replied_at,'legacy' FROM outreach WHERE replied_at IS NOT NULL;
CREATE TRIGGER outreach_created_activity AFTER INSERT ON outreach BEGIN
  INSERT INTO outreach_activity(outreach_id,kind,at,source) VALUES(NEW.id,'Draft created',NEW.drafted_at,'system');
END;
CREATE TRIGGER outreach_changed_activity AFTER UPDATE ON outreach BEGIN
  INSERT INTO outreach_activity(outreach_id,kind,at,source)
  SELECT NEW.id,'Draft edited',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'manual' WHERE NEW.revision>OLD.revision
  UNION ALL SELECT NEW.id,'Approved',NEW.approved_at,'manual' WHERE OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL
  UNION ALL SELECT NEW.id,'Sent',NEW.sent_at,'integration' WHERE OLD.sent_at IS NULL AND NEW.sent_at IS NOT NULL AND NEW.send_confirmed = 1
  UNION ALL SELECT NEW.id,'Sent',NEW.sent_at,'legacy' WHERE OLD.sent_at IS NULL AND NEW.sent_at IS NOT NULL AND NEW.send_confirmed = 0
  UNION ALL SELECT NEW.id,'Reply recorded',NEW.replied_at,'integration' WHERE OLD.replied_at IS NULL AND NEW.replied_at IS NOT NULL;
END;
