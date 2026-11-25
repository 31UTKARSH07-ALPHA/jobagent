CREATE TABLE dashboard_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL
) STRICT;

CREATE TABLE dashboard_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES dashboard_owner(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX dashboard_sessions_expiry ON dashboard_sessions(expires_at);

CREATE TABLE dashboard_auth_limits (
  action TEXT PRIMARY KEY CHECK (action IN ('login', 'signup')),
  window_ends_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
) STRICT;
