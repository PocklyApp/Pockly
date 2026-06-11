-- Recent active-turn events for runtimes where browser realtime streaming is
-- disabled. The table is intentionally a cursor cache; transcript history
-- remains in session_turns and daemon window sync.

CREATE TABLE IF NOT EXISTS session_events (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  request_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_events_session_cursor
  ON session_events(user_id, device_id, session_id, event_id);

CREATE INDEX IF NOT EXISTS idx_session_events_request
  ON session_events(user_id, request_id, event_id);
