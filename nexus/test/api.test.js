/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { base64Url, challengeMessage } from "../src/auth.js";
import { createBrowserRealtimeCommandHandler, handleRequest } from "../src/app.js";
import { InMemoryControlHub } from "../src/control.js";
import { InMemoryNexusStore } from "../src/store.js";

const base = "https://nexus-runtime.test";

describe("Nexus api", () => {
  it("keeps dev login disabled unless explicitly enabled", async () => {
    const env = testEnv({ devLogin: false });
    const login = await call(env, "POST", "/api/dev/login", {
      email: "test@example.local",
      name: "Test User",
    });
    assert.equal(login.status, 404);
    assert.deepEqual(await login.json(), {
      error: "dev_login_disabled",
      code: "not_found",
    });
    assert.equal(login.headers.get("set-cookie"), null);
  });

  it("creates a dev session, reports auth state, and logs out", async () => {
    const env = testEnv();

    const anon = await call(env, "GET", "/api/auth/session");
    assert.deepEqual(await anon.json(), { authenticated: false });

    const login = await call(env, "POST", "/api/dev/login", {
      email: "test@example.local",
      name: "Test User",
    });
    assert.equal(login.status, 200);
    const cookie = sessionCookie(login);
    assert.match(cookie, /pockly_session=/);
    const loginBody = await login.json();
    assert.match(loginBody.user_id, /^usr_/);
    assert.equal(loginBody.email, "test@example.local");
    assert.equal(loginBody.name, "Test User");

    const session = await call(env, "GET", "/api/auth/session", null, { cookie });
    const body = await session.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.user.email, "test@example.local");

    const logout = await call(env, "POST", "/api/auth/logout", null, { cookie });
    assert.equal(logout.status, 200);
    const afterLogout = await call(env, "GET", "/api/auth/session", null, { cookie });
    assert.deepEqual(await afterLogout.json(), { authenticated: false });
  });

  it("requires a registered password for non-dev login", async () => {
    const env = testEnv();
    const registered = await call(env, "POST", "/api/auth/register", {
      email: "password@example.local",
      name: "Password User",
      password: "correct horse battery staple",
    });
    assert.equal(registered.status, 200);
    assert.match(sessionCookie(registered), /pockly_session=/);
    const registeredBody = await registered.json();
    assert.equal(registeredBody.status, "active");

    const duplicate = await call(env, "POST", "/api/auth/register", {
      email: "password@example.local",
      name: "Password User Again",
      password: "different horse battery staple",
    });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), {
      error: "email_already_registered",
      code: "conflict",
    });

    const wrong = await call(env, "POST", "/api/auth/login", {
      email: "password@example.local",
      password: "different horse battery staple",
    });
    assert.equal(wrong.status, 401);

    const login = await call(env, "POST", "/api/auth/login", {
      email: "password@example.local",
      password: "correct horse battery staple",
    });
    assert.equal(login.status, 200);
    assert.match(sessionCookie(login), /pockly_session=/);
  });

  it("does not expose email verification endpoints when verification is not configured", async () => {
    const env = testEnv();
    const verify = await call(env, "POST", "/api/auth/register/verify", {
      email: "verify@example.local",
      code: "123456",
    });
    assert.equal(verify.status, 503);
    assert.deepEqual(await verify.json(), {
      error: "verification_not_configured",
      code: "service_unavailable",
    });
    assert.equal(verify.headers.get("set-cookie"), null);

    const resend = await call(env, "POST", "/api/auth/verification/resend", {
      email: "verify@example.local",
    });
    assert.equal(resend.status, 503);
    assert.deepEqual(await resend.json(), {
      error: "verification_not_configured",
      code: "service_unavailable",
    });
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
    env.RELEASES = new FakeObjectStore({
      "pockly-daemon/latest/checksums.txt": "0".repeat(64) + "  pockly-daemon_v0.1.1_linux_amd64.tar.gz\n",
    });
    env.DAEMON_RELEASE_CACHE_SECONDS = "0";
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
    const syncBody = await sync.json();
    assert.deepEqual({
      ok: syncBody.ok,
      session_count: syncBody.session_count,
      turn_count: syncBody.turn_count,
      received_turn_count: syncBody.received_turn_count,
      session_upsert_count: syncBody.session_upsert_count,
      daemon_device: syncBody.daemon_device,
      daemon_version: syncBody.daemon_version,
    }, {
      ok: true,
      session_count: 2,
      turn_count: 2,
      received_turn_count: 2,
      session_upsert_count: 2,
      daemon_device: daemon.daemon_device_id,
      daemon_version: "0.1.0-test",
    });
    assert.equal(typeof syncBody.timings_ms?.total, "number");

    const listed = await call(env, "GET", "/api/sessions", null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const sessions = (await listed.json()).sessions;
    assert.deepEqual(sessions.map((session) => session.session_id), ["sess_codex", "sess_claude"]);
    assert.deepEqual(new Set(sessions.map((session) => session.agent)), new Set(["claude-code", "codex"]));
    assert.equal(sessions.find((session) => session.session_id === "sess_claude").writable, true);
    assert.equal(sessions.find((session) => session.session_id === "sess_claude").sync_state, "fully_synced");
    assert.equal(sessions.find((session) => session.session_id === "sess_codex").sync_state, "catalog_only");
    assert.equal(sessions.find((session) => session.session_id === "sess_codex").synced_turn_count, 0);
    assert.equal(sessions.find((session) => session.session_id === "sess_codex").turn_count, 1);

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
    assert.equal(catalogOnlyBody.total_turn_count, 1);
    assert.equal(catalogOnlyBody.synced_turn_count, 0);

    const hosts = await call(env, "GET", "/api/hosts/online", null, { cookie });
    const hostBody = await hosts.json();
    assert.equal(hostBody.hosts.length, 1);
    assert.equal(hostBody.hosts[0].presence_status, "online");
    assert.equal(hostBody.hosts[0].active_session_count, 2);
    assert.equal(hostBody.hosts[0].daemon_latest_version, "v0.1.1");
    assert.equal(hostBody.hosts[0].daemon_update_available, true);
    assert.equal(hostBody.hosts[0].daemon_update_source, "release_latest");

    const devices = await call(env, "GET", "/api/devices", null, { cookie });
    const daemonDevice = (await devices.json()).devices.find((device) => device.device_id === daemon.daemon_device_id);
    assert.equal(daemonDevice.daemon_latest_version, "v0.1.1");
    assert.equal(daemonDevice.daemon_update_available, true);
  });

  it("stores a partial lazy sync window without treating missing older turns as lost", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);

    const turns = [];
    for (let seq = 81; seq <= 100; seq += 1) {
      turns.push({
        session_id: "sess_partial",
        seq,
        agent: "claude-code",
        kind: seq % 2 === 0 ? "assistant_text" : "user_message",
        timestamp: `2026-06-06T01:${String(seq - 80).padStart(2, "0")}:00.000Z`,
        payload: { text: `turn ${seq}` },
      });
    }
    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_partial",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "old but visible",
        last_seq: 100,
        last_timestamp: "2026-06-06T01:20:00.000Z",
        sync_state: "partial",
        turn_count: 100,
        min_seq: 81,
        max_seq: 100,
        has_older: true,
      }],
      turns,
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);
    assert.equal((await sync.json()).turn_count, 20);

    const listed = await call(env, "GET", "/api/sessions", null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const session = (await listed.json()).sessions.find((item) => item.session_id === "sess_partial");
    assert.equal(session.sync_state, "partial");
    assert.equal(session.turn_count, 100);
    assert.equal(session.synced_turn_count, 20);
    assert.equal(session.synced_min_seq, 81);
    assert.equal(session.synced_max_seq, 100);
    assert.equal(session.has_older_turns, true);

    const turnRes = await call(env, "GET", `/api/sessions/sess_partial/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const body = await turnRes.json();
    assert.equal(body.turns.length, 20);
    assert.equal(body.oldest_seq, 81);
    assert.equal(body.latest_seq, 100);
    assert.equal(body.total_turn_count, 100);
    assert.equal(body.synced_turn_count, 20);
    assert.equal(body.has_older_turns, true);
    assert.equal(body.needs_sync, false);
  });

  it("stores synced turn payloads for session history", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const connected = await call(env, "POST", `/api/hosts/${daemon.daemon_device_id}/connect`, {
      browser_device_id: browser.browser_device_id,
      browser_device_pubkey: browserKeys.publicKey,
      device_name: "Test Browser",
      user_agent: "node-test",
    }, { cookie });
    assert.equal(connected.status, 200);

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_payload",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "payload",
        last_seq: 1,
        last_timestamp: "2026-06-06T04:00:00.000Z",
        turn_count: 1,
        min_seq: 1,
        max_seq: 1,
      }],
      turns: [{
        session_id: "sess_payload",
        seq: 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:00.000Z",
        payload: { text: "plaintext history" },
      }],
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);

    const turns = await call(env, "GET", `/api/sessions/sess_payload/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const body = await turns.json();
    assert.deepEqual(body.turns[0].payload, { text: "plaintext history" });
  });

  it("serves session history windows without reading the entire large session", async () => {
    const env = testEnv({ extra: { POCKLY_EDGE_RETENTION_PROFILE: "extended" } });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const turns = Array.from({ length: 150 }, (_, index) => ({
      session_id: "sess_windowed_history",
      seq: index + 1,
      agent: "claude-code",
      kind: "assistant_text",
      timestamp: `2026-06-06T04:00:${String(index % 60).padStart(2, "0")}.000Z`,
      payload: { text: `turn ${index + 1}` },
    }));

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_windowed_history",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "windowed",
        last_seq: 150,
        last_timestamp: "2026-06-06T04:02:30.000Z",
        turn_count: 150,
        min_seq: 1,
        max_seq: 150,
      }],
      turns,
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);
    const auth = { authorization: `Bearer ${browser.device_access_token}` };

    const defaultWindow = await call(env, "GET", `/api/sessions/sess_windowed_history/turns?device_id=${daemon.daemon_device_id}`, null, auth);
    assert.equal(defaultWindow.status, 200);
    const defaultWindowBody = await defaultWindow.json();
    assert.deepEqual(defaultWindowBody.turns.map((turn) => turn.seq), Array.from({ length: 100 }, (_, index) => 51 + index));
    assert.equal(defaultWindowBody.window_limit, 100);
    assert.equal(defaultWindowBody.next_loaded_before_seq, 51);

    const full = await call(env, "GET", `/api/sessions/sess_windowed_history/turns?device_id=${daemon.daemon_device_id}&limit=0&full=1`, null, auth);
    assert.equal(full.status, 200);
    const fullBody = await full.json();
    assert.equal(fullBody.turns.length, 150);
    assert.equal(fullBody.window_limit, 0);
    assert.equal(fullBody.next_loaded_before_seq, 0);

    const tail = await call(env, "GET", `/api/sessions/sess_windowed_history/turns?device_id=${daemon.daemon_device_id}&limit=20`, null, auth);
    assert.equal(tail.status, 200);
    const tailBody = await tail.json();
    assert.deepEqual(tailBody.turns.map((turn) => turn.seq), Array.from({ length: 20 }, (_, index) => 131 + index));
    assert.equal(tailBody.window_limit, 20);
    assert.equal(tailBody.oldest_seq, 131);
    assert.equal(tailBody.latest_seq, 150);
    assert.equal(tailBody.next_loaded_before_seq, 131);
    assert.equal(tailBody.has_older_turns, false);

    const earlier = await call(env, "GET", `/api/sessions/sess_windowed_history/turns?device_id=${daemon.daemon_device_id}&limit=20&before_seq=131`, null, auth);
    assert.equal(earlier.status, 200);
    const earlierBody = await earlier.json();
    assert.deepEqual(earlierBody.turns.map((turn) => turn.seq), Array.from({ length: 20 }, (_, index) => 111 + index));
    assert.equal(earlierBody.next_loaded_before_seq, 111);

    const incremental = await call(env, "GET", `/api/sessions/sess_windowed_history/turns?device_id=${daemon.daemon_device_id}&limit=20&after_seq=145`, null, auth);
    assert.equal(incremental.status, 200);
    const incrementalBody = await incremental.json();
    assert.deepEqual(incrementalBody.turns.map((turn) => turn.seq), [146, 147, 148, 149, 150]);
    assert.equal(incrementalBody.after_seq, 145);
    assert.equal(incrementalBody.oldest_seq, 146);
    assert.equal(incrementalBody.latest_seq, 150);
  });

  it("serves incremental turn reads without full turn stats", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const turns = Array.from({ length: 150 }, (_, index) => ({
      session_id: "sess_incremental_turns",
      seq: index + 1,
      agent: "claude-code",
      kind: "assistant_text",
      timestamp: new Date(Date.UTC(2026, 5, 6, 4, 0, index % 60)).toISOString(),
      payload: { text: `turn ${index + 1}` },
    }));
    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [{
        session_id: "sess_incremental_turns",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "incremental",
        last_seq: 150,
        last_timestamp: "2026-06-06T04:02:30.000Z",
        turn_count: 150,
        min_seq: 1,
        max_seq: 150,
      }],
      turns,
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);

    store.resetCounts();
    const incremental = await call(env, "GET", `/api/sessions/sess_incremental_turns/turns?device_id=${daemon.daemon_device_id}&limit=20&after_seq=145`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(incremental.status, 200);
    const body = await incremental.json();
    assert.equal(body.source, "remote_hot_window");
    assert.deepEqual(body.turns.map((turn) => turn.seq), [146, 147, 148, 149, 150]);
    assert.equal(body.after_seq, 145);
    assert.equal(store.counts.getSession, 1);
    assert.equal(store.counts.getSessionTurnStats, 0);
    assert.equal(store.counts.listTurns, 0);
  });

  it("serves hot-window reads with materialized turn stats instead of repair scans", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({
      store,
      extra: {
        POCKLY_HOT_TURNS_PER_SESSION: "200",
        POCKLY_HOT_TURNS_PER_USER: "1000",
      },
    });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const turns = Array.from({ length: 150 }, (_, index) => ({
      session_id: "sess_materialized_stats",
      seq: index + 1,
      agent: "claude-code",
      kind: "assistant_text",
      timestamp: new Date(Date.UTC(2026, 5, 6, 5, 0, index % 60)).toISOString(),
      payload: { text: `turn ${index + 1}` },
    }));

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_materialized_stats",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "materialized stats",
        last_seq: 150,
        last_timestamp: "2026-06-06T05:02:30.000Z",
        turn_count: 150,
        min_seq: 1,
        max_seq: 150,
      }],
      turns,
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);

    store.resetCounts();
    const response = await call(env, "GET", `/api/sessions/sess_materialized_stats/turns?device_id=${daemon.daemon_device_id}&limit=20`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.turns.map((turn) => turn.seq), Array.from({ length: 20 }, (_, index) => 131 + index));
    assert.equal(body.synced_turn_count, 150);
    assert.equal(body.synced_min_seq, 1);
    assert.equal(body.synced_max_seq, 150);
    assert.equal(store.counts.getSession, 1);
    assert.equal(store.counts.getSessionTurnStats, 0);
    assert.equal(store.counts.listTurns, 1);
    assert.equal(store.counts.upsertSessionRows, 0);
  });

  it("keeps only bounded hot turns per session in remote storage", async () => {
    const env = testEnv({
      extra: {
        POCKLY_HOT_TURNS_PER_SESSION: "5",
        POCKLY_HOT_TURNS_PER_USER: "100",
      },
    });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const turns = Array.from({ length: 12 }, (_, index) => ({
      session_id: "sess_hot_window",
      seq: index + 1,
      agent: "claude-code",
      kind: "assistant_text",
      timestamp: `2026-06-06T04:00:${String(index).padStart(2, "0")}.000Z`,
      payload: { text: `turn ${index + 1}` },
    }));

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_hot_window",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "hot",
        last_seq: 12,
        last_timestamp: "2026-06-06T04:00:12.000Z",
        turn_count: 12,
        min_seq: 1,
        max_seq: 12,
      }],
      turns,
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);

    const stored = await env.POCKLY_NEXUS_STORE.listTurns("usr_test", daemon.daemon_device_id, "sess_hot_window", { limit: 20 });
    assert.deepEqual(stored.map((turn) => turn.seq), [8, 9, 10, 11, 12]);
    const response = await call(env, "GET", `/api/sessions/sess_hot_window/turns?device_id=${daemon.daemon_device_id}&limit=20`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const body = await response.json();
    assert.deepEqual(body.turns.map((turn) => turn.seq), [8, 9, 10, 11, 12]);
    assert.equal(body.synced_turn_count, 5);
    assert.equal(body.synced_min_seq, 8);
    assert.equal(body.synced_max_seq, 12);
    assert.equal(body.next_loaded_before_seq, 0);
    assert.equal(body.next_before_seq, 8);
    assert.equal(body.has_older_turns, true);
  });

  it("pre-clips a 500-session large fixture before durable writes", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({
      store,
      extra: {
        POCKLY_EDGE_RETENTION_PROFILE: "standard",
        POCKLY_HOT_TURN_MAX_PAYLOAD_BYTES: "32768",
      },
    });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const browserAuth = { authorization: `Bearer ${browser.device_access_token}` };
    const sessionCount = 500;
    const turnCount = 10_000;
    const largeSessionID = "sess_large_fixture_000";
    const sessions = Array.from({ length: sessionCount }, (_, index) => ({
      session_id: `sess_large_fixture_${String(index).padStart(3, "0")}`,
      agent: "claude-code",
      cwd: "/work/large-fixture",
      snippet: `large fixture session ${index}`,
      last_seq: index === 0 ? turnCount : 1,
      last_timestamp: new Date(Date.UTC(2026, 5, 6, 6, 0, index % 60)).toISOString(),
      turn_count: index === 0 ? turnCount : 1,
      min_seq: index === 0 ? 1 : 0,
      max_seq: index === 0 ? turnCount : 0,
    }));
    const largeText = "x".repeat(40 * 1024);
    const turns = Array.from({ length: turnCount }, (_, index) => {
      const seq = index + 1;
      return {
        session_id: largeSessionID,
        seq,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: new Date(Date.UTC(2026, 5, 6, 7, 0, 0, seq)).toISOString(),
        payload: { text: seq === 9_950 ? largeText : `large fixture turn ${seq}` },
      };
    });

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      full_reconcile: true,
      sessions,
      turns,
    }, daemonAuth);
    assert.equal(sync.status, 200);
    const syncBody = await sync.json();
    assert.equal(syncBody.session_count, sessionCount);
    assert.equal(syncBody.turn_count, 100);
    assert.equal(syncBody.received_turn_count, turnCount);
    assert.equal(store.counts.listExistingTurnKeys, 1);
    assert.equal(store.counts.listExistingTurnPayloads, 0);
    assert.equal(store.counts.upsertTurnRows, 100);
    assert.equal(store.counts.upsertSessionRows, sessionCount);
    assert.equal(store.pruneHotTurnCacheOptions.at(-1).sessionKeys.length, 1);

    const stored = await env.POCKLY_NEXUS_STORE.listTurns("usr_test", daemon.daemon_device_id, largeSessionID, { limit: 200 });
    assert.equal(stored.length, 100);
    assert.equal(stored[0].seq, 9_901);
    assert.equal(stored.at(-1).seq, 10_000);
    const largeStored = stored.find((turn) => turn.seq === 9_950);
    assert.ok(largeStored, "large payload fixture turn should be inside the retained hot window");
    const largeStoredPayload = JSON.parse(largeStored.payload);
    assert.equal(largeStoredPayload.pockly_payload_ref, "local_only");
    assert.equal(largeStoredPayload.reason, "payload_too_large");
    assert.ok(largeStoredPayload.bytes > 32 * 1024);

    const response = await call(env, "GET", `/api/sessions/${largeSessionID}/turns?device_id=${daemon.daemon_device_id}&limit=150`, null, browserAuth);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.turns.length, 100);
    assert.equal(body.synced_turn_count, 100);
    assert.equal(body.synced_min_seq, 9_901);
    assert.equal(body.synced_max_seq, 10_000);
    assert.equal(body.next_before_seq, 9_901);
    assert.equal(body.has_older_turns, true);

    store.resetCounts();
    const retry = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      full_reconcile: true,
      sessions,
      turns,
    }, daemonAuth);
    assert.equal(retry.status, 200);
    const retryBody = await retry.json();
    assert.equal(retryBody.turn_count, 0);
    assert.equal(retryBody.received_turn_count, turnCount);
    assert.equal(store.counts.listExistingTurnKeys, 1);
    assert.equal(store.counts.listExistingTurnPayloads, 1);
    assert.equal(store.counts.upsertTurns, 0);
    assert.equal(store.counts.upsertTurnRows, 0);
    assert.equal(store.counts.upsertSessions, 0);
    assert.equal(store.counts.upsertSessionRows, 0);
  });

  it("uses retention profiles for default hot turn caps", async () => {
    const env = testEnv({ extra: { POCKLY_EDGE_RETENTION_PROFILE: "standard" } });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const turns = Array.from({ length: 130 }, (_, index) => ({
      session_id: "sess_standard_profile_hot_window",
      seq: index + 1,
      agent: "claude-code",
      kind: "assistant_text",
      timestamp: `2026-06-06T04:${String(index % 60).padStart(2, "0")}:00.000Z`,
      payload: { text: `turn ${index + 1}` },
    }));

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_standard_profile_hot_window",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "standard profile hot cap",
        last_seq: 130,
        last_timestamp: "2026-06-06T04:59:00.000Z",
        turn_count: 130,
        min_seq: 1,
        max_seq: 130,
      }],
      turns,
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);

    const stored = await env.POCKLY_NEXUS_STORE.listTurns("usr_test", daemon.daemon_device_id, "sess_standard_profile_hot_window", { limit: 200 });
    assert.equal(stored.length, 100);
    assert.equal(stored[0].seq, 31);
    assert.equal(stored.at(-1).seq, 130);
  });

  it("allows larger hot windows for extended retention defaults", async () => {
    const env = testEnv({ extra: { POCKLY_EDGE_RETENTION_PROFILE: "extended" } });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const turns = Array.from({ length: 350 }, (_, index) => ({
      session_id: "sess_extended_profile_hot_window",
      seq: index + 1,
      agent: "claude-code",
      kind: "assistant_text",
      timestamp: `2026-06-06T05:${String(index % 60).padStart(2, "0")}:00.000Z`,
      payload: { text: `turn ${index + 1}` },
    }));

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_extended_profile_hot_window",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "extended retention hot cap",
        last_seq: 350,
        last_timestamp: "2026-06-06T05:59:00.000Z",
        turn_count: 350,
        min_seq: 1,
        max_seq: 350,
      }],
      turns,
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);

    const stored = await env.POCKLY_NEXUS_STORE.listTurns("usr_test", daemon.daemon_device_id, "sess_extended_profile_hot_window", { limit: 400 });
    assert.equal(stored.length, 300);
    assert.equal(stored[0].seq, 51);
    assert.equal(stored.at(-1).seq, 350);
  });

  it("enforces a per-user hot turn cap across sessions", async () => {
    const env = testEnv({
      extra: {
        POCKLY_HOT_TURNS_PER_SESSION: "20",
        POCKLY_HOT_TURNS_PER_USER: "6",
        POCKLY_FORCE_GLOBAL_HOT_TURN_PRUNE: "1",
      },
    });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const browserAuth = { authorization: `Bearer ${browser.device_access_token}` };
    const syncSession = async (sessionID, timestampMinute) => {
      const turns = Array.from({ length: 5 }, (_, index) => ({
        session_id: sessionID,
        seq: index + 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: `2026-06-06T04:${String(timestampMinute).padStart(2, "0")}:${String(index).padStart(2, "0")}.000Z`,
        payload: { text: `${sessionID} turn ${index + 1}` },
      }));
      const res = await call(env, "POST", "/api/daemon/sync", {
        hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
        sessions: [{
          session_id: sessionID,
          agent: "claude-code",
          cwd: "/work/app",
          snippet: sessionID,
          last_seq: 5,
          last_timestamp: `2026-06-06T04:${String(timestampMinute).padStart(2, "0")}:05.000Z`,
          turn_count: 5,
          min_seq: 1,
          max_seq: 5,
        }],
        turns,
      }, { authorization: `Bearer ${daemon.device_access_token}` });
      assert.equal(res.status, 200);
      return await res.json();
    };

    const firstSync = await syncSession("sess_hot_user_old", 0);
    assert.equal(firstSync.session_repair_count, 0);
    const secondSync = await syncSession("sess_hot_user_new", 1);
    assert.equal(secondSync.session_repair_count, 1);

    const oldTurns = await env.POCKLY_NEXUS_STORE.listTurns("usr_test", daemon.daemon_device_id, "sess_hot_user_old", { limit: 20 });
    const newTurns = await env.POCKLY_NEXUS_STORE.listTurns("usr_test", daemon.daemon_device_id, "sess_hot_user_new", { limit: 20 });
    assert.equal(oldTurns.length + newTurns.length, 6);
    assert.deepEqual(newTurns.map((turn) => turn.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(oldTurns.map((turn) => turn.seq), [5]);

    const listed = await call(env, "GET", "/api/sessions", null, browserAuth);
    assert.equal(listed.status, 200);
    const sessions = (await listed.json()).sessions;
    const oldSession = sessions.find((session) => session.session_id === "sess_hot_user_old");
    assert.equal(oldSession.synced_turn_count, 1);
    assert.equal(oldSession.synced_min_seq, 5);
    assert.equal(oldSession.synced_max_seq, 5);
    assert.equal(oldSession.sync_state, "partial");
    assert.equal(oldSession.has_older_turns, true);
  });

  it("omits large payloads from the remote hot window without writing history blobs by default", async () => {
    const objectStore = new FakeObjectStore({});
    const store = new CountingNexusStore();
    const env = testEnv({
      store,
      extra: {
        HISTORY_BLOBS: objectStore,
        POCKLY_HOT_TURN_MAX_PAYLOAD_BYTES: "64",
      },
    });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const largePayload = { text: "large hot window payload ".repeat(64) };

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_hot_payload",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "payload",
        last_seq: 1,
        last_timestamp: "2026-06-06T04:00:00.000Z",
        turn_count: 1,
        min_seq: 1,
        max_seq: 1,
      }],
      turns: [{
        session_id: "sess_hot_payload",
        seq: 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:00.000Z",
        payload: largePayload,
      }],
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);
    assert.equal(Object.keys(objectStore.objects).length, 0);

    const storedTurns = await env.POCKLY_NEXUS_STORE.listTurns("usr_test", daemon.daemon_device_id, "sess_hot_payload");
    const storedPayload = JSON.parse(storedTurns[0].payload);
    assert.equal(storedPayload.pockly_payload_ref, "local_only");
    assert.equal(storedPayload.reason, "payload_too_large");
    assert.equal(storedPayload.bytes, Buffer.byteLength(JSON.stringify(largePayload)));
    assert.match(storedPayload.text, /Large message omitted/);

    const turns = await call(env, "GET", `/api/sessions/sess_hot_payload/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const body = await turns.json();
    assert.equal(body.turns[0].payload.pockly_payload_ref, "local_only");
    assert.match(body.turns[0].payload.text, /Large message omitted/);

    store.resetCounts();
    const retry = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_hot_payload",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "payload",
        last_seq: 1,
        last_timestamp: "2026-06-06T04:00:00.000Z",
        turn_count: 1,
        min_seq: 1,
        max_seq: 1,
      }],
      turns: [{
        session_id: "sess_hot_payload",
        seq: 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:00.000Z",
        payload: largePayload,
      }],
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(retry.status, 200);
    assert.equal(store.counts.upsertTurns, 0);
  });

  it("tiers large turn payloads to object storage without changing the read API", async () => {
    const objectStore = new FakeObjectStore({}, { oneShotReads: true });
    const env = testEnv({
      extra: {
        RELEASES: objectStore,
        HISTORY_BLOBS: objectStore,
        POCKLY_HISTORY_BLOBS_ENABLED: "1",
        POCKLY_TURN_PAYLOAD_BLOB_THRESHOLD_BYTES: "16",
      },
    });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const largePayload = { text: "this payload is intentionally larger than the test threshold. ".repeat(256) };

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_blob_payload",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "payload",
        last_seq: 1,
        last_timestamp: "2026-06-06T04:00:00.000Z",
        turn_count: 1,
        min_seq: 1,
        max_seq: 1,
      }],
      turns: [{
        session_id: "sess_blob_payload",
        seq: 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:00.000Z",
        payload: largePayload,
      }],
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);

    const storedTurns = await env.POCKLY_NEXUS_STORE.listTurns("usr_test", daemon.daemon_device_id, "sess_blob_payload");
    assert.equal(storedTurns.length, 1);
    const pointer = JSON.parse(storedTurns[0].payload);
    assert.equal(pointer.pockly_payload_ref, "blob");
    assert.equal(pointer.encoding, "gzip");
    assert.equal(pointer.bytes, Buffer.byteLength(JSON.stringify(largePayload)));
    assert.ok(pointer.encoded_bytes > 0);
    assert.match(pointer.key, /\.json\.gz$/);
    assert.equal(Object.keys(objectStore.objects).length, 1);
    assert.equal(await objectStore.get(pointer.key).then(readGzipObjectText), JSON.stringify(largePayload));
    assert.ok(pointer.encoded_bytes < pointer.bytes);

    const turns = await call(env, "GET", `/api/sessions/sess_blob_payload/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const body = await turns.json();
    assert.deepEqual(body.turns[0].payload, largePayload);
  });

  it("does not rewrite history blobs when a daemon retries unchanged turns", async () => {
    const objectStore = new FakeObjectStore({});
    const env = testEnv({
      extra: {
        HISTORY_BLOBS: objectStore,
        POCKLY_HISTORY_BLOBS_ENABLED: "1",
        POCKLY_TURN_PAYLOAD_BLOB_THRESHOLD_BYTES: "16",
      },
    });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const payload = { text: "retry payload should be externalized once. ".repeat(256) };
    const body = {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_blob_retry",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "payload",
        last_seq: 1,
        last_timestamp: "2026-06-06T04:00:00.000Z",
        turn_count: 1,
        min_seq: 1,
        max_seq: 1,
      }],
      turns: [{
        session_id: "sess_blob_retry",
        seq: 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:00.000Z",
        payload,
      }],
    };

    const first = await call(env, "POST", "/api/daemon/sync", body, daemonAuth);
    assert.equal(first.status, 200);
    assert.equal(objectStore.putCalls.length, 1);

    const retry = await call(env, "POST", "/api/daemon/sync", body, daemonAuth);
    assert.equal(retry.status, 200);
    const retryBody = await retry.json();
    assert.equal(retryBody.turn_count, 0);
    assert.equal(retryBody.received_turn_count, 1);
    assert.equal(objectStore.putCalls.length, 1);
  });

  it("batches multiple large turn payloads into one history blob", async () => {
    const objectStore = new FakeObjectStore({});
    const env = testEnv({
      extra: {
        HISTORY_BLOBS: objectStore,
        POCKLY_HISTORY_BLOBS_ENABLED: "1",
        POCKLY_TURN_PAYLOAD_BLOB_THRESHOLD_BYTES: "16",
        POCKLY_TURN_PAYLOAD_BATCH_RAW_BYTES: String(1024 * 1024),
      },
    });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const firstPayload = { text: "first batched payload. ".repeat(256) };
    const secondPayload = { text: "second batched payload. ".repeat(256) };

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_blob_batch",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "payload",
        last_seq: 2,
        last_timestamp: "2026-06-06T04:00:01.000Z",
        turn_count: 2,
        min_seq: 1,
        max_seq: 2,
      }],
      turns: [{
        session_id: "sess_blob_batch",
        seq: 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:00.000Z",
        payload: firstPayload,
      }, {
        session_id: "sess_blob_batch",
        seq: 2,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:01.000Z",
        payload: secondPayload,
      }],
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);
    assert.equal(objectStore.putCalls.length, 1);

    const storedTurns = await env.POCKLY_NEXUS_STORE.listTurns("usr_test", daemon.daemon_device_id, "sess_blob_batch");
    assert.equal(storedTurns.length, 2);
    const pointers = storedTurns.map((turn) => JSON.parse(turn.payload));
    assert.deepEqual(pointers.map((pointer) => pointer.pockly_payload_ref), ["blob_batch", "blob_batch"]);
    assert.equal(pointers[0].key, pointers[1].key);
    assert.equal(pointers[0].item_seq, 1);
    assert.equal(pointers[1].item_seq, 2);
    assert.match(pointers[0].key, /^session-turn-batches\/usr_test\/dd_test\/sess_blob_batch\//);
    assert.match(pointers[0].key, /\.json\.gz$/);

    objectStore.getCalls = [];
    const turns = await call(env, "GET", `/api/sessions/sess_blob_batch/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(turns.status, 200);
    const body = await turns.json();
    assert.deepEqual(body.turns.map((turn) => turn.payload), [firstPayload, secondPayload]);
    assert.deepEqual(objectStore.getCalls, [pointers[0].key]);
  });

  it("does not rewrite batched history blobs when a daemon retries unchanged turns", async () => {
    const objectStore = new FakeObjectStore({});
    const env = testEnv({
      extra: {
        HISTORY_BLOBS: objectStore,
        POCKLY_HISTORY_BLOBS_ENABLED: "1",
        POCKLY_TURN_PAYLOAD_BLOB_THRESHOLD_BYTES: "16",
        POCKLY_TURN_PAYLOAD_BATCH_RAW_BYTES: String(1024 * 1024),
      },
    });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const body = {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_blob_batch_retry",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "payload",
        last_seq: 2,
        last_timestamp: "2026-06-06T04:00:01.000Z",
        turn_count: 2,
        min_seq: 1,
        max_seq: 2,
      }],
      turns: [{
        session_id: "sess_blob_batch_retry",
        seq: 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:00.000Z",
        payload: { text: "first retry payload should stay in one batch. ".repeat(256) },
      }, {
        session_id: "sess_blob_batch_retry",
        seq: 2,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:01.000Z",
        payload: { text: "second retry payload should stay in one batch. ".repeat(256) },
      }],
    };

    const first = await call(env, "POST", "/api/daemon/sync", body, daemonAuth);
    assert.equal(first.status, 200);
    assert.equal(objectStore.putCalls.length, 1);

    const retry = await call(env, "POST", "/api/daemon/sync", body, daemonAuth);
    assert.equal(retry.status, 200);
    assert.equal(objectStore.putCalls.length, 1);
  });

  it("fast-paths repeated hot-window sync without stats reads or session writes", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const body = {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_repeated_hot_window",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "tail",
        last_seq: 60,
        last_timestamp: "2026-06-06T04:00:59.000Z",
        turn_count: 60,
        min_seq: 41,
        max_seq: 60,
        has_older: true,
      }],
      turns: Array.from({ length: 20 }, (_, index) => {
        const seq = 41 + index;
        return {
          session_id: "sess_repeated_hot_window",
          seq,
          agent: "claude-code",
          kind: "assistant_text",
          timestamp: `2026-06-06T04:00:${String(index).padStart(2, "0")}.000Z`,
          payload: { text: `turn ${seq}` },
        };
      }),
    };

    const first = await call(env, "POST", "/api/daemon/sync", body, daemonAuth);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.turn_count, 20);
    assert.equal(firstBody.received_turn_count, 20);

    store.resetCounts();
    const retry = await call(env, "POST", "/api/daemon/sync", body, daemonAuth);
    assert.equal(retry.status, 200);
    const retryBody = await retry.json();
    assert.equal(retryBody.turn_count, 0);
    assert.equal(retryBody.received_turn_count, 20);
    assert.equal(retryBody.session_upsert_count, 0);
    assert.equal(retryBody.session_fast_path_count, 1);
    assert.equal(store.counts.listExistingTurnKeys, 1);
    assert.equal(store.counts.listExistingTurnPayloads, 1);
    assert.equal(store.counts.upsertTurnRows, 0);
    assert.equal(store.counts.getSessionTurnStats, 0);
    assert.equal(store.counts.upsertSessionRows, 0);
    assert.equal(store.counts.appendSessionCatalogChangeRows, 0);
  });

  it("updates catalog metadata when a repeated hot-window sync changes the session row", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const turns = [{
      session_id: "sess_repeated_hot_window_catalog_change",
      seq: 1,
      agent: "claude-code",
      kind: "assistant_text",
      timestamp: "2026-06-06T04:00:00.000Z",
      payload: { text: "turn 1" },
    }];
    const baseSession = {
      session_id: "sess_repeated_hot_window_catalog_change",
      agent: "claude-code",
      cwd: "/work/app",
      snippet: "old snippet",
      last_seq: 1,
      last_timestamp: "2026-06-06T04:00:00.000Z",
      turn_count: 1,
      min_seq: 1,
      max_seq: 1,
    };
    const body = {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [baseSession],
      turns,
    };

    const first = await call(env, "POST", "/api/daemon/sync", body, daemonAuth);
    assert.equal(first.status, 200);

    store.resetCounts();
    const retry = await call(env, "POST", "/api/daemon/sync", {
      ...body,
      sessions: [{ ...baseSession, snippet: "new snippet" }],
    }, daemonAuth);
    assert.equal(retry.status, 200);
    const retryBody = await retry.json();
    assert.equal(retryBody.turn_count, 0);
    assert.equal(retryBody.received_turn_count, 1);
    assert.equal(retryBody.session_upsert_count, 1);
    assert.equal(retryBody.session_fast_path_count, 0);
    assert.equal(store.counts.upsertTurnRows, 0);
    assert.equal(store.counts.getSessionTurnStats, 0);
    assert.equal(store.counts.upsertSessionRows, 1);
    const session = await store.getSession("usr_test", daemon.daemon_device_id, "sess_repeated_hot_window_catalog_change");
    assert.equal(session.snippet, "new snippet");
  });

  it("reports history storage usage for inline, blob, and batched payloads", async () => {
    const objectStore = new FakeObjectStore({});
    const env = testEnv();
    env.HISTORY_BLOBS = objectStore;
    const blobEnv = {
      ...env,
      POCKLY_HISTORY_BLOBS_ENABLED: "1",
      POCKLY_TURN_PAYLOAD_BLOB_THRESHOLD_BYTES: "16",
      POCKLY_TURN_PAYLOAD_BATCH_RAW_BYTES: String(1024 * 1024),
    };
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const inlinePayload = { text: "small" };
    const firstPayload = { text: "first archived payload. ".repeat(256) };
    const secondPayload = { text: "second archived payload. ".repeat(256) };

    const inlineSync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_history_usage",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "usage",
        last_seq: 3,
        last_timestamp: "2026-06-06T04:00:02.000Z",
        turn_count: 3,
        min_seq: 1,
        max_seq: 3,
      }],
      turns: [{
        session_id: "sess_history_usage",
        seq: 1,
        agent: "claude-code",
        kind: "user_message",
        timestamp: "2026-06-06T04:00:00.000Z",
        payload: inlinePayload,
      }],
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(inlineSync.status, 200);

    const archiveSync = await call(blobEnv, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_history_usage",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "usage",
        last_seq: 3,
        last_timestamp: "2026-06-06T04:00:02.000Z",
        turn_count: 3,
        min_seq: 1,
        max_seq: 3,
      }],
      turns: [{
        session_id: "sess_history_usage",
        seq: 2,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:01.000Z",
        payload: firstPayload,
      }, {
        session_id: "sess_history_usage",
        seq: 3,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:02.000Z",
        payload: secondPayload,
      }],
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(archiveSync.status, 200);

    const storedTurns = await env.POCKLY_NEXUS_STORE.listTurns("usr_test", daemon.daemon_device_id, "sess_history_usage");
    const pointerPayloads = storedTurns.slice(1).map((turn) => JSON.parse(turn.payload));
    assert.equal(pointerPayloads[0].pockly_payload_ref, "blob_batch");
    assert.equal(pointerPayloads[0].key, pointerPayloads[1].key);

    const usage = await call(env, "GET", `/api/history-usage?device_id=${daemon.daemon_device_id}&session_id=sess_history_usage`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(usage.status, 200);
    const body = await usage.json();
    assert.equal(body.turn_count, 3);
    assert.equal(body.inline_turn_count, 1);
    assert.equal(body.blob_turn_count, 0);
    assert.equal(body.blob_batch_turn_count, 2);
    assert.equal(body.archived_object_count, 1);
    assert.equal(body.archived_payload_bytes, Buffer.byteLength(JSON.stringify(firstPayload)) + Buffer.byteLength(JSON.stringify(secondPayload)));
    assert.equal(body.archived_encoded_bytes, pointerPayloads[0].encoded_bytes);
    assert.ok(body.primary_payload_bytes > Buffer.byteLength(JSON.stringify(inlinePayload)));
    assert.ok(body.estimated_storage_cost_components.primary_payload_storage > 0);
    assert.ok(body.estimated_storage_cost_components.archive_payload_storage >= 0);
    assert.ok(body.estimated_storage_cost_usd_per_month > 0);
    assert.deepEqual(Object.keys(body.sessions), ["sess_history_usage"]);
    assert.equal(body.sessions.sess_history_usage.archived_object_count, 1);

    const accountWideUsage = await call(env, "GET", `/api/history-usage?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(accountWideUsage.status, 400);
    assert.equal((await accountWideUsage.json()).error, "session_id is required");

    const crossDeviceUsage = await call(env, "GET", "/api/history-usage?session_id=sess_history_usage", null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(crossDeviceUsage.status, 400);
    assert.equal((await crossDeviceUsage.json()).error, "device_id is required");
  });

  it("treats daemon-uploaded blob pointer shaped payloads as ordinary content", async () => {
    const objectStore = new FakeObjectStore({});
    const env = testEnv({
      extra: {
        HISTORY_BLOBS: objectStore,
        POCKLY_HISTORY_BLOBS_ENABLED: "1",
        POCKLY_TURN_PAYLOAD_BLOB_THRESHOLD_BYTES: "1024",
      },
    });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const pointerShapedPayload = {
      pockly_payload_ref: "blob",
      version: 1,
      key: "session-turns/other/user/session/000000000001/hash.json",
      sha256: "",
      bytes: 2,
    };

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_pointer_payload",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "pointer",
        last_seq: 1,
        last_timestamp: "2026-06-06T04:00:00.000Z",
        turn_count: 1,
        min_seq: 1,
        max_seq: 1,
      }],
      turns: [{
        session_id: "sess_pointer_payload",
        seq: 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:00.000Z",
        payload: pointerShapedPayload,
      }],
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);

    const storedTurns = await env.POCKLY_NEXUS_STORE.listTurns("usr_test", daemon.daemon_device_id, "sess_pointer_payload");
    const storedPointer = JSON.parse(storedTurns[0].payload);
    assert.equal(storedPointer.pockly_payload_ref, "blob");
    assert.match(storedPointer.key, /^session-turns\/usr_test\/dd_test\/sess_pointer_payload\/000000000001\//);
    assert.equal(Object.keys(objectStore.objects).length, 1);

    const turns = await call(env, "GET", `/api/sessions/sess_pointer_payload/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(turns.status, 200);
    const body = await turns.json();
    assert.deepEqual(body.turns[0].payload, pointerShapedPayload);
  });

  it("reads scoped history blobs within a turns response", async () => {
    const objectStore = new FakeObjectStore({});
    const env = testEnv({
      extra: {
        HISTORY_BLOBS: objectStore,
      },
    });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const firstPayload = JSON.stringify({ text: "first blob payload" });
    const secondPayload = JSON.stringify({ text: "second blob payload" });
    const firstKey = "session-turns/usr_test/dd_test/sess_blob_cache/000000000001/first.json";
    const secondKey = "session-turns/usr_test/dd_test/sess_blob_cache/000000000002/second.json";
    await objectStore.put(firstKey, firstPayload);
    await objectStore.put(secondKey, secondPayload);
    const firstPointer = JSON.stringify({
      pockly_payload_ref: "blob",
      version: 1,
      key: firstKey,
      sha256: "",
      bytes: firstPayload.length,
    });
    const secondPointer = JSON.stringify({
      pockly_payload_ref: "blob",
      version: 1,
      key: secondKey,
      sha256: "",
      bytes: secondPayload.length,
    });
    await env.POCKLY_NEXUS_STORE.upsertSession({
      user_id: "usr_test",
      device_id: daemon.daemon_device_id,
      session_id: "sess_blob_cache",
      agent: "claude-code",
      cwd: "/work/app",
      snippet: "cache",
      first_message: "",
      title: "",
      last_seq: 2,
      last_timestamp: "2026-06-06T04:00:01.000Z",
      sync_state: "ready",
      turn_count: 2,
      synced_turn_count: 2,
      synced_min_seq: 1,
      synced_max_seq: 2,
      has_older_turns: false,
      updated_at: "2026-06-06T04:00:01.000Z",
    });
    await env.POCKLY_NEXUS_STORE.upsertTurns([
      { user_id: "usr_test", device_id: daemon.daemon_device_id, session_id: "sess_blob_cache", seq: 1, agent: "claude-code", kind: "assistant_text", timestamp: "2026-06-06T04:00:00.000Z", payload: firstPointer },
      { user_id: "usr_test", device_id: daemon.daemon_device_id, session_id: "sess_blob_cache", seq: 2, agent: "claude-code", kind: "assistant_text", timestamp: "2026-06-06T04:00:01.000Z", payload: secondPointer },
    ]);
    objectStore.getCalls = [];

    const turns = await call(env, "GET", `/api/sessions/sess_blob_cache/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(turns.status, 200);
    const body = await turns.json();
    assert.deepEqual(body.turns.map((turn) => turn.payload), [{ text: "first blob payload" }, { text: "second blob payload" }]);
    assert.deepEqual(objectStore.getCalls, [firstKey, secondKey]);
  });

  it("rejects blob pointers that do not belong to the current turn", async () => {
    const objectStore = new FakeObjectStore({
      "session-turns/usr_test/dd_test/other_session/000000000001/hash.json": JSON.stringify({ text: "wrong session" }),
    });
    const env = testEnv({
      extra: {
        HISTORY_BLOBS: objectStore,
      },
    });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const pointer = JSON.stringify({
      pockly_payload_ref: "blob",
      version: 1,
      key: "session-turns/usr_test/dd_test/other_session/000000000001/hash.json",
      sha256: "",
      bytes: 24,
    });
    await env.POCKLY_NEXUS_STORE.upsertSession({
      user_id: "usr_test",
      device_id: daemon.daemon_device_id,
      session_id: "sess_blob_scope",
      agent: "claude-code",
      cwd: "/work/app",
      snippet: "scope",
      first_message: "",
      title: "",
      last_seq: 1,
      last_timestamp: "2026-06-06T04:00:00.000Z",
      sync_state: "ready",
      turn_count: 1,
      synced_turn_count: 1,
      synced_min_seq: 1,
      synced_max_seq: 1,
      has_older_turns: false,
      updated_at: "2026-06-06T04:00:00.000Z",
    });
    await env.POCKLY_NEXUS_STORE.upsertTurns([
      { user_id: "usr_test", device_id: daemon.daemon_device_id, session_id: "sess_blob_scope", seq: 1, agent: "claude-code", kind: "assistant_text", timestamp: "2026-06-06T04:00:00.000Z", payload: pointer },
    ]);

    const turns = await call(env, "GET", `/api/sessions/sess_blob_scope/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(turns.status, 200);
    const body = await turns.json();
    assert.deepEqual(body.turns[0].payload, { payload_ref_invalid: true });
    assert.deepEqual(objectStore.getCalls, []);
  });

  it("does not store large turn payloads in the release object store", async () => {
    const releaseStore = new FakeObjectStore({});
    const env = testEnv({
      extra: {
        RELEASES: releaseStore,
        POCKLY_TURN_PAYLOAD_BLOB_THRESHOLD_BYTES: "16",
      },
    });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_release_bucket_guard",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "payload",
        last_seq: 1,
        last_timestamp: "2026-06-06T04:00:00.000Z",
        turn_count: 1,
        min_seq: 1,
        max_seq: 1,
      }],
      turns: [{
        session_id: "sess_release_bucket_guard",
        seq: 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:00.000Z",
        payload: { text: "this payload is intentionally larger than the test threshold" },
      }],
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);

    const storedTurns = await env.POCKLY_NEXUS_STORE.listTurns("usr_test", daemon.daemon_device_id, "sess_release_bucket_guard");
    assert.deepEqual(JSON.parse(storedTurns[0].payload), { text: "this payload is intentionally larger than the test threshold" });
    assert.equal(Object.keys(releaseStore.objects).length, 0);
  });

  it("garbage-collects history blobs when full reconcile removes sessions", async () => {
    const objectStore = new FakeObjectStore({});
    const store = new CountingNexusStore();
    const env = testEnv({
      store,
      extra: {
        HISTORY_BLOBS: objectStore,
        POCKLY_HISTORY_BLOBS_ENABLED: "1",
        POCKLY_TURN_PAYLOAD_BLOB_THRESHOLD_BYTES: "16",
      },
    });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };

    const first = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions: [{
        session_id: "sess_blob_gc",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "gc",
        last_seq: 1,
        last_timestamp: "2026-06-06T04:00:00.000Z",
        turn_count: 2,
        min_seq: 1,
        max_seq: 2,
      }],
      turns: [{
        session_id: "sess_blob_gc",
        seq: 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:00.000Z",
        payload: { text: "this payload should be externalized and later deleted. ".repeat(256) },
      }, {
        session_id: "sess_blob_gc",
        seq: 2,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:01.000Z",
        payload: { text: "this second payload should share the deleted batch. ".repeat(256) },
      }],
    }, daemonAuth);
    assert.equal(first.status, 200);
    assert.equal(Object.keys(objectStore.objects).length, 1);
    store.resetCounts();

    const reconcile = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions: [],
      turns: [],
    }, daemonAuth);
    assert.equal(reconcile.status, 200);
    assert.equal((await reconcile.json()).session_delete_count, 1);
    assert.deepEqual(Object.keys(objectStore.objects), []);
    assert.equal(objectStore.deleteCalls.length, 1);
    assert.equal(store.counts.listTurnPayloadPointers, 1);
    assert.equal(store.counts.listTurns, 0);
  });

  it("returns known hot-window hashes on metadata-only catalog sync", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };

    const first = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [{
        session_id: "sess_known_window",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "known",
        last_seq: 3,
        last_timestamp: "2026-06-06T04:03:00.000Z",
        turn_count: 3,
        min_seq: 1,
        max_seq: 3,
      }],
      turns: [1, 2, 3].map((seq) => ({
        session_id: "sess_known_window",
        seq,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: `2026-06-06T04:0${seq}:00.000Z`,
        payload: { text: `turn ${seq}` },
      })),
    }, daemonAuth);
    assert.equal(first.status, 200);
    store.resetCounts();

    const second = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [{
        session_id: "sess_known_window",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "known",
        last_seq: 3,
        last_timestamp: "2026-06-06T04:03:00.000Z",
        turn_count: 3,
      }],
      known_window_session_ids: ["sess_known_window"],
    }, daemonAuth);
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.equal(body.turn_count, 0);
    assert.match(body.known_windows?.[0]?.window_hash || "", /^sha256:[A-Za-z0-9_-]+$/);
    delete body.known_windows[0].window_hash;
    assert.deepEqual(body.known_windows, [{
      session_id: "sess_known_window",
      synced_min_seq: 1,
      synced_max_seq: 3,
      synced_turn_count: 3,
    }]);
    assert.equal(store.counts.listTurnPayloadPointers, 1);
    assert.equal(store.counts.listTurns, 0);
  });

  it("returns stored known hot-window hashes without reading turn payloads", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const windowHash = "sha256:stored-known-window";

    const first = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [{
        session_id: "sess_known_window_stored",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "known",
        last_seq: 3,
        last_timestamp: "2026-06-06T04:03:00.000Z",
        turn_count: 3,
        min_seq: 1,
        max_seq: 3,
        window_hash: windowHash,
      }],
      turns: [1, 2, 3].map((seq) => ({
        session_id: "sess_known_window_stored",
        seq,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: `2026-06-06T04:0${seq}:00.000Z`,
        payload: { text: `turn ${seq}` },
      })),
    }, daemonAuth);
    assert.equal(first.status, 200);
    const stored = await store.getSession("usr_test", daemon.daemon_device_id, "sess_known_window_stored");
    assert.equal(stored.synced_window_hash, windowHash);
    store.resetCounts();

    const second = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      known_window_session_ids: ["sess_known_window_stored"],
    }, daemonAuth);
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.deepEqual(body.known_windows, [{
      session_id: "sess_known_window_stored",
      synced_min_seq: 1,
      synced_max_seq: 3,
      synced_turn_count: 3,
      window_hash: windowHash,
    }]);
    assert.equal(store.counts.listDeviceSessionSyncSnapshotsByIDs, 1);
    assert.equal(store.counts.listTurnPayloadPointers, 0);
    assert.equal(store.counts.listTurns, 0);
  });

  it("returns known hot-window hashes on lightweight probe sync without session rows", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };

    const first = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [{
        session_id: "sess_known_window_probe",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "known",
        last_seq: 3,
        last_timestamp: "2026-06-06T04:03:00.000Z",
        turn_count: 3,
        min_seq: 1,
        max_seq: 3,
      }],
      turns: [1, 2, 3].map((seq) => ({
        session_id: "sess_known_window_probe",
        seq,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: `2026-06-06T04:0${seq}:00.000Z`,
        payload: { text: `turn ${seq}` },
      })),
    }, daemonAuth);
    assert.equal(first.status, 200);
    store.resetCounts();

    const probe = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      known_window_session_ids: ["sess_known_window_probe"],
    }, daemonAuth);
    assert.equal(probe.status, 200);
    const body = await probe.json();
    assert.equal(body.session_count, 0);
    assert.equal(body.session_upsert_count, 0);
    assert.equal(body.turn_count, 0);
    assert.match(body.known_windows?.[0]?.window_hash || "", /^sha256:[A-Za-z0-9_-]+$/);
    delete body.known_windows[0].window_hash;
    assert.deepEqual(body.known_windows, [{
      session_id: "sess_known_window_probe",
      synced_min_seq: 1,
      synced_max_seq: 3,
      synced_turn_count: 3,
    }]);
    assert.equal(store.counts.getSession, 0);
    assert.equal(store.counts.listDeviceSessionSyncSnapshotsByIDs, 1);
    assert.equal(store.counts.listTurnPayloadPointers, 1);
    assert.equal(store.counts.listTurns, 0);
    assert.equal(store.counts.upsertSessions, 0);
    assert.equal(store.counts.appendSessionCatalogChanges, 0);
  });

  it("returns latest contiguous known hot-window tail when hot cache is sparse", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };

    const syncWindow = async (min, max) => {
      const turns = [];
      for (let seq = min; seq <= max; seq += 1) {
        turns.push({
          session_id: "sess_known_sparse",
          seq,
          agent: "claude-code",
          kind: "assistant_text",
          timestamp: `2026-06-06T04:${String(seq % 60).padStart(2, "0")}:00.000Z`,
          payload: { text: `turn ${seq}` },
        });
      }
      const res = await call(env, "POST", "/api/daemon/sync", {
        hello: { device_id: daemon.daemon_device_id },
        sessions: [{
          session_id: "sess_known_sparse",
          agent: "claude-code",
          cwd: "/work/app",
          snippet: "sparse",
          last_seq: 45628,
          last_timestamp: "2026-06-06T04:28:00.000Z",
          sync_state: "partial",
          turn_count: 45628,
          min_seq: min,
          max_seq: max,
          has_older: true,
        }],
        turns,
      }, daemonAuth);
      assert.equal(res.status, 200);
    };

    await syncWindow(45406, 45420);
    await syncWindow(45609, 45628);
    store.resetCounts();

    const probe = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      known_window_session_ids: ["sess_known_sparse"],
    }, daemonAuth);
    assert.equal(probe.status, 200);
    const body = await probe.json();
    assert.match(body.known_windows?.[0]?.window_hash || "", /^sha256:[A-Za-z0-9_-]+$/);
    delete body.known_windows[0].window_hash;
    assert.deepEqual(body.known_windows, [{
      session_id: "sess_known_sparse",
      synced_min_seq: 45609,
      synced_max_seq: 45628,
      synced_turn_count: 20,
    }]);
    assert.equal(store.counts.getSession, 0);
    assert.equal(store.counts.listDeviceSessionSyncSnapshotsByIDs, 1);
    assert.equal(store.counts.listTurnPayloadPointers, 1);
    assert.equal(store.counts.listTurns, 0);
    assert.equal(store.counts.upsertSessions, 0);
  });

  it("does not compute known hot-window hashes unless daemon opts in", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };

    const first = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [{
        session_id: "sess_known_window_no_opt_in",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "known",
        last_seq: 2,
        last_timestamp: "2026-06-06T04:03:00.000Z",
        turn_count: 2,
        min_seq: 1,
        max_seq: 2,
      }],
      turns: [1, 2].map((seq) => ({
        session_id: "sess_known_window_no_opt_in",
        seq,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: `2026-06-06T04:0${seq}:00.000Z`,
        payload: { text: `turn ${seq}` },
      })),
    }, daemonAuth);
    assert.equal(first.status, 200);
    store.resetCounts();

    const second = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [{
        session_id: "sess_known_window_no_opt_in",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "known",
        last_seq: 2,
        last_timestamp: "2026-06-06T04:03:00.000Z",
        turn_count: 2,
      }],
    }, daemonAuth);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).known_windows, undefined);
    assert.equal(store.counts.listTurnPayloadPointers, 0);
    assert.equal(store.counts.listTurns, 0);
  });

  it("bounds known hot-window hashes to daemon-requested sessions", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };

    const sessions = ["sess_known_a", "sess_known_b"].map((sessionID, index) => ({
      session_id: sessionID,
      agent: "claude-code",
      cwd: "/work/app",
      snippet: sessionID,
      last_seq: 2,
      last_timestamp: `2026-06-06T04:1${index}:00.000Z`,
      turn_count: 2,
      min_seq: 1,
      max_seq: 2,
    }));
    const turns = sessions.flatMap((session) => [1, 2].map((seq) => ({
      session_id: session.session_id,
      seq,
      agent: "claude-code",
      kind: "assistant_text",
      timestamp: `2026-06-06T04:1${seq}:00.000Z`,
      payload: { text: `${session.session_id} turn ${seq}` },
    })));
    const first = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions,
      turns,
    }, daemonAuth);
    assert.equal(first.status, 200);
    store.resetCounts();

    const second = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions,
      known_window_session_ids: ["sess_known_b"],
    }, daemonAuth);
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.deepEqual(body.known_windows?.map((window) => window.session_id), ["sess_known_b"]);
    assert.equal(store.counts.listTurnPayloadPointers, 1);
    assert.equal(store.counts.listTurns, 0);

    store.resetCounts();
    const third = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions,
      known_window_session_ids: [],
    }, daemonAuth);
    assert.equal(third.status, 200);
    assert.equal((await third.json()).known_windows, undefined);
    assert.equal(store.counts.listTurnPayloadPointers, 0);
    assert.equal(store.counts.listTurns, 0);
  });

  it("keeps lazy backfill windows out of the durable hot cache", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);

    const syncWindow = async (min, max, hasOlder) => {
      const turns = [];
      for (let seq = min; seq <= max; seq += 1) {
        turns.push({
          session_id: "sess_merge",
          seq,
          agent: "claude-code",
          kind: "assistant_text",
          timestamp: `2026-06-06T02:${String(seq).padStart(2, "0")}:00.000Z`,
          payload: { text: `turn ${seq}` },
        });
      }
      const res = await call(env, "POST", "/api/daemon/sync", {
        hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
        sessions: [{
          session_id: "sess_merge",
          agent: "claude-code",
          cwd: "/work/app",
          snippet: "merge windows",
          last_seq: 60,
          last_timestamp: "2026-06-06T02:59:00.000Z",
          sync_state: hasOlder ? "partial" : "fully_synced",
          turn_count: 60,
          min_seq: min,
          max_seq: max,
          has_older: hasOlder,
        }],
        turns,
      }, { authorization: `Bearer ${daemon.device_access_token}` });
      assert.equal(res.status, 200);
    };

    await syncWindow(41, 60, true);
    await syncWindow(21, 40, true);

    const middle = await call(env, "GET", `/api/sessions/sess_merge/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const middleBody = await middle.json();
    assert.equal(middleBody.turns.length, 20);
    assert.equal(middleBody.oldest_seq, 41);
    assert.equal(middleBody.latest_seq, 60);
    assert.equal(middleBody.synced_turn_count, 20);
    assert.equal(middleBody.has_older_turns, true);

    await syncWindow(1, 20, false);

    const complete = await call(env, "GET", `/api/sessions/sess_merge/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const completeBody = await complete.json();
    assert.equal(completeBody.turns.length, 20);
    assert.equal(completeBody.oldest_seq, 41);
    assert.equal(completeBody.latest_seq, 60);
    assert.equal(completeBody.synced_turn_count, 20);
    assert.equal(completeBody.has_older_turns, true);

    const listed = await call(env, "GET", "/api/sessions", null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const session = (await listed.json()).sessions.find((item) => item.session_id === "sess_merge");
    assert.equal(session.sync_state, "partial");
    assert.equal(session.synced_min_seq, 41);
    assert.equal(session.synced_max_seq, 60);
    assert.equal(session.has_older_turns, true);
  });

  it("does not inflate synced turn count when the daemon retries the same window", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const browserAuth = { authorization: `Bearer ${browser.device_access_token}` };
    const turns = [];
    for (let seq = 81; seq <= 100; seq += 1) {
      turns.push({
        session_id: "sess_retry_window",
        seq,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: `2026-06-06T09:${String(seq % 60).padStart(2, "0")}:00.000Z`,
        payload: { text: `turn ${seq}` },
      });
    }
    const syncPayload = {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_retry_window",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "retry window",
        last_seq: 100,
        last_timestamp: "2026-06-06T09:59:00.000Z",
        sync_state: "partial",
        turn_count: 100,
        min_seq: 81,
        max_seq: 100,
        has_older: true,
      }],
      turns,
    };

    assert.equal((await call(env, "POST", "/api/daemon/sync", syncPayload, daemonAuth)).status, 200);
    store.resetCounts();
    assert.equal((await call(env, "POST", "/api/daemon/sync", syncPayload, daemonAuth)).status, 200);
    assert.equal(store.counts.listExistingTurnKeys, 1);
    assert.equal(store.counts.listExistingTurnPayloads, 1);
    assert.equal(store.counts.upsertTurnRows, 0);

    const listed = await call(env, "GET", "/api/sessions", null, browserAuth);
    const session = (await listed.json()).sessions.find((item) => item.session_id === "sess_retry_window");
    assert.equal(session.synced_turn_count, 20);
    assert.equal(session.synced_min_seq, 81);
    assert.equal(session.synced_max_seq, 100);
    assert.equal(session.sync_state, "partial");
  });

  it("repairs stale catalog-only metadata on single-session turn reads", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const browserAuth = { authorization: `Bearer ${browser.device_access_token}` };

    const turns = [];
    for (let seq = 81; seq <= 100; seq += 1) {
      turns.push({
        session_id: "sess_repair",
        seq,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: `2026-06-06T05:${String(seq % 60).padStart(2, "0")}:00.000Z`,
        payload: { text: `turn ${seq}` },
      });
    }
    const initial = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_repair",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "repair",
        last_seq: 100,
        last_timestamp: "2026-06-06T05:59:00.000Z",
        sync_state: "partial",
        turn_count: 100,
        min_seq: 81,
        max_seq: 100,
        has_older: true,
      }],
      turns,
    }, daemonAuth);
    assert.equal(initial.status, 200);

    await env.POCKLY_NEXUS_STORE.upsertSession({
      user_id: "usr_test",
      computer_id: "dc_test",
      device_id: daemon.daemon_device_id,
      session_id: "sess_repair",
      agent: "claude-code",
      runner_alias: "",
      cwd: "/work/app",
      snippet: "repair",
      first_message: "",
      title: "repair",
      last_seq: 100,
      last_timestamp: "2026-06-06T06:00:00.000Z",
      channel_last_seen_at: "2026-06-06T06:00:00.000Z",
      sync_state: "catalog_only",
      turn_count: 100,
      last_sync_error: "",
      synced_turn_count: 0,
      synced_min_seq: 0,
      synced_max_seq: 0,
      has_older_turns: 0,
      updated_at: "2026-06-06T06:00:00.000Z",
    });

    const catalogOnly = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_repair",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "repair",
        last_seq: 100,
        last_timestamp: "2026-06-06T06:01:00.000Z",
        sync_state: "catalog_only",
        turn_count: 100,
      }],
      turns: [],
    }, daemonAuth);
    assert.equal(catalogOnly.status, 200);

    const listed = await call(env, "GET", "/api/sessions", null, browserAuth);
    const session = (await listed.json()).sessions.find((item) => item.session_id === "sess_repair");
    assert.equal(session.synced_turn_count, 0);
    assert.equal(session.synced_min_seq, 0);
    assert.equal(session.synced_max_seq, 0);
    assert.equal(session.sync_state, "catalog_only");

    const turnsRes = await call(env, "GET", `/api/sessions/sess_repair/turns?device_id=${daemon.daemon_device_id}`, null, browserAuth);
    const body = await turnsRes.json();
    assert.equal(body.synced_turn_count, 20);
    assert.equal(body.synced_min_seq, 81);
    assert.equal(body.synced_max_seq, 100);
    assert.equal(body.has_older_turns, true);

    const repaired = await call(env, "GET", "/api/sessions", null, browserAuth);
    const repairedSession = (await repaired.json()).sessions.find((item) => item.session_id === "sess_repair");
    assert.equal(repairedSession.synced_turn_count, 20);
    assert.equal(repairedSession.synced_min_seq, 81);
    assert.equal(repairedSession.synced_max_seq, 100);
    assert.equal(repairedSession.sync_state, "partial");
    assert.equal(repairedSession.has_older_turns, true);
  });

  it("uses cached device presence for large session catalogs", async () => {
    const env = testEnv();
    const control = new CountingControlHub({ onlineDeviceIDs: ["dd_test"] });
    env.POCKLY_CONTROL_HUB = control;
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const sessions = Array.from({ length: 336 }, (_, index) => ({
      session_id: `sess_large_${String(index).padStart(3, "0")}`,
      agent: index % 2 === 0 ? "claude-code" : "codex",
      cwd: "/work/app",
      snippet: `session ${index}`,
      last_seq: 1,
      last_timestamp: new Date(Date.UTC(2026, 5, 6, 1, 0, index)).toISOString(),
      turn_count: 1,
      min_seq: 1,
      max_seq: 1,
    }));

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions,
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);
    control.onlineDeviceBatches = [];
    const telemetryEvents = [];
    const ctx = {
      providers: {
        telemetryProvider: {
          record: async ({ text }) => telemetryEvents.push(...JSON.parse(text).events),
        },
      },
    };

    const listed = await call(env, "GET", "/api/sessions", null, {
      authorization: `Bearer ${browser.device_access_token}`,
    }, ctx);
    assert.equal(listed.status, 200);
    const body = await listed.json();
    assert.equal(body.sessions.length, 336);
    assert.equal(body.sessions.every((session) => session.writable === true), true);
    assert.deepEqual(control.onlineDeviceBatches, []);
    assert.equal(telemetryEvents[0].command, "sessions");
    assert.equal(telemetryEvents[0].presence_source, "device_last_seen");
    assert.equal(telemetryEvents[0].sessions_count, 336);
    assert.equal(telemetryEvents[0].unique_daemon_count, 1);
    assert.equal(telemetryEvents[0].presence_batch_size, 0);
  });

  it("emits low-cardinality endpoint cost telemetry for sync and session polls", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const browserAuth = { authorization: `Bearer ${browser.device_access_token}` };
    const telemetryEvents = [];
    const pendingTelemetry = [];
    const ctx = {
      providers: {
        telemetryProvider: {
          record: async ({ text }) => telemetryEvents.push(...JSON.parse(text).events),
        },
      },
      waitUntil: (promise) => pendingTelemetry.push(promise),
    };
    const sessionID = "sess_secret_identifier_should_not_appear";

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [{
        session_id: sessionID,
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "cost",
        last_seq: 2,
        last_timestamp: "2026-06-06T01:00:02.000Z",
        turn_count: 2,
        min_seq: 1,
        max_seq: 2,
      }],
      turns: [{
        session_id: sessionID,
        seq: 1,
        agent: "claude-code",
        kind: "user_message",
        timestamp: "2026-06-06T01:00:01.000Z",
        payload: { text: "hello" },
      }, {
        session_id: sessionID,
        seq: 2,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T01:00:02.000Z",
        payload: { text: "world" },
      }],
    }, daemonAuth, ctx);
    assert.equal(sync.status, 200);

    const turns = await call(env, "GET", `/api/sessions/${sessionID}/turns?device_id=${daemon.daemon_device_id}`, null, browserAuth, ctx);
    assert.equal(turns.status, 200);
    const events = await call(env, "GET", `/api/sessions/${sessionID}/events?device_id=${daemon.daemon_device_id}`, null, browserAuth, ctx);
    assert.equal(events.status, 200);
    const catalogItem = await call(env, "GET", `/api/sessions/${sessionID}?device_id=${daemon.daemon_device_id}`, null, browserAuth, ctx);
    assert.equal(catalogItem.status, 200);
    const delta = await call(env, "GET", "/api/sessions/delta?limit=10", null, browserAuth, ctx);
    assert.equal(delta.status, 200);
    const sessions = await call(env, "GET", "/api/sessions", null, browserAuth, ctx);
    assert.equal(sessions.status, 200);
    await Promise.all(pendingTelemetry);

    const costEvents = telemetryEvents.filter((event) => event.name === "nexus_endpoint_cost");
    assert.deepEqual(costEvents.map((event) => event.endpoint), ["daemon_sync", "session_turns", "session_events", "session_catalog_item", "sessions_delta", "sessions"]);
    assert.deepEqual(costEvents.map((event) => event.status), [200, 200, 200, 200, 200, 200]);
    assert.equal(costEvents.every((event) => event.duration_ms >= 0), true);
    assert.equal(costEvents.every((event) => event.worker_requests === 1), true);
    assert.equal(costEvents.every((event) => event.worker_wall_duration_ms >= 0), true);
    assert.equal(costEvents.every((event) => event.worker_cpu_time_ms_estimate >= 0), true);
    assert.equal(costEvents.every((event) => event.worker_cpu_time_source === "wall_clock_proxy"), true);
    assert.equal(costEvents.every((event) => event.response_bytes > 0), true);
    assert.equal(costEvents.find((event) => event.endpoint === "daemon_sync").store_writes > 0, true);
    assert.equal(costEvents.find((event) => event.endpoint === "session_turns").store_reads > 0, true);
    assert.equal(costEvents.find((event) => event.endpoint === "session_events").store_reads > 0, true);
    assert.equal(costEvents.find((event) => event.endpoint === "sessions").control_requests, 0);
    assert.equal(costEvents.find((event) => event.endpoint === "sessions").do_requests, 0);
    assert.equal(JSON.stringify(costEvents).includes(sessionID), false);
  });

  it("serves session catalog delta pages and tombstones without full catalog reads", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const control = new CountingControlHub({ onlineDeviceIDs: ["dd_test"] });
    env.POCKLY_CONTROL_HUB = control;
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const browserAuth = { authorization: `Bearer ${browser.device_access_token}` };
    const sessions = Array.from({ length: 75 }, (_, index) => ({
      session_id: `sess_delta_${String(index).padStart(3, "0")}`,
      agent: "claude-code",
      cwd: "/work/app",
      snippet: `session ${index}`,
      last_seq: 1,
      last_timestamp: new Date(Date.UTC(2026, 5, 6, 1, 0, index)).toISOString(),
      turn_count: 1,
      min_seq: 1,
      max_seq: 1,
    }));

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions,
    }, daemonAuth);
    assert.equal(sync.status, 200);
    assert.equal(store.counts.appendSessionCatalogChanges, 1);
    assert.equal(store.counts.appendSessionCatalogChangeRows, 75);
    assert.equal(store.counts.appendSessionCatalogChange, 0);

    control.onlineDeviceBatches = [];
    const initialDelta = await call(env, "GET", "/api/sessions/delta?limit=50", null, browserAuth);
    assert.equal(initialDelta.status, 200);
    const initialBody = await initialDelta.json();
    assert.equal(initialBody.reset, true);
    assert.equal(initialBody.upserts.length, 50);
    assert.deepEqual(initialBody.deletes, []);
    assert.equal(typeof initialBody.next_cursor, "string");
    assert.equal(initialBody.has_more, true);
    assert.equal(typeof initialBody.next_page_cursor, "string");
    assert.notEqual(initialBody.next_page_cursor, "");
    assert.equal(initialBody.upserts.every((session) => session.writable === false), true);
    assert.deepEqual(control.onlineDeviceBatches, []);
    assert.equal(store.counts.listDevicesForUser, 0);

    const secondPage = await call(env, "GET", `/api/sessions/delta?limit=50&page_cursor=${encodeURIComponent(initialBody.next_page_cursor)}`, null, browserAuth);
    assert.equal(secondPage.status, 200);
    const secondPageBody = await secondPage.json();
    assert.equal(secondPageBody.reset, undefined);
    assert.equal(secondPageBody.upserts.length, 25);
    assert.equal(secondPageBody.has_more, false);
    assert.equal(secondPageBody.next_page_cursor, "");

    const nextSessions = sessions.slice(1).map((session, index) => index === 0
      ? { ...session, title: "Updated delta session", last_timestamp: "2026-06-06T03:00:00.000Z" }
      : session);
    const reconcile = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions: nextSessions,
    }, daemonAuth);
    assert.equal(reconcile.status, 200);

    const delta = await call(env, "GET", `/api/sessions/delta?since=${encodeURIComponent(initialBody.next_cursor)}&limit=10`, null, browserAuth);
    assert.equal(delta.status, 200);
    const deltaBody = await delta.json();
    assert.deepEqual(deltaBody.deletes, [{ device_id: daemon.daemon_device_id, session_id: "sess_delta_000" }]);
    assert.equal(deltaBody.upserts.length, 1);
    assert.equal(deltaBody.upserts[0].session_id, "sess_delta_001");
    assert.equal(deltaBody.upserts[0].title, "Updated delta session");
    assert.equal(deltaBody.next_cursor > initialBody.next_cursor, true);
    assert.deepEqual(control.onlineDeviceBatches, []);
    assert.equal(store.counts.listDevicesForUser, 0);
  });

  it("does not skip catalog changes after an empty initial delta cursor", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const browserAuth = { authorization: `Bearer ${browser.device_access_token}` };

    const empty = await call(env, "GET", "/api/sessions/delta?limit=50", null, browserAuth);
    assert.equal(empty.status, 200);
    const emptyBody = await empty.json();
    assert.deepEqual(emptyBody.upserts, []);
    assert.deepEqual(emptyBody.deletes, []);
    assert.equal(emptyBody.next_cursor, "sc_0000000000000_000000_000000");

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions: [{
        session_id: "sess_after_empty_cursor",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "created after empty cursor",
        last_seq: 1,
        last_timestamp: "2026-06-06T04:00:00.000Z",
        turn_count: 1,
        min_seq: 1,
        max_seq: 1,
      }],
    }, daemonAuth);
    assert.equal(sync.status, 200);

    const delta = await call(env, "GET", `/api/sessions/delta?since=${encodeURIComponent(emptyBody.next_cursor)}&limit=50`, null, browserAuth);
    assert.equal(delta.status, 200);
    const deltaBody = await delta.json();
    assert.equal(deltaBody.upserts.length, 1);
    assert.equal(deltaBody.upserts[0].session_id, "sess_after_empty_cursor");
    assert.deepEqual(deltaBody.deletes, []);
    assert.equal(deltaBody.next_cursor > emptyBody.next_cursor, true);
  });

  it("does not skip catalog changes created while building the initial catalog page", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const browserAuth = { authorization: `Bearer ${browser.device_access_token}` };

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions: [{
        session_id: "sess_initial_page_race",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "before race",
        last_seq: 1,
        last_timestamp: "2026-06-06T06:00:00.000Z",
        turn_count: 1,
        min_seq: 1,
        max_seq: 1,
      }],
    }, daemonAuth);
    assert.equal(sync.status, 200);

    let injected = false;
    store.onListSessionCatalogPage = async () => {
      if (injected) return;
      injected = true;
      const update = await call(env, "POST", "/api/daemon/sync", {
        hello: { device_id: daemon.daemon_device_id },
        full_reconcile: true,
        sessions: [{
          session_id: "sess_initial_page_race",
          agent: "claude-code",
          cwd: "/work/app",
          snippet: "after race",
          title: "Updated during initial page",
          last_seq: 2,
          last_timestamp: "2026-06-06T06:01:00.000Z",
          turn_count: 2,
          min_seq: 1,
          max_seq: 2,
        }],
      }, daemonAuth);
      assert.equal(update.status, 200);
    };

    const initial = await call(env, "GET", "/api/sessions/delta?limit=50", null, browserAuth);
    assert.equal(initial.status, 200);
    const initialBody = await initial.json();
    assert.equal(initialBody.reset, true);
    assert.equal(initialBody.upserts.length, 1);
    assert.equal(initialBody.upserts[0].title, "Updated during initial page");

    const delta = await call(env, "GET", `/api/sessions/delta?since=${encodeURIComponent(initialBody.next_cursor)}&limit=50`, null, browserAuth);
    assert.equal(delta.status, 200);
    const deltaBody = await delta.json();
    assert.equal(deltaBody.upserts.length, 1);
    assert.equal(deltaBody.upserts[0].session_id, "sess_initial_page_race");
    assert.equal(deltaBody.upserts[0].title, "Updated during initial page");
    assert.deepEqual(deltaBody.deletes, []);
    assert.equal(deltaBody.next_cursor > initialBody.next_cursor, true);
  });

  it("returns a reset page when a session catalog delta cursor has expired", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const browserAuth = { authorization: `Bearer ${browser.device_access_token}` };

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions: [{
        session_id: "sess_reset_page",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "reset page",
        last_seq: 1,
        last_timestamp: "2026-06-06T05:00:00.000Z",
        turn_count: 1,
        min_seq: 1,
        max_seq: 1,
      }],
    }, daemonAuth);
    assert.equal(sync.status, 200);

    const delta = await call(env, "GET", "/api/sessions/delta?since=sc_0000000000001_000000_oldold&limit=50", null, browserAuth);
    assert.equal(delta.status, 200);
    const body = await delta.json();
    assert.equal(body.reset, true);
    assert.equal(body.upserts.length, 1);
    assert.equal(body.upserts[0].session_id, "sess_reset_page");
    assert.deepEqual(body.deletes, []);
  });

  it("serves a single session catalog item without full catalog or presence reads", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const control = new CountingControlHub({ onlineDeviceIDs: ["dd_test"] });
    env.POCKLY_CONTROL_HUB = control;
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const browserAuth = { authorization: `Bearer ${browser.device_access_token}` };
    const sessions = Array.from({ length: 120 }, (_, index) => ({
      session_id: `sess_catalog_item_${String(index).padStart(3, "0")}`,
      agent: "claude-code",
      cwd: "/work/app",
      snippet: `session ${index}`,
      last_seq: 1,
      last_timestamp: new Date(Date.UTC(2026, 5, 6, 1, 0, index % 60)).toISOString(),
      turn_count: 1,
      min_seq: 1,
      max_seq: 1,
    }));

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions,
    }, daemonAuth);
    assert.equal(sync.status, 200);

    store.resetCounts();
    control.onlineDeviceBatches = [];
    const item = await call(
      env,
      "GET",
      `/api/sessions/sess_catalog_item_099?device_id=${encodeURIComponent(daemon.daemon_device_id)}`,
      null,
      browserAuth,
    );
    assert.equal(item.status, 200);
    const body = await item.json();
    assert.equal(body.session.session_id, "sess_catalog_item_099");
    assert.equal(body.session.device_id, daemon.daemon_device_id);
    assert.equal(body.session.writable, false);
    assert.equal(store.counts.getSession, 1);
    assert.equal(store.counts.listSessionsForUser, 0);
    assert.equal(store.counts.listDevicesForUser, 0);
    assert.deepEqual(control.onlineDeviceBatches, []);
  });

  it("syncs large catalog reconciles without per-session session or stats queries", async () => {
    const env = testEnv();
    const store = new CountingNexusStore();
    env.POCKLY_NEXUS_STORE = store;
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const browserAuth = { authorization: `Bearer ${browser.device_access_token}` };
    const sessions = Array.from({ length: 336 }, (_, index) => ({
      session_id: `sess_reconcile_${String(index).padStart(3, "0")}`,
      agent: "claude-code",
      cwd: "/work/app",
      snippet: `session ${index}`,
      last_seq: 100,
      last_timestamp: new Date(Date.UTC(2026, 5, 6, 2, 0, index % 60)).toISOString(),
      sync_state: "catalog_only",
      turn_count: 100,
    }));

    const initial = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions,
      turns: [],
    }, daemonAuth);
    assert.equal(initial.status, 200);

    store.resetCounts();
    const reconcile = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions: sessions.slice(1),
      turns: [],
    }, daemonAuth);
    assert.equal(reconcile.status, 200);
    const reconcileBody = await reconcile.json();
    assert.equal(reconcileBody.session_delete_count, 1);
    assert.equal(store.counts.listDeviceSessionSyncSnapshots, 1);
    assert.equal(store.counts.listDeviceSessionSyncSnapshotsByIDs, 0);
    assert.equal(store.counts.listDeviceSessions, 0);
    assert.equal(store.counts.deleteMissingDeviceSessionsFromExisting, 1);
    assert.equal(store.counts.deleteMissingDeviceSessions, 0);
    assert.equal(store.counts.getSession, 0);
    assert.equal(store.counts.getSessionTurnStats, 0);
    assert.equal(store.counts.listTurns, 0);

    const listed = await call(env, "GET", "/api/sessions", null, browserAuth);
    assert.equal(listed.status, 200);
    const body = await listed.json();
    assert.equal(body.sessions.some((session) => session.session_id === "sess_reconcile_000"), false);
    assert.equal(body.sessions.length, 335);
    const existing = await store.getSession("usr_test", daemon.daemon_device_id, "sess_reconcile_001");
    await store.upsertSession({
      ...existing,
      first_message: "existing long first message should survive catalog-only sync",
    });

    store.resetCounts();
    const repeat = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions: sessions.slice(1),
      turns: [],
    }, daemonAuth);
    assert.equal(repeat.status, 200);
    const repeatBody = await repeat.json();
    assert.equal(repeatBody.session_count, 335);
    assert.equal(repeatBody.session_upsert_count, 0);
    assert.equal(repeatBody.session_delete_count, 0);
    assert.equal(repeatBody.session_fast_path_count, 335);
    assertSyncTimings(repeatBody.timings_ms, [
      "auth",
      "read_json",
      "touch_device",
      "upsert_turns",
      "reconcile",
      "load_existing_sessions",
      "build_session_records",
      "filter_unchanged_sessions",
      "upsert_sessions",
      "total",
    ]);
    assert.equal(store.counts.listDeviceSessionSyncSnapshots, 1);
    assert.equal(store.counts.listDeviceSessionSyncSnapshotsByIDs, 0);
    assert.equal(store.counts.listDeviceSessions, 0);
    assert.equal(store.counts.upsertSessions, 0);
    assert.equal(store.counts.upsertSessionRows, 0);
    assert.equal(store.counts.getSessionTurnStats, 0);
    const preserved = await store.getSession("usr_test", daemon.daemon_device_id, "sess_reconcile_001");
    assert.equal(preserved.first_message, "existing long first message should survive catalog-only sync");

    store.resetCounts();
    const metadataOnly = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: sessions.slice(1),
      turns: [],
    }, daemonAuth);
    assert.equal(metadataOnly.status, 200);
    const metadataOnlyBody = await metadataOnly.json();
    assert.equal(metadataOnlyBody.session_count, 335);
    assert.equal(metadataOnlyBody.session_upsert_count, 0);
    assert.equal(metadataOnlyBody.session_delete_count, 0);
    assert.equal(metadataOnlyBody.session_fast_path_count, 335);
    assert.equal(store.counts.listDeviceSessionSyncSnapshots, 0);
    assert.equal(store.counts.listDeviceSessionSyncSnapshotsByIDs, 1);
    assert.equal(store.counts.deleteMissingDeviceSessionsFromExisting, 0);
    assert.equal(store.counts.upsertSessions, 0);
  });

  it("uses batch control presence for host lists", async () => {
    const env = testEnv();
    const control = new CountingControlHub({ onlineDeviceIDs: ["dd_test"] });
    env.POCKLY_CONTROL_HUB = control;
    env.POCKLY_HOSTS_ONLINE_CACHE_MS = "0";
    const cookie = await loginCookie(env);
    await loginDaemon(env, cookie);
    control.onlineDeviceBatches = [];

    const hosts = await call(env, "GET", "/api/hosts/online", null, { cookie });
    assert.equal(hosts.status, 200);
    const body = await hosts.json();
    assert.equal(body.hosts.length, 1);
    assert.equal(body.hosts[0].presence_status, "online");
    assert.equal(body.hosts[0].presence_reason, "control_connected");
    assert.equal(body.hosts[0].control_connected, true);
    assert.deepEqual(control.onlineDeviceBatches, [["dd_test"]]);
  });

  it("does not read full session rows for host presence on large catalogs", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const control = new CountingControlHub({ onlineDeviceIDs: ["dd_test"] });
    env.POCKLY_CONTROL_HUB = control;
    env.POCKLY_HOSTS_ONLINE_CACHE_MS = "0";
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const sessions = Array.from({ length: 336 }, (_, index) => ({
      session_id: `sess_host_presence_${String(index).padStart(3, "0")}`,
      agent: "claude-code",
      cwd: "/work/app",
      snippet: `session ${index}`,
      last_seq: 1,
      last_timestamp: new Date(Date.UTC(2026, 5, 6, 1, 0, index % 60)).toISOString(),
      turn_count: 1,
    }));
    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      full_reconcile: true,
      sessions,
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);

    store.resetCounts();
    const hosts = await call(env, "GET", "/api/hosts/online", null, { cookie });
    assert.equal(hosts.status, 200);
    const body = await hosts.json();
    assert.equal(body.hosts.length, 1);
    assert.equal(body.hosts[0].active_session_count, 336);
    assert.equal(store.counts.countSessionsByDeviceForUser, 1);
    assert.equal(store.counts.listSessionsForUser, 0);
    assert.deepEqual(control.onlineDeviceBatches, [["dd_test"]]);
  });

  it("short-caches host presence and emits low-cardinality telemetry", async () => {
    const env = testEnv();
    const control = new CountingControlHub({ onlineDeviceIDs: ["dd_test"] });
    const telemetryEvents = [];
    env.POCKLY_CONTROL_HUB = control;
    const cookie = await loginCookie(env);
    await loginDaemon(env, cookie);
    control.onlineDeviceBatches = [];

    const ctx = {
      providers: {
        telemetryProvider: {
          record: async ({ text }) => telemetryEvents.push(...JSON.parse(text).events),
        },
      },
    };
    const first = await call(env, "GET", "/api/hosts/online", null, { cookie }, ctx);
    const second = await call(env, "GET", "/api/hosts/online", null, { cookie }, ctx);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(control.onlineDeviceBatches, [["dd_test"]]);
    const presenceEvents = telemetryEvents.filter((event) => event.name === "nexus_presence_refresh");
    assert.deepEqual(presenceEvents.map((event) => event.presence_source), ["batch_control", "cache"]);
    assert.equal(presenceEvents[0].sessions_count, 0);
    assert.equal(presenceEvents[0].unique_daemon_count, 1);
    assert.equal(presenceEvents[0].presence_batch_size, 1);
  });

  it("does not touch presence for catalogs without controllable daemon devices", async () => {
    const env = testEnv();
    const control = new CountingControlHub();
    env.POCKLY_CONTROL_HUB = control;
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const disabled = await call(env, "POST", "/api/daemon/remote-access", { enabled: false }, {
      authorization: `Bearer ${daemon.device_access_token}`,
    });
    assert.equal(disabled.status, 200);
    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [
        {
          session_id: "sess_historical",
          agent: "claude-code",
          cwd: "/work/app",
          last_seq: 1,
          last_timestamp: "2026-06-06T01:00:01Z",
          turn_count: 1,
        },
      ],
    }, { authorization: `Bearer ${daemon.device_access_token}` });
    assert.equal(sync.status, 200);
    control.onlineDeviceBatches = [];

    const listed = await call(env, "GET", "/api/sessions", null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(listed.status, 200);
    const sessions = (await listed.json()).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].writable, false);
    assert.deepEqual(control.onlineDeviceBatches, []);
  });

  it("does not touch presence when there are no daemon hosts", async () => {
    const env = testEnv();
    const control = new CountingControlHub();
    env.POCKLY_CONTROL_HUB = control;
    const cookie = await loginCookie(env);
    const hosts = await call(env, "GET", "/api/hosts/online", null, { cookie });
    assert.equal(hosts.status, 200);
    assert.deepEqual(await hosts.json(), { hosts: [] });
    assert.deepEqual(control.onlineDeviceBatches, []);
  });

  it("runs the daemon device authorization claim and confirm flow", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const daemonKeys = await generateSigningKeyPair();
    const create = await call(env, "POST", "/api/daemon/device-authorizations", {
      daemon_device_id: "dd_auth",
      daemon_pubkey: daemonKeys.publicKey,
      device_name: "Auth Host",
      hostname: "auth-host",
      os: "linux",
      app_version: "0.2.0-test",
      computer_id: "dc_auth",
    });
    assert.equal(create.status, 200);
    const created = await create.json();
    assert.match(created.device_code, /^dac_/);
    assert.match(created.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.match(created.poll_secret, /^daps_/);
    assert.match(created.verification_uri_complete, /\/cli\/login\?device_code=dac_/);

    const unauth = await call(env, "GET", `/api/daemon/device-authorizations/${created.device_code}`);
    assert.equal(unauth.status, 401);

    const pending = await call(env, "GET", `/api/daemon/device-authorizations/${created.device_code}/token?poll_secret=${created.poll_secret}`);
    assert.deepEqual((await pending.json()).status, "pending");

    const browserKeys = await generateSigningKeyPair();
    const authorize = await call(env, "POST", `/api/daemon/device-authorizations/${created.device_code}/authorize`, {
      browser_device_pubkey: browserKeys.publicKey,
      device_name: "Auth Browser",
      user_agent: "node-test",
    }, { cookie });
    const authorized = await authorize.json();
    assert.equal(authorized.status, "awaiting_daemon_confirm");
    assert.equal(authorized.daemon_device_id, "dd_auth");
    assert.match(authorized.browser_device_id, /^bd_/);

    const awaiting = await call(env, "GET", `/api/daemon/device-authorizations/${created.device_code}/token?poll_secret=${created.poll_secret}`);
    const awaitingBody = await awaiting.json();
    assert.equal(awaitingBody.status, "awaiting_daemon_confirm");
    assert.equal(awaitingBody.claim.user_email, "test@example.local");

    const confirm = await call(env, "POST", `/api/daemon/device-authorizations/${created.device_code}/confirm`, {
      poll_secret: created.poll_secret,
      allow: true,
    });
    const confirmBody = await confirm.json();
    assert.equal(confirmBody.status, "authorized");
    assert.equal(confirmBody.daemon_device_id, "dd_auth");
    assert.equal(confirmBody.browser_device_id, authorized.browser_device_id);

    const beforeTokenHosts = await call(env, "GET", "/api/hosts/online", null, { cookie });
    assert.equal((await beforeTokenHosts.json()).hosts[0].presence_status, "offline");

    const token = await call(env, "GET", `/api/daemon/device-authorizations/${created.device_code}/token?poll_secret=${created.poll_secret}`);
    const tokenBody = await token.json();
    assert.equal(tokenBody.status, "authorized");
    assert.equal(tokenBody.daemon_device_id, "dd_auth");
    assert.match(tokenBody.device_access_token, /^dt_/);
    assert.match(tokenBody.device_refresh_token, /^drt_/);

    const challengeRes = await call(env, "POST", "/api/device-challenge", {
      device_id: "dd_auth",
      audience: "daemon-ws",
    });
    const challenge = await challengeRes.json();
    const signature = await daemonKeys.sign(challengeMessage(challenge));
    const verified = await call(env, "POST", "/api/device-challenge/verify", {
      device_id: "dd_auth",
      audience: "daemon-ws",
      challenge_id: challenge.challenge_id,
      signature,
    });
    assert.equal((await verified.json()).verified, true);

    const secondToken = await call(env, "GET", `/api/daemon/device-authorizations/${created.device_code}/token?poll_secret=${created.poll_secret}`);
    assert.equal(secondToken.status, 409);
  });

  it("supports setup grant claim, daemon polling, and local claim token return", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const daemonKeys = await generateSigningKeyPair();
    const browserKeys = await generateSigningKeyPair();

    const setup = await call(env, "POST", "/api/daemon/setup-grants", {
      daemon_device_id: "dd_setup",
      daemon_pubkey: daemonKeys.publicKey,
      device_name: "Setup Host",
      hostname: "setup-host",
      os: "darwin",
      app_version: "0.2.0-test",
      computer_id: "dc_setup",
    });
    const setupBody = await setup.json();
    assert.match(setupBody.setup_grant, /^ds_/);
    assert.match(setupBody.poll_secret, /^dsp_/);
    assert.match(setupBody.setup_url, /daemon_setup=ds_/);

    const pending = await call(env, "GET", `/api/daemon/setup-grants/${setupBody.setup_grant}/result?poll_secret=${setupBody.poll_secret}`);
    assert.equal((await pending.json()).status, "pending");

    const claim = await call(env, "POST", `/api/daemon/setup-grants/${setupBody.setup_grant}/claim`, {
      browser_device_pubkey: browserKeys.publicKey,
      device_name: "Setup Browser",
      user_agent: "node-test",
    }, { cookie });
    const claimBody = await claim.json();
    assert.equal(claimBody.status, "claimed");
    assert.equal(claimBody.daemon_device_id, "dd_setup");
    assert.match(claimBody.browser_device_id, /^bd_/);

    const result = await call(env, "GET", `/api/daemon/setup-grants/${setupBody.setup_grant}/result?poll_secret=${setupBody.poll_secret}`);
    const resultBody = await result.json();
    assert.equal(resultBody.status, "claimed");
    assert.equal(resultBody.user.email, "test@example.local");
    assert.match(resultBody.device_access_token, /^dt_/);
    assert.match(resultBody.device_refresh_token, /^drt_/);

    const localSetup = await call(env, "POST", "/api/daemon/setup-grants", {
      daemon_device_id: "dd_local",
      daemon_pubkey: daemonKeys.publicKey,
      device_name: "Local Host",
    });
    const localSetupBody = await localSetup.json();
    const localBrowserKeys = await generateSigningKeyPair();
    const localClaim = await call(env, "POST", "/api/daemon/local-claim", {
      daemon_setup: localSetupBody.setup_grant,
      browser_nonce: "nonce-123",
      browser_device_pubkey: localBrowserKeys.publicKey,
      device_name: "Local Browser",
      user_agent: "node-test",
    }, { cookie });
    const localClaimBody = await localClaim.json();
    assert.equal(localClaimBody.status, "claimed");
    assert.equal(localClaimBody.browser_nonce, "nonce-123");
    assert.equal(localClaimBody.daemon_device_id, "dd_local");
    assert.match(localClaimBody.device_access_token, /^dt_/);
    assert.match(localClaimBody.device_refresh_token, /^drt_/);
  });

  it("supports pairing grants through daemon polling, confirmation, and browser claim", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const daemonKeys = await generateSigningKeyPair();
    const browserKeys = await generateSigningKeyPair();

    const create = await call(env, "POST", "/api/pairing-grants", {
      daemon_device_id: "dd_pair",
      daemon_pubkey: daemonKeys.publicKey,
      relay_url: base,
      device_name: "Pair Host",
      hostname: "pair-host",
      os: "linux",
      computer_id: "dc_pair",
    });
    const created = await create.json();
    assert.match(created.pairing_grant, /^pg_/);
    assert.equal(created.qr_payload.daemon_device_id, "dd_pair");

    const pairingToken = await authenticateDevice(env, "dd_pair", "daemon-pairing", daemonKeys);
    const consume = await call(env, "POST", "/api/pairing-grants/consume", {
      pairing_grant: created.pairing_grant,
      browser_device_pubkey: browserKeys.publicKey,
      device_name: "Pair Browser",
      user_agent: "node-test",
    }, { cookie });
    const consumed = await consume.json();
    assert.equal(consumed.status, "awaiting_confirmation");
    assert.match(consumed.browser_device_id, /^bd_/);
    assert.equal(consumed.daemon_device_name, "Pair Host");

    const pending = await call(env, "GET", "/api/daemon/pairing-requests", null, {
      authorization: `Bearer ${pairingToken}`,
    });
    const requests = (await pending.json()).requests;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].pairing_grant, created.pairing_grant);

    const confirm = await call(env, "POST", `/api/pairing-grants/${created.pairing_grant}`, {
      allow: true,
    }, { authorization: `Bearer ${pairingToken}` });
    const confirmed = await confirm.json();
    assert.equal(confirmed.status, "consumed");
    assert.equal(confirmed.daemon_device_id, "dd_pair");
    assert.match(confirmed.device_access_token, /^dt_/);

    const claim = await call(env, "POST", `/api/pairing-grants/${created.pairing_grant}/claim`, null, { cookie });
    const claimed = await claim.json();
    assert.equal(claimed.browser_device_id, consumed.browser_device_id);
    assert.match(claimed.device_access_token, /^dt_/);
  });

  it("supports mobile QR grants and claims a browser into the account", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const daemon = await loginDaemon(env, cookie);
    const browserKeys = await generateSigningKeyPair();

    const grant = await call(env, "POST", "/api/daemon/mobile-join-grant", null, {
      authorization: `Bearer ${daemon.device_access_token}`,
    });
    const grantBody = await grant.json();
    assert.match(grantBody.grant_token, /^qrg_/);
    assert.match(grantBody.qr_payload, /\/mobile-join#grant=qrg_/);

    const claim = await call(env, "POST", "/api/devices/qr-claim", {
      grant_token: grantBody.grant_token,
      browser_device_pubkey: browserKeys.publicKey,
      device_name: "QR Browser",
      user_agent: "node-test",
    });
    const claimCookie = sessionCookie(claim);
    const claimBody = await claim.json();
    assert.equal(claimBody.status, "claimed");
    assert.equal(claimBody.user.email, "test@example.local");
    assert.match(claimBody.browser_device_id, /^bd_/);
    assert.match(claimBody.device_access_token, /^dt_/);
    assert.equal(claimBody.daemons_notified, 0);

    const session = await call(env, "GET", "/api/auth/session", null, { cookie: claimCookie });
    assert.equal((await session.json()).authenticated, true);

    const secondClaim = await call(env, "POST", "/api/devices/qr-claim", {
      grant_token: grantBody.grant_token,
      browser_device_pubkey: browserKeys.publicKey,
      device_name: "QR Browser",
    });
    assert.equal(secondClaim.status, 401);
  });

  it("connects a browser to a host, dispatches daemon update, and disconnects the binding", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const daemon = await loginDaemon(env, cookie);
    const envelopes = [];
    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async (envelope) => {
      envelopes.push(envelope);
    });

    const connect = await call(env, "POST", `/api/hosts/${daemon.daemon_device_id}/connect`, {
      browser_device_pubkey: browserKeys.publicKey,
      device_name: "Connected Browser",
      user_agent: "node-test",
    }, { cookie });
    assert.equal(connect.status, 200);
    const connected = await connect.json();
    assert.equal(connected.status, "connected");
    assert.equal(connected.daemon_device_id, daemon.daemon_device_id);
    assert.match(connected.browser_device_id, /^bd_/);
    assert.match(connected.device_access_token, /^dt_/);

    const update = await call(env, "POST", `/api/hosts/${daemon.daemon_device_id}/update`, {
      to_version: "0.2.0-test",
    }, { authorization: `Bearer ${connected.device_access_token}` });
    assert.equal(update.status, 202);
    assert.equal((await update.json()).status, "dispatched");
    assert.equal(envelopes[0].type, "UPDATE_REQUEST");
    assert.equal(envelopes[0].update_request.to_version, "0.2.0-test");

    const disconnect = await call(env, "POST", `/api/hosts/${daemon.daemon_device_id}/disconnect`, null, {
      authorization: `Bearer ${connected.device_access_token}`,
    });
    assert.equal(disconnect.status, 200);
    assert.equal((await disconnect.json()).status, "disconnected");

    const afterDisconnect = await call(env, "POST", `/api/hosts/${daemon.daemon_device_id}/update`, null, {
      authorization: `Bearer ${connected.device_access_token}`,
    });
    assert.equal(afterDisconnect.status, 403);
  });

  it("cancels an active inject through the control hub", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [
        { session_id: "sess_cancel", agent: "claude-code", cwd: "/work/app", last_seq: 1, last_timestamp: "2026-06-06T01:00:01Z", turn_count: 1 },
      ],
    }, { authorization: `Bearer ${daemon.device_access_token}` });

    const envelopes = [];
    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async (envelope) => {
      envelopes.push(envelope);
    });

    const inject = await call(env, "POST", `/api/sessions/sess_cancel/inject?device_id=${daemon.daemon_device_id}`, {
      text: "long task",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal(inject.status, 200);
    const { event, reader } = await readFirstSSEEvent(inject);
    assert.equal(event.type, "inject_started");

    const cancel = await call(env, "POST", `/api/injects/${event.request_id}/cancel`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(cancel.status, 200);
    assert.deepEqual(await cancel.json(), { status: "queued", request_id: event.request_id });
    assert.deepEqual(envelopes.map((envelope) => envelope.type), ["INJECT_REQUEST", "CANCEL_INJECT"]);
    assert.equal(envelopes[1].cancel_inject.request_id, event.request_id);
    await reader.cancel();
  });

  it("garbage-collects history blobs after daemon-confirmed session delete", async () => {
    const objectStore = new FakeObjectStore({});
    const env = testEnv({
      extra: {
        HISTORY_BLOBS: objectStore,
        POCKLY_HISTORY_BLOBS_ENABLED: "1",
        POCKLY_TURN_PAYLOAD_BLOB_THRESHOLD_BYTES: "16",
      },
    });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const browserAuth = { authorization: `Bearer ${browser.device_access_token}` };

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [{
        session_id: "sess_delete_gc",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "delete gc",
        last_seq: 1,
        last_timestamp: "2026-06-06T04:00:00.000Z",
        turn_count: 1,
        min_seq: 1,
        max_seq: 1,
      }],
      turns: [{
        session_id: "sess_delete_gc",
        seq: 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:00.000Z",
        payload: { text: "this manually deleted session payload should leave object storage" },
      }],
    }, daemonAuth);
    assert.equal(sync.status, 200);
    assert.equal(Object.keys(objectStore.objects).length, 1);

    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async (envelope, reply) => {
      assert.equal(envelope.type, "SESSION_DELETE");
      reply({
        type: "SESSION_DELETE_RESULT",
        session_delete_result: {
          request_id: envelope.session_delete.request_id,
          status: "ok",
          deleted: ["transcript"],
        },
      });
    });

    const deleted = await call(env, "POST", `/api/sessions/sess_delete_gc/delete?device_id=${daemon.daemon_device_id}`, null, browserAuth);
    const deletedBody = await deleted.json();
    assert.equal(deleted.status, 200, JSON.stringify(deletedBody));
    assert.deepEqual(Object.keys(objectStore.objects), []);
    assert.equal(objectStore.deleteCalls.length, 1);
  });

  it("does not let setup claim reassign an already-linked daemon to another user", async () => {
    const env = testEnv();
    const firstCookie = await loginCookie(env);
    const secondLogin = await call(env, "POST", "/api/dev/login", {
      email: "other@example.local",
      name: "Other User",
    });
    const secondCookie = sessionCookie(secondLogin);
    const daemonKeys = await generateSigningKeyPair();
    const firstBrowserKeys = await generateSigningKeyPair();
    const secondBrowserKeys = await generateSigningKeyPair();

    const firstSetup = await call(env, "POST", "/api/daemon/setup-grants", {
      daemon_device_id: "dd_no_reassign",
      daemon_pubkey: daemonKeys.publicKey,
      device_name: "No Reassign Host",
    });
    const firstSetupBody = await firstSetup.json();
    const firstClaim = await call(env, "POST", `/api/daemon/setup-grants/${firstSetupBody.setup_grant}/claim`, {
      browser_device_pubkey: firstBrowserKeys.publicKey,
      device_name: "First Browser",
    }, { cookie: firstCookie });
    assert.equal(firstClaim.status, 200);

    const secondSetup = await call(env, "POST", "/api/daemon/setup-grants", {
      daemon_device_id: "dd_no_reassign",
      daemon_pubkey: daemonKeys.publicKey,
      device_name: "No Reassign Host",
    });
    const secondSetupBody = await secondSetup.json();
    const secondClaim = await call(env, "POST", `/api/daemon/setup-grants/${secondSetupBody.setup_grant}/claim`, {
      browser_device_pubkey: secondBrowserKeys.publicKey,
      device_name: "Second Browser",
    }, { cookie: secondCookie });
    assert.equal(secondClaim.status, 409);
    assert.equal((await secondClaim.json()).error, "daemon_device_id is already linked to another account");
  });

  it("routes control-plane requests to the attached daemon", async () => {
    const env = testEnv();
    env.TERMINAL_ENABLED = "1";
    env.TERMINAL_STREAMING_ENABLED = "1";
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [
        { session_id: "sess_ctl", agent: "claude-code", cwd: "/work/app", last_seq: 1, last_timestamp: "2026-06-06T01:00:01Z", turn_count: 1 },
      ],
    }, { authorization: `Bearer ${daemon.device_access_token}` });

    const envelopes = [];
    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async (envelope, reply) => {
      envelopes.push(envelope);
      switch (envelope.type) {
        case "AGENT_DEFAULTS_GET":
          reply({
            type: "AGENT_DEFAULTS_RESULT",
            agent_defaults_result: {
              request_id: envelope.agent_defaults_get.request_id,
              status: "ok",
              default_model: "opus",
              resolved_model: "anthropic-compatible-pro",
              available_models: ["opus"],
              available_model_options: [{ value: "opus", resolved_model: "anthropic-compatible-pro", source: "claude_settings_env" }],
              available_permission_modes: ["default", "acceptEdits", "plan"],
              available_efforts: ["default"],
            },
          });
          break;
        case "AGENT_SETTINGS_GET":
          reply({
            type: "AGENT_SETTINGS_RESULT",
            agent_settings_result: {
              request_id: envelope.agent_settings_get.request_id,
              status: "ok",
              model: "opus",
              resolved_model: "anthropic-compatible-pro",
              permission_mode: "default",
              effort: "default",
              available_models: ["opus"],
              available_model_options: [{ value: "opus", resolved_model: "anthropic-compatible-pro" }],
              available_permission_modes: ["default"],
              available_efforts: ["default"],
            },
          });
          break;
        case "GIT_DIFF_GET":
          reply({ type: "GIT_DIFF_RESULT", git_diff_result: { request_id: envelope.git_diff_get.request_id, status: "ok", diff: "diff --git a/file b/file", truncated: false } });
          break;
        case "LIST_DIR_REQUEST":
          reply({ type: "LIST_DIR_RESPONSE", list_dir_response: { request_id: envelope.list_dir_request.request_id, path: "/work/app", entries: [{ name: "src", is_dir: true }] } });
          break;
        case "PERMISSION_DECIDE":
          reply({ type: "PERMISSION_DECIDE_EVENT", permission_decide_event: { request_id: envelope.permission_decide.request_id, status: "accepted" } });
          break;
        case "INJECT_REQUEST":
          reply({
            type: "INJECT_EVENT",
            event: {
              request_id: envelope.request.request_id,
              type: "inject_completed",
              session_id: envelope.request.session_id || "new_session",
              turn: {
                device_id: daemon.daemon_device_id,
                session_id: "sess_ctl",
                seq: 2,
                agent: "claude-code",
                kind: "assistant_text",
                timestamp: "2026-06-06T01:00:02Z",
                payload: { text: "done" },
              },
            },
          });
          break;
        case "TERMINAL_CREATE":
          reply({
            type: "TERMINAL_EVENT",
            terminal_event: {
              request_id: envelope.terminal_request.request_id,
              terminal_session_id: envelope.terminal_request.terminal_session_id,
              kind: "session_ready",
              session_status: "live",
              turn_status: "idle",
              timestamp: "2026-06-06T01:00:03Z",
            },
          });
          break;
        case "TERMINAL_INPUT":
        case "TERMINAL_OPEN_TERMINAL":
        case "TERMINAL_STOP":
          break;
        default:
          throw new Error(`unexpected envelope ${envelope.type}`);
      }
    });

    const listed = await call(env, "GET", "/api/sessions", null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal((await listed.json()).sessions[0].connection_mode, "sdk_headless");

    const defaults = await call(env, "GET", `/api/agent-defaults?daemon_device_id=${daemon.daemon_device_id}&cwd=%2Fwork%2Fapp`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const defaultsBody = await defaults.json();
    assert.equal(defaultsBody.resolved_model, "anthropic-compatible-pro");
    assert.deepEqual(defaultsBody.available_model_options[0], { value: "opus", resolved_model: "anthropic-compatible-pro", source: "claude_settings_env" });

    const settings = await call(env, "GET", `/api/sessions/sess_ctl/agent-settings?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal((await settings.json()).current.resolved_model, "anthropic-compatible-pro");

    const diff = await call(env, "GET", `/api/sessions/sess_ctl/diff?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.match((await diff.json()).diff, /diff --git/);

    const listDir = await call(env, "POST", "/api/daemon/list-dir", {
      daemon_device_id: daemon.daemon_device_id,
      path: "/work/app",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal((await listDir.json()).entries[0].name, "src");

    const decide = await call(env, "POST", "/api/permission-requests/pr_123/decide", {
      daemon_device_id: daemon.daemon_device_id,
      decision: "allow",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal((await decide.json()).status, "accepted");

    const browserSocket = env.POCKLY_CONTROL_HUB.attachBrowserForTest({
      userID: "usr_test",
      browserDeviceID: browser.browser_device_id,
      daemonDeviceID: daemon.daemon_device_id,
      sessionID: "sess_ctl",
    });
    const inject = await call(env, "POST", `/api/sessions/sess_ctl/inject?device_id=${daemon.daemon_device_id}`, {
      text: "hello",
      model: "opus",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal(inject.status, 200);
    const injectEvents = await readSSE(inject);
    assert.deepEqual(injectEvents.map((event) => event.type), ["inject_started", "inject_completed"]);
    assert.equal(browserSocket.messages[0].type, "TURN");
    assert.equal(browserSocket.messages[0].turn.payload.text, "done");
    browserSocket.cleanup();

    const terminalCreate = await call(env, "POST", "/api/terminal-sessions", {
      daemon_device_id: daemon.daemon_device_id,
      session_id: "sess_ctl",
      agent: "claude-code",
      cwd: "/work/app",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    const terminal = (await terminalCreate.json()).terminal_session;
    assert.match(terminal.terminal_session_id, /^ts_/);

    const terminalList = await call(env, "GET", "/api/terminal-sessions", null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal((await terminalList.json()).terminal_sessions[0].session_status, "live");

    const terminalInput = await call(env, "POST", `/api/terminal-sessions/${terminal.terminal_session_id}/input`, { text: "pwd\n" }, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal((await terminalInput.json()).status, "queued");

    const terminalOpen = await call(env, "POST", `/api/terminal-sessions/${terminal.terminal_session_id}/open-terminal`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal((await terminalOpen.json()).status, "queued");

    const terminalStop = await call(env, "POST", `/api/terminal-sessions/${terminal.terminal_session_id}/stop`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal((await terminalStop.json()).status, "queued");

    const terminalStream = await call(env, "GET", `/api/terminal-sessions/${terminal.terminal_session_id}/stream`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const terminalEvents = await readSSEEvents(terminalStream, 2);
    assert.equal(terminalEvents[0].kind, "terminal_session");
    assert.equal(terminalEvents[1].kind, "session_ready");

    assert.deepEqual(envelopes.map((envelope) => envelope.type), [
      "AGENT_DEFAULTS_GET",
      "AGENT_SETTINGS_GET",
      "GIT_DIFF_GET",
      "LIST_DIR_REQUEST",
      "PERMISSION_DECIDE",
      "INJECT_REQUEST",
      "TERMINAL_CREATE",
      "TERMINAL_INPUT",
      "TERMINAL_OPEN_TERMINAL",
      "TERMINAL_STOP",
      "TERMINAL_SUBSCRIBE",
      "TERMINAL_UNSUBSCRIBE",
    ]);
    assert.equal(envelopes.find((envelope) => envelope.type === "INJECT_REQUEST").request.model, "opus");
    const terminalSubscribe = envelopes.find((envelope) => envelope.type === "TERMINAL_SUBSCRIBE");
    assert.equal(terminalSubscribe.terminal_request.terminal_session_id, terminal.terminal_session_id);
  });

  it("uses polling fallback transport without browser websocket or long control streams", async () => {
    const env = testEnv();
    env.POCKLY_NEXUS_RUNTIME = "managed";
    env.REALTIME_ENABLED = "1";
    env.BROWSER_REALTIME_ENABLED = "0";
    env.CONTROL_STREAMING_ENABLED = "0";
    env.TERMINAL_ENABLED = "1";
    env.TERMINAL_STREAMING_ENABLED = "0";
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [
        { session_id: "sess_low", agent: "claude-code", cwd: "/work/app", last_seq: 1, last_timestamp: "2026-06-06T01:00:01Z", turn_count: 1 },
      ],
    }, { authorization: `Bearer ${daemon.device_access_token}` });

    const envelopes = [];
    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async (envelope, reply) => {
      envelopes.push(envelope);
      if (envelope.type === "INJECT_REQUEST") {
        reply({
          type: "INJECT_EVENT",
          event: {
            request_id: envelope.request.request_id,
            type: "inject_started",
            session_id: envelope.request.session_id,
            message: "noise event should not be persisted",
          },
        });
        // A mid-turn stream_event is delivered through the transient control
        // cache. It must not be duplicated into durable session_turns/events.
        reply({
          type: "INJECT_EVENT",
          event: {
            request_id: envelope.request.request_id,
            type: "stream_event",
            session_id: envelope.request.session_id,
            turn: {
              device_id: daemon.daemon_device_id,
              session_id: envelope.request.session_id,
              seq: 2,
              agent: "claude-code",
              kind: "assistant_text",
              timestamp: "2026-06-06T01:00:02Z",
              payload: { text: "live streamed block" },
            },
          },
        });
        reply({
          type: "INJECT_EVENT",
          event: {
            request_id: envelope.request.request_id,
            type: "inject_completed",
            session_id: envelope.request.session_id,
            turn: {
              device_id: daemon.daemon_device_id,
              session_id: envelope.request.session_id,
              seq: 3,
              agent: "claude-code",
              kind: "assistant_text",
              timestamp: "2026-06-06T01:00:03Z",
              payload: { text: "polling fallback done" },
            },
          },
        });
      }
      if (envelope.type === "SYNC_SESSION_REQUEST") {
        reply({
          type: "SYNC_SESSION_EVENT",
          sync_event: {
            request_id: envelope.sync_request.request_id,
            session_id: envelope.sync_request.session_id,
            device_id: daemon.daemon_device_id,
            stage: "completed",
            status: "completed",
            processed: 1,
            total: 1,
            turns: [{
              device_id: daemon.daemon_device_id,
              session_id: envelope.sync_request.session_id,
              seq: 41,
              agent: "claude-code",
              kind: "assistant_text",
              timestamp: "2026-06-06T00:00:41Z",
              payload: { text: "transient older window" },
            }],
          },
        });
      }
    });

    const browserSocket = await call(env, "GET", `/api/ws?access_token=${encodeURIComponent(browser.device_access_token)}`);
    assert.equal(browserSocket.status, 501);
    assert.equal((await browserSocket.json()).code, "unsupported_runtime");

    const inject = await call(env, "POST", `/api/sessions/sess_low/inject?device_id=${daemon.daemon_device_id}`, {
      text: "hello",
      model: "opus",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal(inject.status, 200);
    assert.equal(inject.headers.get("content-type"), "application/json; charset=utf-8");
    const injectBody = await inject.json();
    const injectEnvelope = envelopes.find((envelope) => envelope.type === "INJECT_REQUEST");
    assert.equal(injectBody.status, "accepted");
    assert.equal(injectBody.type, "inject_started");
    assert.equal(injectBody.session_id, "sess_low");
    assert.equal(injectBody.device_id, daemon.daemon_device_id);
    assert.equal(injectBody.streaming, false);
    assert.equal(injectBody.request_id, injectEnvelope.request.request_id);
    assert.equal(injectEnvelope.request.model, "opus");
    const injectEventBody = await readEventsEventually(env, `/api/sessions/sess_low/events?device_id=${daemon.daemon_device_id}&request_id=${injectBody.request_id}&after_seq=1`, {
      authorization: `Bearer ${browser.device_access_token}`,
    }, 1);
    // Only the lifecycle event persists as a session_events row; the mid-turn
    // stream_event content arrives through the transient control cache.
    assert.equal(injectEventBody.events.length, 1);
    assert.equal(injectEventBody.events[0].payload.type, "inject_completed");
    assert.equal(injectEventBody.events[0].payload.turn.payload.text, "polling fallback done");
    assert.deepEqual(injectEventBody.turns.map((turn) => [turn.seq, turn.payload.text]), [
      [2, "live streamed block"],
      [3, "polling fallback done"],
    ]);
    assert.equal(injectEventBody.next_seq, 3);
    // Cursor advance: nothing new after seq 3.
    const drained = await call(env, "GET", `/api/sessions/sess_low/events?device_id=${daemon.daemon_device_id}&request_id=${injectBody.request_id}&after=${encodeURIComponent(injectEventBody.next_cursor)}&after_seq=3`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const drainedBody = await drained.json();
    assert.equal(drainedBody.events.length, 0);
    assert.deepEqual(drainedBody.turns, []);
    assert.equal(drainedBody.next_seq, 3);
    // Managed runtime keeps all active-turn content transient for the current
    // reader. The daemon hot-window sync batches durable session_turns later.
    const turnsAfterInject = await call(env, "GET", `/api/sessions/sess_low/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const turnsAfterInjectBody = await turnsAfterInject.json();
    assert.deepEqual(turnsAfterInjectBody.turns.map((turn) => turn.seq).filter((seq) => seq >= 2), []);
    const persistedInjectEvents = await listSessionEventsEventually(env.POCKLY_NEXUS_STORE, "usr_test", daemon.daemon_device_id, "sess_low", {
      request_id: injectBody.request_id,
    }, 1);
    assert.equal(persistedInjectEvents.length, 1);
    const persistedInjectPayload = JSON.parse(persistedInjectEvents[0].payload);
    assert.equal(persistedInjectPayload.turn, undefined);
    assert.equal(persistedInjectPayload.turn_omitted, true);
    assert.equal(JSON.stringify(persistedInjectPayload).includes("polling fallback done"), false);

    const sync = await call(env, "POST", `/api/sessions/sess_low/sync?device_id=${daemon.daemon_device_id}`, {
      limit: 20,
      before_seq: 81,
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal(sync.status, 200);
    assert.equal(sync.headers.get("content-type"), "application/json; charset=utf-8");
    const syncBody = await sync.json();
    const syncEnvelope = envelopes.find((envelope) => envelope.type === "SYNC_SESSION_REQUEST");
    assert.equal(syncBody.status, "running");
    assert.equal(syncBody.stage, "queued");
    assert.equal(syncBody.session_id, "sess_low");
    assert.equal(syncBody.streaming, false);
    assert.equal(syncBody.request_id, syncEnvelope.sync_request.request_id);
    assert.equal(syncEnvelope.sync_request.limit, 20);
    assert.equal(syncEnvelope.sync_request.before_seq, 81);
    const syncEventBody = await readEventsEventually(env, `/api/sessions/sess_low/events?device_id=${daemon.daemon_device_id}&request_id=${syncBody.request_id}`, {
      authorization: `Bearer ${browser.device_access_token}`,
    }, 1);
    assert.equal(syncEventBody.events.length, 1);
    assert.equal(syncEventBody.events[0].payload.status, "completed");
    assert.deepEqual(syncEventBody.events[0].payload.turns.map((turn) => [turn.seq, turn.payload.text]), [
      [41, "transient older window"],
    ]);
    const persistedSyncEvents = await listSessionEventsEventually(env.POCKLY_NEXUS_STORE, "usr_test", daemon.daemon_device_id, "sess_low", {
      request_id: syncBody.request_id,
    }, 1);
    assert.equal(persistedSyncEvents.length, 1);
    const persistedSyncPayload = JSON.parse(persistedSyncEvents[0].payload);
    assert.equal(persistedSyncPayload.turns, undefined);
    assert.equal(persistedSyncPayload.turns_omitted, true);
    assert.equal(persistedSyncPayload.turns_omitted_count, 1);
    assert.equal(JSON.stringify(persistedSyncPayload).includes("transient older window"), false);
    const turnsAfterTransientSync = await call(env, "GET", `/api/sessions/sess_low/turns?device_id=${daemon.daemon_device_id}&limit=100&before_seq=81`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const turnsAfterTransientSyncBody = await turnsAfterTransientSync.json();
    assert.equal(turnsAfterTransientSyncBody.turns.some((turn) => turn.seq === 41), false);

    const terminalCreate = await call(env, "POST", "/api/terminal-sessions", {
      daemon_device_id: daemon.daemon_device_id,
      session_id: "sess_low",
      agent: "claude-code",
      cwd: "/work/app",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal(terminalCreate.status, 200);
    const terminal = (await terminalCreate.json()).terminal_session;
    assert.match(terminal.terminal_session_id, /^ts_/);
    assert.equal(envelopes.some((envelope) => envelope.type === "TERMINAL_CREATE"), true);

    const terminalStream = await call(env, "GET", `/api/terminal-sessions/${terminal.terminal_session_id}/stream`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(terminalStream.status, 501);
    assert.equal((await terminalStream.json()).code, "unsupported_runtime");

    await env.POCKLY_NEXUS_STORE.appendSessionEvent({
      user_id: "usr_test",
      device_id: daemon.daemon_device_id,
      session_id: "sess_low",
      request_id: terminal.terminal_session_id,
      event_type: "text_delta",
      payload: JSON.stringify({
        terminal_session_id: terminal.terminal_session_id,
        kind: "text_delta",
        payload: "persisted terminal batch",
        timestamp: "2026-06-06T01:00:03Z",
      }),
      created_at: "2026-06-06T01:00:03Z",
    });
    const terminalEvents = await call(env, "GET", `/api/terminal-sessions/${terminal.terminal_session_id}/events`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(terminalEvents.status, 200);
    const terminalEventsBody = await terminalEvents.json();
    assert.equal(terminalEventsBody.events.length, 1);
    assert.equal(terminalEventsBody.events[0].payload.payload, "persisted terminal batch");

    await env.POCKLY_NEXUS_STORE.appendSessionEvent({
      user_id: "usr_test",
      device_id: daemon.daemon_device_id,
      session_id: "sess_low",
      request_id: injectBody.request_id,
      event_type: "inject_completed",
      payload: JSON.stringify({
        request_id: injectBody.request_id,
        type: "inject_completed",
        session_id: "sess_low",
        turn: {
          device_id: daemon.daemon_device_id,
          session_id: "sess_low",
          seq: 3,
          agent: "claude-code",
          kind: "assistant_text",
          timestamp: "2026-06-06T01:00:04Z",
          payload: { text: "control event after terminal cursor" },
        },
      }),
      created_at: "2026-06-06T01:00:04Z",
    });
    const afterTerminalCursor = await call(env, "GET", `/api/sessions/sess_low/events?device_id=${daemon.daemon_device_id}&after=${encodeURIComponent(terminalEventsBody.next_cursor)}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(afterTerminalCursor.status, 200);
    const afterTerminalCursorBody = await afterTerminalCursor.json();
    assert.equal(afterTerminalCursorBody.events.length, 1);
    assert.equal(afterTerminalCursorBody.events[0].payload.turn.payload.text, "control event after terminal cursor");
  });

  it("does not persist every active-turn stream delta as a session event", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    env.POCKLY_NEXUS_RUNTIME = "managed";
    env.REALTIME_ENABLED = "1";
    env.BROWSER_REALTIME_ENABLED = "0";
    env.CONTROL_STREAMING_ENABLED = "0";
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [
        { session_id: "sess_burst", agent: "claude-code", cwd: "/work/app", last_seq: 1, last_timestamp: "2026-06-06T01:00:01Z", turn_count: 1 },
      ],
    }, { authorization: `Bearer ${daemon.device_access_token}` });

    store.resetCounts();
    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async (envelope, reply) => {
      if (envelope.type !== "INJECT_REQUEST") return;
      for (let seq = 2; seq <= 101; seq += 1) {
        reply({
          type: "INJECT_EVENT",
          event: {
            request_id: envelope.request.request_id,
            type: "stream_event",
            session_id: envelope.request.session_id,
            turn: {
              device_id: daemon.daemon_device_id,
              session_id: envelope.request.session_id,
              seq,
              agent: "claude-code",
              kind: "assistant_text",
              timestamp: `2026-06-06T01:${String(seq % 60).padStart(2, "0")}:00Z`,
              payload: { text: `delta ${seq}` },
            },
          },
        });
      }
      reply({
        type: "INJECT_EVENT",
        event: {
          request_id: envelope.request.request_id,
          type: "inject_completed",
          session_id: envelope.request.session_id,
          turn: {
            device_id: daemon.daemon_device_id,
            session_id: envelope.request.session_id,
            seq: 102,
            agent: "claude-code",
            kind: "assistant_text",
            timestamp: "2026-06-06T01:59:59Z",
            payload: { text: "done" },
          },
        },
      });
    });

    const inject = await call(env, "POST", `/api/sessions/sess_burst/inject?device_id=${daemon.daemon_device_id}`, {
      text: "burst",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal(inject.status, 200);
    const injectBody = await inject.json();
    const events = await readEventsEventually(env, `/api/sessions/sess_burst/events?device_id=${daemon.daemon_device_id}&request_id=${injectBody.request_id}&after_seq=1&limit=150`, {
      authorization: `Bearer ${browser.device_access_token}`,
    }, 1);

    assert.equal(events.events.length, 1);
    assert.equal(events.events[0].payload.type, "inject_completed");
    assert.equal(events.turns.length, 101);
    assert.equal(events.next_seq, 102);
    assert.equal(store.counts.appendSessionEvents, 1);
    assert.equal(store.counts.appendSessionEventRows, 1);
    assert.equal(store.counts.upsertTurnRows, 0);
    assert.equal(store.counts.pruneHotTurnCache, 0);
    assert.equal(store.pruneHotTurnCacheOptions.every((options) => Number(options.perSession) > 0), true);
    assert.equal(store.pruneHotTurnCacheOptions.every((options) => options.sessionKeys.length === 1), true);
    assert.equal(store.pruneHotTurnCacheOptions.filter((options) => Number(options.perUser) > 0).length <= 1, true);
    assert.equal(store.pruneHotTurnCacheOptions.filter((options) => options.inactiveBefore).length <= 1, true);

    const storedTurns = await call(env, "GET", `/api/sessions/sess_burst/turns?device_id=${daemon.daemon_device_id}&limit=150`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(storedTurns.status, 200);
    const storedTurnsBody = await storedTurns.json();
    assert.equal(storedTurnsBody.turns.length, 0);
  });

  it("keeps self-hosted completed inject turns durable for polling readers", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    env.CONTROL_STREAMING_ENABLED = "0";
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [
        { session_id: "sess_selfhost_final", agent: "claude-code", cwd: "/work/app", last_seq: 1, last_timestamp: "2026-06-06T01:00:01Z", turn_count: 1 },
      ],
    }, { authorization: `Bearer ${daemon.device_access_token}` });

    store.resetCounts();
    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async (envelope, reply) => {
      if (envelope.type !== "INJECT_REQUEST") return;
      reply({
        type: "INJECT_EVENT",
        event: {
          request_id: envelope.request.request_id,
          type: "inject_completed",
          session_id: envelope.request.session_id,
          turn: {
            device_id: daemon.daemon_device_id,
            session_id: envelope.request.session_id,
            seq: 2,
            agent: "claude-code",
            kind: "assistant_text",
            timestamp: "2026-06-06T01:00:02Z",
            payload: { text: "self-host durable final" },
          },
        },
      });
    });

    const inject = await call(env, "POST", `/api/sessions/sess_selfhost_final/inject?device_id=${daemon.daemon_device_id}`, {
      text: "self-host",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal(inject.status, 200);
    const injectBody = await inject.json();
    const events = await readEventsEventually(env, `/api/sessions/sess_selfhost_final/events?device_id=${daemon.daemon_device_id}&request_id=${injectBody.request_id}&after_seq=1`, {
      authorization: `Bearer ${browser.device_access_token}`,
    }, 1);
    assert.deepEqual(events.turns.map((turn) => [turn.seq, turn.payload.text]), [
      [2, "self-host durable final"],
    ]);
    const storedTurns = await call(env, "GET", `/api/sessions/sess_selfhost_final/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const storedTurnsBody = await storedTurns.json();
    assert.deepEqual(storedTurnsBody.turns.map((turn) => [turn.seq, turn.payload.text]), [
      [2, "self-host durable final"],
    ]);
    assert.equal(store.counts.upsertTurnRows, 1);
    assert.equal(store.counts.pruneHotTurnCache, 1);
  });

  it("keeps daemon stream_event turns live when inject_completed is only an ack", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    env.POCKLY_NEXUS_RUNTIME = "managed";
    env.REALTIME_ENABLED = "1";
    env.BROWSER_REALTIME_ENABLED = "0";
    env.CONTROL_STREAMING_ENABLED = "0";
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id },
      sessions: [
        { session_id: "sess_ack_only", agent: "claude-code", cwd: "/work/app", last_seq: 1, last_timestamp: "2026-06-06T01:00:01Z", turn_count: 1 },
      ],
    }, { authorization: `Bearer ${daemon.device_access_token}` });

    store.resetCounts();
    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async (envelope, reply) => {
      if (envelope.type !== "INJECT_REQUEST") return;
      reply({
        type: "INJECT_EVENT",
        event: {
          request_id: envelope.request.request_id,
          type: "stream_event",
          session_id: envelope.request.session_id,
          turn: {
            device_id: daemon.daemon_device_id,
            session_id: envelope.request.session_id,
            seq: 2,
            agent: "claude-code",
            kind: "assistant_text",
            timestamp: "2026-06-06T01:00:02Z",
            payload: { text: "live reply from stream event" },
          },
        },
      });
      reply({
        type: "INJECT_EVENT",
        event: {
          request_id: envelope.request.request_id,
          type: "inject_completed",
          session_id: envelope.request.session_id,
        },
      });
    });

    const inject = await call(env, "POST", `/api/sessions/sess_ack_only/inject?device_id=${daemon.daemon_device_id}`, {
      text: "ack only",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal(inject.status, 200);
    const injectBody = await inject.json();
    const events = await readEventsEventually(env, `/api/sessions/sess_ack_only/events?device_id=${daemon.daemon_device_id}&request_id=${injectBody.request_id}&after_seq=1`, {
      authorization: `Bearer ${browser.device_access_token}`,
    }, 1);

    assert.equal(events.events.length, 1);
    assert.equal(events.events[0].payload.type, "inject_completed");
    assert.deepEqual(events.turns.map((turn) => [turn.seq, turn.payload.text]), [
      [2, "live reply from stream event"],
    ]);
    assert.equal(store.counts.upsertTurnRows, 0);
    assert.equal(store.counts.appendSessionEventRows, 1);
  });

  it("falls back to live control terminal events in self-hosted runtime when persisted cache is disabled", async () => {
    const env = testEnv();
    env.TERMINAL_EVENT_CACHE_ENABLED = "0";
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);

    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async () => {});

    const terminalCreate = await call(env, "POST", "/api/terminal-sessions", {
      daemon_device_id: daemon.daemon_device_id,
      session_id: "sess_live_events",
      agent: "claude-code",
      cwd: "/work/app",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal(terminalCreate.status, 200);
    const terminal = (await terminalCreate.json()).terminal_session;

    env.POCKLY_CONTROL_HUB.receiveDaemonEnvelope(daemon.daemon_device_id, {
      type: "TERMINAL_EVENT",
      terminal_event: {
        terminal_session_id: terminal.terminal_session_id,
        kind: "text_delta",
        payload: "live terminal batch",
        session_id: "sess_live_events",
        timestamp: "2026-06-06T01:00:03Z",
      },
    });

    const first = await call(env, "GET", `/api/terminal-sessions/${terminal.terminal_session_id}/events?after=ev_0000000000000_000000`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.events.length, 1);
    assert.equal(firstBody.events[0].payload.payload, "live terminal batch");

    const second = await call(env, "GET", `/api/terminal-sessions/${terminal.terminal_session_id}/events?after=${encodeURIComponent(firstBody.next_cursor)}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { events: [], next_cursor: firstBody.next_cursor });
  });

  it("does not poll live control terminal events in managed runtime when persisted cache is disabled", async () => {
    const env = testEnv();
    env.POCKLY_NEXUS_RUNTIME = "managed";
    env.TERMINAL_EVENT_CACHE_ENABLED = "0";
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);

    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async () => {});

    const terminalCreate = await call(env, "POST", "/api/terminal-sessions", {
      daemon_device_id: daemon.daemon_device_id,
      session_id: "sess_managed_events",
      agent: "claude-code",
      cwd: "/work/app",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal(terminalCreate.status, 200);
    const terminal = (await terminalCreate.json()).terminal_session;

    env.POCKLY_CONTROL_HUB.receiveDaemonEnvelope(daemon.daemon_device_id, {
      type: "TERMINAL_EVENT",
      terminal_event: {
        terminal_session_id: terminal.terminal_session_id,
        kind: "text_delta",
        payload: "live terminal batch",
        session_id: "sess_managed_events",
        timestamp: "2026-06-06T01:00:03Z",
      },
    });

    const events = await call(env, "GET", `/api/terminal-sessions/${terminal.terminal_session_id}/events`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(events.status, 501);
    assert.deepEqual(await events.json(), {
      error: "terminal event polling requires browser realtime or terminal event cache in this runtime",
      code: "unsupported_runtime",
    });
  });

  it("exposes request-scoped events for polling fallback new-session starts before a session id exists", async () => {
    const env = testEnv();
    env.CONTROL_STREAMING_ENABLED = "0";
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);

    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async (envelope, reply) => {
      if (envelope.type !== "INJECT_REQUEST") return;
      reply({
        type: "INJECT_EVENT",
        event: {
          request_id: envelope.request.request_id,
          type: "session_created",
          session_id: "sess_new_low",
          message: "Session created",
        },
      });
      reply({
        type: "INJECT_EVENT",
        event: {
          request_id: envelope.request.request_id,
          type: "inject_completed",
          session_id: "sess_new_low",
          turn: {
            device_id: daemon.daemon_device_id,
            session_id: "sess_new_low",
            seq: 1,
            agent: "claude-code",
            kind: "assistant_text",
            timestamp: "2026-06-06T01:00:02Z",
            payload: { text: "new polling fallback done" },
          },
        },
      });
    });

    const start = await call(env, "POST", "/api/tasks", {
      daemon_device_id: daemon.daemon_device_id,
      agent: "claude-code",
      cwd: "/work/app",
      text: "hello",
      model: "opus",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal(start.status, 200);
    const startBody = await start.json();
    assert.equal(startBody.status, "accepted");
    assert.equal(startBody.streaming, false);
    assert.equal(startBody.session_id, "");

    const body = await readEventsEventually(env, `/api/injects/${startBody.request_id}/events`, {
      authorization: `Bearer ${browser.device_access_token}`,
    }, 2);
    assert.deepEqual(body.events.map((event) => event.payload.type), ["session_created", "inject_completed"]);
    assert.equal(body.events[1].payload.turn.payload.text, "new polling fallback done");
  });

  it("exposes polling fallback new-session failures before a session id exists", async () => {
    const env = testEnv();
    env.CONTROL_STREAMING_ENABLED = "0";
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);

    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async (envelope, reply) => {
      if (envelope.type !== "INJECT_REQUEST") return;
      reply({
        type: "INJECT_EVENT",
        event: {
          request_id: envelope.request.request_id,
          type: "inject_failed",
          error: "agent failed before session creation",
        },
      });
    });

    const start = await call(env, "POST", "/api/tasks", {
      daemon_device_id: daemon.daemon_device_id,
      agent: "claude-code",
      cwd: "/work/app",
      text: "hello",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal(start.status, 200);
    const startBody = await start.json();
    assert.equal(startBody.status, "accepted");
    assert.equal(startBody.session_id, "");

    const body = await readEventsEventually(env, `/api/injects/${startBody.request_id}/events`, {
      authorization: `Bearer ${browser.device_access_token}`,
    }, 1);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].payload.type, "inject_failed");
    assert.equal(body.events[0].payload.error, "agent failed before session creation");
    assert.equal(body.events[0].session_id, "");
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

  it("serves push config, stores push subscriptions and feedback, and reports unconfigured voice STT", async () => {
    const env = testEnv();
    env.WEB_PUSH_ENABLED = "1";
    env.VAPID_PUBLIC_KEY = "B".repeat(88);
    env.VAPID_PRIVATE_KEY = "C".repeat(43);
    const cookie = await loginCookie(env);
    const authSession = await call(env, "GET", "/api/auth/session", null, { cookie });
    const userID = (await authSession.json()).user.user_id;
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);

    const vapid = await call(env, "GET", "/api/push/vapid-public-key");
    assert.equal((await vapid.json()).public_key, env.VAPID_PUBLIC_KEY);

    const subscription = await call(env, "POST", "/api/push/subscriptions", {
      endpoint: "https://push.example/subscription",
      keys: { p256dh: "p256dh-key", auth: "auth-secret" },
      user_agent: "node-test",
    }, { authorization: `Bearer ${browser.device_access_token}` });
    assert.equal(subscription.status, 200);
    const subscriptionBody = await subscription.json();
    assert.match(subscriptionBody.subscription_id, /^ps_/);
    assert.equal(subscriptionBody.status, "active");
    assert.equal((await env.POCKLY_NEXUS_STORE.listActivePushSubscriptionsForUser(userID)).length, 1);

    const deleteSubscription = await call(env, "DELETE", `/api/push/subscriptions/${subscriptionBody.subscription_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    assert.equal(deleteSubscription.status, 200);
    assert.equal((await deleteSubscription.json()).status, "deleted");
    assert.equal((await env.POCKLY_NEXUS_STORE.listActivePushSubscriptionsForUser(userID)).length, 0);

    const form = new FormData();
    form.set("message", "This is feedback");
    form.set("page_path", "/workspace/sessions");
    form.set("attachment", new Blob(["hello"], { type: "text/plain" }), "note.txt");
    const feedback = await handleRequest(new Request(`${base}/api/feedback`, {
      method: "POST",
      headers: { authorization: `Bearer ${browser.device_access_token}` },
      body: form,
    }), env);
    assert.equal(feedback.status, 200);
    const feedbackBody = await feedback.json();
    assert.match(feedbackBody.feedback_id, /^fb_/);
    assert.equal(feedbackBody.status, "accepted");

    const voice = await handleRequest(new Request(`${base}/api/voice/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${browser.device_access_token}` },
      body: new FormData(),
    }), env);
    assert.equal(voice.status, 503);
    assert.equal((await voice.json()).error, "voice transcription is not configured");

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, init) => {
        assert.equal(url, "https://voice.example/transcribe");
        assert.equal(init.headers.get("authorization"), "Bearer voice-key");
        assert.equal(init.body.get("model"), "whisper-1");
        assert.ok(init.body.get("audio") instanceof File);
        return Response.json({ text: "hello voice", provider: "mock-stt", duration_ms: 123, fallback_used: false });
      };
      const voiceForm = new FormData();
      voiceForm.set("audio", new Blob(["voice"], { type: "audio/webm" }), "voice.webm");
      const proxiedVoice = await handleRequest(new Request(`${base}/api/voice/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${browser.device_access_token}` },
        body: voiceForm,
      }), {
        ...env,
        VOICE_TRANSCRIPTION_ENDPOINT: "https://voice.example/transcribe",
        VOICE_TRANSCRIPTION_API_KEY: "voice-key",
        VOICE_TRANSCRIPTION_MODEL: "whisper-1",
      });
      assert.equal(proxiedVoice.status, 200);
      assert.deepEqual(await proxiedVoice.json(), {
        text: "hello voice",
        provider: "mock-stt",
        duration_ms: 123,
        fallback_used: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses injected push and STT providers consistently with runtime capabilities", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const transcriptions = [];
    const providers = {
      store: env.POCKLY_NEXUS_STORE,
      controlHub: env.POCKLY_CONTROL_HUB,
      pushProvider: {
        publicKey: "provider-public-key",
        send: async () => ({ ok: true, status: 201 }),
      },
      sttProvider: {
        transcribe: async ({ form }) => {
          transcriptions.push({ audio: form.get("audio"), durationMs: form.get("duration_ms") });
          return { text: "provider transcript", provider: "test-provider", duration_ms: Number(form.get("duration_ms") || 0) };
        },
      },
    };

    const runtime = await handleRequest(new Request(`${base}/api/runtime`), {
      REALTIME_ENABLED: "1",
      WEB_PUSH_ENABLED: "1",
      STT_ENABLED: "1",
    }, { providers });
    assert.deepEqual(await runtime.json(), {
      runtime: "self_hosted",
      realtime: true,
      browser_realtime: true,
      browser_realtime_control: false,
      control_streaming: true,
      terminal: false,
      terminal_streaming: false,
      web_push: true,
      stt: true,
      release_update: false,
      contract_version: "1",
    });

    const vapid = await handleRequest(new Request(`${base}/api/push/vapid-public-key`), {
      WEB_PUSH_ENABLED: "1",
    }, { providers });
    assert.equal(vapid.status, 200);
    assert.deepEqual(await vapid.json(), { public_key: "provider-public-key" });

    const voiceForm = new FormData();
    voiceForm.set("duration_ms", "456");
    voiceForm.set("audio", new Blob(["voice"], { type: "audio/webm" }), "voice.webm");
    const voice = await handleRequest(new Request(`${base}/api/voice/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${browser.device_access_token}` },
      body: voiceForm,
    }), {
      STT_ENABLED: "1",
    }, { providers });
    assert.equal(voice.status, 200);
    assert.deepEqual(await voice.json(), {
      text: "provider transcript",
      provider: "test-provider",
      duration_ms: 456,
      fallback_used: false,
    });
    assert.equal(transcriptions.length, 1);
    assert.ok(transcriptions[0].audio instanceof File);
  });

  it("builds browser realtime commands with the same ownership checks as HTTP control", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    await env.POCKLY_NEXUS_STORE.upsertDevice({
      user_id: daemon.user_id,
      device_id: daemon.daemon_device_id,
      kind: "daemon",
      public_key: "daemon-public",
      name: "Pockly Test Host",
      status: "active",
      remote_access_enabled: true,
      created_at: "2026-06-10T00:00:00.000Z",
      updated_at: "2026-06-10T00:00:00.000Z",
    });
    await env.POCKLY_NEXUS_STORE.upsertDeviceBinding({
      user_id: daemon.user_id,
      daemon_device_id: daemon.daemon_device_id,
      browser_device_id: browser.browser_device_id,
      status: "active",
      created_at: "2026-06-10T00:00:00.000Z",
      updated_at: "2026-06-10T00:00:00.000Z",
    });
    await env.POCKLY_NEXUS_STORE.upsertSession({
      user_id: daemon.user_id,
      device_id: daemon.daemon_device_id,
      session_id: "sess_realtime",
      agent: "codex",
      cwd: "/work/app",
      title: "Realtime",
      snippet: "hello",
      last_seq: 12,
      last_timestamp: "2026-06-10T00:00:00.000Z",
      updated_at: "2026-06-10T00:00:00.000Z",
    });

    const build = createBrowserRealtimeCommandHandler(env.POCKLY_NEXUS_STORE, {});
    const spec = await build({
      userID: daemon.user_id,
      browserDeviceID: browser.browser_device_id,
      message: {
        type: "COMMAND",
        command: "inject_session",
        request_id: "bcmd_realtime",
        daemon_device_id: daemon.daemon_device_id,
        session_id: "sess_realtime",
        payload: { text: "continue", model: "gpt-5.1-codex" },
      },
    });

    assert.equal(spec.mode, "stream");
    assert.equal(spec.daemonDeviceID, daemon.daemon_device_id);
    assert.equal(spec.envelope.type, "INJECT_REQUEST");
    assert.deepEqual(spec.envelope.request, {
      request_id: "bcmd_realtime",
      daemon_device_id: daemon.daemon_device_id,
      browser_device_id: browser.browser_device_id,
      mode: "resume_session",
      session_id: "sess_realtime",
      agent: "codex",
      cwd: "/work/app",
      text: "continue",
      model: "gpt-5.1-codex",
      files: [],
    });

    await assert.rejects(
      () => build({
        userID: daemon.user_id,
        browserDeviceID: "bd_not_bound",
        message: {
          type: "COMMAND",
          command: "inject_session",
          request_id: "bcmd_reject",
          daemon_device_id: daemon.daemon_device_id,
          session_id: "sess_realtime",
          payload: { text: "continue" },
        },
      }),
      /browser is not connected to this host/,
    );

    await env.POCKLY_NEXUS_STORE.upsertDevice({
      user_id: daemon.user_id,
      device_id: daemon.daemon_device_id,
      kind: "daemon",
      public_key: "daemon-public",
      name: "Pockly Test Host",
      status: "active",
      remote_access_enabled: false,
      created_at: "2026-06-10T00:00:00.000Z",
      updated_at: "2026-06-10T00:01:00.000Z",
    });
    await assert.rejects(
      () => build({
        userID: daemon.user_id,
        browserDeviceID: browser.browser_device_id,
        message: {
          type: "COMMAND",
          command: "session_opened_hint",
          request_id: "bcmd_remote_disabled",
          daemon_device_id: daemon.daemon_device_id,
          payload: { session_id: "sess_realtime" },
        },
      }),
      /remote access is disabled/,
    );
  });

  it("stores per-user session and project prefs without partial-update clobbering", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const keys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, keys.publicKey);
    const auth = { authorization: `Bearer ${browser.device_access_token}` };

    const empty = await call(env, "GET", "/api/prefs", null, auth);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { session_prefs: [], project_prefs: [] });

    // Pin a session, then rename it in a SEPARATE call — the rename must not
    // clobber the pin (COALESCE semantics), and vice versa.
    const pin = await call(env, "POST", "/api/sessions/sess-1/prefs", {
      device_id: "dev-1",
      pinned: true,
    }, auth);
    assert.equal(pin.status, 200);
    const opened = await call(env, "POST", "/api/sessions/sess-1/opened", {
      device_id: "dev-1",
      opened_at: "2026-06-10T08:00:00.000Z",
    }, auth);
    assert.equal(opened.status, 200);
    assert.deepEqual(await opened.json(), {
      device_id: "dev-1",
      session_id: "sess-1",
      last_opened_at: "2026-06-10T08:00:00.000Z",
    });
    const rename = await call(env, "POST", "/api/sessions/sess-1/prefs", {
      device_id: "dev-1",
      custom_title: "我的会话",
    }, auth);
    assert.equal(rename.status, 200);
    assert.deepEqual(await rename.json(), {
      device_id: "dev-1",
      session_id: "sess-1",
      pinned: true,
      archived: false,
      custom_title: "我的会话",
    });

    // Project prefs: pin + rename + archive accumulate the same way.
    const proj = await call(env, "POST", "/api/projects/prefs", {
      device_id: "dev-1",
      cwd: "/Users/me/aqua",
      pinned: true,
    }, auth);
    assert.equal(proj.status, 200);
    const projRename = await call(env, "POST", "/api/projects/prefs", {
      device_id: "dev-1",
      cwd: "/Users/me/aqua",
      custom_label: "Aqua 主仓",
    }, auth);
    assert.deepEqual(await projRename.json(), {
      device_id: "dev-1",
      cwd: "/Users/me/aqua",
      pinned: true,
      archived: false,
      removed: false,
      custom_label: "Aqua 主仓",
    });

    const listed = await call(env, "GET", "/api/prefs", null, auth);
    const body = await listed.json();
    assert.equal(body.session_prefs.length, 1);
    assert.equal(body.session_prefs[0].pinned, true);
    assert.equal(body.session_prefs[0].custom_title, "我的会话");
    assert.equal(body.project_prefs.length, 1);
    assert.equal(body.project_prefs[0].pinned, true);
    assert.equal(body.project_prefs[0].custom_label, "Aqua 主仓");

    // Unpinning with an explicit false lands (false ≠ "absent").
    await call(env, "POST", "/api/sessions/sess-1/prefs", {
      device_id: "dev-1",
      pinned: false,
    }, auth);
    const afterUnpin = await (await call(env, "GET", "/api/prefs", null, auth)).json();
    assert.equal(afterUnpin.session_prefs[0].pinned, false);
    assert.equal(afterUnpin.session_prefs[0].custom_title, "我的会话");

    // Missing device_id is rejected.
    const bad = await call(env, "POST", "/api/sessions/sess-1/prefs", { pinned: true }, auth);
    assert.equal(bad.status, 400);

    // Prefs are per-user: a second user sees none.
    const otherCookie = sessionCookie(await call(env, "POST", "/api/dev/login", {
      email: "other@example.local",
      name: "Other",
    }));
    const otherKeys = await generateSigningKeyPair();
    const otherBrowser = await registerBrowser(env, otherCookie, otherKeys.publicKey);
    const otherList = await call(env, "GET", "/api/prefs", null, {
      authorization: `Bearer ${otherBrowser.device_access_token}`,
    });
    assert.deepEqual(await otherList.json(), { session_prefs: [], project_prefs: [] });
  });

  it("returns daemon sync hints for pinned and recently opened sessions only on that daemon", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const keys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, keys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const auth = { authorization: `Bearer ${browser.device_access_token}` };
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };

    await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [
        { session_id: "sess_recent_open", agent: "claude-code", cwd: "/work", turn_count: 200, last_timestamp: "2026-06-10T00:00:00.000Z" },
        { session_id: "sess_pinned_old", agent: "claude-code", cwd: "/work", turn_count: 200, last_timestamp: "2026-04-10T00:00:00.000Z" },
        { session_id: "sess_old", agent: "claude-code", cwd: "/work", turn_count: 200, last_timestamp: "2026-04-09T00:00:00.000Z" },
        { session_id: "sess_large_recent_open", agent: "codex", cwd: "/work", turn_count: 2001, last_timestamp: "2026-06-10T00:00:00.000Z" },
      ],
      full_reconcile: true,
    }, daemonAuth);

    const now = new Date().toISOString();
    await call(env, "POST", "/api/sessions/sess_recent_open/opened", {
      device_id: daemon.daemon_device_id,
      opened_at: now,
    }, auth);
    await call(env, "POST", "/api/sessions/sess_pinned_old/prefs", {
      device_id: daemon.daemon_device_id,
      pinned: true,
    }, auth);
    await call(env, "POST", "/api/sessions/sess_old/opened", {
      device_id: daemon.daemon_device_id,
      opened_at: "2020-01-01T00:00:00.000Z",
    }, auth);
    await call(env, "POST", "/api/sessions/sess_other_device/opened", {
      device_id: "dd_other",
      opened_at: now,
    }, auth);
    await call(env, "POST", "/api/sessions/sess_large_recent_open/opened", {
      device_id: daemon.daemon_device_id,
      opened_at: now,
    }, auth);

    store.resetCounts();
    const hints = await call(env, "GET", "/api/daemon/sync-hints", null, daemonAuth);
    assert.equal(hints.status, 200);
    assert.deepEqual(await hints.json(), {
      sessions: [
        {
          session_id: "sess_pinned_old",
          reason: "pinned",
          preferred_min: 100,
          synced_turn_count: 0,
          synced_min_seq: 0,
          synced_max_seq: 0,
          latest_contiguous_min_seq: 0,
          next_before_seq: 0,
          total_turn_count: 200,
          has_older_turns: false,
        },
        {
          session_id: "sess_recent_open",
          reason: "recently_opened",
          preferred_min: 100,
          synced_turn_count: 0,
          synced_min_seq: 0,
          synced_max_seq: 0,
          latest_contiguous_min_seq: 0,
          next_before_seq: 0,
          total_turn_count: 200,
          has_older_turns: false,
        },
      ],
    });
    assert.equal(store.counts.listDeviceSessionHintSnapshots, 1);
    assert.equal(store.counts.listDeviceSessions, 0);
    assert.equal(store.counts.listSessionPrefsForDevice, 1);
    assert.equal(store.counts.listSessionOpenHintsForDevice, 1);
    assert.equal(store.counts.listSessionPrefsForUser, 0);
    assert.equal(store.counts.listSessionOpenHintsForUser, 0);
  });

  it("returns sync hint range metadata so daemon can backfill older windows", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const keys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, keys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const auth = { authorization: `Bearer ${browser.device_access_token}` };
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const turns = [];
    for (let seq = 141; seq <= 240; seq += 1) {
      turns.push({
        session_id: "sess_gap",
        seq,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: `2026-06-06T03:${String(seq % 60).padStart(2, "0")}:00.000Z`,
        payload: { text: `turn ${seq}` },
      });
    }
    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_gap",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "gap",
        last_seq: 240,
        last_timestamp: "2026-06-06T03:59:00.000Z",
        sync_state: "partial",
        turn_count: 240,
        min_seq: 141,
        max_seq: 240,
        has_older: true,
      }],
      turns,
    }, daemonAuth);
    assert.equal(sync.status, 200);

    const opened = await call(env, "POST", "/api/sessions/sess_gap/opened", {
      device_id: daemon.daemon_device_id,
      opened_at: new Date().toISOString(),
    }, auth);
    assert.equal(opened.status, 200);

    const hints = await call(env, "GET", "/api/daemon/sync-hints", null, daemonAuth);
    assert.equal(hints.status, 200);
    const body = await hints.json();
    assert.match(body.sessions[0].window_hash, /^sha256:[A-Za-z0-9_-]+$/);
    delete body.sessions[0].window_hash;
    assert.deepEqual(body, {
      sessions: [{
        session_id: "sess_gap",
        reason: "recently_opened",
        preferred_min: 100,
        synced_turn_count: 100,
        synced_min_seq: 141,
        synced_max_seq: 240,
        latest_contiguous_min_seq: 141,
        next_before_seq: 141,
        total_turn_count: 240,
        has_older_turns: true,
      }],
    });
  });

  it("returns sync hint cursor for the newest contiguous range when older rows are non-contiguous", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const keys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, keys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const auth = { authorization: `Bearer ${browser.device_access_token}` };
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };

    const syncWindow = async (min, max, hasOlder) => {
      const turns = [];
      for (let seq = min; seq <= max; seq += 1) {
        turns.push({
          session_id: "sess_noncontiguous",
          seq,
          agent: "claude-code",
          kind: "assistant_text",
          timestamp: `2026-06-06T07:${String(seq % 60).padStart(2, "0")}:00.000Z`,
          payload: { text: `turn ${seq}` },
        });
      }
      const res = await call(env, "POST", "/api/daemon/sync", {
        hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
        sessions: [{
          session_id: "sess_noncontiguous",
          agent: "claude-code",
          cwd: "/work/app",
          snippet: "gap",
          last_seq: 240,
          last_timestamp: "2026-06-06T07:59:00.000Z",
          sync_state: "partial",
          turn_count: 240,
          min_seq: min,
          max_seq: max,
          has_older: hasOlder,
        }],
        turns,
      }, daemonAuth);
      assert.equal(res.status, 200);
    };

    await syncWindow(141, 240, true);
    await syncWindow(1, 40, true);
    const opened = await call(env, "POST", "/api/sessions/sess_noncontiguous/opened", {
      device_id: daemon.daemon_device_id,
    }, auth);
    assert.equal(opened.status, 200);

    const hints = await call(env, "GET", "/api/daemon/sync-hints", null, daemonAuth);
    assert.equal(hints.status, 200);
    const body = await hints.json();
    assert.match(body.sessions[0].window_hash, /^sha256:[A-Za-z0-9_-]+$/);
    delete body.sessions[0].window_hash;
    assert.deepEqual(body, {
      sessions: [{
        session_id: "sess_noncontiguous",
        reason: "recently_opened",
        preferred_min: 100,
        synced_turn_count: 100,
        synced_min_seq: 141,
        synced_max_seq: 240,
        latest_contiguous_min_seq: 141,
        next_before_seq: 141,
        total_turn_count: 240,
        has_older_turns: true,
      }],
    });

    const listed = await call(env, "GET", "/api/sessions", null, auth);
    const session = (await listed.json()).sessions.find((item) => item.session_id === "sess_noncontiguous");
    assert.equal(session.has_older_turns, true);
    assert.equal(session.sync_state, "partial");
  });

  it("keeps the newest contiguous cursor when appending after non-contiguous older history", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const keys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, keys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const auth = { authorization: `Bearer ${browser.device_access_token}` };
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };

    const syncWindow = async (min, max, total = 260) => {
      const turns = [];
      for (let seq = min; seq <= max; seq += 1) {
        turns.push({
          session_id: "sess_noncontiguous_append",
          seq,
          agent: "claude-code",
          kind: "assistant_text",
          timestamp: `2026-06-06T08:${String(seq % 60).padStart(2, "0")}:00.000Z`,
          payload: { text: `turn ${seq}` },
        });
      }
      const res = await call(env, "POST", "/api/daemon/sync", {
        hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
        sessions: [{
          session_id: "sess_noncontiguous_append",
          agent: "claude-code",
          cwd: "/work/app",
          snippet: "gap append",
          last_seq: total,
          last_timestamp: "2026-06-06T08:59:00.000Z",
          sync_state: "partial",
          turn_count: total,
          min_seq: min,
          max_seq: max,
          has_older: true,
        }],
        turns,
      }, daemonAuth);
      assert.equal(res.status, 200);
    };

    await syncWindow(141, 240, 260);
    const existing = await store.getSession("usr_test", daemon.daemon_device_id, "sess_noncontiguous_append");
    await store.upsertSession({
      ...existing,
      synced_turn_count: 140,
      actual_turn_count: 140,
      synced_min_seq: 1,
      synced_max_seq: 240,
      latest_contiguous_min_seq: 141,
      has_older_turns: true,
    });
    await syncWindow(241, 260, 260);

    const opened = await call(env, "POST", "/api/sessions/sess_noncontiguous_append/opened", {
      device_id: daemon.daemon_device_id,
    }, auth);
    assert.equal(opened.status, 200);

    const hints = await call(env, "GET", "/api/daemon/sync-hints", null, daemonAuth);
    assert.equal(hints.status, 200);
    const body = await hints.json();
    assert.equal(body.sessions[0].synced_turn_count, 160);
    assert.equal(body.sessions[0].synced_min_seq, 1);
    assert.equal(body.sessions[0].synced_max_seq, 260);
    assert.equal(body.sessions[0].latest_contiguous_min_seq, 141);
    assert.equal(body.sessions[0].next_before_seq, 141);
  });

  it("does not persist older backfill windows into the durable hot-turn cache", async () => {
    const store = new CountingNexusStore();
    const env = testEnv({ store });
    const cookie = await loginCookie(env);
    const keys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, keys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const auth = { authorization: `Bearer ${browser.device_access_token}` };
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };

    const latestTurns = [];
    for (let seq = 141; seq <= 240; seq += 1) {
      latestTurns.push({
        session_id: "sess_no_write_old_window",
        seq,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: `2026-06-06T09:${String(seq % 60).padStart(2, "0")}:00.000Z`,
        payload: { text: `tail ${seq}` },
      });
    }
    const latest = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_no_write_old_window",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "tail",
        last_seq: 240,
        last_timestamp: "2026-06-06T09:59:00.000Z",
        sync_state: "partial",
        turn_count: 240,
        min_seq: 141,
        max_seq: 240,
        has_older: true,
      }],
      turns: latestTurns,
    }, daemonAuth);
    assert.equal(latest.status, 200);
    assert.equal((await latest.json()).turn_count, 100);

    store.resetCounts();
    const oldTurns = [];
    for (let seq = 41; seq <= 140; seq += 1) {
      oldTurns.push({
        session_id: "sess_no_write_old_window",
        seq,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: `2026-06-06T08:${String(seq % 60).padStart(2, "0")}:00.000Z`,
        payload: { text: `old ${seq}` },
      });
    }
    const old = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_no_write_old_window",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "old window",
        last_seq: 240,
        last_timestamp: "2026-06-06T08:59:00.000Z",
        sync_state: "partial",
        turn_count: 240,
        min_seq: 41,
        max_seq: 140,
        has_older: true,
      }],
      turns: oldTurns,
    }, daemonAuth);
    assert.equal(old.status, 200);
    const oldBody = await old.json();
    assert.equal(oldBody.turn_count, 0);
    assert.equal(oldBody.received_turn_count, 100);
    assert.equal(store.counts.upsertTurnRows, 0);
    assert.equal(store.counts.pruneHotTurnCache, 0);
    assert.equal(store.counts.appendSessionCatalogChangeRows, 0);

    const turns = await call(env, "GET", `/api/sessions/sess_no_write_old_window/turns?device_id=${daemon.daemon_device_id}&full=1&limit=0`, null, auth);
    const turnsBody = await turns.json();
    assert.equal(turnsBody.turns.length, 100);
    assert.equal(turnsBody.oldest_seq, 141);
    assert.equal(turnsBody.latest_seq, 240);
    assert.equal(turnsBody.turns.some((turn) => turn.seq === 41), false);

    const listed = await call(env, "GET", "/api/sessions", null, auth);
    const session = (await listed.json()).sessions.find((item) => item.session_id === "sess_no_write_old_window");
    assert.equal(session.turn_count, 240);
    assert.equal(session.synced_turn_count, 100);
    assert.equal(session.synced_min_seq, 141);
    assert.equal(session.synced_max_seq, 240);
    assert.equal(session.has_older_turns, true);
  });

  it("computes sync hint window_hash with the daemon-compatible algorithm", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const keys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, keys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const auth = { authorization: `Bearer ${browser.device_access_token}` };
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };
    const turns = [];
    for (let seq = 1; seq <= 3; seq += 1) {
      turns.push({
        session_id: "sess_hash_parity",
        seq,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: `2026-06-06T04:0${seq}:00.000Z`,
        payload: { text: `turn ${seq}` },
      });
    }

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_hash_parity",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "hash",
        last_seq: 3,
        last_timestamp: "2026-06-06T04:03:00.000Z",
        sync_state: "fully_synced",
        turn_count: 3,
        min_seq: 1,
        max_seq: 3,
        has_older: false,
      }],
      turns,
    }, daemonAuth);
    assert.equal(sync.status, 200);

    const opened = await call(env, "POST", "/api/sessions/sess_hash_parity/opened", {
      device_id: daemon.daemon_device_id,
      opened_at: new Date().toISOString(),
    }, auth);
    assert.equal(opened.status, 200);

    const hints = await call(env, "GET", "/api/daemon/sync-hints", null, daemonAuth);
    assert.equal(hints.status, 200);
    const body = await hints.json();
    assert.equal(body.sessions[0].window_hash, "sha256:5snTIyF1vDYeoLml9s3oSpSLyexv6juLDgHZ9if9ruw");
  });

  it("pushes a SYNC_HINT over the control WS when a session is opened", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const keys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, keys.publicKey);
    const auth = { authorization: `Bearer ${browser.device_access_token}` };
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };

    const envelopes = [];
    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async (envelope) => {
      envelopes.push(envelope);
    });

    const turns = [];
    for (let seq = 41; seq <= 60; seq += 1) {
      turns.push({
        session_id: "sess_hint_push",
        seq,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: `2026-06-06T08:${String(seq % 60).padStart(2, "0")}:00.000Z`,
        payload: { text: `turn ${seq}` },
      });
    }
    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_hint_push",
        agent: "claude-code",
        cwd: "/work/app",
        snippet: "push",
        last_seq: 60,
        last_timestamp: "2026-06-06T08:59:00.000Z",
        sync_state: "partial",
        turn_count: 60,
        min_seq: 41,
        max_seq: 60,
        has_older: true,
      }],
      turns,
    }, daemonAuth);
    assert.equal(sync.status, 200);

    const opened = await call(env, "POST", "/api/sessions/sess_hint_push/opened", {
      device_id: daemon.daemon_device_id,
    }, auth);
    assert.equal(opened.status, 200);

    const hint = envelopes.find((envelope) => envelope.type === "SYNC_HINT");
    assert.ok(hint, "daemon should receive a SYNC_HINT envelope");
    assert.match(hint.sync_hint.window_hash, /^sha256:[A-Za-z0-9_-]+$/);
    delete hint.sync_hint.window_hash;
    assert.deepEqual(hint.sync_hint, {
      session_id: "sess_hint_push",
      reason: "recently_opened",
      preferred_min: 100,
      synced_turn_count: 20,
      synced_min_seq: 41,
      synced_max_seq: 60,
      latest_contiguous_min_seq: 41,
      next_before_seq: 41,
      total_turn_count: 60,
      has_older_turns: true,
    });

    // An offline daemon must not break the opened endpoint — the hint is
    // best-effort and the persisted open hint still covers the poll path.
    const offline = await call(env, "POST", "/api/sessions/sess_hint_push/opened", {
      device_id: "dd_not_connected",
    }, auth);
    assert.equal(offline.status, 200);
  });

  it("does not push recently-opened SYNC_HINT for large sessions", async () => {
    const env = testEnv();
    const cookie = await loginCookie(env);
    const keys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, keys.publicKey);
    const auth = { authorization: `Bearer ${browser.device_access_token}` };
    const daemon = await loginDaemon(env, cookie);
    const daemonAuth = { authorization: `Bearer ${daemon.device_access_token}` };

    const envelopes = [];
    env.POCKLY_CONTROL_HUB.attachDaemonForTest(daemon.daemon_device_id, "usr_test", async (envelope) => {
      envelopes.push(envelope);
    });

    const sync = await call(env, "POST", "/api/daemon/sync", {
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [{
        session_id: "sess_large_hint_skip",
        agent: "codex",
        cwd: "/work/large",
        snippet: "large",
        last_seq: 2001,
        last_timestamp: "2026-06-06T08:59:00.000Z",
        sync_state: "catalog_only",
        turn_count: 2001,
      }],
    }, daemonAuth);
    assert.equal(sync.status, 200);

    const opened = await call(env, "POST", "/api/sessions/sess_large_hint_skip/opened", {
      device_id: daemon.daemon_device_id,
      opened_at: "2026-06-10T08:00:00.000Z",
    }, auth);
    assert.equal(opened.status, 200);
    assert.deepEqual(await opened.json(), {
      device_id: daemon.daemon_device_id,
      session_id: "sess_large_hint_skip",
      last_opened_at: "2026-06-10T08:00:00.000Z",
    });
    assert.deepEqual(envelopes.filter((envelope) => envelope.type === "SYNC_HINT"), []);

    const hints = await call(env, "GET", "/api/daemon/sync-hints", null, daemonAuth);
    assert.deepEqual(await hints.json(), { sessions: [] });
    assert.deepEqual(await env.POCKLY_NEXUS_STORE.listSessionOpenHintsForDevice("usr_test", daemon.daemon_device_id), []);

    const turns = await call(env, "GET", `/api/sessions/sess_large_hint_skip/turns?device_id=${daemon.daemon_device_id}`, null, auth);
    assert.equal(turns.status, 200);
    const turnsBody = await turns.json();
    assert.deepEqual(turnsBody.turns, []);
    assert.equal(turnsBody.needs_sync, true);
    assert.equal(turnsBody.total_turn_count, 2001);
    assert.equal(turnsBody.synced_turn_count, 0);
    assert.equal(turnsBody.has_older_turns, true);
  });
});

function testEnv(options = {}) {
  return {
    POCKLY_NEXUS_STORE: options.store || new InMemoryNexusStore(),
    POCKLY_CONTROL_HUB: new InMemoryControlHub(),
    POCKLY_HOSTS_ONLINE_CACHE_SCOPE: randomIDForTest("cache"),
    POCKLY_SESSION_EVENT_BATCH_MS: "1",
    ...(options.devLogin === false ? {} : { POCKLY_NEXUS_DEV_LOGIN_ENABLED: "1" }),
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

async function authenticateDevice(env, deviceId, audience, keyPair) {
  const challengeRes = await call(env, "POST", "/api/device-challenge", {
    device_id: deviceId,
    audience,
  });
  assert.equal(challengeRes.status, 200);
  const challenge = await challengeRes.json();
  const signature = await keyPair.sign(challengeMessage(challenge));
  const verified = await call(env, "POST", "/api/device-challenge/verify", {
    device_id: deviceId,
    audience,
    challenge_id: challenge.challenge_id,
    signature,
  });
  assert.equal(verified.status, 200);
  const body = await verified.json();
  assert.equal(body.verified, true);
  assert.match(body.device_access_token, /^dt_/);
  return body.device_access_token;
}

async function call(env, method, path, body, headers = {}, ctx = {}) {
  return await callWithContext(env, method, path, body, headers, ctx);
}

async function callWithContext(env, method, path, body, headers = {}, ctx = {}) {
  const init = {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(headers.cookie ? { cookie: headers.cookie } : {}),
      ...(headers.authorization ? { authorization: headers.authorization } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  return await handleRequest(new Request(`${base}${path}`, init), env, ctx);
}

async function readEventsEventually(env, path, headers, count) {
  let body = { events: [] };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = await call(env, "GET", path, null, headers);
    assert.equal(res.status, 200);
    body = await res.json();
    if ((body.events || []).length >= count) return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return body;
}

async function listSessionEventsEventually(store, userID, deviceID, sessionID, options, count) {
  let events = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    events = await store.listSessionEvents(userID, deviceID, sessionID, options);
    if (events.length >= count) return events;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return events;
}

async function readSSE(response) {
  const text = await response.text();
  return text.split(/\n\n+/)
    .map((chunk) => chunk.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

async function readSSEEvents(response, count) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (readSSEText(text).length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return readSSEText(text).slice(0, count);
}

async function readFirstSSEEvent(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (readSSEText(text).length < 1) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return { event: readSSEText(text)[0], reader };
}

function readSSEText(text) {
  return text.split(/\n\n+/)
    .map((chunk) => chunk.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

function sessionCookie(response) {
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "response set-cookie missing");
  return cookie.split(";")[0];
}

function assertSyncTimings(timings, keys) {
  assert.ok(timings && typeof timings === "object", "sync response should include timings_ms");
  for (const key of keys) {
    assert.equal(typeof timings[key], "number", `timings_ms.${key} should be numeric`);
  }
}

function randomIDForTest(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2)}`;
}

class FakeObjectStore {
  constructor(objects, options = {}) {
    this.objects = objects;
    this.oneShotReads = Boolean(options.oneShotReads);
    this.getCalls = [];
    this.putCalls = [];
    this.deleteCalls = [];
  }

  async get(key) {
    this.getCalls.push(key);
    const value = this.objects[key];
    if (value == null) return null;
    let consumed = false;
    const read = async () => {
      if (this.oneShotReads && consumed) throw new Error("object body already consumed");
      consumed = true;
      return value;
    };
    return {
      text: async () => String(await read()),
      arrayBuffer: async () => valueToArrayBuffer(await read()),
    };
  }

  async put(key, value) {
    this.putCalls.push(key);
    this.objects[key] = value;
    return { key };
  }

  async delete(key) {
    this.deleteCalls.push(key);
    delete this.objects[key];
  }
}

async function readGzipObjectText(object) {
  return await new Response(new Blob([await object.arrayBuffer()]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

function valueToArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return new TextEncoder().encode(String(value)).buffer;
}

class CountingControlHub extends InMemoryControlHub {
  constructor(options = {}) {
    super(options);
    this.onlineDeviceIDs = new Set(options.onlineDeviceIDs || []);
    this.onlineDeviceBatches = [];
  }

  async onlineDevices(deviceIDs = []) {
    const ids = [];
    const seen = new Set();
    for (const deviceID of deviceIDs) {
      const next = String(deviceID || "");
      if (!next || seen.has(next)) continue;
      seen.add(next);
      ids.push(next);
    }
    this.onlineDeviceBatches.push(ids);
    return Object.fromEntries(ids.map((deviceID) => [deviceID, this.onlineDeviceIDs.has(deviceID)]));
  }
}

class CountingNexusStore extends InMemoryNexusStore {
  constructor() {
    super();
    this.resetCounts();
  }

  resetCounts() {
    this.counts = {
      listDeviceSessions: 0,
      listDeviceSessionSyncSnapshots: 0,
      listDeviceSessionSyncSnapshotsByIDs: 0,
      listDeviceSessionHintSnapshots: 0,
      deleteMissingDeviceSessions: 0,
      deleteMissingDeviceSessionsFromExisting: 0,
      getSession: 0,
      getSessionTurnStats: 0,
      listTurns: 0,
      listExistingTurnKeys: 0,
      listExistingTurnPayloads: 0,
      listTurnPayloadPointers: 0,
      upsertTurns: 0,
      upsertTurnRows: 0,
      upsertSessions: 0,
      upsertSessionRows: 0,
      appendSessionCatalogChange: 0,
      appendSessionCatalogChanges: 0,
      appendSessionCatalogChangeRows: 0,
      appendSessionEvents: 0,
      appendSessionEventRows: 0,
      listDevicesForUser: 0,
      listSessionsForUser: 0,
      countSessionsByDeviceForUser: 0,
      listSessionPrefsForUser: 0,
      listSessionPrefsForDevice: 0,
      listSessionOpenHintsForUser: 0,
      listSessionOpenHintsForDevice: 0,
      pruneHotTurnCache: 0,
    };
    this.pruneHotTurnCacheOptions = [];
  }

  async upsertSessions(sessions) {
    this.counts.upsertSessions += 1;
    this.counts.upsertSessionRows += sessions.length;
    return await super.upsertSessions(sessions);
  }

  async upsertTurns(turns) {
    this.counts.upsertTurns += 1;
    this.counts.upsertTurnRows += turns.length;
    return await super.upsertTurns(turns);
  }

  async appendSessionCatalogChange(change) {
    this.counts.appendSessionCatalogChange += 1;
    this.counts.appendSessionCatalogChangeRows += 1;
    return await super.appendSessionCatalogChange(change);
  }

  async appendSessionCatalogChanges(changes) {
    this.counts.appendSessionCatalogChanges += 1;
    this.counts.appendSessionCatalogChangeRows += changes.length;
    return await InMemoryNexusStore.prototype.appendSessionCatalogChanges.call(this, changes);
  }

  async appendSessionEvent(event) {
    this.counts.appendSessionEvents += 1;
    this.counts.appendSessionEventRows += 1;
    return await super.appendSessionEvent(event);
  }

  async appendSessionEvents(events = []) {
    this.counts.appendSessionEvents += 1;
    this.counts.appendSessionEventRows += events.length;
    return await super.appendSessionEvents(events);
  }

  async pruneHotTurnCache(options = {}) {
    this.counts.pruneHotTurnCache += 1;
    this.pruneHotTurnCacheOptions.push(options);
    return await super.pruneHotTurnCache(options);
  }

  async listDeviceSessions(...args) {
    this.counts.listDeviceSessions += 1;
    return await super.listDeviceSessions(...args);
  }

  async listDeviceSessionSyncSnapshots(...args) {
    this.counts.listDeviceSessionSyncSnapshots += 1;
    return await super.listDeviceSessionSyncSnapshots(...args);
  }

  async listDeviceSessionSyncSnapshotsByIDs(...args) {
    this.counts.listDeviceSessionSyncSnapshotsByIDs += 1;
    return await super.listDeviceSessionSyncSnapshotsByIDs(...args);
  }

  async listDeviceSessionHintSnapshots(...args) {
    this.counts.listDeviceSessionHintSnapshots += 1;
    return await super.listDeviceSessionHintSnapshots(...args);
  }

  async deleteMissingDeviceSessions(...args) {
    this.counts.deleteMissingDeviceSessions += 1;
    return await super.deleteMissingDeviceSessions(...args);
  }

  async deleteMissingDeviceSessionsFromExisting(...args) {
    this.counts.deleteMissingDeviceSessionsFromExisting += 1;
    return await super.deleteMissingDeviceSessionsFromExisting(...args);
  }

  async getSession(...args) {
    this.counts.getSession += 1;
    return await super.getSession(...args);
  }

  async getSessionTurnStats(...args) {
    this.counts.getSessionTurnStats += 1;
    return await super.getSessionTurnStats(...args);
  }

  async listTurns(...args) {
    this.counts.listTurns += 1;
    return await super.listTurns(...args);
  }

  async listExistingTurnKeys(...args) {
    this.counts.listExistingTurnKeys += 1;
    return await super.listExistingTurnKeys(...args);
  }

  async listExistingTurnPayloads(...args) {
    this.counts.listExistingTurnPayloads += 1;
    return await super.listExistingTurnPayloads(...args);
  }

  async listTurnPayloadPointers(...args) {
    this.counts.listTurnPayloadPointers += 1;
    return await super.listTurnPayloadPointers(...args);
  }

  async listSessionsForUser(...args) {
    this.counts.listSessionsForUser += 1;
    return await super.listSessionsForUser(...args);
  }

  async listSessionCatalogPage(...args) {
    if (this.onListSessionCatalogPage) {
      await this.onListSessionCatalogPage(...args);
    }
    return await super.listSessionCatalogPage(...args);
  }

  async listDevicesForUser(...args) {
    this.counts.listDevicesForUser += 1;
    return await super.listDevicesForUser(...args);
  }

  async countSessionsByDeviceForUser(...args) {
    this.counts.countSessionsByDeviceForUser += 1;
    return await super.countSessionsByDeviceForUser(...args);
  }

  async listSessionPrefsForUser(...args) {
    this.counts.listSessionPrefsForUser += 1;
    return await super.listSessionPrefsForUser(...args);
  }

  async listSessionPrefsForDevice(...args) {
    this.counts.listSessionPrefsForDevice += 1;
    return await super.listSessionPrefsForDevice(...args);
  }

  async listSessionOpenHintsForUser(...args) {
    this.counts.listSessionOpenHintsForUser += 1;
    return await super.listSessionOpenHintsForUser(...args);
  }

  async listSessionOpenHintsForDevice(...args) {
    this.counts.listSessionOpenHintsForDevice += 1;
    return await super.listSessionOpenHintsForDevice(...args);
  }
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
