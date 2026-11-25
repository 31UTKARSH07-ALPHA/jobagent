-- When a startup role was announced on Telegram (decision 059). NULL = not yet.
--
-- His split, 2026-10-06: Telegram carries the short list of startup *roles*, one line each;
-- briefs and demo ideas stay in files. Kept on the role rather than the startup so a company
-- that posts a second role gets a second line.
ALTER TABLE startup_roles ADD COLUMN notified_at TEXT;
