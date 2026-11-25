-- What he reads before any startup email is drafted: the role in full, and what the company
-- shipped most recently (decision 057).
--
-- The listing on a company page carries a title, a location and a salary. The description,
-- the interview process and the hiring manager are only on the job's own page, so they are
-- fetched separately — once per role, when it is first briefed, and again after a week.

ALTER TABLE startup_roles ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE startup_roles ADD COLUMN interview_process TEXT NOT NULL DEFAULT '';
-- the name YC shows as the role's hiring manager; NULL when it shows none
ALTER TABLE startup_roles ADD COLUMN hiring_manager TEXT;
ALTER TABLE startup_roles ADD COLUMN detail_fetched_at TEXT;

-- One row per dated thing the company shipped or was written about: a YC launch post, a press
-- item YC links, or a Hacker News story about its site. Kept with its date because a 2023
-- launch is not "what they are working on" — Rivet's says multiplayer games; its product now
-- is stateful workloads.
CREATE TABLE startup_updates (
  id           INTEGER PRIMARY KEY,
  startup_id   INTEGER NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('launch', 'news', 'hn')),
  title        TEXT NOT NULL,
  -- a launch's tagline and opening paragraph; empty for news and HN
  summary      TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL,
  published_at TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (startup_id, url)
) STRICT;

CREATE INDEX startup_updates_startup_idx ON startup_updates(startup_id, published_at);

-- When Hacker News was last asked about this startup. NULL = never.
ALTER TABLE startups ADD COLUMN updates_fetched_at TEXT;
