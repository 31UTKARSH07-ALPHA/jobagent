-- Initial schema. Mirrors src/store/schema.ts — if the two disagree, that is a bug.
-- STRICT tables so a typo'd type fails loudly instead of being silently coerced.

CREATE TABLE companies (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  -- normalised: lowercase, no scheme, no www. This is the company dedup key.
  domain       TEXT NOT NULL UNIQUE,
  ats_type     TEXT NOT NULL DEFAULT 'none'
                 CHECK (ats_type IN ('greenhouse','lever','ashby','workable','none')),
  ats_slug     TEXT,
  careers_url  TEXT,
  team_url     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE TABLE jobs (
  id                      INTEGER PRIMARY KEY,
  company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- sha256(company_domain + normalise(title) + normalise(location))
  dedup_key               TEXT NOT NULL UNIQUE,
  source                  TEXT NOT NULL
                            CHECK (source IN ('greenhouse','lever','ashby','workable',
                                              'gmail-alert','hackernews','manual')),
  source_id               TEXT,
  url                     TEXT NOT NULL,
  title                   TEXT NOT NULL,
  location                TEXT NOT NULL DEFAULT '',
  description             TEXT NOT NULL DEFAULT '',
  posted_at               TEXT,
  state                   TEXT NOT NULL DEFAULT 'DISCOVERED'
                            CHECK (state IN ('DISCOVERED','SCORED','MATCHED','REJECTED',
                                             'NEEDS_CONTACT','EXPIRED','DRAFTED','AUTO_SEND',
                                             'PENDING_APPROVAL','REJECTED_BY_USER','SENT',
                                             'FOLLOW_UP_SENT','REPLIED','BOUNCED','CLOSED')),
  -- written only by src/store/state.ts
  state_changed_at        TEXT NOT NULL,
  contact_attempts        INTEGER NOT NULL DEFAULT 0,
  last_contact_attempt_at TEXT,
  first_seen_at           TEXT NOT NULL,
  last_seen_at            TEXT NOT NULL
) STRICT;

-- Every stage selects rows by state; this is the hot index.
CREATE INDEX jobs_state_idx        ON jobs(state);
CREATE INDEX jobs_company_idx      ON jobs(company_id);
CREATE INDEX jobs_last_seen_idx    ON jobs(last_seen_at);

CREATE TABLE job_scores (
  job_id         INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- bump to re-score without destroying history (decision 008)
  prompt_version INTEGER NOT NULL,
  fit_score      INTEGER NOT NULL CHECK (fit_score BETWEEN 0 AND 100),
  reasoning      TEXT NOT NULL,
  hook           TEXT NOT NULL,
  model          TEXT NOT NULL,
  scored_at      TEXT NOT NULL,
  PRIMARY KEY (job_id, prompt_version)
) STRICT;

CREATE INDEX job_scores_fit_idx ON job_scores(prompt_version, fit_score);

CREATE TABLE contacts (
  id          INTEGER PRIMARY KEY,
  -- scoped to the company, not the job: the cascade runs once per company
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  title       TEXT,
  source      TEXT NOT NULL CHECK (source IN ('posting','team_page','github','pattern')),
  confidence  TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  mx_valid    INTEGER CHECK (mx_valid IN (0,1)),
  created_at  TEXT NOT NULL,
  -- only posting/team_page may be high; only high may auto-send (invariant 3)
  CHECK (confidence <> 'high' OR source IN ('posting','team_page'))
) STRICT;

CREATE INDEX contacts_company_idx ON contacts(company_id);

CREATE TABLE outreach (
  id                INTEGER PRIMARY KEY,
  -- INVARIANT: one outreach row per job, ever. This makes double-sending structurally
  -- impossible. Do not relax it.
  job_id            INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  contact_id        INTEGER NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  subject           TEXT NOT NULL,
  body              TEXT NOT NULL,
  -- set by drafts.create. Gone from Gmail + still set here = it sent.
  gmail_draft_id    TEXT,
  gmail_message_id  TEXT,
  gmail_thread_id   TEXT,
  drafted_at        TEXT NOT NULL,
  scheduled_send_at TEXT,
  sent_at           TEXT,
  followup_sent_at  TEXT,
  replied_at        TEXT,
  bounced_at        TEXT,
  closed_at         TEXT
) STRICT;

-- The 09:00 sender scans for due, unsent rows.
CREATE INDEX outreach_due_idx ON outreach(scheduled_send_at) WHERE sent_at IS NULL;

CREATE TABLE runs (
  id          INTEGER PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  dry_run     INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0,1)),
  -- JSON: per-stage counters
  stats       TEXT NOT NULL DEFAULT '{}',
  -- JSON: non-empty does not mean the run failed
  errors      TEXT NOT NULL DEFAULT '[]'
) STRICT;
