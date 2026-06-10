-- Per-user UI preferences for sessions and projects (pin / archive / rename).
-- Kept in SEPARATE tables (not columns on sessions): the daemon's catalog sync
-- upserts/overwrites session rows wholesale, so prefs stored there would be
-- clobbered on every sync. These tables are written only by the web.

CREATE TABLE IF NOT EXISTS session_prefs (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  custom_title TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, session_id)
);

-- Projects are identified by (device_id, cwd) — same grouping the sidebar uses.
CREATE TABLE IF NOT EXISTS project_prefs (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  custom_label TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, cwd)
);

CREATE INDEX IF NOT EXISTS idx_session_prefs_user
  ON session_prefs(user_id);

CREATE INDEX IF NOT EXISTS idx_project_prefs_user
  ON project_prefs(user_id);
