-- Startup prospecting: early-stage companies and their founders, kept apart from the job
-- pipeline on purpose (decision 056).
--
-- The job pipeline starts from a *posting* and walks it through `jobs.state`. This starts from
-- a *company* — a seed or Series A startup that is hiring — and ends at a founder's inbox.
-- Mixing the two would mean synthetic "jobs" with no posting, scores from a rubric that was
-- never asked about a company, and approvals in the same Telegram queue as real applications.
-- So nothing here references `jobs`, `contacts` or `outreach`, and no stage of the daily
-- pipeline reads these tables. The one deliberate crossing is read-only: before drafting, the
-- startup CLI checks that the job pipeline has not already written to the same company.

CREATE TABLE startups (
  id                 INTEGER PRIMARY KEY,
  -- where the company was found; one source today, the column is there for the next one
  source             TEXT NOT NULL CHECK (source IN ('yc')),
  -- the company's id at its source, e.g. the YC slug `bolna-ai`
  source_id          TEXT NOT NULL,
  name               TEXT NOT NULL,
  website            TEXT,
  -- normalised like companies.domain; NULL when the source gave no usable website
  domain             TEXT,
  location           TEXT NOT NULL DEFAULT '',
  batch              TEXT NOT NULL DEFAULT '',
  team_size          INTEGER,
  one_liner          TEXT NOT NULL DEFAULT '',
  description        TEXT NOT NULL DEFAULT '',
  -- JSON array of the source's tags ("Artificial Intelligence", "B2B", ...)
  tags               TEXT NOT NULL DEFAULT '[]',
  github_url         TEXT,
  source_url         TEXT NOT NULL,
  -- when the company page (founders, open roles) was last read; NULL = never
  details_fetched_at TEXT,
  first_seen_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  UNIQUE (source, source_id)
) STRICT;

CREATE TABLE startup_roles (
  id             INTEGER PRIMARY KEY,
  startup_id     INTEGER NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  source_id      TEXT NOT NULL,
  title          TEXT NOT NULL,
  location       TEXT NOT NULL DEFAULT '',
  job_type       TEXT NOT NULL DEFAULT '',
  min_experience TEXT NOT NULL DEFAULT '',
  -- as the source printed it, e.g. "₹800K - ₹2M INR". Parsed only for ranking.
  salary         TEXT NOT NULL DEFAULT '',
  url            TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL,
  -- a role not seen on the latest fetch of its company page has closed
  last_seen_at   TEXT NOT NULL,
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
  -- the founder this address belongs to; NULL for a role address like hello@
  person_id  INTEGER REFERENCES startup_people(id) ON DELETE SET NULL,
  email      TEXT NOT NULL,
  -- the person's name exactly as the source listed it; NULL for a role address
  name       TEXT,
  -- published: printed on the company's own site · github: a founder's own commits ·
  -- guess: built from the founder's name and the company's address pattern
  source     TEXT NOT NULL CHECK (source IN ('published', 'github', 'guess')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  -- higher is better within one startup; never compared across startups
  rank       INTEGER NOT NULL,
  found_at   TEXT NOT NULL,
  -- set by hand or by a bounce; a dead address is never drafted again
  dead_at    TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (startup_id, email),
  -- a guess is a guess, however good the pattern behind it
  CHECK (source <> 'guess' OR confidence = 'low')
) STRICT;

-- When the contact search last ran for a startup, found or not, so a startup with nothing
-- findable is not re-searched every run.
ALTER TABLE startups ADD COLUMN contacts_checked_at TEXT;

CREATE TABLE startup_outreach (
  id             INTEGER PRIMARY KEY,
  -- one email per startup, ever: the same backstop as outreach's UNIQUE(job_id)
  startup_id     INTEGER NOT NULL UNIQUE REFERENCES startups(id) ON DELETE CASCADE,
  contact_id     INTEGER NOT NULL REFERENCES startup_contacts(id) ON DELETE RESTRICT,
  role_id        INTEGER REFERENCES startup_roles(id) ON DELETE SET NULL,
  subject        TEXT NOT NULL,
  body           TEXT NOT NULL,
  gmail_draft_id TEXT NOT NULL,
  drafted_at     TEXT NOT NULL,
  -- this module never sends. Utkarsh sends from Gmail; `--status` reads the label back.
  sent_at        TEXT,
  checked_at     TEXT
) STRICT;

CREATE INDEX startup_roles_startup_idx ON startup_roles(startup_id);
CREATE INDEX startup_contacts_startup_idx ON startup_contacts(startup_id);
