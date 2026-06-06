-- Copyright 2026 Pockly contributors
-- SPDX-License-Identifier: Apache-2.0

-- Worker-native relay metadata schema.
-- Keep this aligned with the public relay contract. Do not store model provider
-- API keys.

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  session_token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  browser_device_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS computers (
  computer_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  hostname TEXT,
  os TEXT,
  status TEXT NOT NULL,
  current_daemon_device_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(user_id) ON DELETE CASCADE,
  computer_id TEXT REFERENCES computers(computer_id) ON DELETE SET NULL,
  device_type TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  public_key TEXT NOT NULL DEFAULT '',
  e2e_public_key TEXT,
  status TEXT NOT NULL,
  remote_access_enabled INTEGER NOT NULL DEFAULT 0,
  superseded_by_device_id TEXT,
  hostname TEXT,
  os TEXT,
  user_agent TEXT,
  app_version TEXT,
  capabilities TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS device_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  audience TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_challenges (
  challenge_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  audience TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_codes (
  login_code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_bindings (
  daemon_device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  browser_device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (daemon_device_id, browser_device_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  computer_id TEXT,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  runner_alias TEXT,
  cwd TEXT NOT NULL DEFAULT '',
  snippet TEXT,
  first_message TEXT,
  title TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_timestamp TEXT,
  channel_last_seen_at TEXT,
  sync_state TEXT,
  turn_count INTEGER NOT NULL DEFAULT 0,
  last_sync_error TEXT,
  synced_turn_count INTEGER NOT NULL DEFAULT 0,
  synced_min_seq INTEGER NOT NULL DEFAULT 0,
  synced_max_seq INTEGER NOT NULL DEFAULT 0,
  has_older_turns INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, session_id)
);

CREATE TABLE IF NOT EXISTS session_turns (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  timestamp TEXT,
  payload TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_devices_user_type_status
  ON devices(user_id, device_type, status);

CREATE INDEX IF NOT EXISTS idx_sessions_user_updated
  ON sessions(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_tokens_expires
  ON device_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_device_challenges_device
  ON device_challenges(device_id, expires_at);
