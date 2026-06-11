-- Recently opened sessions drive daemon lazy-backfill priority. This is a
-- sync hint, not a user preference, so keep it out of session_prefs.

CREATE TABLE IF NOT EXISTS session_open_hints (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  last_opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_session_open_hints_user_device
  ON session_open_hints(user_id, device_id);
