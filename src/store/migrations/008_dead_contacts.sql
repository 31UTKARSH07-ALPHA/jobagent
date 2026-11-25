-- Persist evidence that a contact is dead and where it was found.
ALTER TABLE contacts ADD COLUMN dead_at TEXT;
ALTER TABLE contacts ADD COLUMN dead_reason TEXT;
ALTER TABLE contacts ADD COLUMN found_at TEXT;
