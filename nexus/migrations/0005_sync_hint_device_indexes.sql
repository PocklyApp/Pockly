-- Keep daemon sync-hints queries scoped to the daemon device instead of
-- scanning all session prefs/open hints for large accounts.

CREATE INDEX IF NOT EXISTS idx_session_prefs_user_device
  ON session_prefs(user_id, device_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user_device_updated
  ON sessions(user_id, device_id, updated_at DESC);
