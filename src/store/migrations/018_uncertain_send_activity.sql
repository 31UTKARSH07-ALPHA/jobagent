-- An ambiguous send still occupies its ledger slot for deduplication, but it is not a confirmed event.
DROP TRIGGER outreach_changed_activity;
CREATE TRIGGER outreach_changed_activity AFTER UPDATE ON outreach BEGIN
  INSERT INTO outreach_activity(outreach_id,kind,at,source)
  SELECT NEW.id,'Draft edited',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'manual' WHERE NEW.revision>OLD.revision
  UNION ALL SELECT NEW.id,'Approved',NEW.approved_at,'manual' WHERE OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL
  UNION ALL SELECT NEW.id,'Sent',NEW.sent_at,'integration' WHERE OLD.sent_at IS NULL AND NEW.sent_at IS NOT NULL AND NEW.send_confirmed = 1
  UNION ALL SELECT NEW.id,'Send status uncertain',NEW.sent_at,'system' WHERE OLD.sent_at IS NULL AND NEW.sent_at IS NOT NULL AND NEW.send_confirmed = 0
  UNION ALL SELECT NEW.id,'Reply recorded',NEW.replied_at,'integration' WHERE OLD.replied_at IS NULL AND NEW.replied_at IS NOT NULL;
END;
