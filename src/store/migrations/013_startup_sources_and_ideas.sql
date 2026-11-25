-- A second startup source (Peak XV's portfolio jobs board) and demo ideas (decision 058).
--
-- `startups.source` has a CHECK that names only 'yc', and SQLite cannot alter a CHECK. Its rows
-- have ON DELETE CASCADE children, so the usual copy-drop-rename would cascade-delete them, and a
-- rename rewrites the children's references to the old name. So the startup tables are dropped
-- and recreated, children first.
--
-- That is safe **only because nothing in them is irreplaceable**: on 2026-10-06 when this was
-- written, `startup_outreach` was empty (no draft had been made), and every other row is
-- re-derived by `--discover` and `--contacts` in about two minutes. A migration like this must
-- never be written once `startup_outreach` has rows; it would lose the record of who has been
-- emailed.

DROP TABLE IF EXISTS startup_outreach;
DROP TABLE IF EXISTS startup_contacts;
DROP TABLE IF EXISTS startup_people;
DROP TABLE IF EXISTS startup_roles;
DROP TABLE IF EXISTS startup_updates;
DROP TABLE IF EXISTS startups;

CREATE TABLE startups (
  id                  INTEGER PRIMARY KEY,
  -- yc: the YC directory and company pages · peakxv: Peak XV / Surge's portfolio jobs board
  source              TEXT NOT NULL CHECK (source IN ('yc', 'peakxv')),
  source_id           TEXT NOT NULL,
  name                TEXT NOT NULL,
  website             TEXT,
  domain              TEXT,
  location            TEXT NOT NULL DEFAULT '',
  batch               TEXT NOT NULL DEFAULT '',
  team_size           INTEGER,
  one_liner           TEXT NOT NULL DEFAULT '',
  description         TEXT NOT NULL DEFAULT '',
  tags                TEXT NOT NULL DEFAULT '[]',
  github_url          TEXT,
  source_url          TEXT NOT NULL,
  details_fetched_at  TEXT,
  contacts_checked_at TEXT,
  updates_fetched_at  TEXT,
  -- the demo he built for this startup, once he has; the email links it (058)
  demo_url            TEXT,
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  UNIQUE (source, source_id)
) STRICT;

CREATE TABLE startup_roles (
  id                INTEGER PRIMARY KEY,
  startup_id        INTEGER NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  source_id         TEXT NOT NULL,
  title             TEXT NOT NULL,
  location          TEXT NOT NULL DEFAULT '',
  job_type          TEXT NOT NULL DEFAULT '',
  min_experience    TEXT NOT NULL DEFAULT '',
  salary            TEXT NOT NULL DEFAULT '',
  url               TEXT NOT NULL,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  interview_process TEXT NOT NULL DEFAULT '',
  hiring_manager    TEXT,
  detail_fetched_at TEXT,
  UNIQUE (startup_id, source_id)
) STRICT;

CREATE TABLE startup_people (
  id         INTEGER PRIMARY KEY,
  startup_id INTEGER NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (startup_id, name)
) STRICT;

CREATE TABLE startup_contacts (
  id         INTEGER PRIMARY KEY,
  startup_id INTEGER NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  person_id  INTEGER REFERENCES startup_people(id) ON DELETE SET NULL,
  email      TEXT NOT NULL,
  name       TEXT,
  source     TEXT NOT NULL CHECK (source IN ('published', 'github', 'guess')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  rank       INTEGER NOT NULL,
  found_at   TEXT NOT NULL,
  dead_at    TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (startup_id, email),
  CHECK (source <> 'guess' OR confidence = 'low')
) STRICT;

CREATE TABLE startup_updates (
  id           INTEGER PRIMARY KEY,
  startup_id   INTEGER NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('launch', 'news', 'hn')),
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL,
  published_at TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (startup_id, url)
) STRICT;

-- One set of demo ideas per startup, kept so that asking twice does not spend a second Groq
-- call. `--ideas --regenerate` replaces it.
CREATE TABLE startup_ideas (
  startup_id INTEGER PRIMARY KEY REFERENCES startups(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  model      TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE startup_outreach (
  id             INTEGER PRIMARY KEY,
  startup_id     INTEGER NOT NULL UNIQUE REFERENCES startups(id) ON DELETE CASCADE,
  contact_id     INTEGER NOT NULL REFERENCES startup_contacts(id) ON DELETE RESTRICT,
  role_id        INTEGER REFERENCES startup_roles(id) ON DELETE SET NULL,
  subject        TEXT NOT NULL,
  body           TEXT NOT NULL,
  gmail_draft_id TEXT NOT NULL,
  drafted_at     TEXT NOT NULL,
  sent_at        TEXT,
  checked_at     TEXT
) STRICT;

CREATE INDEX startup_roles_startup_idx ON startup_roles(startup_id);
CREATE INDEX startup_contacts_startup_idx ON startup_contacts(startup_id);
CREATE INDEX startup_updates_startup_idx ON startup_updates(startup_id, published_at);
