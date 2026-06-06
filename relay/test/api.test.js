/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { base64Url, challengeMessage } from "../src/auth.js";
import { handleRequest } from "../src/app.js";
import { InMemoryRelayStore } from "../src/store.js";

const base = "https://managed-runtime.test";

describe("worker-native relay api", () => {
  it("creates a dev session, reports auth state, and logs out", async () => {
    const env = testEnv();

    const anon = await call(env, "GET", "/api/auth/session");
    assert.deepEqual(await anon.json(), { authenticated: false });

    const login = await call(env, "POST", "/api/dev/login", {
      email: "test@pockly.dev",
      name: "Test User",
    });
    assert.equal(login.status, 200);
    const cookie = sessionCookie(login);
    assert.match(cookie, /pockly_session=/);
    const loginBody = await login.json();
    assert.match(loginBody.user_id, /^usr_/);
    assert.equal(loginBody.email, "test@pockly.dev");
    assert.equal(loginBody.name, "Test User");

    const session = await call(env, "GET", "/api/auth/session", null, { cookie });
    const body = await session.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.user.email, "test@pockly.dev");

    const logout = await call(env, "POST", "/api/auth/logout", null, { cookie });
    assert.equal(logout.status, 200);
    const afterLogout = await call(env, "GET", "/api/auth/session", null, { cookie });
    assert.deepEqual(await afterLogout.json(), { authenticated: false });
  });

  it("requires a registered password for non-dev login", async () => {
    const env = testEnv();
    const registered = await call(env, "POST", "/api/auth/register", {
      email: "password@pockly.dev",
      name: "Password User",
      password: "correct horse battery staple",
    });
    assert.equal(registered.status, 200);

    const wrong = await call(env, "POST", "/api/auth/login", {
      email: "password@pockly.dev",
      password: "wrong",
    });
    assert.equal(wrong.status, 401);

    const login = await call(env, "POST", "/api/auth/login", {
      email: "password@pockly.dev",
      password: "correct horse battery staple",
    });
    assert.equal(login.status, 200);
    assert.match(sessionCookie(login), /pockly_session=/);
  });

  it("registers a browser and verifies device challenge signatures", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();

    const registered = await registerBrowser(env, cookie, browserKeys.publicKey);
    assert.equal(registered.status, "registered");
    assert.match(registered.browser_device_id, /^bd_/);
    assert.match(registered.device_access_token, /^dt_/);

    const challengeRes = await call(env, "POST", "/api/device-challenge", {
      device_id: registered.browser_device_id,
      audience: "browser-ws",
    });
    const challenge = await challengeRes.json();
    const signature = await browserKeys.sign(challengeMessage(challenge));
    const verified = await call(env, "POST", "/api/device-challenge/verify", {
      device_id: registered.browser_device_id,
      audience: "browser-ws",
      challenge_id: challenge.challenge_id,
      signature,
    });
    const verifiedBody = await verified.json();
    assert.equal(verifiedBody.verified, true);
    assert.match(verifiedBody.device_access_token, /^dt_/);

    const sessions = await call(env, "GET", "/api/sessions", null, {
      authorization: `Bearer ${verifiedBody.device_access_token}`,
    });
    assert.deepEqual(await sessions.json(), { sessions: [] });
  });

  it("binds a daemon, accepts sync, and exposes sessions, turns, and host presence", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      full_reconcile: true,
      sessions: [
        {
          session_id: "sess_claude",
          agent: "claude-code",
          cwd: "/work/app",
          snippet: "hello claude",
          last_seq: 2,
          last_timestamp: "2026-06-06T01:00:02.000Z",
          turn_count: 2,
          min_seq: 1,
          max_seq: 2,
        },
        {
          session_id: "sess_codex",
          agent: "codex",
          cwd: "/work/app",
          snippet: "hello codex",
          last_seq: 1,
          last_timestamp: "2026-06-06T01:00:03.000Z",
          turn_count: 1,
          min_seq: 1,
          max_seq: 1,
        },
      ],
      turns: [
        {
          session_id: "sess_claude",
          seq: 1,
          agent: "claude-code",
          kind: "user_message",
          timestamp: "2026-06-06T01:00:01.000Z",
          payload: { text: "hello claude" },
        },
        {
          session_id: "sess_claude",
          seq: 2,
          agent: "claude-code",
          kind: "assistant_text",
          timestamp: "2026-06-06T01:00:02.000Z",
          payload: { text: "hi" },
        },
      ],
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.deepEqual(await sync.json(), {
      ok: true,
      session_count: 2,
      turn_count: 2,
      daemon_device: daemon.daemon_device_id,
      daemon_version: "0.1.0-test",
    });

    const listed = await call(env, "GET", "/api/sessions", null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const sessions = (await listed.json()).sessions;
    assert.deepEqual(sessions.map((session) => session.session_id), ["sess_codex", "sess_claude"]);
    assert.deepEqual(new Set(sessions.map((session) => session.agent)), new Set(["claude-code", "codex"]));
    assert.equal(sessions.find((session) => session.session_id === "sess_claude").writable, true);
    assert.equal(sessions.find((session) => session.session_id === "sess_claude").sync_state, "ready");
    assert.equal(sessions.find((session) => session.session_id === "sess_codex").sync_state, "catalog_only");
    assert.equal(sessions.find((session) => session.session_id === "sess_codex").synced_turn_count, 0);

    const turns = await call(env, "GET", `/api/sessions/sess_claude/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const turnBody = await turns.json();
    assert.equal(turnBody.session_id, "sess_claude");
    assert.equal(turnBody.turns.length, 2);
    assert.deepEqual(turnBody.turns[1].payload, { text: "hi" });

    const catalogOnlyTurns = await call(env, "GET", `/api/sessions/sess_codex/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const catalogOnlyBody = await catalogOnlyTurns.json();
    assert.equal(catalogOnlyBody.turns.length, 0);
    assert.equal(catalogOnlyBody.needs_sync, true);

    const hosts = await call(env, "GET", "/api/hosts/online", null, { cookie });
    const hostBody = await hosts.json();
    assert.equal(hostBody.hosts.length, 1);
    assert.equal(hostBody.hosts[0].presence_status, "online");
    assert.equal(hostBody.hosts[0].active_session_count, 2);
  });

  it("full reconcile removes sessions missing from the daemon snapshot", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);

    await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions: [
        { session_id: "old", agent: "claude-code", cwd: "/a", last_seq: 1, last_timestamp: "2026-06-06T01:00:01Z" },
        { session_id: "keep", agent: "codex", cwd: "/a", last_seq: 1, last_timestamp: "2026-06-06T01:00:02Z" },
      ],
    }, { authorization: `Bearer ${daemon.device_access_token}` });

    await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions: [
        { session_id: "keep", agent: "codex", cwd: "/a", last_seq: 2, last_timestamp: "2026-06-06T01:00:03Z" },
      ],
    }, { authorization: `Bearer ${daemon.device_access_token}` });

    const listed = await call(env, "GET", "/api/sessions", null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.deepEqual((await listed.json()).sessions.map((session) => session.session_id), ["keep"]);
  });
});

function testEnv() {
  return { POCKLY_RELAY_STORE: new InMemoryRelayStore() };
}

async function loginCookie(env) {
  const res = await call(env, "POST", "/api/dev/login", {
    email: "test@pockly.dev",
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
    daemon_device_id: "dd_test",
    daemon_pubkey: keys.publicKey,
    device_name: "Pockly Test Host",
    hostname: "test-host",
    os: "linux",
    app_version: "0.1.0-test",
    computer_id: "dc_test",
  });
  assert.equal(login.status, 200);
  const body = await login.json();
  assert.match(body.device_refresh_token, /^drt_/);
  return body;
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
