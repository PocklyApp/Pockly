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
    assert.equal(hostBody.hosts[0].daemon_latest_version, "v0.1.1");
    assert.equal(hostBody.hosts[0].daemon_update_available, true);
    assert.equal(hostBody.hosts[0].daemon_update_source, "release_latest");

    const devices = await call(env, "GET", "/api/devices", null, { cookie });
    const daemonDevice = (await devices.json()).devices.find((device) => device.device_id === daemon.daemon_device_id);
    assert.equal(daemonDevice.daemon_latest_version, "v0.1.1");
    assert.equal(daemonDevice.daemon_update_available, true);
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
    ]);
    assert.equal(envelopes.find((envelope) => envelope.type === "INJECT_REQUEST").request.model, "opus");
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
      terminal: false,
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
});

function testEnv(options = {}) {
  return {
    POCKLY_NEXUS_STORE: new InMemoryNexusStore(),
    POCKLY_CONTROL_HUB: new InMemoryControlHub(),
    ...(options.devLogin === false ? {} : { POCKLY_NEXUS_DEV_LOGIN_ENABLED: "1" }),
  };
}

async function loginCookie(env) {
  const res = await call(env, "POST", "/api/dev/login", {
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

class FakeObjectStore {
  constructor(objects) {
    this.objects = objects;
  }

  async get(key) {
    const value = this.objects[key];
    if (value == null) return null;
    return { text: async () => value };
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
