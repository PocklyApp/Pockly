-- Cursor log for incremental session catalog sync. This is a short metadata
-- feed for browsers; transcript content remains in session_turns or on the
-- local daemon.

CREATE TABLE IF NOT EXISTS session_catalog_changes (
  change_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  session_row TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_catalog_changes_user_cursor
  ON session_catalog_changes(user_id, change_id);
