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

let nextEventCounter = 1;
const maxSessionEventsPerUser = 5000;
const maxSessionEventsPerSession = 500;

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
    this.sessionEvents = [];
    this.sessionCatalogChanges = [];
    this.sessionPrefs = new Map();
    this.sessionOpenHints = new Map();
    this.projectPrefs = new Map();
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

  async countSessionsByDeviceForUser(userID, deviceIDs = []) {
    const allowed = new Set(deviceIDs.map((id) => String(id)).filter(Boolean));
    const counts = new Map();
    for (const session of this.sessions.values()) {
      if (session.user_id !== userID) continue;
      const deviceID = String(session.device_id || "");
      if (allowed.size > 0 && !allowed.has(deviceID)) continue;
      counts.set(deviceID, (counts.get(deviceID) ?? 0) + 1);
    }
    return counts;
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

  async upsertSessions(sessions) {
    for (const session of sessions) await this.upsertSession(session);
  }

  async deleteMissingDeviceSessions(userID, deviceID, keepSessionIDs) {
    return await this.deleteMissingDeviceSessionsFromExisting(userID, deviceID, keepSessionIDs, await this.listDeviceSessions(userID, deviceID));
  }

  async deleteMissingDeviceSessionsFromExisting(userID, deviceID, keepSessionIDs, existingSessions) {
    const keep = new Set(keepSessionIDs.map((id) => String(id)));
    let deleted = 0;
    for (const session of existingSessions) {
      if (!keep.has(String(session.session_id))) {
        const key = sessionKey(userID, deviceID, session.session_id);
        this.sessions.delete(key);
        deleted += 1;
        for (const [turnKey, turn] of [...this.turns.entries()]) {
          if (turn.user_id === userID && turn.device_id === deviceID && turn.session_id === session.session_id) {
            this.turns.delete(turnKey);
          }
        }
      }
    }
    return deleted;
  }

  async listSessionsForUser(userID) {
    return [...this.sessions.values()]
      .filter((session) => session.user_id === userID)
      .sort(compareSessionCatalogRows);
  }

  async listSessionCatalogPage(userID, options = {}) {
    const limit = clampLimit(options.limit, 100);
    const after = options.after ?? null;
    return (await this.listSessionsForUser(userID))
      .filter((session) => !after || sessionCatalogRowAfterCursor(session, after))
      .slice(0, limit);
  }

  async listDeviceSessions(userID, deviceID) {
    return [...this.sessions.values()]
      .filter((session) => session.user_id === userID && session.device_id === deviceID)
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  }

  async appendSessionCatalogChange(change) {
    const next = normalizeSessionCatalogChange(change);
    this.appendSessionCatalogChangeRows([next]);
    return next;
  }

  async appendSessionCatalogChanges(changes = []) {
    const out = changes.map(normalizeSessionCatalogChange);
    this.appendSessionCatalogChangeRows(out);
    return out;
  }

  appendSessionCatalogChangeRows(rows) {
    this.sessionCatalogChanges.push(...rows);
    if (this.sessionCatalogChanges.length > 10_000) {
      this.sessionCatalogChanges.splice(0, this.sessionCatalogChanges.length - 10_000);
    }
  }

  async listSessionCatalogChanges(userID, options = {}) {
    const since = String(options.since ?? "");
    const limit = clampLimit(options.limit, 100);
    return this.sessionCatalogChanges
      .filter((change) => change.user_id === userID && (!since || String(change.change_id) > since))
      .sort((left, right) => String(left.change_id).localeCompare(String(right.change_id)))
      .slice(0, limit);
  }

  async currentSessionCatalogCursor(userID) {
    return (await this.sessionCatalogCursorBounds(userID)).latest;
  }

  async sessionCatalogCursorBounds(userID) {
    const cursors = this.sessionCatalogChanges
      .filter((change) => change.user_id === userID)
      .map((change) => String(change.change_id))
      .sort((left, right) => left.localeCompare(right));
    return {
      oldest: cursors[0] || "",
      latest: cursors[cursors.length - 1] || emptyCatalogChangeCursor(),
    };
  }

  async listDeviceSessionSyncSnapshots(userID, deviceID) {
    return [...this.sessions.values()]
      .filter((session) => session.user_id === userID && session.device_id === deviceID)
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  }

  async listDeviceSessionSyncSnapshotsByIDs(userID, deviceID, sessionIDs = []) {
    const ids = new Set(sessionIDs.map((id) => String(id || "").trim()).filter(Boolean));
    if (!ids.size) return [];
    return [...this.sessions.values()]
      .filter((session) => session.user_id === userID && session.device_id === deviceID && ids.has(String(session.session_id)))
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  }

  async listDeviceSessionHintSnapshots(userID, deviceID) {
    return await this.listDeviceSessionSyncSnapshots(userID, deviceID);
  }

  async getSession(userID, deviceID, sessionID) {
    return this.sessions.get(sessionKey(userID, deviceID, sessionID)) ?? null;
  }

  // ---- UI preferences (pin / archive / rename) -------------------------
  // Written only by the web; never touched by daemon sync.

  async listSessionPrefsForUser(userID) {
    return [...this.sessionPrefs.values()].filter((pref) => pref.user_id === userID);
  }

  async listSessionPrefsForDevice(userID, deviceID) {
    return [...this.sessionPrefs.values()].filter((pref) => pref.user_id === userID && pref.device_id === deviceID);
  }

  async upsertSessionPref(pref) {
    const key = sessionKey(pref.user_id, pref.device_id, pref.session_id);
    const existing = this.sessionPrefs.get(key);
    const next = { ...(existing ?? { pinned: 0, archived: 0, custom_title: null }), ...withoutUndefined(pref) };
    this.sessionPrefs.set(key, next);
    return next;
  }

  async deleteSessionPref(userID, deviceID, sessionID) {
    this.sessionPrefs.delete(sessionKey(userID, deviceID, sessionID));
  }

  async listSessionOpenHintsForUser(userID) {
    return [...this.sessionOpenHints.values()].filter((hint) => hint.user_id === userID);
  }

  async listSessionOpenHintsForDevice(userID, deviceID) {
    return [...this.sessionOpenHints.values()].filter((hint) => hint.user_id === userID && hint.device_id === deviceID);
  }

  async upsertSessionOpenHint(hint) {
    const key = sessionKey(hint.user_id, hint.device_id, hint.session_id);
    const next = { ...(this.sessionOpenHints.get(key) ?? {}), ...withoutUndefined(hint) };
    this.sessionOpenHints.set(key, next);
    return next;
  }

  async deleteSessionOpenHint(userID, deviceID, sessionID) {
    this.sessionOpenHints.delete(sessionKey(userID, deviceID, sessionID));
  }

  async listProjectPrefsForUser(userID) {
    return [...this.projectPrefs.values()].filter((pref) => pref.user_id === userID);
  }

  async upsertProjectPref(pref) {
    const key = sessionKey(pref.user_id, pref.device_id, pref.cwd);
    const existing = this.projectPrefs.get(key);
    const next = { ...(existing ?? { pinned: 0, archived: 0, removed: 0, custom_label: null }), ...withoutUndefined(pref) };
    this.projectPrefs.set(key, next);
    return next;
  }

  async deleteSessionData(userID, deviceID, sessionID) {
    this.sessions.delete(sessionKey(userID, deviceID, sessionID));
    this.sessionPrefs.delete(sessionKey(userID, deviceID, sessionID));
    this.sessionOpenHints.delete(sessionKey(userID, deviceID, sessionID));
    for (const [key, turn] of this.turns) {
      if (turn.user_id === userID && turn.device_id === deviceID && turn.session_id === sessionID) {
        this.turns.delete(key);
      }
    }
  }

  async upsertTurn(turn) {
    const key = turnKey(turn.user_id, turn.device_id, turn.session_id, turn.seq);
    const existing = this.turns.get(key);
    const next = { ...(existing ?? {}), ...turn };
    this.turns.set(key, next);
    return next;
  }

  async upsertTurns(turns) {
    for (const turn of turns) await this.upsertTurn(turn);
  }

  async pruneHotTurnCache(options = {}) {
    const perSession = positiveInteger(options.perSession ?? options.per_session, 0);
    const perUser = positiveInteger(options.perUser ?? options.per_user, 0);
    const inactiveBefore = String(options.inactiveBefore ?? options.inactive_before ?? "");
    const userIDs = new Set((options.userIDs ?? options.user_ids ?? []).map((id) => String(id)).filter(Boolean));
    const sessionKeys = new Set((options.sessionKeys ?? options.session_keys ?? []).map((key) => String(key)).filter(Boolean));
    const affected = new Map();
    const markAffected = (turn) => {
      const key = sessionKey(turn.user_id, turn.device_id, turn.session_id);
      affected.set(key, {
        user_id: turn.user_id,
        device_id: turn.device_id,
        session_id: turn.session_id,
      });
    };
    if (inactiveBefore) {
      const staleSessions = new Set([...this.sessions.values()]
        .filter((session) => (!userIDs.size || userIDs.has(String(session.user_id))) && String(session.updated_at || "") < inactiveBefore)
        .map((session) => sessionKey(session.user_id, session.device_id, session.session_id)));
      if (staleSessions.size) {
        for (const [key, turn] of [...this.turns.entries()]) {
          if (staleSessions.has(sessionKey(turn.user_id, turn.device_id, turn.session_id))) {
            markAffected(turn);
            this.turns.delete(key);
          }
        }
      }
    }
    if (perSession > 0) {
      const groups = new Map();
      for (const turn of this.turns.values()) {
        if (userIDs.size && !userIDs.has(String(turn.user_id))) continue;
        const key = sessionKey(turn.user_id, turn.device_id, turn.session_id);
        if (sessionKeys.size && !sessionKeys.has(key)) continue;
        const group = groups.get(key) || [];
        group.push(turn);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        group.sort((left, right) => Number(left.seq) - Number(right.seq));
        for (const turn of group.slice(0, Math.max(0, group.length - perSession))) {
          markAffected(turn);
          this.turns.delete(turnKey(turn.user_id, turn.device_id, turn.session_id, turn.seq));
        }
      }
    }
    if (perUser > 0) {
      const groups = new Map();
      const sessionUpdatedAt = new Map([...this.sessions.values()].map((session) => [
        sessionKey(session.user_id, session.device_id, session.session_id),
        session.updated_at,
      ]));
      for (const turn of this.turns.values()) {
        if (userIDs.size && !userIDs.has(String(turn.user_id))) continue;
        const key = sessionKey(turn.user_id, turn.device_id, turn.session_id);
        const group = groups.get(turn.user_id) || [];
        group.push({ ...turn, session_updated_at: sessionUpdatedAt.get(key) || turn.updated_at });
        groups.set(turn.user_id, group);
      }
      for (const group of groups.values()) {
        group.sort(compareTurnsForHotCachePrune);
        for (const turn of group.slice(0, Math.max(0, group.length - perUser))) {
          markAffected(turn);
          this.turns.delete(turnKey(turn.user_id, turn.device_id, turn.session_id, turn.seq));
        }
      }
    }
    return [...affected.values()];
  }

  async listExistingTurnPayloads(turns = []) {
    const out = new Map();
    for (const turn of turns) {
      const key = turnKey(turn.user_id, turn.device_id, turn.session_id, turn.seq);
      const existing = this.turns.get(key);
      if (existing?.payload !== undefined) out.set(key, existing.payload);
    }
    return out;
  }

  async listExistingTurnKeys(turns = []) {
    const out = new Set();
    for (const turn of turns) {
      const key = turnKey(turn.user_id, turn.device_id, turn.session_id, turn.seq);
      if (this.turns.has(key)) out.add(key);
    }
    return out;
  }

  async listTurnPayloadsForWindow(userID, deviceID, sessionID, minSeq, maxSeq) {
    const min = Number(minSeq) || 0;
    const max = Number(maxSeq) || 0;
    if (min <= 0 || max < min) return [];
    return [...this.turns.values()]
      .filter((turn) =>
        turn.user_id === userID &&
        turn.device_id === deviceID &&
        turn.session_id === sessionID &&
        Number(turn.seq ?? 0) >= min &&
        Number(turn.seq ?? 0) <= max)
      .sort((left, right) => Number(left.seq) - Number(right.seq))
      .map((turn) => ({
        session_id: turn.session_id,
        seq: turn.seq,
        agent: turn.agent,
        kind: turn.kind,
        timestamp: turn.timestamp,
        payload: turn.payload,
      }));
  }

  async listTurnPayloadPointers(userID, deviceID, sessionIDs = []) {
    const wanted = new Set(sessionIDs.map((id) => String(id)).filter(Boolean));
    if (!wanted.size) return [];
    return [...this.turns.values()]
      .filter((turn) => turn.user_id === userID && turn.device_id === deviceID && wanted.has(String(turn.session_id)))
      .sort((left, right) => String(left.session_id).localeCompare(String(right.session_id)) || Number(left.seq) - Number(right.seq))
      .map((turn) => ({
        session_id: turn.session_id,
        seq: turn.seq,
        agent: turn.agent,
        kind: turn.kind,
        timestamp: turn.timestamp,
        payload: turn.payload,
      }));
  }

  async listTurns(userID, deviceID, sessionID, options = {}) {
    return filterTurnWindow(
      [...this.turns.values()]
        .filter((turn) => turn.user_id === userID && turn.device_id === deviceID && turn.session_id === sessionID)
        .sort((left, right) => Number(left.seq) - Number(right.seq)),
      options,
    );
  }

  async getSessionTurnStats(userID, deviceID, sessionID) {
    const turns = await this.listTurns(userID, deviceID, sessionID);
    if (!turns.length) return { count: 0, min_seq: 0, max_seq: 0, latest_contiguous_min_seq: 0 };
    let expected = Number(turns[turns.length - 1].seq ?? 0) || 0;
    let latestContiguousMinSeq = expected;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const seq = Number(turns[i].seq ?? 0) || 0;
      if (seq !== expected) break;
      latestContiguousMinSeq = seq;
      expected -= 1;
    }
    return {
      count: turns.length,
      min_seq: Number(turns[0].seq ?? 0) || 0,
      max_seq: Number(turns[turns.length - 1].seq ?? 0) || 0,
      latest_contiguous_min_seq: latestContiguousMinSeq,
    };
  }

  async getHistoryStorageUsage(userID, options = {}) {
    const deviceID = String(options.device_id ?? options.deviceID ?? "");
    const sessionID = String(options.session_id ?? options.sessionID ?? "");
    const turns = [...this.turns.values()].filter((turn) => {
      if (turn.user_id !== userID) return false;
      if (deviceID && turn.device_id !== deviceID) return false;
      if (sessionID && turn.session_id !== sessionID) return false;
      return true;
    });
    return historyStorageUsageFromTurns(turns);
  }

  async listSessionTurnsAfter(userID, deviceID, sessionID, afterSeq, limit) {
    const after = Number(afterSeq) || 0;
    return [...this.turns.values()]
      .filter((turn) =>
        turn.user_id === userID &&
        turn.device_id === deviceID &&
        turn.session_id === sessionID &&
        Number(turn.seq) > after)
      .sort((left, right) => Number(left.seq) - Number(right.seq))
      .slice(0, clampLimit(limit, 100));
  }

  async appendSessionEvent(event) {
    const next = {
      ...event,
      event_id: event.event_id || eventID(),
      payload: typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload ?? {}),
    };
    this.sessionEvents.push(next);
    this.pruneInMemorySessionEvents(next.user_id, next.device_id, next.session_id);
    return next;
  }

  async appendSessionEvents(events = []) {
    const out = [];
    const affected = new Set();
    for (const event of events) {
      const next = {
        ...event,
        event_id: event.event_id || eventID(),
        payload: typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload ?? {}),
      };
      this.sessionEvents.push(next);
      out.push(next);
      affected.add(`${next.user_id}\x00${next.device_id}\x00${next.session_id}`);
    }
    for (const key of affected) {
      const [userID, deviceID, sessionID] = key.split("\x00");
      this.pruneInMemorySessionEvents(userID, deviceID, sessionID);
    }
    return out;
  }

  pruneInMemorySessionEvents(userID, deviceID, sessionID) {
    const forSession = this.sessionEvents
      .filter((event) => event.user_id === userID && event.device_id === deviceID && event.session_id === sessionID)
      .sort((left, right) => String(right.event_id).localeCompare(String(left.event_id)));
    const keepSession = new Set(forSession.slice(0, maxSessionEventsPerSession).map((event) => event.event_id));
    this.sessionEvents = this.sessionEvents.filter((event) =>
      event.user_id !== userID ||
      event.device_id !== deviceID ||
      event.session_id !== sessionID ||
      keepSession.has(event.event_id));
    const forUser = this.sessionEvents
      .filter((event) => event.user_id === userID)
      .sort((left, right) => String(right.event_id).localeCompare(String(left.event_id)));
    const keepUser = new Set(forUser.slice(0, maxSessionEventsPerUser).map((event) => event.event_id));
    this.sessionEvents = this.sessionEvents.filter((event) => event.user_id !== userID || keepUser.has(event.event_id));
  }

  async listSessionEvents(userID, deviceID, sessionID, options = {}) {
    const after = String(options.after ?? "");
    const requestID = String(options.request_id ?? "");
    const limit = clampLimit(options.limit, 100);
    return this.sessionEvents
      .filter((event) => {
        if (event.user_id !== userID) return false;
        if (after && String(event.event_id) <= after) return false;
        if (requestID) return event.request_id === requestID;
        return event.device_id === deviceID && event.session_id === sessionID;
      })
      .sort((left, right) => String(left.event_id).localeCompare(String(right.event_id)))
      .slice(0, limit);
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
  constructor(db, options = {}) {
    this.db = db;
    this.sessionEventPruneByUser = new Map();
    this.sessionUpsertBatchSize = positiveInteger(options.sessionUpsertBatchSize, 40);
    this.turnUpsertBatchSize = positiveInteger(options.turnUpsertBatchSize, 100);
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

  async countSessionsByDeviceForUser(userID, deviceIDs = []) {
    const ids = [...new Set(deviceIDs.map((id) => String(id)).filter(Boolean))];
    if (ids.length === 0) return new Map();
    const out = new Map();
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = await this.db.prepare(`
        SELECT device_id, COUNT(*) AS session_count
        FROM sessions
        WHERE user_id = ? AND device_id IN (${placeholders})
        GROUP BY device_id
      `).bind(userID, ...chunk).all();
      for (const row of result.results ?? []) {
        out.set(String(row.device_id || ""), Number(row.session_count ?? row.count ?? 0) || 0);
      }
    }
    return out;
  }

  async patchDevice(userID, deviceID, patch) {
    const existing = await this.getDevice(deviceID);
    if (!existing || existing.user_id !== userID) return null;
    const next = { ...existing, ...patch };
    await this.upsertDevice(next);
    return this.getDevice(deviceID);
  }

  async touchDevice(deviceID, at) {
    const device = await this.getDevice(deviceID);
    if (!device) return null;
    if (!shouldPersistDeviceTouch(device.last_seen_at, at)) return device;
    await this.db.prepare(`UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE device_id = ?`).bind(at, at, deviceID).run();
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

  _upsertSessionStatement(session) {
    return this.db.prepare(`
      INSERT INTO sessions (
        user_id, computer_id, device_id, session_id, agent, runner_alias, cwd,
        snippet, first_message, title, last_seq, last_timestamp,
        channel_last_seen_at, sync_state, turn_count, last_sync_error,
        synced_turn_count, synced_min_seq, synced_max_seq, synced_window_hash, has_older_turns,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        synced_window_hash = excluded.synced_window_hash,
        has_older_turns = excluded.has_older_turns,
        updated_at = excluded.updated_at
      WHERE
        sessions.computer_id IS DISTINCT FROM excluded.computer_id OR
        sessions.agent IS DISTINCT FROM excluded.agent OR
        sessions.runner_alias IS DISTINCT FROM excluded.runner_alias OR
        sessions.cwd IS DISTINCT FROM excluded.cwd OR
        sessions.snippet IS DISTINCT FROM excluded.snippet OR
        sessions.first_message IS DISTINCT FROM excluded.first_message OR
        sessions.title IS DISTINCT FROM excluded.title OR
        sessions.last_seq IS DISTINCT FROM excluded.last_seq OR
        sessions.last_timestamp IS DISTINCT FROM excluded.last_timestamp OR
        sessions.channel_last_seen_at IS DISTINCT FROM excluded.channel_last_seen_at OR
        sessions.sync_state IS DISTINCT FROM excluded.sync_state OR
        sessions.turn_count IS DISTINCT FROM excluded.turn_count OR
        sessions.last_sync_error IS DISTINCT FROM excluded.last_sync_error OR
        sessions.synced_turn_count IS DISTINCT FROM excluded.synced_turn_count OR
        sessions.synced_min_seq IS DISTINCT FROM excluded.synced_min_seq OR
        sessions.synced_max_seq IS DISTINCT FROM excluded.synced_max_seq OR
        sessions.synced_window_hash IS DISTINCT FROM excluded.synced_window_hash OR
        sessions.has_older_turns IS DISTINCT FROM excluded.has_older_turns
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
      session.synced_window_hash ?? "",
      session.has_older_turns ? 1 : 0,
      session.updated_at,
    );
  }

  async upsertSession(session) {
    await this._upsertSessionStatement(session).run();
    return session;
  }

  async upsertSessions(sessions) {
    const deduped = dedupeSessionRows(sessions);
    if (!deduped.length) return;
    // The default keeps the batch below SQLite's conservative 999
    // bind-parameter floor: sessions has 22 columns, so 40 rows => 880
    // parameters. Runtime adapters with stricter limits can lower this via
    // the constructor without changing the sync path.
    const CHUNK = this.sessionUpsertBatchSize;
    for (let i = 0; i < deduped.length; i += CHUNK) {
      await this._upsertSessionsStatement(deduped.slice(i, i + CHUNK)).run();
    }
  }

  _upsertSessionsStatement(sessions) {
    if (sessions.length === 1) return this._upsertSessionStatement(sessions[0]);
    const placeholders = sessions
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .join(", ");
    return this.db.prepare(`
      INSERT INTO sessions (
        user_id, computer_id, device_id, session_id, agent, runner_alias, cwd,
        snippet, first_message, title, last_seq, last_timestamp,
        channel_last_seen_at, sync_state, turn_count, last_sync_error,
        synced_turn_count, synced_min_seq, synced_max_seq, synced_window_hash, has_older_turns,
        updated_at
      )
      VALUES ${placeholders}
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
        synced_window_hash = excluded.synced_window_hash,
        has_older_turns = excluded.has_older_turns,
        updated_at = excluded.updated_at
      WHERE
        sessions.computer_id IS DISTINCT FROM excluded.computer_id OR
        sessions.agent IS DISTINCT FROM excluded.agent OR
        sessions.runner_alias IS DISTINCT FROM excluded.runner_alias OR
        sessions.cwd IS DISTINCT FROM excluded.cwd OR
        sessions.snippet IS DISTINCT FROM excluded.snippet OR
        sessions.first_message IS DISTINCT FROM excluded.first_message OR
        sessions.title IS DISTINCT FROM excluded.title OR
        sessions.last_seq IS DISTINCT FROM excluded.last_seq OR
        sessions.last_timestamp IS DISTINCT FROM excluded.last_timestamp OR
        sessions.channel_last_seen_at IS DISTINCT FROM excluded.channel_last_seen_at OR
        sessions.sync_state IS DISTINCT FROM excluded.sync_state OR
        sessions.turn_count IS DISTINCT FROM excluded.turn_count OR
        sessions.last_sync_error IS DISTINCT FROM excluded.last_sync_error OR
        sessions.synced_turn_count IS DISTINCT FROM excluded.synced_turn_count OR
        sessions.synced_min_seq IS DISTINCT FROM excluded.synced_min_seq OR
        sessions.synced_max_seq IS DISTINCT FROM excluded.synced_max_seq OR
        sessions.synced_window_hash IS DISTINCT FROM excluded.synced_window_hash OR
        sessions.has_older_turns IS DISTINCT FROM excluded.has_older_turns
    `).bind(...sessions.flatMap(sessionUpsertValues));
  }

  async deleteMissingDeviceSessions(userID, deviceID, keepSessionIDs) {
    return await this.deleteMissingDeviceSessionsFromExisting(userID, deviceID, keepSessionIDs, await this.listDeviceSessions(userID, deviceID));
  }

  async deleteMissingDeviceSessionsFromExisting(userID, deviceID, keepSessionIDs, existingSessions) {
    if (keepSessionIDs.length === 0) {
      await this.db.prepare(`DELETE FROM session_turns WHERE user_id = ? AND device_id = ?`).bind(userID, deviceID).run();
      await this.db.prepare(`DELETE FROM sessions WHERE user_id = ? AND device_id = ?`).bind(userID, deviceID).run();
      return existingSessions.length;
    }
    const keep = new Set(keepSessionIDs.map((id) => String(id)));
    const stale = existingSessions
      .map((row) => String(row.session_id))
      .filter((id) => !keep.has(id));
    if (stale.length === 0) return 0;
    const CHUNK = 50;
    for (let i = 0; i < stale.length; i += CHUNK) {
      const batch = stale.slice(i, i + CHUNK);
      const placeholders = batch.map(() => "?").join(", ");
      await this.db.prepare(`
        DELETE FROM session_turns
        WHERE user_id = ? AND device_id = ? AND session_id IN (${placeholders})
      `).bind(userID, deviceID, ...batch).run();
      await this.db.prepare(`
        DELETE FROM sessions
        WHERE user_id = ? AND device_id = ? AND session_id IN (${placeholders})
      `).bind(userID, deviceID, ...batch).run();
    }
    return stale.length;
  }

  async listSessionsForUser(userID) {
    const result = await this.db.prepare(`
      SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC, device_id ASC, session_id ASC
    `).bind(userID).all();
    return (result.results ?? []).map(normalizeSessionRow);
  }

  async listSessionCatalogPage(userID, options = {}) {
    const limit = clampLimit(options.limit, 100);
    const after = options.after ?? null;
    const result = after
      ? await this.db.prepare(`
          SELECT * FROM sessions
          WHERE user_id = ?
            AND (
              updated_at < ?
              OR (
                updated_at = ?
                AND (
                  device_id > ?
                  OR (device_id = ? AND session_id > ?)
                )
              )
            )
          ORDER BY updated_at DESC, device_id ASC, session_id ASC
          LIMIT ?
        `).bind(userID, after.updated_at, after.updated_at, after.device_id, after.device_id, after.session_id, limit).all()
      : await this.db.prepare(`
          SELECT * FROM sessions
          WHERE user_id = ?
          ORDER BY updated_at DESC, device_id ASC, session_id ASC
          LIMIT ?
        `).bind(userID, limit).all();
    return (result.results ?? []).map(normalizeSessionRow);
  }

  async listDeviceSessions(userID, deviceID) {
    const result = await this.db.prepare(`
      SELECT * FROM sessions WHERE user_id = ? AND device_id = ? ORDER BY updated_at DESC
    `).bind(userID, deviceID).all();
    return (result.results ?? []).map(normalizeSessionRow);
  }

  async appendSessionCatalogChange(change) {
    const row = normalizeSessionCatalogChange(change);
    await this._appendSessionCatalogChangeStatement(row).run();
    await this.pruneSessionCatalogChangesIfDue(row.user_id);
    return row;
  }

  async appendSessionCatalogChanges(changes = []) {
    if (!changes.length) return [];
    const out = [];
    const userIDs = new Set();
    for (const change of changes) {
      const row = normalizeSessionCatalogChange(change);
      await this._appendSessionCatalogChangeStatement(row).run();
      out.push(row);
      if (row.user_id) userIDs.add(row.user_id);
    }
    for (const userID of userIDs) await this.pruneSessionCatalogChangesIfDue(userID);
    return out;
  }

  _appendSessionCatalogChangeStatement(change) {
    return this.db.prepare(`
      INSERT INTO session_catalog_changes (change_id, user_id, device_id, session_id, change_type, session_row, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      change.change_id,
      change.user_id,
      change.device_id,
      change.session_id,
      change.change_type,
      change.session_row,
      change.created_at,
    );
  }

  async listSessionCatalogChanges(userID, options = {}) {
    const since = String(options.since ?? "");
    const limit = clampLimit(options.limit, 100);
    const result = await this.db.prepare(`
      SELECT * FROM session_catalog_changes
      WHERE user_id = ? AND change_id > ?
      ORDER BY change_id ASC
      LIMIT ?
    `).bind(userID, since, limit).all();
    return result.results ?? [];
  }

  async currentSessionCatalogCursor(userID) {
    return (await this.sessionCatalogCursorBounds(userID)).latest;
  }

  async sessionCatalogCursorBounds(userID) {
    const row = await this.db.prepare(`
      SELECT MIN(change_id) AS oldest, MAX(change_id) AS latest
      FROM session_catalog_changes
      WHERE user_id = ?
    `).bind(userID).first();
    return {
      oldest: String(row?.oldest || ""),
      latest: String(row?.latest || "") || emptyCatalogChangeCursor(),
    };
  }

  async pruneSessionCatalogChanges(userID) {
    await this.db.prepare(`
      DELETE FROM session_catalog_changes
      WHERE user_id = ?
        AND change_id NOT IN (
          SELECT change_id FROM session_catalog_changes
          WHERE user_id = ?
          ORDER BY change_id DESC
          LIMIT 10000
        )
    `).bind(userID, userID).run();
  }

  async pruneSessionCatalogChangesIfDue(userID, now = Date.now()) {
    this.sessionCatalogPruneByUser ??= new Map();
    const last = this.sessionCatalogPruneByUser.get(userID) ?? 0;
    if (now - last < 60_000) return;
    this.sessionCatalogPruneByUser.set(userID, now);
    await this.pruneSessionCatalogChanges(userID);
  }

  async listDeviceSessionSyncSnapshots(userID, deviceID) {
    const result = await this.db.prepare(`
      SELECT
        user_id, computer_id, device_id, session_id, agent, runner_alias, cwd,
        snippet, first_message, title, last_seq, last_timestamp,
        channel_last_seen_at, sync_state, turn_count, last_sync_error,
        synced_turn_count, synced_min_seq, synced_max_seq, synced_window_hash, has_older_turns,
        updated_at
      FROM sessions
      WHERE user_id = ? AND device_id = ?
      ORDER BY updated_at DESC
    `).bind(userID, deviceID).all();
    return (result.results ?? []).map(normalizeSessionRow);
  }

  async listDeviceSessionSyncSnapshotsByIDs(userID, deviceID, sessionIDs = []) {
    const ids = [...new Set(sessionIDs.map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) return [];
    const out = [];
    const CHUNK = 50;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = await this.db.prepare(`
        SELECT
          user_id, computer_id, device_id, session_id, agent, runner_alias, cwd,
          snippet, first_message, title, last_seq, last_timestamp,
          channel_last_seen_at, sync_state, turn_count, last_sync_error,
          synced_turn_count, synced_min_seq, synced_max_seq, synced_window_hash, has_older_turns,
          updated_at
        FROM sessions
        WHERE user_id = ? AND device_id = ? AND session_id IN (${placeholders})
      `).bind(userID, deviceID, ...chunk).all();
      out.push(...((result.results ?? []).map(normalizeSessionRow)));
    }
    return out;
  }

  async listDeviceSessionHintSnapshots(userID, deviceID) {
    const result = await this.db.prepare(`
      SELECT
        user_id, device_id, session_id, turn_count, synced_turn_count,
        synced_min_seq, synced_max_seq, synced_window_hash, has_older_turns
      FROM sessions
      WHERE user_id = ? AND device_id = ?
    `).bind(userID, deviceID).all();
    return (result.results ?? []).map(normalizeSessionRow);
  }

  async getSession(userID, deviceID, sessionID) {
    const row = await this.db.prepare(`
      SELECT * FROM sessions WHERE user_id = ? AND device_id = ? AND session_id = ?
    `).bind(userID, deviceID, sessionID).first();
    return row ? normalizeSessionRow(row) : null;
  }

  // ---- UI preferences (pin / archive / rename) -------------------------
  // Written only by the web; daemon sync never touches these tables.

  async listSessionPrefsForUser(userID) {
    const result = await this.db.prepare(`
      SELECT * FROM session_prefs WHERE user_id = ?
    `).bind(userID).all();
    return result.results ?? [];
  }

  async listSessionPrefsForDevice(userID, deviceID) {
    const result = await this.db.prepare(`
      SELECT * FROM session_prefs WHERE user_id = ? AND device_id = ?
    `).bind(userID, deviceID).all();
    return result.results ?? [];
  }

  async upsertSessionPref(pref) {
    // COALESCE keeps fields the caller didn't send (null binds) unchanged,
    // so a pin toggle can't clobber a rename and vice versa.
    await this.db.prepare(`
      INSERT INTO session_prefs (user_id, device_id, session_id, pinned, archived, custom_title, updated_at)
      VALUES (?, ?, ?, COALESCE(?, 0), COALESCE(?, 0), ?, ?)
      ON CONFLICT(user_id, device_id, session_id) DO UPDATE SET
        pinned = COALESCE(?, pinned),
        archived = COALESCE(?, archived),
        custom_title = COALESCE(?, custom_title),
        updated_at = ?
    `).bind(
      pref.user_id,
      pref.device_id,
      pref.session_id,
      pref.pinned ?? null,
      pref.archived ?? null,
      pref.custom_title ?? null,
      pref.updated_at,
      pref.pinned ?? null,
      pref.archived ?? null,
      pref.custom_title ?? null,
      pref.updated_at,
    ).run();
    return await this.db.prepare(`
      SELECT * FROM session_prefs WHERE user_id = ? AND device_id = ? AND session_id = ?
    `).bind(pref.user_id, pref.device_id, pref.session_id).first();
  }

  async deleteSessionPref(userID, deviceID, sessionID) {
    await this.db.prepare(`
      DELETE FROM session_prefs WHERE user_id = ? AND device_id = ? AND session_id = ?
    `).bind(userID, deviceID, sessionID).run();
  }

  async listSessionOpenHintsForUser(userID) {
    const result = await this.db.prepare(`
      SELECT * FROM session_open_hints WHERE user_id = ?
    `).bind(userID).all();
    return result.results ?? [];
  }

  async listSessionOpenHintsForDevice(userID, deviceID) {
    const result = await this.db.prepare(`
      SELECT * FROM session_open_hints WHERE user_id = ? AND device_id = ?
    `).bind(userID, deviceID).all();
    return result.results ?? [];
  }

  async upsertSessionOpenHint(hint) {
    await this.db.prepare(`
      INSERT INTO session_open_hints (user_id, device_id, session_id, last_opened_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, device_id, session_id) DO UPDATE SET
        last_opened_at = excluded.last_opened_at,
        updated_at = excluded.updated_at
    `).bind(
      hint.user_id,
      hint.device_id,
      hint.session_id,
      hint.last_opened_at,
      hint.updated_at,
    ).run();
    return await this.db.prepare(`
      SELECT * FROM session_open_hints WHERE user_id = ? AND device_id = ? AND session_id = ?
    `).bind(hint.user_id, hint.device_id, hint.session_id).first();
  }

  async deleteSessionOpenHint(userID, deviceID, sessionID) {
    await this.db.prepare(`
      DELETE FROM session_open_hints WHERE user_id = ? AND device_id = ? AND session_id = ?
    `).bind(userID, deviceID, sessionID).run();
  }

  async listProjectPrefsForUser(userID) {
    const result = await this.db.prepare(`
      SELECT * FROM project_prefs WHERE user_id = ?
    `).bind(userID).all();
    return result.results ?? [];
  }

  async upsertProjectPref(pref) {
    await this.db.prepare(`
      INSERT INTO project_prefs (user_id, device_id, cwd, pinned, archived, removed, custom_label, updated_at)
      VALUES (?, ?, ?, COALESCE(?, 0), COALESCE(?, 0), COALESCE(?, 0), ?, ?)
      ON CONFLICT(user_id, device_id, cwd) DO UPDATE SET
        pinned = COALESCE(?, pinned),
        archived = COALESCE(?, archived),
        removed = COALESCE(?, removed),
        custom_label = COALESCE(?, custom_label),
        updated_at = ?
    `).bind(
      pref.user_id,
      pref.device_id,
      pref.cwd,
      pref.pinned ?? null,
      pref.archived ?? null,
      pref.removed ?? null,
      pref.custom_label ?? null,
      pref.updated_at,
      pref.pinned ?? null,
      pref.archived ?? null,
      pref.removed ?? null,
      pref.custom_label ?? null,
      pref.updated_at,
    ).run();
    return await this.db.prepare(`
      SELECT * FROM project_prefs WHERE user_id = ? AND device_id = ? AND cwd = ?
    `).bind(pref.user_id, pref.device_id, pref.cwd).first();
  }

  async deleteSessionData(userID, deviceID, sessionID) {
    await this.db.batch([
      this.db.prepare(`DELETE FROM session_turns WHERE user_id = ? AND device_id = ? AND session_id = ?`).bind(userID, deviceID, sessionID),
      this.db.prepare(`DELETE FROM sessions WHERE user_id = ? AND device_id = ? AND session_id = ?`).bind(userID, deviceID, sessionID),
      this.db.prepare(`DELETE FROM session_prefs WHERE user_id = ? AND device_id = ? AND session_id = ?`).bind(userID, deviceID, sessionID),
      this.db.prepare(`DELETE FROM session_open_hints WHERE user_id = ? AND device_id = ? AND session_id = ?`).bind(userID, deviceID, sessionID),
    ]);
  }

  _upsertTurnStatement(turn) {
    return this.db.prepare(`
      INSERT INTO session_turns (user_id, device_id, session_id, seq, agent, kind, timestamp, payload, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, device_id, session_id, seq) DO UPDATE SET
        agent = excluded.agent,
        kind = excluded.kind,
        timestamp = excluded.timestamp,
        payload = excluded.payload,
        updated_at = excluded.updated_at
      WHERE
        session_turns.agent IS DISTINCT FROM excluded.agent OR
        session_turns.kind IS DISTINCT FROM excluded.kind OR
        session_turns.timestamp IS DISTINCT FROM excluded.timestamp OR
        session_turns.payload IS DISTINCT FROM excluded.payload
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
    );
  }

  async upsertTurn(turn) {
    await this._upsertTurnStatement(turn).run();
    return turn;
  }

  async upsertTurns(turns) {
    const deduped = dedupeTurnRows(turns);
    if (!deduped.length) return;
    // 100 rows x 9 columns stays below SQLite's conservative bind limit.
    const CHUNK = this.turnUpsertBatchSize;
    for (let i = 0; i < deduped.length; i += CHUNK) {
      await this._upsertTurnsStatement(deduped.slice(i, i + CHUNK)).run();
    }
  }

  async pruneHotTurnCache(options = {}) {
    const perSession = positiveInteger(options.perSession ?? options.per_session, 0);
    const perUser = positiveInteger(options.perUser ?? options.per_user, 0);
    const inactiveBefore = String(options.inactiveBefore ?? options.inactive_before ?? "");
    const userIDs = [...new Set((options.userIDs ?? options.user_ids ?? []).map((id) => String(id)).filter(Boolean))];
    const sessionKeys = parseSessionKeys(options.sessionKeys ?? options.session_keys ?? []);
    const affected = new Map();
    const addAffectedRows = (rows = []) => {
      for (const row of rows) {
        const key = sessionKey(row.user_id, row.device_id, row.session_id);
        affected.set(key, {
          user_id: row.user_id,
          device_id: row.device_id,
          session_id: row.session_id,
        });
      }
    };
    if (inactiveBefore) {
      const userClause = userIDs.length ? `AND user_id IN (${userIDs.map(() => "?").join(", ")})` : "";
      const stale = await this.db.prepare(`
        SELECT user_id, device_id, session_id
        FROM session_turns
        WHERE (user_id, device_id, session_id) IN (
          SELECT user_id, device_id, session_id
          FROM sessions
          WHERE updated_at < ?
          ${userClause}
        )
        GROUP BY user_id, device_id, session_id
      `).bind(inactiveBefore, ...userIDs).all();
      addAffectedRows(stale.results ?? []);
      await this.db.prepare(`
        DELETE FROM session_turns
        WHERE (user_id, device_id, session_id) IN (
          SELECT user_id, device_id, session_id
          FROM sessions
          WHERE updated_at < ?
          ${userClause}
        )
      `).bind(inactiveBefore, ...userIDs).run();
    }
    if (perSession > 0) {
      const scoped = sessionScopeSQL("session_turns", { userIDs, sessionKeys });
      const clauses = scoped.where ? `WHERE ${scoped.where}` : "";
      const stale = await this.db.prepare(`
        SELECT user_id, device_id, session_id
        FROM (
          SELECT
            user_id,
            device_id,
            session_id,
            seq,
            ROW_NUMBER() OVER (
              PARTITION BY user_id, device_id, session_id
              ORDER BY seq DESC
            ) AS rn
          FROM session_turns
          ${clauses}
        )
        WHERE rn > ?
        GROUP BY user_id, device_id, session_id
      `).bind(...scoped.binds, perSession).all();
      addAffectedRows(stale.results ?? []);
      await this.db.prepare(`
        DELETE FROM session_turns
        WHERE (user_id, device_id, session_id, seq) IN (
          SELECT user_id, device_id, session_id, seq
          FROM (
            SELECT
              user_id,
              device_id,
              session_id,
              seq,
              ROW_NUMBER() OVER (
                PARTITION BY user_id, device_id, session_id
                ORDER BY seq DESC
              ) AS rn
            FROM session_turns
            ${clauses}
          )
          WHERE rn > ?
        )
      `).bind(...scoped.binds, perSession).run();
    }
    if (perUser > 0) {
      const clauses = userIDs.length ? `WHERE turns.user_id IN (${userIDs.map(() => "?").join(", ")})` : "";
      const stale = await this.db.prepare(`
        SELECT user_id, device_id, session_id
        FROM (
          SELECT
            turns.user_id,
            turns.device_id,
            turns.session_id,
            turns.seq,
            ROW_NUMBER() OVER (
              PARTITION BY turns.user_id
              ORDER BY COALESCE(sessions.updated_at, turns.updated_at) DESC, turns.seq DESC
            ) AS rn
          FROM session_turns turns
          LEFT JOIN sessions
            ON sessions.user_id = turns.user_id
           AND sessions.device_id = turns.device_id
           AND sessions.session_id = turns.session_id
          ${clauses}
        )
        WHERE rn > ?
        GROUP BY user_id, device_id, session_id
      `).bind(...userIDs, perUser).all();
      addAffectedRows(stale.results ?? []);
      await this.db.prepare(`
        DELETE FROM session_turns
        WHERE (user_id, device_id, session_id, seq) IN (
          SELECT user_id, device_id, session_id, seq
          FROM (
            SELECT
              turns.user_id,
              turns.device_id,
              turns.session_id,
              turns.seq,
              ROW_NUMBER() OVER (
                PARTITION BY turns.user_id
                ORDER BY COALESCE(sessions.updated_at, turns.updated_at) DESC, turns.seq DESC
              ) AS rn
            FROM session_turns turns
            LEFT JOIN sessions
              ON sessions.user_id = turns.user_id
             AND sessions.device_id = turns.device_id
             AND sessions.session_id = turns.session_id
            ${clauses}
          )
          WHERE rn > ?
        )
      `).bind(...userIDs, perUser).run();
    }
    return [...affected.values()];
  }

  async listExistingTurnPayloads(turns = []) {
    const deduped = dedupeTurnRows(turns);
    if (!deduped.length) return new Map();
    const bySession = new Map();
    for (const turn of deduped) {
      const key = sessionKey(turn.user_id, turn.device_id, turn.session_id);
      const entry = bySession.get(key) || {
        user_id: turn.user_id,
        device_id: turn.device_id,
        session_id: turn.session_id,
        seqs: [],
      };
      entry.seqs.push(Number(turn.seq) || 0);
      bySession.set(key, entry);
    }
    const out = new Map();
    for (const entry of bySession.values()) {
      const seqs = [...new Set(entry.seqs.filter((seq) => seq > 0))];
      for (let i = 0; i < seqs.length; i += this.turnUpsertBatchSize) {
        const chunk = seqs.slice(i, i + this.turnUpsertBatchSize);
        if (!chunk.length) continue;
        const placeholders = chunk.map(() => "?").join(", ");
        const result = await this.db.prepare(`
          SELECT user_id, device_id, session_id, seq, payload
          FROM session_turns
          WHERE user_id = ? AND device_id = ? AND session_id = ? AND seq IN (${placeholders})
        `).bind(entry.user_id, entry.device_id, entry.session_id, ...chunk).all();
        for (const row of result.results ?? []) {
          out.set(turnKey(row.user_id, row.device_id, row.session_id, row.seq), row.payload);
        }
      }
    }
    return out;
  }

  async listExistingTurnKeys(turns = []) {
    const deduped = dedupeTurnRows(turns);
    if (!deduped.length) return new Set();
    const bySession = new Map();
    for (const turn of deduped) {
      const key = sessionKey(turn.user_id, turn.device_id, turn.session_id);
      const entry = bySession.get(key) || {
        user_id: turn.user_id,
        device_id: turn.device_id,
        session_id: turn.session_id,
        seqs: [],
      };
      entry.seqs.push(Number(turn.seq) || 0);
      bySession.set(key, entry);
    }
    const out = new Set();
    for (const entry of bySession.values()) {
      const seqs = [...new Set(entry.seqs.filter((seq) => seq > 0))];
      for (let i = 0; i < seqs.length; i += this.turnUpsertBatchSize) {
        const chunk = seqs.slice(i, i + this.turnUpsertBatchSize);
        if (!chunk.length) continue;
        const placeholders = chunk.map(() => "?").join(", ");
        const result = await this.db.prepare(`
          SELECT user_id, device_id, session_id, seq
          FROM session_turns
          WHERE user_id = ? AND device_id = ? AND session_id = ? AND seq IN (${placeholders})
        `).bind(entry.user_id, entry.device_id, entry.session_id, ...chunk).all();
        for (const row of result.results ?? []) {
          out.add(turnKey(row.user_id, row.device_id, row.session_id, row.seq));
        }
      }
    }
    return out;
  }

  async listTurnPayloadsForWindow(userID, deviceID, sessionID, minSeq, maxSeq) {
    const min = Number(minSeq) || 0;
    const max = Number(maxSeq) || 0;
    if (min <= 0 || max < min) return [];
    const result = await this.db.prepare(`
      SELECT session_id, seq, agent, kind, timestamp, payload
      FROM session_turns
      WHERE user_id = ? AND device_id = ? AND session_id = ? AND seq >= ? AND seq <= ?
      ORDER BY seq ASC
    `).bind(userID, deviceID, sessionID, min, max).all();
    return result.results ?? [];
  }

  async listTurnPayloadPointers(userID, deviceID, sessionIDs = []) {
    const ids = [...new Set(sessionIDs.map((id) => String(id)).filter(Boolean))];
    if (!ids.length) return [];
    const out = [];
    for (let i = 0; i < ids.length; i += this.turnUpsertBatchSize) {
      const chunk = ids.slice(i, i + this.turnUpsertBatchSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = await this.db.prepare(`
        SELECT session_id, seq, agent, kind, timestamp, payload
        FROM session_turns
        WHERE user_id = ? AND device_id = ? AND session_id IN (${placeholders})
        ORDER BY session_id ASC, seq ASC
      `).bind(userID, deviceID, ...chunk).all();
      out.push(...(result.results ?? []));
    }
    return out;
  }

  _upsertTurnsStatement(turns) {
    if (turns.length === 1) return this._upsertTurnStatement(turns[0]);
    const placeholders = turns
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .join(", ");
    return this.db.prepare(`
      INSERT INTO session_turns (user_id, device_id, session_id, seq, agent, kind, timestamp, payload, updated_at)
      VALUES ${placeholders}
      ON CONFLICT(user_id, device_id, session_id, seq) DO UPDATE SET
        agent = excluded.agent,
        kind = excluded.kind,
        timestamp = excluded.timestamp,
        payload = excluded.payload,
        updated_at = excluded.updated_at
      WHERE
        session_turns.agent IS DISTINCT FROM excluded.agent OR
        session_turns.kind IS DISTINCT FROM excluded.kind OR
        session_turns.timestamp IS DISTINCT FROM excluded.timestamp OR
        session_turns.payload IS DISTINCT FROM excluded.payload
    `).bind(...turns.flatMap(turnUpsertValues));
  }

  async listTurns(userID, deviceID, sessionID, options = {}) {
    const limit = Number(options.limit ?? 0) || 0;
    const beforeSeq = Number(options.beforeSeq ?? options.before_seq ?? 0) || 0;
    if (limit > 0) {
      const result = beforeSeq > 0
        ? await this.db.prepare(`
            SELECT * FROM (
              SELECT * FROM session_turns
              WHERE user_id = ? AND device_id = ? AND session_id = ? AND seq < ?
              ORDER BY seq DESC
              LIMIT ?
            )
            ORDER BY seq ASC
          `).bind(userID, deviceID, sessionID, beforeSeq, clampLimit(limit, 100)).all()
        : await this.db.prepare(`
            SELECT * FROM (
              SELECT * FROM session_turns
              WHERE user_id = ? AND device_id = ? AND session_id = ?
              ORDER BY seq DESC
              LIMIT ?
            )
            ORDER BY seq ASC
          `).bind(userID, deviceID, sessionID, clampLimit(limit, 100)).all();
      return result.results ?? [];
    }
    const result = await this.db.prepare(`
      SELECT * FROM session_turns
      WHERE user_id = ? AND device_id = ? AND session_id = ?
      ORDER BY seq ASC
    `).bind(userID, deviceID, sessionID).all();
    return result.results ?? [];
  }

  async getSessionTurnStats(userID, deviceID, sessionID) {
    const row = await this.db.prepare(`
      SELECT COUNT(*) AS count, MIN(seq) AS min_seq, MAX(seq) AS max_seq
      FROM session_turns
      WHERE user_id = ? AND device_id = ? AND session_id = ?
    `).bind(userID, deviceID, sessionID).first();
    const maxSeq = Number(row?.max_seq ?? 0) || 0;
    let latestContiguousMinSeq = 0;
    if (maxSeq > 0) {
      const contiguous = await this.db.prepare(`
        WITH ordered AS (
          SELECT seq, ROW_NUMBER() OVER (ORDER BY seq DESC) AS rn
          FROM session_turns
          WHERE user_id = ? AND device_id = ? AND session_id = ?
        )
        SELECT MIN(seq) AS latest_contiguous_min_seq
        FROM ordered
        WHERE seq + rn = ?
      `).bind(userID, deviceID, sessionID, maxSeq + 1).first();
      latestContiguousMinSeq = Number(contiguous?.latest_contiguous_min_seq ?? 0) || 0;
    }
    return {
      count: Number(row?.count ?? 0) || 0,
      min_seq: Number(row?.min_seq ?? 0) || 0,
      max_seq: maxSeq,
      latest_contiguous_min_seq: latestContiguousMinSeq,
    };
  }

  async getHistoryStorageUsage(userID, options = {}) {
    const deviceID = String(options.device_id ?? options.deviceID ?? "");
    const sessionID = String(options.session_id ?? options.sessionID ?? "");
    const clauses = ["user_id = ?"];
    const binds = [userID];
    if (deviceID) {
      clauses.push("device_id = ?");
      binds.push(deviceID);
    }
    if (sessionID) {
      clauses.push("session_id = ?");
      binds.push(sessionID);
    }
    const where = clauses.join(" AND ");
    const payloadBytesSQL = typeof this.db.payloadByteLengthSQL === "function"
      ? this.db.payloadByteLengthSQL("payload")
      : "LENGTH(CAST(payload AS BLOB))";
    const summaries = await this.db.prepare(`
      SELECT
        session_id,
        COUNT(*) AS turn_count,
        COALESCE(SUM(${payloadBytesSQL}), 0) AS primary_payload_bytes
      FROM session_turns
      WHERE ${where}
      GROUP BY session_id
    `).bind(...binds).all();
    const pointers = await this.db.prepare(`
      SELECT session_id, seq, payload
      FROM session_turns
      WHERE ${where}
        AND payload LIKE '%"pockly_payload_ref"%'
    `).bind(...binds).all();
    return historyStorageUsageFromSQLSummaries(summaries.results ?? [], pointers.results ?? []);
  }

  async listSessionTurnsAfter(userID, deviceID, sessionID, afterSeq, limit) {
    const result = await this.db.prepare(`
      SELECT * FROM session_turns
      WHERE user_id = ? AND device_id = ? AND session_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).bind(userID, deviceID, sessionID, Number(afterSeq) || 0, clampLimit(limit, 100)).all();
    return result.results ?? [];
  }

  async appendSessionEvent(event) {
    const payload = typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload ?? {});
    const eventIDValue = event.event_id || eventID();
    await this.db.prepare(`
      INSERT INTO session_events (event_id, user_id, device_id, session_id, request_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventIDValue,
      event.user_id,
      event.device_id,
      event.session_id,
      event.request_id ?? null,
      event.event_type,
      payload,
      event.created_at,
    ).run();
    await this.pruneSessionEventsIfDue(event.user_id);
    return { ...event, event_id: eventIDValue, payload };
  }

  async appendSessionEvents(events = []) {
    if (!events.length) return [];
    const out = [];
    const userIDs = new Set();
    const statements = events.map((event) => {
      const payload = typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload ?? {});
      const eventIDValue = event.event_id || eventID();
      out.push({ ...event, event_id: eventIDValue, payload });
      if (event.user_id) userIDs.add(event.user_id);
      return this.db.prepare(`
        INSERT INTO session_events (event_id, user_id, device_id, session_id, request_id, event_type, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        eventIDValue,
        event.user_id,
        event.device_id,
        event.session_id,
        event.request_id ?? null,
        event.event_type,
        payload,
        event.created_at,
      );
    });
    await this.db.batch(statements);
    await Promise.all([...userIDs].map((userID) => this.pruneSessionEventsIfDue(userID)));
    return out;
  }

  async listSessionEvents(userID, deviceID, sessionID, options = {}) {
    const after = String(options.after ?? "");
    const requestID = String(options.request_id ?? "");
    const limit = clampLimit(options.limit, 100);
    const result = requestID
      ? await this.db.prepare(`
          SELECT * FROM session_events
          WHERE user_id = ? AND request_id = ? AND event_id > ?
          ORDER BY event_id ASC
          LIMIT ?
        `).bind(userID, requestID, after, limit).all()
      : await this.db.prepare(`
          SELECT * FROM session_events
          WHERE user_id = ? AND device_id = ? AND session_id = ? AND event_id > ?
          ORDER BY event_id ASC
          LIMIT ?
        `).bind(userID, deviceID, sessionID, after, limit).all();
    return result.results ?? [];
  }

  async pruneSessionEvents(userID) {
    await this.db.prepare(`
      DELETE FROM session_events
      WHERE user_id = ?
        AND event_id IN (
          SELECT event_id
          FROM (
            SELECT
              event_id,
              ROW_NUMBER() OVER (
                PARTITION BY user_id, device_id, session_id
                ORDER BY event_id DESC
              ) AS rn
            FROM session_events
            WHERE user_id = ?
          )
          WHERE rn > ${maxSessionEventsPerSession}
        )
    `).bind(userID, userID).run();
    await this.db.prepare(`
      DELETE FROM session_events
      WHERE user_id = ?
        AND event_id NOT IN (
          SELECT event_id FROM session_events
          WHERE user_id = ?
          ORDER BY event_id DESC
          LIMIT ${maxSessionEventsPerUser}
        )
    `).bind(userID, userID).run();
  }

  async pruneSessionEventsIfDue(userID, now = Date.now()) {
    const last = this.sessionEventPruneByUser.get(userID) ?? 0;
    if (now - last < 60_000) return;
    this.sessionEventPruneByUser.set(userID, now);
    await this.pruneSessionEvents(userID);
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

function parseSessionKeys(keys = []) {
  const out = [];
  const seen = new Set();
  for (const key of keys) {
    const parts = String(key || "").split("\x00");
    if (parts.length !== 3 || parts.some((part) => !part)) continue;
    const normalized = sessionKey(parts[0], parts[1], parts[2]);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ user_id: parts[0], device_id: parts[1], session_id: parts[2] });
  }
  return out;
}

function sessionScopeSQL(tableAlias, options = {}) {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const clauses = [];
  const binds = [];
  const userIDs = options.userIDs ?? [];
  const sessionKeys = options.sessionKeys ?? [];
  if (sessionKeys.length) {
    clauses.push(`(${sessionKeys.map(() => `(${prefix}user_id = ? AND ${prefix}device_id = ? AND ${prefix}session_id = ?)`).join(" OR ")})`);
    for (const key of sessionKeys) binds.push(key.user_id, key.device_id, key.session_id);
  } else if (userIDs.length) {
    clauses.push(`${prefix}user_id IN (${userIDs.map(() => "?").join(", ")})`);
    binds.push(...userIDs);
  }
  return { where: clauses.join(" AND "), binds };
}

function bindingKey(daemonDeviceID, browserDeviceID) {
  return `${daemonDeviceID}\x00${browserDeviceID}`;
}

function turnKey(userID, deviceID, sessionID, seq) {
  return `${sessionKey(userID, deviceID, sessionID)}\x00${seq}`;
}

function historyStorageUsageFromTurns(turns = []) {
  const sessions = new Map();
  const totalBatchKeys = new Set();
  const sessionBatchKeys = new Map();
  const total = emptyHistoryStorageUsage();
  for (const turn of turns) {
    const sessionID = String(turn.session_id || "");
    const sessionUsage = sessions.get(sessionID) || emptyHistoryStorageUsage();
    const sessionSeen = sessionBatchKeys.get(sessionID) || new Set();
    addTurnHistoryStorageUsage(total, turn, totalBatchKeys);
    addTurnHistoryStorageUsage(sessionUsage, turn, sessionSeen);
    sessionBatchKeys.set(sessionID, sessionSeen);
    sessions.set(sessionID, sessionUsage);
  }
  return {
    ...total,
    sessions: Object.fromEntries([...sessions.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
}

function historyStorageUsageFromSQLSummaries(summaries = [], pointerTurns = []) {
  const sessions = new Map();
  const total = emptyHistoryStorageUsage();
  for (const row of summaries) {
    const sessionID = String(row.session_id || "");
    const sessionUsage = emptyHistoryStorageUsage();
    sessionUsage.turn_count = Number(row.turn_count ?? 0) || 0;
    sessionUsage.primary_payload_bytes = Number(row.primary_payload_bytes ?? 0) || 0;
    sessions.set(sessionID, sessionUsage);
    total.turn_count += sessionUsage.turn_count;
    total.primary_payload_bytes += sessionUsage.primary_payload_bytes;
  }

  const totalBatchKeys = new Set();
  const sessionBatchKeys = new Map();
  for (const turn of pointerTurns) {
    const pointer = parseJSONPayload(turn?.payload == null ? "" : String(turn.payload));
    if (!isHistoryBlobPointer(pointer)) continue;
    const sessionID = String(turn.session_id || "");
    const sessionUsage = sessions.get(sessionID) || emptyHistoryStorageUsage();
    const sessionSeen = sessionBatchKeys.get(sessionID) || new Set();
    addPointerHistoryStorageUsage(total, pointer, totalBatchKeys);
    addPointerHistoryStorageUsage(sessionUsage, pointer, sessionSeen);
    sessionBatchKeys.set(sessionID, sessionSeen);
    sessions.set(sessionID, sessionUsage);
  }

  for (const usage of sessions.values()) {
    usage.inline_turn_count = Math.max(0, usage.turn_count - usage.blob_turn_count - usage.blob_batch_turn_count);
  }
  total.inline_turn_count = Math.max(0, total.turn_count - total.blob_turn_count - total.blob_batch_turn_count);
  return {
    ...total,
    sessions: Object.fromEntries([...sessions.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
}

function emptyHistoryStorageUsage() {
  return {
    turn_count: 0,
    inline_turn_count: 0,
    blob_turn_count: 0,
    blob_batch_turn_count: 0,
    primary_payload_bytes: 0,
    archived_payload_bytes: 0,
    archived_encoded_bytes: 0,
    archived_object_count: 0,
  };
}

function addTurnHistoryStorageUsage(usage, turn, seenBatchKeys) {
  usage.turn_count += 1;
  const payload = turn?.payload == null ? "" : String(turn.payload);
  const pointer = parseJSONPayload(payload);
  if (isHistoryBlobPointer(pointer)) {
    usage.primary_payload_bytes += byteLength(payload);
    addPointerHistoryStorageUsage(usage, pointer, seenBatchKeys);
    return;
  }
  usage.inline_turn_count += 1;
  usage.primary_payload_bytes += byteLength(payload);
}

function addPointerHistoryStorageUsage(usage, pointer, seenBatchKeys) {
  usage.archived_payload_bytes += positiveNumberField(pointer.bytes);
  if (pointer.pockly_payload_ref === "blob_batch") {
    usage.blob_batch_turn_count += 1;
    const key = String(pointer.key || "");
    if (key && !seenBatchKeys.has(key)) {
      seenBatchKeys.add(key);
      usage.archived_object_count += 1;
      usage.archived_encoded_bytes += positiveNumberField(pointer.encoded_bytes);
    }
    return;
  }
  usage.blob_turn_count += 1;
  usage.archived_object_count += 1;
  usage.archived_encoded_bytes += positiveNumberField(pointer.encoded_bytes);
}

function isHistoryBlobPointer(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value.pockly_payload_ref === "blob" || value.pockly_payload_ref === "blob_batch") &&
    typeof value.key === "string",
  );
}

function parseJSONPayload(payload) {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function positiveNumberField(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function byteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

function eventID() {
  const millis = String(Date.now()).padStart(13, "0");
  nextEventCounter = (nextEventCounter + 1) % 1_000_000;
  const suffix = String(nextEventCounter).padStart(6, "0");
  const random = cursorRandomSuffix();
  return `ev_${millis}_${suffix}_${random}`;
}

function catalogChangeID() {
  const millis = String(Date.now()).padStart(13, "0");
  nextEventCounter = (nextEventCounter + 1) % 1_000_000;
  const suffix = String(nextEventCounter).padStart(6, "0");
  const random = cursorRandomSuffix();
  return `sc_${millis}_${suffix}_${random}`;
}

function cursorRandomSuffix() {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID().replaceAll("-", "").slice(0, 12);
  }
  if (typeof webCrypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(6);
    webCrypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}${nextEventCounter.toString(36)}`.slice(0, 12).padEnd(12, "0");
}

function normalizeSessionCatalogChange(change) {
  return {
    ...change,
    change_id: change.change_id || catalogChangeID(),
    session_row: typeof change.session_row === "string" || change.session_row == null
      ? change.session_row ?? null
      : JSON.stringify(change.session_row),
  };
}

function emptyCatalogChangeCursor() {
  return "sc_0000000000000_000000_000000";
}

function compareSessionCatalogRows(left, right) {
  const updatedDiff = String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
  if (updatedDiff !== 0) return updatedDiff;
  const deviceDiff = String(left.device_id || "").localeCompare(String(right.device_id || ""));
  if (deviceDiff !== 0) return deviceDiff;
  return String(left.session_id || "").localeCompare(String(right.session_id || ""));
}

function sessionCatalogRowAfterCursor(session, cursor) {
  const row = {
    updated_at: String(session.updated_at || ""),
    device_id: String(session.device_id || ""),
    session_id: String(session.session_id || ""),
  };
  const after = {
    updated_at: String(cursor.updated_at || ""),
    device_id: String(cursor.device_id || ""),
    session_id: String(cursor.session_id || ""),
  };
  if (row.updated_at !== after.updated_at) return row.updated_at < after.updated_at;
  if (row.device_id !== after.device_id) return row.device_id > after.device_id;
  return row.session_id > after.session_id;
}

function shouldPersistDeviceTouch(previous, next) {
  const previousMs = Date.parse(previous || "");
  const nextMs = Date.parse(next || "");
  if (!Number.isFinite(previousMs) || !Number.isFinite(nextMs)) return true;
  return nextMs - previousMs >= 60_000;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function clampLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(500, Math.max(1, Math.floor(parsed)));
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
    synced_window_hash: row.synced_window_hash ?? "",
    has_older_turns: Boolean(row.has_older_turns),
  };
}

function dedupeSessionRows(sessions = []) {
  const byKey = new Map();
  for (const session of sessions) {
    byKey.set(sessionKey(session.user_id, session.device_id, session.session_id), session);
  }
  return [...byKey.values()];
}

function dedupeTurnRows(turns = []) {
  const byKey = new Map();
  for (const turn of turns) {
    byKey.set(turnKey(turn.user_id, turn.device_id, turn.session_id, turn.seq), turn);
  }
  return [...byKey.values()];
}

function filterTurnWindow(turns, options = {}) {
  const limit = Number(options.limit ?? 0) || 0;
  const beforeSeq = Number(options.beforeSeq ?? options.before_seq ?? 0) || 0;
  let out = turns;
  if (beforeSeq > 0) {
    out = out.filter((turn) => Number(turn.seq ?? 0) < beforeSeq);
  }
  if (limit > 0 && out.length > limit) {
    out = out.slice(-clampLimit(limit, 100));
  }
  return out;
}

function compareTurnsForHotCachePrune(left, right) {
  const leftUpdated = Date.parse(left.session_updated_at || left.updated_at || "") || 0;
  const rightUpdated = Date.parse(right.session_updated_at || right.updated_at || "") || 0;
  if (leftUpdated !== rightUpdated) return leftUpdated - rightUpdated;
  const leftSeq = Number(left.seq ?? 0) || 0;
  const rightSeq = Number(right.seq ?? 0) || 0;
  if (leftSeq !== rightSeq) return leftSeq - rightSeq;
  return String(left.session_id).localeCompare(String(right.session_id));
}

function sessionUpsertValues(session) {
  return [
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
    session.synced_window_hash ?? "",
    session.has_older_turns ? 1 : 0,
    session.updated_at,
  ];
}

function turnUpsertValues(turn) {
  return [
    turn.user_id,
    turn.device_id,
    turn.session_id,
    turn.seq,
    turn.agent,
    turn.kind,
    turn.timestamp ?? null,
    turn.payload ?? null,
    turn.updated_at,
  ];
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
