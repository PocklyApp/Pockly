/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export function createStore(env = {}) {
  if (env.POCKLY_NEXUS_STORE || env.POCKLY_RELAY_STORE) {
    return env.POCKLY_NEXUS_STORE || env.POCKLY_RELAY_STORE;
  }
  globalThis.__POCKLY_NEXUS_STORE ??= new InMemoryNexusStore();
  return globalThis.__POCKLY_NEXUS_STORE;
}

export class InMemoryNexusStore {
  constructor() {
    this.usersById = new Map();
    this.userIdByEmail = new Map();
    this.webSessions = new Map();
    this.loginCodes = new Map();
    this.devices = new Map();
    this.computers = new Map();
    this.deviceTokens = new Map();
    this.deviceChallenges = new Map();
    this.deviceAuthorizations = new Map();
    this.setupGrants = new Map();
    this.pairingGrants = new Map();
    this.mobileJoinGrants = new Map();
    this.deviceBindings = new Map();
    this.pushSubscriptions = new Map();
    this.feedback = new Map();
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

  async upsertDeviceBinding(binding) {
    const key = bindingKey(binding.daemon_device_id, binding.browser_device_id);
    const existing = this.deviceBindings.get(key);
    const next = {
      ...(existing ?? {}),
      ...binding,
      created_at: existing?.created_at ?? binding.created_at,
    };
    this.deviceBindings.set(key, next);
    return next;
  }

  async getDeviceBinding(userID, daemonDeviceID, browserDeviceID) {
    const binding = this.deviceBindings.get(bindingKey(daemonDeviceID, browserDeviceID));
    if (!binding || binding.user_id !== userID || binding.status !== "active") return null;
    return binding;
  }

  async deleteDeviceBinding(userID, daemonDeviceID, browserDeviceID, at) {
    const key = bindingKey(daemonDeviceID, browserDeviceID);
    const binding = this.deviceBindings.get(key);
    if (!binding || binding.user_id !== userID) return null;
    const next = { ...binding, status: "revoked", updated_at: at };
    this.deviceBindings.set(key, next);
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

  async saveDeviceAuthorization(authorization) {
    this.deviceAuthorizations.set(authorization.device_code, {
      ...this.deviceAuthorizations.get(authorization.device_code),
      ...authorization,
    });
    return this.deviceAuthorizations.get(authorization.device_code);
  }

  async getDeviceAuthorization(deviceCode) {
    return this.deviceAuthorizations.get(deviceCode) ?? null;
  }

  async saveSetupGrant(grant) {
    this.setupGrants.set(grant.setup_grant, {
      ...this.setupGrants.get(grant.setup_grant),
      ...grant,
    });
    return this.setupGrants.get(grant.setup_grant);
  }

  async getSetupGrant(setupGrant) {
    return this.setupGrants.get(setupGrant) ?? null;
  }

  async savePairingGrant(grant) {
    this.pairingGrants.set(grant.pairing_grant, {
      ...this.pairingGrants.get(grant.pairing_grant),
      ...grant,
    });
    return this.pairingGrants.get(grant.pairing_grant);
  }

  async getPairingGrant(pairingGrant) {
    return this.pairingGrants.get(pairingGrant) ?? null;
  }

  async listPendingPairingGrants(daemonDeviceID) {
    return [...this.pairingGrants.values()]
      .filter((grant) => grant.daemon_device_id === daemonDeviceID && grant.status === "awaiting_confirmation")
      .sort((left, right) => String(left.expires_at).localeCompare(String(right.expires_at)));
  }

  async saveMobileJoinGrant(grant) {
    this.mobileJoinGrants.set(grant.grant_token, {
      ...this.mobileJoinGrants.get(grant.grant_token),
      ...grant,
    });
    return this.mobileJoinGrants.get(grant.grant_token);
  }

  async getMobileJoinGrant(grantToken) {
    return this.mobileJoinGrants.get(grantToken) ?? null;
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

  async upsertPushSubscription(subscription) {
    const existing = this.pushSubscriptions.get(subscription.subscription_id);
    const next = {
      ...(existing ?? {}),
      ...subscription,
      created_at: existing?.created_at ?? subscription.created_at,
    };
    this.pushSubscriptions.set(next.subscription_id, next);
    return next;
  }

  async deletePushSubscription(userID, browserDeviceID, subscriptionID, at) {
    const existing = this.pushSubscriptions.get(subscriptionID);
    if (!existing || existing.user_id !== userID || existing.browser_device_id !== browserDeviceID) return null;
    const next = { ...existing, status: "revoked", updated_at: at };
    this.pushSubscriptions.set(subscriptionID, next);
    return next;
  }

  async listActivePushSubscriptionsForUser(userID) {
    return [...this.pushSubscriptions.values()]
      .filter((subscription) => subscription.user_id === userID && subscription.status === "active")
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  }

  async revokePushSubscription(userID, subscriptionID, at) {
    const existing = this.pushSubscriptions.get(subscriptionID);
    if (!existing || existing.user_id !== userID) return null;
    const next = { ...existing, status: "revoked", updated_at: at };
    this.pushSubscriptions.set(subscriptionID, next);
    return next;
  }

  async createFeedback(feedback) {
    this.feedback.set(feedback.feedback_id, feedback);
    return feedback;
  }
}

export class SQLNexusStore {
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
        browser_public_key, status, remote_access_enabled, superseded_by_device_id,
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
        browser_public_key = excluded.browser_public_key,
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
      device.browser_public_key ?? null,
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

  async upsertDeviceBinding(binding) {
    await this.db.prepare(`
      INSERT INTO device_bindings (daemon_device_id, browser_device_id, user_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(daemon_device_id, browser_device_id) DO UPDATE SET
        user_id = excluded.user_id,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).bind(
      binding.daemon_device_id,
      binding.browser_device_id,
      binding.user_id,
      binding.status,
      binding.created_at,
      binding.updated_at,
    ).run();
    return binding;
  }

  async getDeviceBinding(userID, daemonDeviceID, browserDeviceID) {
    return await this.db.prepare(`
      SELECT * FROM device_bindings
      WHERE user_id = ? AND daemon_device_id = ? AND browser_device_id = ? AND status = 'active'
    `).bind(userID, daemonDeviceID, browserDeviceID).first();
  }

  async deleteDeviceBinding(userID, daemonDeviceID, browserDeviceID, at) {
    const existing = await this.getDeviceBinding(userID, daemonDeviceID, browserDeviceID);
    if (!existing) return null;
    await this.db.prepare(`
      UPDATE device_bindings SET status = 'revoked', updated_at = ?
      WHERE user_id = ? AND daemon_device_id = ? AND browser_device_id = ?
    `).bind(at, userID, daemonDeviceID, browserDeviceID).run();
    return { ...existing, status: "revoked", updated_at: at };
  }

  async createDeviceToken(token) {
    await this.db.prepare(`
      INSERT INTO device_tokens (token_hash, user_id, device_id, audience, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(token.token_hash, token.user_id ?? null, token.device_id, token.audience, token.expires_at, token.created_at).run();
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

  async saveDeviceAuthorization(authorization) {
    await this.db.prepare(`
      INSERT INTO daemon_device_authorizations (
        device_code, user_code, poll_secret, daemon_device_id, daemon_public_key,
        device_name, hostname, os, app_version, computer_id, computer_public_key,
        computer_signature, status, user_id, verification_uri,
        verification_uri_complete, poll_interval, expires_at, authorized_at,
        denied_at, consumed_at, claim_payload, claim_browser_device_id,
        claim_requested_at, daemon_confirmed_at, daemon_denied_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_code) DO UPDATE SET
        status = excluded.status,
        user_id = excluded.user_id,
        authorized_at = excluded.authorized_at,
        denied_at = excluded.denied_at,
        consumed_at = excluded.consumed_at,
        claim_payload = excluded.claim_payload,
        claim_browser_device_id = excluded.claim_browser_device_id,
        claim_requested_at = excluded.claim_requested_at,
        daemon_confirmed_at = excluded.daemon_confirmed_at,
        daemon_denied_at = excluded.daemon_denied_at
    `).bind(
      authorization.device_code,
      authorization.user_code,
      authorization.poll_secret,
      authorization.daemon_device_id,
      authorization.daemon_public_key,
      authorization.device_name ?? "",
      authorization.hostname ?? null,
      authorization.os ?? null,
      authorization.app_version ?? null,
      authorization.computer_id ?? null,
      authorization.computer_public_key ?? null,
      authorization.computer_signature ?? null,
      authorization.status,
      authorization.user_id ?? null,
      authorization.verification_uri,
      authorization.verification_uri_complete,
      authorization.poll_interval,
      authorization.expires_at,
      authorization.authorized_at ?? null,
      authorization.denied_at ?? null,
      authorization.consumed_at ?? null,
      authorization.claim_payload ?? null,
      authorization.claim_browser_device_id ?? null,
      authorization.claim_requested_at ?? null,
      authorization.daemon_confirmed_at ?? null,
      authorization.daemon_denied_at ?? null,
    ).run();
    return this.getDeviceAuthorization(authorization.device_code);
  }

  async getDeviceAuthorization(deviceCode) {
    return await this.db.prepare(`
      SELECT * FROM daemon_device_authorizations WHERE device_code = ?
    `).bind(deviceCode).first();
  }

  async saveSetupGrant(grant) {
    await this.db.prepare(`
      INSERT INTO daemon_setup_grants (
        setup_grant, poll_secret, daemon_device_id, daemon_public_key,
        device_name, hostname, os, app_version, computer_id,
        computer_public_key, computer_signature, setup_url, status,
        user_id, browser_device_id, expires_at, claimed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(setup_grant) DO UPDATE SET
        status = excluded.status,
        user_id = excluded.user_id,
        browser_device_id = excluded.browser_device_id,
        claimed_at = excluded.claimed_at
    `).bind(
      grant.setup_grant,
      grant.poll_secret,
      grant.daemon_device_id,
      grant.daemon_public_key,
      grant.device_name ?? "",
      grant.hostname ?? null,
      grant.os ?? null,
      grant.app_version ?? null,
      grant.computer_id ?? null,
      grant.computer_public_key ?? null,
      grant.computer_signature ?? null,
      grant.setup_url,
      grant.status,
      grant.user_id ?? null,
      grant.browser_device_id ?? null,
      grant.expires_at,
      grant.claimed_at ?? null,
    ).run();
    return this.getSetupGrant(grant.setup_grant);
  }

  async getSetupGrant(setupGrant) {
    return await this.db.prepare(`
      SELECT * FROM daemon_setup_grants WHERE setup_grant = ?
    `).bind(setupGrant).first();
  }

  async savePairingGrant(grant) {
    await this.db.prepare(`
      INSERT INTO pairing_grants (
        pairing_grant, daemon_device_id, daemon_public_key, computer_id,
        computer_public_key, computer_signature, relay_url, short_code,
        device_name, hostname, os, expires_at, status, user_id,
        browser_device_id, browser_device_name, browser_device_pub,
        confirmation_user, confirmed_at, denied_at, claimed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pairing_grant) DO UPDATE SET
        status = excluded.status,
        user_id = excluded.user_id,
        browser_device_id = excluded.browser_device_id,
        browser_device_name = excluded.browser_device_name,
        browser_device_pub = excluded.browser_device_pub,
        confirmation_user = excluded.confirmation_user,
        confirmed_at = excluded.confirmed_at,
        denied_at = excluded.denied_at,
        claimed_at = excluded.claimed_at
    `).bind(
      grant.pairing_grant,
      grant.daemon_device_id,
      grant.daemon_public_key,
      grant.computer_id ?? null,
      grant.computer_public_key ?? null,
      grant.computer_signature ?? null,
      grant.relay_url,
      grant.short_code,
      grant.device_name ?? "",
      grant.hostname ?? null,
      grant.os ?? null,
      grant.expires_at,
      grant.status,
      grant.user_id ?? null,
      grant.browser_device_id ?? null,
      grant.browser_device_name ?? null,
      grant.browser_device_pub ?? null,
      grant.confirmation_user ?? null,
      grant.confirmed_at ?? null,
      grant.denied_at ?? null,
      grant.claimed_at ?? null,
    ).run();
    return this.getPairingGrant(grant.pairing_grant);
  }

  async getPairingGrant(pairingGrant) {
    return await this.db.prepare(`SELECT * FROM pairing_grants WHERE pairing_grant = ?`).bind(pairingGrant).first();
  }

  async listPendingPairingGrants(daemonDeviceID) {
    const result = await this.db.prepare(`
      SELECT * FROM pairing_grants
      WHERE daemon_device_id = ? AND status = 'awaiting_confirmation'
      ORDER BY expires_at ASC
    `).bind(daemonDeviceID).all();
    return result.results ?? [];
  }

  async saveMobileJoinGrant(grant) {
    await this.db.prepare(`
      INSERT INTO mobile_join_grants (grant_token, user_id, grantor_device_id, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(grant_token) DO UPDATE SET consumed_at = excluded.consumed_at
    `).bind(
      grant.grant_token,
      grant.user_id,
      grant.grantor_device_id,
      grant.expires_at,
      grant.consumed_at ?? null,
      grant.created_at,
    ).run();
    return this.getMobileJoinGrant(grant.grant_token);
  }

  async getMobileJoinGrant(grantToken) {
    return await this.db.prepare(`SELECT * FROM mobile_join_grants WHERE grant_token = ?`).bind(grantToken).first();
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

  async upsertPushSubscription(subscription) {
    await this.db.prepare(`
      INSERT INTO push_subscriptions (
        subscription_id, user_id, browser_device_id, endpoint, p256dh, auth,
        user_agent, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subscription_id) DO UPDATE SET
        endpoint = excluded.endpoint,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).bind(
      subscription.subscription_id,
      subscription.user_id,
      subscription.browser_device_id,
      subscription.endpoint,
      subscription.p256dh,
      subscription.auth,
      subscription.user_agent ?? "",
      subscription.status,
      subscription.created_at,
      subscription.updated_at,
    ).run();
    return subscription;
  }

  async deletePushSubscription(userID, browserDeviceID, subscriptionID, at) {
    const row = await this.db.prepare(`
      SELECT * FROM push_subscriptions
      WHERE subscription_id = ? AND user_id = ? AND browser_device_id = ?
    `).bind(subscriptionID, userID, browserDeviceID).first();
    if (!row) return null;
    await this.db.prepare(`
      UPDATE push_subscriptions SET status = 'revoked', updated_at = ?
      WHERE subscription_id = ? AND user_id = ? AND browser_device_id = ?
    `).bind(at, subscriptionID, userID, browserDeviceID).run();
    return { ...row, status: "revoked", updated_at: at };
  }

  async listActivePushSubscriptionsForUser(userID) {
    const result = await this.db.prepare(`
      SELECT * FROM push_subscriptions
      WHERE user_id = ? AND status = 'active'
      ORDER BY updated_at DESC
    `).bind(userID).all();
    return result.results ?? [];
  }

  async revokePushSubscription(userID, subscriptionID, at) {
    const row = await this.db.prepare(`
      SELECT * FROM push_subscriptions
      WHERE subscription_id = ? AND user_id = ?
    `).bind(subscriptionID, userID).first();
    if (!row) return null;
    await this.db.prepare(`
      UPDATE push_subscriptions SET status = 'revoked', updated_at = ?
      WHERE subscription_id = ? AND user_id = ?
    `).bind(at, subscriptionID, userID).run();
    return { ...row, status: "revoked", updated_at: at };
  }

  async createFeedback(feedback) {
    await this.db.prepare(`
      INSERT INTO feedback (
        feedback_id, user_id, browser_device_id, message, page_path,
        app_version, relay_environment, browser_name, browser_platform,
        browser_user_agent, selected_session_id, selected_device_id,
        attachment_name, attachment_type, attachment_size, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      feedback.feedback_id,
      feedback.user_id,
      feedback.browser_device_id,
      feedback.message,
      feedback.page_path ?? null,
      feedback.app_version ?? null,
      feedback.relay_environment ?? null,
      feedback.browser_name ?? null,
      feedback.browser_platform ?? null,
      feedback.browser_user_agent ?? null,
      feedback.selected_session_id ?? null,
      feedback.selected_device_id ?? null,
      feedback.attachment_name ?? null,
      feedback.attachment_type ?? null,
      feedback.attachment_size ?? null,
      feedback.created_at,
    ).run();
    return feedback;
  }
}

export const InMemoryRelayStore = InMemoryNexusStore;

function sessionKey(userID, deviceID, sessionID) {
  return `${userID}\x00${deviceID}\x00${sessionID}`;
}

function bindingKey(daemonDeviceID, browserDeviceID) {
  return `${daemonDeviceID}\x00${browserDeviceID}`;
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
