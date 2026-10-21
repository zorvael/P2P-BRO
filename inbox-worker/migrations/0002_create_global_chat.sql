CREATE TABLE IF NOT EXISTS global_users (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  nickname_key TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  gender TEXT NOT NULL,
  country TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS global_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS global_sessions_expiry ON global_sessions (expires_at);
CREATE INDEX IF NOT EXISTS global_sessions_user ON global_sessions (user_id);

CREATE TABLE IF NOT EXISTS global_auth_attempts (
  nickname_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS global_auth_attempts_window ON global_auth_attempts (nickname_key, created_at);

CREATE TABLE IF NOT EXISTS global_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS global_messages_created ON global_messages (created_at, id);
CREATE INDEX IF NOT EXISTS global_messages_user_created ON global_messages (user_id, created_at);

CREATE TABLE IF NOT EXISTS global_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (reporter_id, message_id)
);
CREATE INDEX IF NOT EXISTS global_reports_created ON global_reports (created_at);

CREATE TABLE IF NOT EXISTS global_blocks (
  user_id TEXT NOT NULL,
  blocked_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_user_id)
);
