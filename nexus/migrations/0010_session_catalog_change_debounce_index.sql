-- Supports debounce lookups for repeated catalog upserts without scanning the
-- full per-user change log.

CREATE INDEX IF NOT EXISTS idx_session_catalog_changes_recent_session
  ON session_catalog_changes(user_id, device_id, session_id, created_at, change_id);
