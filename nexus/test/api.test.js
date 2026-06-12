/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { base64Url, challengeMessage } from "../src/auth.js";
import { handleRequest } from "../src/app.js";
import { InMemoryControlHub } from "../src/control.js";
import { InMemoryNexusStore } from "../src/store.js";

const base = "https://nexus-runtime.test";

describe("worker-native Nexus api", () => {
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
      session_upsert_count: syncBody.session_upsert_count,
      daemon_device: syncBody.daemon_device,
      daemon_version: syncBody.daemon_version,
    }, {
      ok: true,
      session_count: 2,
      turn_count: 2,
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

  it("tiers large turn payloads to object storage without changing the read API", async () => {
    const objectStore = new FakeObjectStore({});
    const env = testEnv({
      extra: {
        RELEASES: objectStore,
        HISTORY_BLOBS: objectStore,
        POCKLY_TURN_PAYLOAD_BLOB_THRESHOLD_BYTES: "16",
      },
    });
    const cookie = await loginCookie(env);
    const browserKeys = await generateSigningKeyPair();
    const browser = await registerBrowser(env, cookie, browserKeys.publicKey);
    const daemon = await loginDaemon(env, cookie);
    const largePayload = { text: "this payload is intentionally larger than the test threshold" };

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
    assert.equal(Object.keys(objectStore.objects).length, 1);
    assert.equal(await objectStore.get(pointer.key).then((object) => object.text()), JSON.stringify(largePayload));

    const turns = await call(env, "GET", `/api/sessions/sess_blob_payload/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const body = await turns.json();
    assert.deepEqual(body.turns[0].payload, largePayload);
  });

  it("treats daemon-uploaded blob pointer shaped payloads as ordinary content", async () => {
    const objectStore = new FakeObjectStore({});
    const env = testEnv({
      extra: {
        HISTORY_BLOBS: objectStore,
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
    const env = testEnv({
      extra: {
        HISTORY_BLOBS: objectStore,
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
        turn_count: 1,
        min_seq: 1,
        max_seq: 1,
      }],
      turns: [{
        session_id: "sess_blob_gc",
        seq: 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T04:00:00.000Z",
        payload: { text: "this payload should be externalized and later deleted" },
      }],
    }, daemonAuth);
    assert.equal(first.status, 200);
    assert.equal(Object.keys(objectStore.objects).length, 1);

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
  });

  it("merges lazy backfill windows instead of replacing the latest synced range", async () => {
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
    assert.equal(middleBody.turns.length, 40);
    assert.equal(middleBody.oldest_seq, 21);
    assert.equal(middleBody.latest_seq, 60);
    assert.equal(middleBody.synced_turn_count, 40);
    assert.equal(middleBody.has_older_turns, true);

    await syncWindow(1, 20, false);

    const complete = await call(env, "GET", `/api/sessions/sess_merge/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const completeBody = await complete.json();
    assert.equal(completeBody.turns.length, 60);
    assert.equal(completeBody.oldest_seq, 1);
    assert.equal(completeBody.latest_seq, 60);
    assert.equal(completeBody.synced_turn_count, 60);
    assert.equal(completeBody.has_older_turns, false);

    const listed = await call(env, "GET", "/api/sessions", null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const session = (await listed.json()).sessions.find((item) => item.session_id === "sess_merge");
    assert.equal(session.sync_state, "fully_synced");
    assert.equal(session.synced_min_seq, 1);
    assert.equal(session.synced_max_seq, 60);
    assert.equal(session.has_older_turns, false);
  });

  it("does not inflate synced turn count when the daemon retries the same window", async () => {
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
    assert.equal((await call(env, "POST", "/api/daemon/sync", syncPayload, daemonAuth)).status, 200);

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

  it("uses one batch presence lookup for large session catalogs", async () => {
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
    assert.deepEqual(control.onlineDeviceBatches, [["dd_test"]]);
    assert.equal(telemetryEvents[0].command, "sessions");
    assert.equal(telemetryEvents[0].sessions_count, 336);
    assert.equal(telemetryEvents[0].unique_daemon_count, 1);
    assert.equal(telemetryEvents[0].presence_batch_size, 1);
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
    assert.equal(store.counts.listDeviceSessions, 0);
    assert.equal(store.counts.upsertSessions, 0);
    assert.equal(store.counts.upsertSessionRows, 0);
    assert.equal(store.counts.getSessionTurnStats, 0);
    const preserved = await store.getSession("usr_test", daemon.daemon_device_id, "sess_reconcile_001");
    assert.equal(preserved.first_message, "existing long first message should survive catalog-only sync");
  });

  it("uses batch presence for host lists", async () => {
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
    assert.deepEqual(telemetryEvents.map((event) => event.presence_source), ["batch_do", "cache"]);
    assert.equal(telemetryEvents[0].sessions_count, 0);
    assert.equal(telemetryEvents[0].unique_daemon_count, 1);
    assert.equal(telemetryEvents[0].presence_batch_size, 1);
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
        payload: { text: "this manually deleted session payload should leave R2" },
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
        // A mid-turn stream_event: its turn must land in session_turns (one
        // write) and must NOT be duplicated into a session_events row.
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
    // stream_event content arrives once through session_turns instead.
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
    // The live-written turns are durable: the plain turns endpoint sees them
    // without any daemon window sync having run.
    const turnsAfterInject = await call(env, "GET", `/api/sessions/sess_low/turns?device_id=${daemon.daemon_device_id}`, null, {
      authorization: `Bearer ${browser.device_access_token}`,
    });
    const turnsAfterInjectBody = await turnsAfterInject.json();
    assert.deepEqual(turnsAfterInjectBody.turns.map((turn) => turn.seq).filter((seq) => seq >= 2), [2, 3]);

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

  it("falls back to live control terminal events when persisted cache is disabled", async () => {
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
    assert.deepEqual(await hints.json(), {
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
    assert.deepEqual(await hints.json(), {
      sessions: [{
        session_id: "sess_noncontiguous",
        reason: "recently_opened",
        preferred_min: 100,
        synced_turn_count: 140,
        synced_min_seq: 1,
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
});

function testEnv(options = {}) {
  return {
    POCKLY_NEXUS_STORE: options.store || new InMemoryNexusStore(),
    POCKLY_CONTROL_HUB: new InMemoryControlHub(),
    POCKLY_HOSTS_ONLINE_CACHE_SCOPE: randomIDForTest("cache"),
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
  constructor(objects) {
    this.objects = objects;
    this.getCalls = [];
    this.deleteCalls = [];
  }

  async get(key) {
    this.getCalls.push(key);
    const value = this.objects[key];
    if (value == null) return null;
    return { text: async () => value };
  }

  async put(key, value) {
    this.objects[key] = String(value);
    return { key };
  }

  async delete(key) {
    this.deleteCalls.push(key);
    delete this.objects[key];
  }
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
      listDeviceSessionHintSnapshots: 0,
      deleteMissingDeviceSessions: 0,
      deleteMissingDeviceSessionsFromExisting: 0,
      getSession: 0,
      getSessionTurnStats: 0,
      listTurns: 0,
      upsertSessions: 0,
      upsertSessionRows: 0,
      listSessionPrefsForUser: 0,
      listSessionPrefsForDevice: 0,
      listSessionOpenHintsForUser: 0,
      listSessionOpenHintsForDevice: 0,
    };
  }

  async upsertSessions(sessions) {
    this.counts.upsertSessions += 1;
    this.counts.upsertSessionRows += sessions.length;
    return await super.upsertSessions(sessions);
  }

  async listDeviceSessions(...args) {
    this.counts.listDeviceSessions += 1;
    return await super.listDeviceSessions(...args);
  }

  async listDeviceSessionSyncSnapshots(...args) {
    this.counts.listDeviceSessionSyncSnapshots += 1;
    return await super.listDeviceSessionSyncSnapshots(...args);
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
