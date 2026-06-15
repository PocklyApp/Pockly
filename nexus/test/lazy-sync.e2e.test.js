/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";

import { base64Url, challengeMessage } from "../src/auth.js";
import { handleRequest } from "../src/app.js";
import { InMemoryControlHub } from "../src/control.js";
import { InMemoryNexusStore } from "../src/store.js";

const base = "https://nexus-runtime.test";
const daemonDeviceID = "dd_lazy_e2e";
const computerID = "dc_lazy_e2e";

test("lazy session sync E2E keeps old catalog visible and backfills on demand", async () => {
  const env = testEnv({ extra: { POCKLY_HOT_TURN_TTL_DAYS: "365" } });
  const cookie = await loginCookie(env);
  const browserKeys = await generateSigningKeyPair();
  const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
  const daemon = await loginDaemon(env, cookie);
  const browserAuth = { authorization: `Bearer ${browser.device_access_token}` };
  const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };

  const recentTurns = buildTurns("sess_recent", 101, 120);
  const catalogSync = await call(env, "POST", "/api/daemon/sync", {
    hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
    full_reconcile: true,
    sessions: [
      {
        session_id: "sess_recent",
        agent: "claude-code",
        cwd: "/work/recent",
        title: "Recent session",
        snippet: "recent user message",
        last_seq: 120,
        last_timestamp: "2026-06-10T08:20:00.000Z",
        channel_last_seen_at: "2026-06-10T08:20:00.000Z",
        sync_state: "partial",
        turn_count: 120,
        min_seq: 101,
        max_seq: 120,
        has_older: true,
      },
      {
        session_id: "sess_old",
        agent: "codex",
        cwd: "/work/old",
        title: "Old session",
        snippet: "old session still visible",
        last_seq: 240,
        last_timestamp: "2026-04-01T08:00:00.000Z",
        channel_last_seen_at: "2026-04-01T08:00:00.000Z",
        sync_state: "catalog_only",
        turn_count: 240,
      },
    ],
    turns: recentTurns,
  }, daemonAuth);
  assert.equal(catalogSync.status, 200);
  assert.equal((await catalogSync.json()).turn_count, 20);

  const listed = await call(env, "GET", "/api/sessions", null, browserAuth);
  assert.equal(listed.status, 200);
  const sessions = (await listed.json()).sessions;
  const recent = sessions.find((session) => session.session_id === "sess_recent");
  const old = sessions.find((session) => session.session_id === "sess_old");
  assert.ok(recent, "recent session missing from catalog");
  assert.ok(old, "old catalog-only session missing from catalog");
  assert.equal(recent.turn_count, 120);
  assert.equal(recent.synced_turn_count, 20);
  assert.equal(recent.synced_min_seq, 101);
  assert.equal(recent.synced_max_seq, 120);
  assert.equal(recent.has_older_turns, true);
  assert.equal(old.agent, "codex");
  assert.equal(old.cwd, "/work/old");
  assert.equal(old.title, "Old session");
  assert.equal(old.snippet, "old session still visible");
  assert.equal(old.turn_count, 240);
  assert.equal(old.synced_turn_count, 0);
  assert.equal(old.sync_state, "catalog_only");
  assert.equal(old.device_id, daemon.daemon_device_id);
  assert.equal(old.computer_id, computerID);

  const recentTurnWindow = await call(env, "GET", `/api/sessions/sess_recent/turns?device_id=${daemon.daemon_device_id}`, null, browserAuth);
  const recentBody = await recentTurnWindow.json();
  assert.equal(recentBody.turns.length, 20);
  assert.equal(recentBody.oldest_seq, 101);
  assert.equal(recentBody.latest_seq, 120);
  assert.equal(recentBody.has_older_turns, true);

  const oldBeforeOpen = await call(env, "GET", `/api/sessions/sess_old/turns?device_id=${daemon.daemon_device_id}`, null, browserAuth);
  const oldBeforeOpenBody = await oldBeforeOpen.json();
  assert.equal(oldBeforeOpenBody.turns.length, 0);
  assert.equal(oldBeforeOpenBody.needs_sync, true);
  assert.equal(oldBeforeOpenBody.total_turn_count, 240);
  assert.equal(oldBeforeOpenBody.synced_turn_count, 0);

  const opened = await call(env, "POST", "/api/sessions/sess_old/opened", {
    device_id: daemon.daemon_device_id,
    opened_at: new Date().toISOString(),
  }, browserAuth);
  assert.equal(opened.status, 200);

  const hints = await call(env, "GET", "/api/daemon/sync-hints", null, daemonAuth);
  assert.deepEqual(await hints.json(), {
    sessions: [{
      session_id: "sess_old",
      reason: "recently_opened",
      preferred_min: 100,
      synced_turn_count: 0,
      synced_min_seq: 0,
      synced_max_seq: 0,
      latest_contiguous_min_seq: 0,
      next_before_seq: 0,
      total_turn_count: 240,
      has_older_turns: false,
    }],
  });

  const oldBackfillSync = await call(env, "POST", "/api/daemon/sync", {
    hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
    sessions: [{
      session_id: "sess_old",
      agent: "codex",
      cwd: "/work/old",
      title: "Old session",
      snippet: "old session still visible",
      last_seq: 240,
      last_timestamp: "2026-04-01T08:00:00.000Z",
      channel_last_seen_at: "2026-04-01T08:00:00.000Z",
      sync_state: "partial",
      turn_count: 240,
      min_seq: 141,
      max_seq: 240,
      has_older: true,
    }],
    turns: buildTurns("sess_old", 141, 240, "codex"),
  }, daemonAuth);
  assert.equal(oldBackfillSync.status, 200);
  assert.equal((await oldBackfillSync.json()).turn_count, 100);

  const oldAfterBackfill = await call(env, "GET", `/api/sessions/sess_old/turns?device_id=${daemon.daemon_device_id}`, null, browserAuth);
  const oldAfterBackfillBody = await oldAfterBackfill.json();
  assert.equal(oldAfterBackfillBody.turns.length, 0);
  assert.equal(oldAfterBackfillBody.oldest_seq, undefined);
  assert.equal(oldAfterBackfillBody.latest_seq, undefined);
  assert.equal(oldAfterBackfillBody.synced_turn_count, 0);
  assert.equal(oldAfterBackfillBody.total_turn_count, 240);
  assert.equal(oldAfterBackfillBody.has_older_turns, true);
  assert.equal(oldAfterBackfillBody.needs_sync, true);

  await env.POCKLY_NEXUS_STORE.patchDevice("usr_test", daemon.daemon_device_id, {
    last_seen_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  const offlineList = await call(env, "GET", "/api/sessions", null, browserAuth);
  const offlineOld = (await offlineList.json()).sessions.find((session) => session.session_id === "sess_old");
  assert.equal(offlineOld.writable, false);
  assert.equal(offlineOld.connection_mode, "read_only");
  assert.equal(offlineOld.synced_turn_count, 0);
  assert.equal(offlineOld.turn_count, 240);
  assert.equal(offlineOld.has_older_turns, true);

  const offlineTurns = await call(env, "GET", `/api/sessions/sess_old/turns?device_id=${daemon.daemon_device_id}`, null, browserAuth);
  const offlineTurnsBody = await offlineTurns.json();
  assert.equal(offlineTurnsBody.turns.length, 0);
  assert.equal(offlineTurnsBody.synced_turn_count, 0);
  assert.equal(offlineTurnsBody.total_turn_count, 240);
  assert.equal(offlineTurnsBody.has_older_turns, true);
});

function testEnv(options = {}) {
  return {
    POCKLY_NEXUS_STORE: new InMemoryNexusStore(),
    POCKLY_CONTROL_HUB: new InMemoryControlHub(),
    POCKLY_NEXUS_DEV_LOGIN_ENABLED: "1",
    ...(options.extra || {}),
  };
}

async function loginCookie(env) {
  const res = await call(env, "POST", "/api/dev/login", {
    user_id: "usr_test",
    email: "test@example.local",
    name: "Test User",
  });
  return sessionCookie(res);
}

async function registerBrowser(env, cookie, publicKey) {
  const res = await call(env, "POST", "/api/devices/register-browser", {
    browser_device_pubkey: publicKey,
    device_name: "Test Browser",
    user_agent: "node-test",
  }, { cookie });
  assert.equal(res.status, 200);
  return await res.json();
}

async function loginDaemon(env, cookie) {
  const keys = await generateSigningKeyPair();
  const codeRes = await call(env, "POST", "/api/daemon/login-codes", null, { cookie });
  const code = await codeRes.json();
  const login = await call(env, "POST", "/api/daemon/login", {
    login_code: code.login_code,
    daemon_device_id: daemonDeviceID,
    daemon_pubkey: keys.publicKey,
    device_name: "Pockly Test Host",
    hostname: "test-host",
    os: "linux",
    app_version: "0.1.0-test",
    computer_id: computerID,
  });
  assert.equal(login.status, 200);
  return await login.json();
}

async function call(env, method, path, body, headers = {}) {
  const init = {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(headers.cookie ? { cookie: headers.cookie } : {}),
      ...(headers.authorization ? { authorization: headers.authorization } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  return await handleRequest(new Request(`${base}${path}`, init), env);
}

function buildTurns(sessionID, minSeq, maxSeq, agent = "claude-code") {
  const turns = [];
  for (let seq = minSeq; seq <= maxSeq; seq += 1) {
    turns.push({
      session_id: sessionID,
      seq,
      agent,
      kind: seq % 2 === 0 ? "assistant_text" : "user_message",
      timestamp: `2026-06-10T08:${String(seq % 60).padStart(2, "0")}:00.000Z`,
      payload: { text: `${sessionID} turn ${seq}` },
    });
  }
  return turns;
}

function sessionCookie(response) {
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "response set-cookie missing");
  return cookie.split(";")[0];
}

async function generateSigningKeyPair() {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const rawPublicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return {
    publicKey: base64Url(new Uint8Array(rawPublicKey)),
    sign: async (message) => {
      const signature = await crypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(message));
      return base64Url(new Uint8Array(signature));
    },
  };
}
