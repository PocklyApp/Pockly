/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export function createStore(env = {}) {
  if (env.POCKLY_RELAY_STORE) {
    return env.POCKLY_RELAY_STORE;
  }
  if (env.DB) {
    return new D1RelayStore(env.DB);
  }
  globalThis.__POCKLY_RELAY_STORE ??= new InMemoryRelayStore();
  return globalThis.__POCKLY_RELAY_STORE;
}

export class InMemoryRelayStore {
  constructor() {
    this.usersById = new Map();
    this.userIdByEmail = new Map();
    this.webSessions = new Map();
    this.loginCodes = new Map();
    this.devices = new Map();
    this.computers = new Map();
    this.deviceTokens = new Map();
    this.deviceChallenges = new Map();
    this.sessions = new Map();
    this.turns = new Map();
  }

  async upsertUser(user) {
    const existingID = this.userIdByEmail.get(user.email);
    const id = existingID ?? user.user_id;
    const existing = existingID ? this.usersById.get(existingID) : null;
    const next = {
      ...(existing ?? {}),
      ...withoutUndefined(user),
      user_id: id,
      name: user.name ?? existing?.name ?? "",
    };
    this.usersById.set(id, next);
    this.userIdByEmail.set(next.email, id);
    return next;
  }

  async getUserByID(userID) {
    return this.usersById.get(userID) ?? null;
  }

  async getUserByEmail(email) {
    const userID = this.userIdByEmail.get(email);
    return userID ? this.usersById.get(userID) ?? null : null;
  }

  async createWebSession(session) {
    this.webSessions.set(session.session_token_hash, session);
    return session;
  }

  async getWebSession(sessionTokenHash) {
    return this.webSessions.get(sessionTokenHash) ?? null;
  }

  async deleteWebSession(sessionTokenHash) {
    this.webSessions.delete(sessionTokenHash);
  }

  async createLoginCode(code) {
    this.loginCodes.set(code.login_code, code);
    return code;
  }

  async getLoginCode(loginCode) {
    return this.loginCodes.get(loginCode) ?? null;
  }

  async consumeLoginCode(loginCode, consumedAt) {
    const existing = this.loginCodes.get(loginCode);
    if (existing) this.loginCodes.set(loginCode, { ...existing, consumed_at: consumedAt });
  }

  async upsertComputer(computer) {
    const existing = this.computers.get(computer.computer_id);
    const next = {
      ...(existing ?? {}),
      ...computer,
      created_at: existing?.created_at ?? computer.created_at,
      last_seen_at: computer.last_seen_at ?? existing?.last_seen_at,
    };
    this.computers.set(next.computer_id, next);
    return next;
  }

  async upsertDevice(device) {
    const existing = this.devices.get(device.device_id);
    const next = {
      ...(existing ?? {}),
      ...device,
      created_at: existing?.created_at ?? device.created_at,
      remote_access_enabled: Boolean(device.remote_access_enabled ?? existing?.remote_access_enabled),
    };
    this.devices.set(next.device_id, next);
    return next;
  }

  async getDevice(deviceID) {
    return this.devices.get(deviceID) ?? null;
  }

  async listDevicesForUser(userID) {
    return [...this.devices.values()]
      .filter((device) => device.user_id === userID)
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  }

  async patchDevice(userID, deviceID, patch) {
    const existing = this.devices.get(deviceID);
    if (!existing || existing.user_id !== userID) return null;
    const next = { ...existing, ...patch };
    this.devices.set(deviceID, next);
    return next;
  }

  async touchDevice(deviceID, at) {
    const existing = this.devices.get(deviceID);
    if (!existing) return null;
    const next = { ...existing, last_seen_at: at, updated_at: at };
    this.devices.set(deviceID, next);
    if (next.computer_id) {
      const computer = this.computers.get(next.computer_id);
      if (computer) {
        this.computers.set(next.computer_id, {
          ...computer,
          current_daemon_device_id: next.device_type === "daemon" ? next.device_id : computer.current_daemon_device_id,
          last_seen_at: at,
          updated_at: at,
        });
      }
    }
    return next;
  }

  async createDeviceToken(token) {
    this.deviceTokens.set(token.token_hash, token);
    return token;
  }

  async getDeviceToken(tokenHash) {
    return this.deviceTokens.get(tokenHash) ?? null;
  }

  async createDeviceChallenge(challenge) {
    this.deviceChallenges.set(challenge.challenge_id, challenge);
    return challenge;
  }

  async getDeviceChallenge(challengeID) {
    return this.deviceChallenges.get(challengeID) ?? null;
  }

  async consumeDeviceChallenge(challengeID, consumedAt) {
    const existing = this.deviceChallenges.get(challengeID);
    if (existing) this.deviceChallenges.set(challengeID, { ...existing, consumed_at: consumedAt });
  }

  async upsertSession(session) {
    const key = sessionKey(session.user_id, session.device_id, session.session_id);
    const existing = this.sessions.get(key);
    const next = {
      ...(existing ?? {}),
      ...session,
      updated_at: session.updated_at,
    };
    this.sessions.set(key, next);
    return next;
  }

  async deleteMissingDeviceSessions(userID, deviceID, keepSessionIDs) {
    const keep = new Set(keepSessionIDs);
    for (const [key, session] of [...this.sessions.entries()]) {
      if (session.user_id === userID && session.device_id === deviceID && !keep.has(session.session_id)) {
        this.sessions.delete(key);
        for (const [turnKey, turn] of [...this.turns.entries()]) {
          if (turn.user_id === userID && turn.device_id === deviceID && turn.session_id === session.session_id) {
            this.turns.delete(turnKey);
          }
        }
      }
    }
  }

  async listSessionsForUser(userID) {
    return [...this.sessions.values()]
      .filter((session) => session.user_id === userID)
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  }

  async getSession(userID, deviceID, sessionID) {
    return this.sessions.get(sessionKey(userID, deviceID, sessionID)) ?? null;
  }

  async upsertTurn(turn) {
    const key = turnKey(turn.user_id, turn.device_id, turn.session_id, turn.seq);
    const existing = this.turns.get(key);
    const next = { ...(existing ?? {}), ...turn };
    this.turns.set(key, next);
    return next;
  }

  async listTurns(userID, deviceID, sessionID) {
    return [...this.turns.values()]
      .filter((turn) => turn.user_id === userID && turn.device_id === deviceID && turn.session_id === sessionID)
      .sort((left, right) => Number(left.seq) - Number(right.seq));
  }
}

export class D1RelayStore {
  constructor(db) {
    this.db = db;
  }

  async upsertUser(user) {
    await this.db.prepare(`
      INSERT INTO users (user_id, email, name, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        name = excluded.name,
        password_hash = COALESCE(excluded.password_hash, users.password_hash),
        updated_at = excluded.updated_at
    `).bind(user.user_id, user.email, user.name ?? "", user.password_hash ?? null, user.created_at, user.updated_at).run();
    return this.getUserByEmail(user.email);
  }

  async getUserByID(userID) {
    return await this.db.prepare(`SELECT * FROM users WHERE user_id = ?`).bind(userID).first();
  }

  async getUserByEmail(email) {
    return await this.db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first();
  }

  async createWebSession(session) {
    await this.db.prepare(`
      INSERT INTO web_sessions (session_token_hash, user_id, browser_device_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      session.session_token_hash,
      session.user_id,
      session.browser_device_id ?? null,
      session.expires_at,
      session.created_at,
    ).run();
    return session;
  }

  async getWebSession(sessionTokenHash) {
    return await this.db.prepare(`SELECT * FROM web_sessions WHERE session_token_hash = ?`).bind(sessionTokenHash).first();
  }

  async deleteWebSession(sessionTokenHash) {
    await this.db.prepare(`DELETE FROM web_sessions WHERE session_token_hash = ?`).bind(sessionTokenHash).run();
  }

  async createLoginCode(code) {
    await this.db.prepare(`
      INSERT INTO login_codes (login_code, user_id, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(code.login_code, code.user_id, code.expires_at, code.consumed_at ?? null, code.created_at).run();
    return code;
  }

  async getLoginCode(loginCode) {
    return await this.db.prepare(`SELECT * FROM login_codes WHERE login_code = ?`).bind(loginCode).first();
  }

  async consumeLoginCode(loginCode, consumedAt) {
    await this.db.prepare(`UPDATE login_codes SET consumed_at = ? WHERE login_code = ?`).bind(consumedAt, loginCode).run();
  }

  async upsertComputer(computer) {
    await this.db.prepare(`
      INSERT INTO computers (
        computer_id, user_id, display_name, hostname, os, status,
        current_daemon_device_id, created_at, updated_at, last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(computer_id) DO UPDATE SET
        user_id = excluded.user_id,
        display_name = COALESCE(NULLIF(excluded.display_name, ''), computers.display_name),
        hostname = excluded.hostname,
        os = excluded.os,
        status = excluded.status,
        current_daemon_device_id = excluded.current_daemon_device_id,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at
    `).bind(
      computer.computer_id,
      computer.user_id,
      computer.display_name ?? "",
      computer.hostname ?? null,
      computer.os ?? null,
      computer.status,
      computer.current_daemon_device_id ?? null,
      computer.created_at,
      computer.updated_at,
      computer.last_seen_at ?? null,
    ).run();
    return computer;
  }

  async upsertDevice(device) {
    await this.db.prepare(`
      INSERT INTO devices (
        device_id, user_id, computer_id, device_type, device_name, public_key,
        e2e_public_key, status, remote_access_enabled, superseded_by_device_id,
        hostname, os, user_agent, app_version, capabilities,
        created_at, updated_at, last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        user_id = excluded.user_id,
        computer_id = excluded.computer_id,
        device_type = excluded.device_type,
        device_name = excluded.device_name,
        public_key = excluded.public_key,
        e2e_public_key = excluded.e2e_public_key,
        status = excluded.status,
        remote_access_enabled = excluded.remote_access_enabled,
        superseded_by_device_id = excluded.superseded_by_device_id,
        hostname = excluded.hostname,
        os = excluded.os,
        user_agent = excluded.user_agent,
        app_version = excluded.app_version,
        capabilities = excluded.capabilities,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at
    `).bind(
      device.device_id,
      device.user_id ?? null,
      device.computer_id ?? null,
      device.device_type,
      device.device_name ?? "",
      device.public_key ?? "",
      device.e2e_public_key ?? null,
      device.status,
      device.remote_access_enabled ? 1 : 0,
      device.superseded_by_device_id ?? null,
      device.hostname ?? null,
      device.os ?? null,
      device.user_agent ?? null,
      device.app_version ?? null,
      device.capabilities ? JSON.stringify(device.capabilities) : null,
      device.created_at,
      device.updated_at,
      device.last_seen_at ?? null,
    ).run();
    return this.getDevice(device.device_id);
  }

  async getDevice(deviceID) {
    const row = await this.db.prepare(`SELECT * FROM devices WHERE device_id = ?`).bind(deviceID).first();
    return row ? normalizeDeviceRow(row) : null;
  }

  async listDevicesForUser(userID) {
    const result = await this.db.prepare(`
      SELECT * FROM devices WHERE user_id = ? ORDER BY updated_at DESC
    `).bind(userID).all();
    return (result.results ?? []).map(normalizeDeviceRow);
  }

  async patchDevice(userID, deviceID, patch) {
    const existing = await this.getDevice(deviceID);
    if (!existing || existing.user_id !== userID) return null;
    const next = { ...existing, ...patch };
    await this.upsertDevice(next);
    return this.getDevice(deviceID);
  }

  async touchDevice(deviceID, at) {
    await this.db.prepare(`UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE device_id = ?`).bind(at, at, deviceID).run();
    const device = await this.getDevice(deviceID);
    if (device?.computer_id && device.device_type === "daemon") {
      await this.db.prepare(`
        UPDATE computers
        SET current_daemon_device_id = ?, last_seen_at = ?, updated_at = ?
        WHERE computer_id = ?
      `).bind(device.device_id, at, at, device.computer_id).run();
    }
    return device;
  }

  async createDeviceToken(token) {
    await this.db.prepare(`
      INSERT INTO device_tokens (token_hash, user_id, device_id, audience, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(token.token_hash, token.user_id, token.device_id, token.audience, token.expires_at, token.created_at).run();
    return token;
  }

  async getDeviceToken(tokenHash) {
    return await this.db.prepare(`SELECT * FROM device_tokens WHERE token_hash = ?`).bind(tokenHash).first();
  }

  async createDeviceChallenge(challenge) {
    await this.db.prepare(`
      INSERT INTO device_challenges (challenge_id, device_id, audience, nonce, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      challenge.challenge_id,
      challenge.device_id,
      challenge.audience,
      challenge.nonce,
      challenge.expires_at,
      challenge.consumed_at ?? null,
      challenge.created_at,
    ).run();
    return challenge;
  }

  async getDeviceChallenge(challengeID) {
    return await this.db.prepare(`SELECT * FROM device_challenges WHERE challenge_id = ?`).bind(challengeID).first();
  }

  async consumeDeviceChallenge(challengeID, consumedAt) {
    await this.db.prepare(`UPDATE device_challenges SET consumed_at = ? WHERE challenge_id = ?`).bind(consumedAt, challengeID).run();
  }

  async upsertSession(session) {
    await this.db.prepare(`
      INSERT INTO sessions (
        user_id, computer_id, device_id, session_id, agent, runner_alias, cwd,
        snippet, first_message, title, last_seq, last_timestamp,
        channel_last_seen_at, sync_state, turn_count, last_sync_error,
        synced_turn_count, synced_min_seq, synced_max_seq, has_older_turns,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, device_id, session_id) DO UPDATE SET
        computer_id = excluded.computer_id,
        agent = excluded.agent,
        runner_alias = excluded.runner_alias,
        cwd = excluded.cwd,
        snippet = excluded.snippet,
        first_message = excluded.first_message,
        title = excluded.title,
        last_seq = excluded.last_seq,
        last_timestamp = excluded.last_timestamp,
        channel_last_seen_at = excluded.channel_last_seen_at,
        sync_state = excluded.sync_state,
        turn_count = excluded.turn_count,
        last_sync_error = excluded.last_sync_error,
        synced_turn_count = excluded.synced_turn_count,
        synced_min_seq = excluded.synced_min_seq,
        synced_max_seq = excluded.synced_max_seq,
        has_older_turns = excluded.has_older_turns,
        updated_at = excluded.updated_at
    `).bind(
      session.user_id,
      session.computer_id ?? null,
      session.device_id,
      session.session_id,
      session.agent,
      session.runner_alias ?? null,
      session.cwd ?? "",
      session.snippet ?? "",
      session.first_message ?? "",
      session.title ?? null,
      session.last_seq ?? 0,
      session.last_timestamp ?? null,
      session.channel_last_seen_at ?? null,
      session.sync_state ?? null,
      session.turn_count ?? 0,
      session.last_sync_error ?? null,
      session.synced_turn_count ?? 0,
      session.synced_min_seq ?? 0,
      session.synced_max_seq ?? 0,
      session.has_older_turns ? 1 : 0,
      session.updated_at,
    ).run();
    return session;
  }

  async deleteMissingDeviceSessions(userID, deviceID, keepSessionIDs) {
    const placeholders = keepSessionIDs.map(() => "?").join(", ");
    if (keepSessionIDs.length === 0) {
      await this.db.prepare(`DELETE FROM session_turns WHERE user_id = ? AND device_id = ?`).bind(userID, deviceID).run();
      await this.db.prepare(`DELETE FROM sessions WHERE user_id = ? AND device_id = ?`).bind(userID, deviceID).run();
      return;
    }
    await this.db.prepare(`
      DELETE FROM session_turns
      WHERE user_id = ? AND device_id = ? AND session_id NOT IN (${placeholders})
    `).bind(userID, deviceID, ...keepSessionIDs).run();
    await this.db.prepare(`
      DELETE FROM sessions
      WHERE user_id = ? AND device_id = ? AND session_id NOT IN (${placeholders})
    `).bind(userID, deviceID, ...keepSessionIDs).run();
  }

  async listSessionsForUser(userID) {
    const result = await this.db.prepare(`
      SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC
    `).bind(userID).all();
    return (result.results ?? []).map(normalizeSessionRow);
  }

  async getSession(userID, deviceID, sessionID) {
    const row = await this.db.prepare(`
      SELECT * FROM sessions WHERE user_id = ? AND device_id = ? AND session_id = ?
    `).bind(userID, deviceID, sessionID).first();
    return row ? normalizeSessionRow(row) : null;
  }

  async upsertTurn(turn) {
    await this.db.prepare(`
      INSERT INTO session_turns (user_id, device_id, session_id, seq, agent, kind, timestamp, payload, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, device_id, session_id, seq) DO UPDATE SET
        agent = excluded.agent,
        kind = excluded.kind,
        timestamp = excluded.timestamp,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).bind(
      turn.user_id,
      turn.device_id,
      turn.session_id,
      turn.seq,
      turn.agent,
      turn.kind,
      turn.timestamp ?? null,
      turn.payload ?? null,
      turn.updated_at,
    ).run();
    return turn;
  }

  async listTurns(userID, deviceID, sessionID) {
    const result = await this.db.prepare(`
      SELECT * FROM session_turns
      WHERE user_id = ? AND device_id = ? AND session_id = ?
      ORDER BY seq ASC
    `).bind(userID, deviceID, sessionID).all();
    return result.results ?? [];
  }
}

function sessionKey(userID, deviceID, sessionID) {
  return `${userID}\x00${deviceID}\x00${sessionID}`;
}

function turnKey(userID, deviceID, sessionID, seq) {
  return `${sessionKey(userID, deviceID, sessionID)}\x00${seq}`;
}

function normalizeDeviceRow(row) {
  return {
    ...row,
    remote_access_enabled: Boolean(row.remote_access_enabled),
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : undefined,
  };
}

function normalizeSessionRow(row) {
  return {
    ...row,
    has_older_turns: Boolean(row.has_older_turns),
  };
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
