-- Persist daemon-compatible hot-window hashes on session rows so known-window
-- probes do not need to read turn payloads.

ALTER TABLE sessions ADD COLUMN synced_window_hash TEXT NOT NULL DEFAULT '';
