/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CHALLENGE_TTL_SECONDS,
  WEB_SESSION_TTL_SECONDS,
  base64Url,
  challengeMessage,
  clearSessionCookie,
  createOpaqueToken,
  fromBase64Url,
  issueDeviceToken,
  requireDeviceAuth,
  requireUserFromCookieOrDevice,
  requireWebUser,
  sessionCookie,
  sha256Base64URL,
  verifyDeviceSignature,
} from "./auth.js";
import {
  ErrorCode,
  errorResponse,
  jsonResponse,
  nexusRuntimeCapabilities,
} from "./contract.js";
import {
  createControlHubForUser,
  injectStreamOptions,
  mapControlError,
  syncStreamOptions,
} from "./control.js";
import { createNexusProviderBundle, requireNexusProvider } from "./core/providers.js";
import { isWebPushConfigured, webPushPublicKey } from "./push.js";
import { daemonReleaseSnapshot, withDaemonReleaseInfo } from "./release.js";
import { createStore } from "./store.js";

const onlineWindowMs = 2 * 60 * 1000;
const recentlyOpenedSyncHintMs = 24 * 60 * 60 * 1000;
const prioritySyncHintTurnLimit = 100;
const defaultHostsOnlineCacheMs = 1000;
const hostsOnlineCache = new Map();

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  const requestRuntime = createRequestRuntime(env, ctx);
  env = requestRuntime.env;
  const store = requestRuntime.store;

  try {
    if (path === "/healthz") return await healthz(request);
    if (path === "/api/runtime") return await runtime(request, env);
    if (path === "/api/auth/session") return await authSession(request, store);
    if (path === "/api/auth/logout") return await authLogout(request, store);
    if (path === "/api/dev/login") return await devLogin(request, store, env);
    if (path === "/api/auth/login") return await passwordLogin(request, store);
    if (path === "/api/auth/register") return await registerAccount(request, store);
    if (path === "/api/auth/register/verify") return await verifyRegistration(request);
    if (path === "/api/auth/verification/resend") return await resendVerification(request);
    if (path === "/api/daemon/login-codes") return await createDaemonLoginCode(request, store);
    if (path === "/api/daemon/device-authorizations") return await createDeviceAuthorization(request, store, url);
    if (path === "/api/daemon/setup-grants") return await createSetupGrant(request, store, url);
    if (path === "/api/daemon/local-claim") return await localClaimSetupGrant(request, store);
    if (path === "/api/daemon/mobile-join-grant") return await createMobileJoinGrant(request, store, url);
    if (path === "/api/daemon/pairing-requests") return await listDaemonPairingRequests(request, store);
    if (path === "/api/daemon/control") return await daemonControl(request, store, env);
    if (path === "/api/daemon/list-dir") return await daemonListDir(request, store, env);
    if (path === "/api/pairing-grants") return await createPairingGrant(request, store, url);
    if (path === "/api/pairing-grants/consume") return await consumePairingGrant(request, store);
    if (path === "/api/daemon/login") return await daemonLogin(request, store);
    if (path === "/api/daemon/remote-access") return await setDaemonRemoteAccess(request, store);
    if (path === "/api/daemon/sync") return await daemonSync(request, store);
    if (path === "/api/daemon/sync-hints") return await daemonSyncHints(request, store);
    if (path === "/api/devices/register-browser") return await registerBrowser(request, store);
    if (path === "/api/devices/qr-grant") return await createBrowserQRGrant(request, store, url);
    if (path === "/api/devices/qr-claim") return await claimBrowserQRGrant(request, store);
    if (path === "/api/devices/announce") return await announceBrowser(request, store);
    if (path === "/api/devices") return await listDevices(request, store, env);
    if (path === "/api/devices/revoke") return await revokeDevice(request, store);
    if (path === "/api/device-challenge") return await createDeviceChallenge(request, store);
    if (path === "/api/device-challenge/verify") return await verifyDeviceChallenge(request, store);
    if (path === "/api/hosts/online") return await listOnlineHosts(request, store, env, requestRuntime.providers.telemetryProvider);
    if (path === "/api/push/vapid-public-key") return await getVAPIDPublicKey(request, env);
    if (path === "/api/push/subscriptions") return await pushSubscriptions(request, store, env);
    if (path === "/api/voice/transcriptions") return await transcribeVoice(request, store, env);
    if (path === "/api/feedback") return await submitFeedback(request, store);
    if (path === "/api/sessions") return await listSessions(request, store, env, requestRuntime.providers.telemetryProvider);
    if (path === "/api/prefs") return await listPrefs(request, store);
    if (path === "/api/projects/prefs") return await setProjectPrefs(request, store);
    if (path === "/api/tasks") return await startTask(request, store, env);
    if (path === "/api/terminal-sessions") return await terminalSessions(request, store, env);
    if (path === "/api/agent-defaults") return await agentDefaults(request, store, env, url);
    if (path === "/api/telemetry/web" || path === "/api/telemetry/daemon") return await acceptTelemetry(request, requestRuntime.providers.telemetryProvider);

    const deviceAuthorization = path.match(/^\/api\/daemon\/device-authorizations\/([^/]+)(?:\/([^/]+))?$/);
    if (deviceAuthorization) {
      return await handleDeviceAuthorizationByID(request, store, decodeURIComponent(deviceAuthorization[1]), deviceAuthorization[2] ?? "", url);
    }

    const setupGrant = path.match(/^\/api\/daemon\/setup-grants\/([^/]+)\/(claim|result)$/);
    if (setupGrant) return await handleSetupGrantByID(request, store, decodeURIComponent(setupGrant[1]), setupGrant[2], url);

    const pairingGrant = path.match(/^\/api\/pairing-grants\/([^/]+)(?:\/(claim))?$/);
    if (pairingGrant) return await handlePairingGrantByID(request, store, decodeURIComponent(pairingGrant[1]), pairingGrant[2] ?? "");

    const devicePatch = path.match(/^\/api\/devices\/([^/]+)$/);
    if (devicePatch) return await patchDevice(request, store, decodeURIComponent(devicePatch[1]));

    const hostAction = path.match(/^\/api\/hosts\/([^/]+)\/(connect|disconnect|update)$/);
    if (hostAction) return await hostControlAction(request, store, env, decodeURIComponent(hostAction[1]), hostAction[2]);

    const pushSubscriptionAction = path.match(/^\/api\/push\/subscriptions\/([^/]+)$/);
    if (pushSubscriptionAction) return await pushSubscriptionByID(request, store, decodeURIComponent(pushSubscriptionAction[1]));

    const injectCancel = path.match(/^\/api\/injects\/([^/]+)\/cancel$/);
    if (injectCancel) return await cancelInject(request, store, env, decodeURIComponent(injectCancel[1]));

    const injectEvents = path.match(/^\/api\/injects\/([^/]+)\/events$/);
    if (injectEvents) return await listInjectEvents(request, store, decodeURIComponent(injectEvents[1]), url);

    const sessionTurns = path.match(/^\/api\/sessions\/([^/]+)\/turns$/);
    if (sessionTurns) return await listSessionTurns(request, store, decodeURIComponent(sessionTurns[1]), url);

    const sessionEvents = path.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (sessionEvents) return await listSessionEvents(request, store, decodeURIComponent(sessionEvents[1]), url);

    const sessionPrefs = path.match(/^\/api\/sessions\/([^/]+)\/prefs$/);
    if (sessionPrefs) return await setSessionPrefs(request, store, decodeURIComponent(sessionPrefs[1]));

    const sessionOpened = path.match(/^\/api\/sessions\/([^/]+)\/opened$/);
    if (sessionOpened) return await markSessionOpened(request, store, env, decodeURIComponent(sessionOpened[1]));

    const sessionAction = path.match(/^\/api\/sessions\/([^/]+)\/(inject|sync|agent-settings|diff|delete|reveal)$/);
    if (sessionAction) return await sessionControlAction(request, store, env, decodeURIComponent(sessionAction[1]), sessionAction[2], url);

    const permissionAction = path.match(/^\/api\/permission-requests\/([^/]+)\/decide$/);
    if (permissionAction) return await decidePermissionRequest(request, store, env, decodeURIComponent(permissionAction[1]));

    const terminalAction = path.match(/^\/api\/terminal-sessions\/([^/]+)\/(input|stop|open-terminal|stream|subscribe|unsubscribe|events)$/);
    if (terminalAction) return await terminalSessionByID(request, store, env, decodeURIComponent(terminalAction[1]), terminalAction[2]);

    if (path === "/api/ws") return await browserWebSocket(request, store, env, url);

    if (path.startsWith("/api/")) {
      return errorResponse("not found", ErrorCode.NotFound, { status: 404 });
    }

    return errorResponse("not found", ErrorCode.NotFound, { status: 404 });
  } catch (error) {
    if (error?.response instanceof Response) return error.response;
    return errorResponse(error instanceof Error ? error.message : "internal error", ErrorCode.Internal, { status: 500 });
  }
}

async function healthz(request) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  return jsonResponse({ ok: true, service: "pockly-nexus" });
}

async function runtime(request, env) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  return jsonResponse(nexusRuntimeCapabilities(env));
}

async function devLogin(request, store, env) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!enabledFlag(env.POCKLY_NEXUS_DEV_LOGIN_ENABLED)) {
    return errorResponse("dev_login_disabled", ErrorCode.NotFound, { status: 404 });
  }
  const body = await readJSON(request);
  const now = new Date();
  const email = requiredString(body.email, "email").toLowerCase();
  const user = await store.upsertUser({
    user_id: body.user_id || randomID("usr"),
    email,
    name: body.name || email.split("@")[0],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
  return await issueWebSession(store, user, now);
}

async function passwordLogin(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readJSON(request);
  const email = requiredString(body.email, "email").toLowerCase();
  const user = await store.getUserByEmail(email);
  if (!user?.password_hash || !(await verifyPassword(requiredString(body.password, "password"), user.password_hash))) {
    return errorResponse("invalid email or password", ErrorCode.Unauthorized, { status: 401 });
  }
  return await issueWebSession(store, user, new Date());
}

async function registerAccount(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readJSON(request);
  const now = new Date();
  const email = requiredString(body.email, "email").toLowerCase();
  if (await store.getUserByEmail(email)) {
    return errorResponse("email_already_registered", ErrorCode.Conflict, { status: 409 });
  }
  const user = await store.upsertUser({
    user_id: randomID("usr"),
    email,
    name: body.name || email.split("@")[0],
    password_hash: await hashPassword(requiredString(body.password, "password")),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
  return await issueWebSessionBody(store, user, now, {
    status: "active",
    user: publicUser(user),
    email,
  });
}

async function verifyRegistration(request) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  await readJSON(request);
  return errorResponse("verification_not_configured", ErrorCode.ServiceUnavailable, { status: 503 });
}

async function resendVerification(request) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  await readJSON(request);
  return errorResponse("verification_not_configured", ErrorCode.ServiceUnavailable, { status: 503 });
}

async function authSession(request, store) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  try {
    const { user } = await requireWebUser(request, store);
    return jsonResponse({ authenticated: true, user: publicUser(user) });
  } catch {
    return jsonResponse({ authenticated: false });
  }
}

async function authLogout(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const cookie = request.headers.get("cookie") ?? "";
  const token = cookie.match(/(?:^|;\s*)pockly_session=([^;]+)/)?.[1];
  if (token) await store.deleteWebSession(await sha256Base64URL(decodeURIComponent(token)));
  return jsonResponse({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}

async function createDaemonLoginCode(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireWebUser(request, store);
  const now = new Date();
  const loginCode = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  await store.createLoginCode({
    login_code: loginCode,
    user_id: user.user_id,
    expires_at: expiresAt,
    created_at: now.toISOString(),
  });
  return jsonResponse({ login_code: loginCode, expires_at: expiresAt });
}

async function createDeviceAuthorization(request, store, url) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readJSON(request);
  const daemonDeviceID = requiredString(body.daemon_device_id, "daemon_device_id");
  const daemonPublicKey = requiredString(body.daemon_pubkey, "daemon_pubkey");
  const existing = await store.getDevice(daemonDeviceID);
  if (existing?.public_key && existing.public_key !== daemonPublicKey) {
    return errorResponse("daemon_device_id already registered with a different public key", ErrorCode.Conflict, { status: 409 });
  }
  const now = new Date();
  const base = publicBaseURL(request, url);
  const deviceCode = randomID("dac");
  const auth = {
    device_code: deviceCode,
    user_code: formatUserCode(),
    poll_secret: await createOpaqueToken("daps"),
    daemon_device_id: daemonDeviceID,
    daemon_public_key: daemonPublicKey,
    device_name: body.device_name || "Pockly Daemon",
    hostname: body.hostname || "",
    os: body.os || "",
    app_version: body.app_version || "",
    computer_id: body.computer_id || "",
    computer_public_key: body.computer_public_key || "",
    computer_signature: body.computer_signature || "",
    status: "pending",
    verification_uri: `${base}/cli/login`,
    verification_uri_complete: `${base}/cli/login?device_code=${encodeURIComponent(deviceCode)}`,
    poll_interval: 2,
    expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    created_at: now.toISOString(),
  };
  await store.saveDeviceAuthorization(auth);
  return jsonResponse({
    device_code: auth.device_code,
    user_code: auth.user_code,
    verification_uri: auth.verification_uri,
    verification_uri_complete: auth.verification_uri_complete,
    poll_secret: auth.poll_secret,
    poll_interval: auth.poll_interval,
    expires_at: auth.expires_at,
  });
}

async function handleDeviceAuthorizationByID(request, store, deviceCode, action, url) {
  switch (action) {
    case "":
      return await getDeviceAuthorization(request, store, deviceCode);
    case "authorize":
      return await authorizeDeviceAuthorization(request, store, deviceCode);
    case "deny":
      return await denyDeviceAuthorization(request, store, deviceCode);
    case "claim-status":
      return await deviceAuthorizationClaimStatus(request, store, deviceCode);
    case "confirm":
      return await confirmDeviceAuthorization(request, store, deviceCode);
    case "token":
      return await pollDeviceAuthorizationToken(request, store, deviceCode, url);
    default:
      return errorResponse("not found", ErrorCode.NotFound, { status: 404 });
  }
}

async function getDeviceAuthorization(request, store, deviceCode) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  await requireWebUser(request, store);
  const auth = await store.getDeviceAuthorization(deviceCode);
  if (!auth) return errorResponse("device authorization not found", ErrorCode.NotFound, { status: 404 });
  return jsonResponse(publicDeviceAuthorization(refreshExpirableStatus(auth)));
}

async function authorizeDeviceAuthorization(request, store, deviceCode) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireWebUser(request, store);
  const auth = refreshExpirableStatus(await store.getDeviceAuthorization(deviceCode));
  if (!auth) return errorResponse("device authorization not found", ErrorCode.NotFound, { status: 404 });
  if (auth.status !== "pending") return errorResponse("device authorization is not pending", ErrorCode.Conflict, { status: 409 });
  const body = await readJSON(request);
  const now = new Date().toISOString();
  let browserDeviceID = body.browser_device_id || "";
  if (body.browser_device_pubkey) {
    const browser = await upsertBrowserDevice(store, user, {
      browser_device_id: browserDeviceID,
      browser_device_pubkey: body.browser_device_pubkey,
      device_name: body.device_name || "Pockly Browser",
      user_agent: body.user_agent || request.headers.get("user-agent") || "",
    }, new Date());
    browserDeviceID = browser.device_id;
  }
  const next = await store.saveDeviceAuthorization({
    ...auth,
    status: "awaiting_daemon_confirm",
    user_id: user.user_id,
    claim_browser_device_id: browserDeviceID,
    claim_payload: JSON.stringify({
      user_email: user.email,
      user_name: user.name,
      browser_device_name: body.device_name || "Pockly Browser",
      user_agent: body.user_agent || request.headers.get("user-agent") || "",
      bind_browser: Boolean(browserDeviceID),
    }),
    claim_requested_at: now,
  });
  return jsonResponse({
    status: "awaiting_daemon_confirm",
    daemon_device_id: next.daemon_device_id,
    browser_device_id: next.claim_browser_device_id || undefined,
    expires_at: next.expires_at,
  });
}

async function denyDeviceAuthorization(request, store, deviceCode) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireWebUser(request, store);
  const auth = refreshExpirableStatus(await store.getDeviceAuthorization(deviceCode));
  if (!auth) return errorResponse("device authorization not found", ErrorCode.NotFound, { status: 404 });
  if (auth.status !== "pending" && auth.status !== "awaiting_daemon_confirm") {
    return errorResponse("device authorization unavailable", ErrorCode.Conflict, { status: 409 });
  }
  await store.saveDeviceAuthorization({
    ...auth,
    status: "denied",
    user_id: user.user_id,
    denied_at: new Date().toISOString(),
  });
  return jsonResponse({ status: "denied" });
}

async function deviceAuthorizationClaimStatus(request, store, deviceCode) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireWebUser(request, store);
  const auth = refreshExpirableStatus(await store.getDeviceAuthorization(deviceCode));
  if (!auth || (auth.user_id && auth.user_id !== user.user_id)) {
    return errorResponse("device authorization not found", ErrorCode.NotFound, { status: 404 });
  }
  return jsonResponse({
    status: auth.status,
    daemon_device_id: auth.daemon_device_id,
    browser_device_id: auth.claim_browser_device_id || undefined,
    device_name: auth.device_name,
    hostname: auth.hostname,
    os: auth.os,
    expires_at: auth.expires_at,
    claim_requested_at: auth.claim_requested_at || null,
    daemon_confirmed_at: auth.daemon_confirmed_at || null,
    daemon_denied_at: auth.daemon_denied_at || null,
  });
}

async function confirmDeviceAuthorization(request, store, deviceCode) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readJSON(request);
  const auth = refreshExpirableStatus(await store.getDeviceAuthorization(deviceCode));
  if (!auth || auth.poll_secret !== body.poll_secret) {
    return errorResponse("device authorization not found", ErrorCode.NotFound, { status: 404 });
  }
  if (auth.status !== "awaiting_daemon_confirm") {
    return errorResponse("device authorization is not awaiting daemon confirmation", ErrorCode.Conflict, { status: 409 });
  }
  const now = new Date();
  if (!body.allow) {
    await store.saveDeviceAuthorization({
      ...auth,
      status: "denied_by_daemon",
      daemon_denied_at: now.toISOString(),
    });
    return jsonResponse({ status: "denied_by_daemon" });
  }
  const user = await store.getUserByID(auth.user_id);
  if (!user) return errorResponse("claim user not found", ErrorCode.Conflict, { status: 409 });
  const daemon = await upsertDaemonFromAuthorization(store, user, auth, now, false);
  if (auth.claim_browser_device_id) {
    await bindBrowserToDaemon(store, user.user_id, daemon.device_id, auth.claim_browser_device_id, now);
  }
  const next = await store.saveDeviceAuthorization({
    ...auth,
    status: "authorized",
    authorized_at: now.toISOString(),
    daemon_confirmed_at: now.toISOString(),
  });
  return jsonResponse({
    status: "authorized",
    daemon_device_id: next.daemon_device_id,
    browser_device_id: next.claim_browser_device_id || undefined,
  });
}

async function pollDeviceAuthorizationToken(request, store, deviceCode, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const auth = refreshExpirableStatus(await store.getDeviceAuthorization(deviceCode));
  const pollSecret = url.searchParams.get("poll_secret") ?? "";
  if (!auth || auth.poll_secret !== pollSecret) {
    return errorResponse("device authorization not found", ErrorCode.NotFound, { status: 404 });
  }
  if (auth.status === "pending") {
    return jsonResponse({ status: "pending", expires_at: auth.expires_at });
  }
  if (auth.status === "awaiting_daemon_confirm") {
    return jsonResponse({
      status: "awaiting_daemon_confirm",
      expires_at: auth.expires_at,
      claim_requested_at: auth.claim_requested_at,
      ...(auth.claim_payload ? { claim: JSON.parse(auth.claim_payload) } : {}),
    });
  }
  if (auth.status !== "authorized") {
    return errorResponse(`device authorization ${auth.status}`, ErrorCode.Conflict, { status: 409 });
  }
  const device = await store.getDevice(auth.daemon_device_id);
  if (!device) return errorResponse("daemon device missing", ErrorCode.Conflict, { status: 409 });
  const now = new Date();
  await store.touchDevice(device.device_id, now.toISOString());
  await store.saveDeviceAuthorization({
    ...auth,
    status: "consumed",
    consumed_at: now.toISOString(),
  });
  return jsonResponse({
    status: "authorized",
    user: publicUser(await store.getUserByID(auth.user_id)),
    daemon_device_id: auth.daemon_device_id,
    remote_access_enabled: true,
    device_access_token: await issueDeviceToken(store, device, "daemon-ws", now),
    device_refresh_token: await createOpaqueToken("drt"),
    expires_at: auth.expires_at,
  });
}

async function createSetupGrant(request, store, url) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readJSON(request);
  const daemonDeviceID = requiredString(body.daemon_device_id, "daemon_device_id");
  const daemonPublicKey = requiredString(body.daemon_pubkey, "daemon_pubkey");
  const existing = await store.getDevice(daemonDeviceID);
  if (existing?.public_key && existing.public_key !== daemonPublicKey) {
    return errorResponse("daemon_device_id already registered with a different public key", ErrorCode.Conflict, { status: 409 });
  }
  const now = new Date();
  const setupGrant = randomID("ds");
  const base = publicBaseURL(request, url);
  const grant = {
    setup_grant: setupGrant,
    poll_secret: await createOpaqueToken("dsp"),
    daemon_device_id: daemonDeviceID,
    daemon_public_key: daemonPublicKey,
    device_name: body.device_name || "Pockly Daemon",
    hostname: body.hostname || "",
    os: body.os || "",
    app_version: body.app_version || "",
    computer_id: body.computer_id || "",
    computer_public_key: body.computer_public_key || "",
    computer_signature: body.computer_signature || "",
    setup_url: `${base}/devices/connect?daemon_setup=${encodeURIComponent(setupGrant)}`,
    status: "pending",
    expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    created_at: now.toISOString(),
  };
  await store.saveSetupGrant(grant);
  return jsonResponse({
    setup_grant: grant.setup_grant,
    poll_secret: grant.poll_secret,
    setup_url: grant.setup_url,
    expires_at: grant.expires_at,
  });
}

async function handleSetupGrantByID(request, store, setupGrant, action, url) {
  if (action === "claim") return await claimSetupGrant(request, store, setupGrant, false);
  if (action === "result") return await pollSetupGrantResult(request, store, setupGrant, url);
  return errorResponse("not found", ErrorCode.NotFound, { status: 404 });
}

async function claimSetupGrant(request, store, setupGrant, returnDaemonTokens, browserNonce = "") {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireWebUser(request, store);
  const body = await readJSON(request);
  const grant = refreshExpirableStatus(await store.getSetupGrant(setupGrant));
  if (!grant || grant.status !== "pending") {
    return errorResponse("setup grant expired or already used", ErrorCode.Conflict, { status: 409 });
  }
  const now = new Date();
  const daemon = await upsertDaemonFromSetupGrant(store, user, grant, now);
  const browser = await upsertBrowserDevice(store, user, {
    browser_device_id: body.browser_device_id,
    browser_device_pubkey: requiredString(body.browser_device_pubkey, "browser_device_pubkey"),
    device_name: body.device_name || "Pockly Browser",
    user_agent: body.user_agent || request.headers.get("user-agent") || "",
  }, now);
  const claimed = await store.saveSetupGrant({
    ...grant,
    status: "claimed",
    user_id: user.user_id,
    browser_device_id: browser.device_id,
    claimed_at: now.toISOString(),
  });
  await bindBrowserToDaemon(store, user.user_id, daemon.device_id, browser.device_id, now);
  const response = {
    status: "claimed",
    browser_device_id: browser.device_id,
    daemon_device_id: daemon.device_id,
  };
  if (returnDaemonTokens) {
    response.user = publicUser(user);
    response.remote_access_enabled = true;
    response.device_access_token = await issueDeviceToken(store, daemon, "daemon-ws", now);
    response.device_refresh_token = await createOpaqueToken("drt");
    response.browser_nonce = browserNonce;
  }
  return jsonResponse(response);
}

async function localClaimSetupGrant(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readJSON(request);
  const setupGrant = requiredString(body.daemon_setup, "daemon_setup");
  return await claimSetupGrant(cloneJSONRequest(request, body), store, setupGrant, true, body.browser_nonce || "");
}

async function pollSetupGrantResult(request, store, setupGrant, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const grant = refreshExpirableStatus(await store.getSetupGrant(setupGrant));
  if (!grant || grant.poll_secret !== (url.searchParams.get("poll_secret") ?? "")) {
    return errorResponse("setup grant not found", ErrorCode.NotFound, { status: 404 });
  }
  if (grant.status !== "claimed") {
    return jsonResponse({ status: grant.status, expires_at: grant.expires_at });
  }
  const user = await store.getUserByID(grant.user_id);
  const daemon = await store.getDevice(grant.daemon_device_id);
  if (!user || !daemon) return errorResponse("setup grant is missing linked device", ErrorCode.Conflict, { status: 409 });
  return jsonResponse({
    status: "claimed",
    user: publicUser(user),
    daemon_device_id: daemon.device_id,
    remote_access_enabled: true,
    device_access_token: await issueDeviceToken(store, daemon, "daemon-ws", new Date()),
    device_refresh_token: await createOpaqueToken("drt"),
    expires_at: grant.expires_at,
  });
}

async function createPairingGrant(request, store, url) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readJSON(request);
  const now = new Date();
  const daemonDeviceID = requiredString(body.daemon_device_id, "daemon_device_id");
  const daemonPublicKey = requiredString(body.daemon_pubkey, "daemon_pubkey");
  const existing = await store.getDevice(daemonDeviceID);
  if (existing?.public_key && existing.public_key !== daemonPublicKey) {
    return errorResponse("daemon_device_id already registered with a different public key", ErrorCode.Conflict, { status: 409 });
  }
  await store.upsertDevice({
    device_id: daemonDeviceID,
    user_id: existing?.user_id ?? null,
    computer_id: body.computer_id || existing?.computer_id || null,
    device_type: "daemon",
    device_name: body.device_name || existing?.device_name || "Pockly Daemon",
    public_key: daemonPublicKey,
    status: existing?.status || "offline",
    remote_access_enabled: Boolean(existing?.remote_access_enabled),
    hostname: body.hostname || existing?.hostname || "",
    os: body.os || existing?.os || "",
    created_at: existing?.created_at || now.toISOString(),
    updated_at: now.toISOString(),
    last_seen_at: existing?.last_seen_at || now.toISOString(),
  });
  const pairingGrant = randomID("pg");
  const grant = {
    pairing_grant: pairingGrant,
    daemon_device_id: daemonDeviceID,
    daemon_public_key: daemonPublicKey,
    computer_id: body.computer_id || "",
    computer_public_key: body.computer_public_key || "",
    computer_signature: body.computer_signature || "",
    relay_url: body.relay_url || publicBaseURL(request, url),
    short_code: formatUserCode(),
    device_name: body.device_name || "Pockly Daemon",
    hostname: body.hostname || "",
    os: body.os || "",
    expires_at: new Date(now.getTime() + 60 * 1000).toISOString(),
    status: "pending",
    created_at: now.toISOString(),
  };
  await store.savePairingGrant(grant);
  return jsonResponse({
    pairing_grant: grant.pairing_grant,
    expires_at: grant.expires_at,
    short_code: grant.short_code,
    qr_payload: {
      v: 1,
      type: "pair",
      relay_url: grant.relay_url,
      pairing_grant: grant.pairing_grant,
      daemon_device_id: grant.daemon_device_id,
      daemon_pubkey: grant.daemon_public_key,
      display: { device_name: grant.device_name, short_code: grant.short_code },
      exp: grant.expires_at,
    },
  });
}

async function consumePairingGrant(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireWebUser(request, store);
  const body = await readJSON(request);
  const grant = refreshExpirableStatus(await store.getPairingGrant(requiredString(body.pairing_grant, "pairing_grant")));
  if (!grant) return errorResponse("pairing grant not found", ErrorCode.NotFound, { status: 404 });
  if (grant.status !== "pending") return errorResponse("pairing grant already used", ErrorCode.Conflict, { status: 409 });
  const now = new Date();
  const browser = await upsertBrowserDevice(store, user, {
    browser_device_pubkey: requiredString(body.browser_device_pubkey, "browser_device_pubkey"),
    device_name: body.device_name || "Pockly Browser",
    user_agent: body.user_agent || request.headers.get("user-agent") || "",
  }, now);
  const next = await store.savePairingGrant({
    ...grant,
    status: "awaiting_confirmation",
    user_id: user.user_id,
    browser_device_id: browser.device_id,
    browser_device_name: browser.device_name,
    browser_device_pub: browser.public_key,
    confirmation_user: user.email || user.name,
  });
  return jsonResponse({
    status: next.status,
    pairing_grant: next.pairing_grant,
    browser_device_id: browser.device_id,
    short_code: next.short_code,
    user_display: next.confirmation_user,
    daemon_device_name: next.device_name,
  });
}

async function listDaemonPairingRequests(request, store) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { device } = await requireDeviceAuth(request, store, "daemon", "daemon-pairing", { allowUnlinked: true });
  const pending = await store.listPendingPairingGrants(device.device_id);
  return jsonResponse({
    requests: pending.map((grant) => ({
      pairing_grant: grant.pairing_grant,
      short_code: grant.short_code,
      user_display: grant.confirmation_user,
      browser_device_name: grant.browser_device_name,
      browser_device_id: grant.browser_device_id,
      exp: grant.expires_at,
    })),
  });
}

async function handlePairingGrantByID(request, store, pairingGrant, action) {
  if (action === "claim") return await claimPairingGrant(request, store, pairingGrant);
  if (request.method === "GET") return await getPairingGrant(request, store, pairingGrant);
  if (request.method === "POST") return await confirmPairingGrant(request, store, pairingGrant);
  return methodNotAllowed("GET, POST");
}

async function getPairingGrant(request, store, pairingGrant) {
  const { user } = await requireWebUser(request, store);
  const grant = await store.getPairingGrant(pairingGrant);
  if (!grant || grant.user_id !== user.user_id) return errorResponse("pairing grant not found", ErrorCode.NotFound, { status: 404 });
  return jsonResponse({
    pairing_grant: grant.pairing_grant,
    daemon_device_id: grant.daemon_device_id,
    daemon_pubkey: grant.daemon_public_key,
    relay_url: grant.relay_url,
    short_code: grant.short_code,
    device_name: grant.device_name,
    exp: grant.expires_at,
    status: grant.status,
    user_id: grant.user_id,
    browser_device_id: grant.browser_device_id,
    browser_device_name: grant.browser_device_name,
    user_display: grant.confirmation_user,
  });
}

async function confirmPairingGrant(request, store, pairingGrant) {
  const { device } = await requireDeviceAuth(request, store, "daemon", "daemon-pairing", { allowUnlinked: true });
  const body = await readJSON(request);
  const grant = refreshExpirableStatus(await store.getPairingGrant(pairingGrant));
  if (!grant) return errorResponse("pairing grant not found", ErrorCode.NotFound, { status: 404 });
  if (grant.daemon_device_id !== device.device_id) return errorResponse("pairing grant belongs to another daemon", ErrorCode.Forbidden, { status: 403 });
  if (grant.status !== "awaiting_confirmation") return errorResponse("grant not awaiting confirmation", ErrorCode.Conflict, { status: 409 });
  const now = new Date();
  if (!body.allow) {
    await store.savePairingGrant({ ...grant, status: "denied", denied_at: now.toISOString() });
    return jsonResponse({ status: "denied" });
  }
  const user = await store.getUserByID(grant.user_id);
  if (!user) return errorResponse("pairing user not found", ErrorCode.Conflict, { status: 409 });
  const daemon = await upsertDaemonIdentity(store, user, {
    daemon_device_id: grant.daemon_device_id,
    daemon_pubkey: grant.daemon_public_key,
    device_name: grant.device_name,
    hostname: grant.hostname,
    os: grant.os,
    computer_id: grant.computer_id,
    computer_public_key: grant.computer_public_key,
  }, now, true);
  const browser = await store.getDevice(grant.browser_device_id);
  if (browser) {
    await store.upsertDevice({
      ...browser,
      user_id: user.user_id,
      status: "active",
      updated_at: now.toISOString(),
      last_seen_at: now.toISOString(),
    });
    await bindBrowserToDaemon(store, user.user_id, daemon.device_id, browser.device_id, now);
  }
  const next = await store.savePairingGrant({
    ...grant,
    status: "consumed",
    confirmed_at: now.toISOString(),
  });
  return jsonResponse({
    status: next.status,
    browser_device_id: next.browser_device_id,
    daemon_device_id: next.daemon_device_id,
    device_access_token: await issueDeviceToken(store, daemon, "daemon-ws", now),
    device_refresh_token: await createOpaqueToken("drt"),
  });
}

async function claimPairingGrant(request, store, pairingGrant) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireWebUser(request, store);
  const grant = await store.getPairingGrant(pairingGrant);
  if (!grant || grant.user_id !== user.user_id) return errorResponse("pairing grant not found", ErrorCode.NotFound, { status: 404 });
  if (grant.status !== "consumed") return errorResponse("pairing not ready", ErrorCode.Conflict, { status: 409 });
  const browser = await store.getDevice(grant.browser_device_id);
  if (!browser || browser.status !== "active") return errorResponse("browser access not active", ErrorCode.Conflict, { status: 409 });
  const now = new Date();
  await store.savePairingGrant({ ...grant, claimed_at: now.toISOString() });
  return jsonResponse({
    browser_device_id: browser.device_id,
    device_access_token: await issueDeviceToken(store, browser, "browser-ws", now),
    device_refresh_token: await createOpaqueToken("brt"),
  });
}

async function createMobileJoinGrant(request, store, url) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { device } = await requireDeviceAuth(request, store, "daemon", "daemon-ws");
  if (!device.user_id || device.status === "revoked") return errorResponse("daemon is not linked to an account", ErrorCode.Conflict, { status: 409 });
  const now = new Date();
  const grantToken = await createOpaqueToken("qrg");
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  await store.saveMobileJoinGrant({
    grant_token: grantToken,
    user_id: device.user_id,
    grantor_device_id: device.device_id,
    expires_at: expiresAt,
    created_at: now.toISOString(),
  });
  return jsonResponse({
    grant_token: grantToken,
    expires_at: expiresAt,
    qr_payload: `${publicBaseURL(request, url)}/mobile-join#grant=${encodeURIComponent(grantToken)}`,
  });
}

async function createBrowserQRGrant(request, store, url) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { device } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const now = new Date();
  const grantToken = await createOpaqueToken("qrg");
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  await store.saveMobileJoinGrant({
    grant_token: grantToken,
    user_id: device.user_id,
    grantor_device_id: device.device_id,
    expires_at: expiresAt,
    created_at: now.toISOString(),
  });
  return jsonResponse({
    grant_token: grantToken,
    expires_at: expiresAt,
    qr_payload: `${publicBaseURL(request, url)}/mobile-join#grant=${encodeURIComponent(grantToken)}`,
  });
}

async function claimBrowserQRGrant(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readJSON(request);
  const grant = refreshExpirableStatus(await store.getMobileJoinGrant(requiredString(body.grant_token, "grant_token")));
  if (!grant || grant.status === "expired" || grant.consumed_at) {
    return errorResponse("qr grant expired or already used", ErrorCode.Unauthorized, { status: 401 });
  }
  const user = await store.getUserByID(grant.user_id);
  if (!user) return errorResponse("qr grant user no longer exists", ErrorCode.Unauthorized, { status: 401 });
  const now = new Date();
  const browser = await upsertBrowserDevice(store, user, {
    browser_device_id: body.browser_device_id,
    browser_device_pubkey: requiredString(body.browser_device_pubkey, "browser_device_pubkey"),
    device_name: body.device_name || "Pockly Browser",
    user_agent: body.user_agent || request.headers.get("user-agent") || "",
  }, now);
  await store.saveMobileJoinGrant({ ...grant, consumed_at: now.toISOString() });
  const token = await createOpaqueToken("ws");
  const expiresAt = new Date(now.getTime() + WEB_SESSION_TTL_SECONDS * 1000);
  await store.createWebSession({
    session_token_hash: await sha256Base64URL(token),
    user_id: user.user_id,
    browser_device_id: browser.device_id,
    expires_at: expiresAt.toISOString(),
    created_at: now.toISOString(),
  });
  return jsonResponse({
    status: "claimed",
    user: publicUser(user),
    browser_device_id: browser.device_id,
    device_access_token: await issueDeviceToken(store, browser, "browser-ws", now),
    device_refresh_token: await createOpaqueToken("brt"),
    daemons_notified: 0,
    grantor_browser_device_id: grant.grantor_device_id,
  }, { headers: { "set-cookie": sessionCookie(token, expiresAt) } });
}

async function daemonLogin(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readJSON(request);
  const code = await store.getLoginCode(requiredString(body.login_code, "login_code"));
  if (!code || code.consumed_at || Date.parse(code.expires_at) <= Date.now()) {
    return errorResponse("invalid login code", ErrorCode.Unauthorized, { status: 401 });
  }
  const user = await store.getUserByID(code.user_id);
  if (!user) return errorResponse("user not found", ErrorCode.NotFound, { status: 404 });
  const now = new Date();
  const daemon = await upsertDaemonDevice(store, user, body, now);
  await store.consumeLoginCode(code.login_code, now.toISOString());
  const accessToken = await issueDeviceToken(store, daemon, "daemon-ws", now);
  return jsonResponse({
    user: publicUser(user),
    daemon_device_id: daemon.device_id,
    remote_access_enabled: daemon.remote_access_enabled,
    device_access_token: accessToken,
    device_refresh_token: await createOpaqueToken("drt"),
  });
}

async function setDaemonRemoteAccess(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { device } = await requireDeviceAuth(request, store, "daemon");
  const body = await readJSON(request);
  const now = new Date().toISOString();
  const updated = await store.patchDevice(device.user_id, device.device_id, {
    remote_access_enabled: Boolean(body.enabled),
    updated_at: now,
    last_seen_at: now,
  });
  return jsonResponse({
    daemon_device_id: updated.device_id,
    remote_access_enabled: updated.remote_access_enabled,
    status: updated.status,
    last_seen_at: updated.last_seen_at,
  });
}

async function registerBrowser(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireWebUser(request, store);
  const body = await readJSON(request);
  const now = new Date();
  const device = await upsertBrowserDevice(store, user, body, now);
  const token = await issueDeviceToken(store, device, "browser-ws", now);
  return jsonResponse({
    status: "registered",
    browser_device_id: device.device_id,
    device_access_token: token,
  });
}

async function announceBrowser(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { device } = await requireDeviceAuth(request, store, "browser");
  const body = await readJSON(request);
  const now = new Date().toISOString();
  await store.touchDevice(device.device_id, now);
  return jsonResponse({ announced: true, daemons_notified: 0 });
}

async function listDevices(request, store, env) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireWebUser(request, store);
  const devices = await store.listDevicesForUser(user.user_id);
  const release = await daemonReleaseSnapshot(env);
  return jsonResponse({
    devices: devices.map((device) => {
      const publicRow = publicDevice(device);
      return device.device_type === "daemon" ? withDaemonReleaseInfo(publicRow, release) : publicRow;
    }),
  });
}

async function patchDevice(request, store, deviceID) {
  if (request.method !== "PATCH") return methodNotAllowed("PATCH");
  const { user } = await requireWebUser(request, store);
  const body = await readJSON(request);
  const device = await store.patchDevice(user.user_id, deviceID, {
    device_name: requiredString(body.device_name, "device_name"),
    updated_at: new Date().toISOString(),
  });
  if (!device) return errorResponse("device not found", ErrorCode.NotFound, { status: 404 });
  return jsonResponse({ device: publicDevice(device) });
}

async function revokeDevice(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireWebUser(request, store);
  const body = await readJSON(request);
  const deviceID = requiredString(body.device_id, "device_id");
  const device = await store.patchDevice(user.user_id, deviceID, {
    status: "revoked",
    updated_at: new Date().toISOString(),
  });
  if (!device) return errorResponse("device not found", ErrorCode.NotFound, { status: 404 });
  return jsonResponse({ status: "revoked", device_id: deviceID });
}

async function createDeviceChallenge(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readJSON(request);
  const device = await store.getDevice(requiredString(body.device_id, "device_id"));
  if (!device || device.status === "revoked") {
    return errorResponse("eligible device not found", ErrorCode.NotFound, { status: 404 });
  }
  const now = new Date();
  const challenge = {
    challenge_id: randomID("ch"),
    device_id: device.device_id,
    audience: requiredString(body.audience, "audience"),
    nonce: randomID("nonce"),
    expires_at: new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    created_at: now.toISOString(),
  };
  await store.createDeviceChallenge(challenge);
  return jsonResponse(challenge);
}

async function verifyDeviceChallenge(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readJSON(request);
  const challenge = await store.getDeviceChallenge(requiredString(body.challenge_id, "challenge_id"));
  if (!challenge || challenge.consumed_at || Date.parse(challenge.expires_at) <= Date.now()) {
    return errorResponse("challenge expired", ErrorCode.Unauthorized, { status: 401 });
  }
  const device = await store.getDevice(requiredString(body.device_id, "device_id"));
  if (!device || device.status === "revoked" || device.device_id !== challenge.device_id || body.audience !== challenge.audience) {
    return errorResponse("challenge mismatch", ErrorCode.Unauthorized, { status: 401 });
  }
  const verified = await verifyDeviceSignature(device, challengeMessage(challenge), requiredString(body.signature, "signature"));
  if (!verified) return errorResponse("invalid signature", ErrorCode.Unauthorized, { status: 401 });
  await store.consumeDeviceChallenge(challenge.challenge_id, new Date().toISOString());
  const token = await issueDeviceToken(store, device, challenge.audience, new Date());
  return jsonResponse({ verified: true, device_access_token: token });
}

async function daemonSync(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user, device } = await requireDeviceAuth(request, store, "daemon");
  const body = await readJSON(request);
  if (body.hello?.device_id && body.hello.device_id !== device.device_id) {
    return errorResponse("daemon device mismatch", ErrorCode.Forbidden, { status: 403 });
  }
  const now = new Date().toISOString();
  await store.touchDevice(device.device_id, now);
  const sessions = Array.isArray(body.sessions) ? body.sessions : [];
  const turns = Array.isArray(body.turns) ? body.turns : [];
  const uploadedTurnStatsBySession = new Map();
  for (const turn of turns) {
    const sessionID = String(turn.session_id ?? "");
    const seq = Number(turn.seq ?? 0) || 0;
    const stats = uploadedTurnStatsBySession.get(sessionID) || { count: 0, min_seq: 0, max_seq: 0 };
    stats.count += 1;
    if (seq > 0) {
      stats.min_seq = stats.min_seq > 0 ? Math.min(stats.min_seq, seq) : seq;
      stats.max_seq = Math.max(stats.max_seq, seq);
    }
    uploadedTurnStatsBySession.set(sessionID, stats);
  }
  await store.upsertTurns(turns.map((turn) => syncTurnRecord(user, device, turn, now)));
  if (body.full_reconcile) {
    await store.deleteMissingDeviceSessions(user.user_id, device.device_id, sessions.map((session) => String(session.session_id)));
  }
  await store.upsertSessions(await Promise.all(sessions.map((session) => syncSessionRecord(store, user, device, session, now, uploadedTurnStatsBySession.get(String(session.session_id))))));
  return jsonResponse({
    ok: true,
    session_count: sessions.length,
    turn_count: turns.length,
    daemon_device: device.device_id,
    daemon_version: body.hello?.version ?? "",
  });
}

async function daemonSyncHints(request, store) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user, device } = await requireDeviceAuth(request, store, "daemon");
  const [sessions, prefs, openHints] = await Promise.all([
    store.listSessionsForUser(user.user_id),
    store.listSessionPrefsForUser(user.user_id),
    store.listSessionOpenHintsForUser(user.user_id),
  ]);
  const sessionIDs = new Set(
    sessions
      .filter((session) => session.device_id === device.device_id)
      .map((session) => String(session.session_id)),
  );
  const sessionsByID = new Map(
    sessions
      .filter((session) => session.device_id === device.device_id)
      .map((session) => [String(session.session_id), session]),
  );
  const cutoff = Date.now() - recentlyOpenedSyncHintMs;
  const hintsBySessionID = new Map();
  for (const pref of prefs) {
    if (pref.device_id !== device.device_id || !sessionIDs.has(String(pref.session_id))) continue;
    if (!pref.pinned) continue;
    hintsBySessionID.set(String(pref.session_id), {
      ...sessionSyncHintPayload(sessionsByID.get(String(pref.session_id)), String(pref.session_id)),
      reason: "pinned",
      preferred_min: prioritySyncHintTurnLimit,
    });
  }
  for (const hint of openHints) {
    if (hint.device_id !== device.device_id || !sessionIDs.has(String(hint.session_id)) || hintsBySessionID.has(String(hint.session_id))) continue;
    const opened = Date.parse(hint.last_opened_at || "");
    if (!Number.isFinite(opened) || opened < cutoff) continue;
    hintsBySessionID.set(String(hint.session_id), {
      ...sessionSyncHintPayload(sessionsByID.get(String(hint.session_id)), String(hint.session_id)),
      reason: "recently_opened",
      preferred_min: prioritySyncHintTurnLimit,
    });
  }
  const hints = [];
  for (const hint of hintsBySessionID.values()) {
    const session = sessionsByID.get(String(hint.session_id));
    if (!session) {
      hints.push(hint);
      continue;
    }
    const sessionWithStats = await sessionWithTurnStats(store, user.user_id, device.device_id, String(hint.session_id));
    hints.push({
      ...hint,
      ...sessionSyncHintPayload(sessionWithStats, String(hint.session_id)),
      reason: hint.reason,
      preferred_min: hint.preferred_min,
    });
  }
  hints.sort((left, right) => {
    if (left.reason !== right.reason) return left.reason === "pinned" ? -1 : 1;
    return String(left.session_id).localeCompare(String(right.session_id));
  });
  return jsonResponse({ sessions: hints.slice(0, 50) });
}

async function listSessions(request, store, env, telemetryProvider = null) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store);
  const control = createControlHubForUser(env, user.user_id);
  const sessions = await store.listSessionsForUser(user.user_id);
  const devices = new Map((await store.listDevicesForUser(user.user_id)).map((device) => [device.device_id, device]));
  const daemonDeviceIDs = uniqueDaemonDeviceIDs(sessions, devices);
  const onlineByDeviceID = daemonDeviceIDs.length > 0 ? await control.onlineDevices(daemonDeviceIDs) : {};
  const rows = [];
  for (const session of sessions) {
    rows.push(publicSession(session, devices.get(session.device_id), Boolean(onlineByDeviceID[session.device_id])));
  }
  void recordPresenceTelemetry(telemetryProvider, request, {
    command: "sessions",
    presence_source: daemonDeviceIDs.length > 0 ? "batch_do" : "none",
    sessions_count: sessions.length,
    unique_daemon_count: daemonDeviceIDs.length,
    presence_batch_size: daemonDeviceIDs.length,
  });
  return jsonResponse({ sessions: rows });
}

// ---- UI preferences (pin / archive / rename) ----------------------------
// Per-user, stored in dedicated tables so daemon catalog sync never clobbers
// them. Written only by the web.

function normalizeBoolPref(value) {
  if (value === undefined || value === null) return undefined;
  return value ? 1 : 0;
}

async function listPrefs(request, store) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store);
  const [sessionPrefs, projectPrefs] = await Promise.all([
    store.listSessionPrefsForUser(user.user_id),
    store.listProjectPrefsForUser(user.user_id),
  ]);
  return jsonResponse({
    session_prefs: sessionPrefs.map((pref) => ({
      device_id: pref.device_id,
      session_id: pref.session_id,
      pinned: Boolean(pref.pinned),
      archived: Boolean(pref.archived),
      custom_title: pref.custom_title || "",
    })),
    project_prefs: projectPrefs.map((pref) => ({
      device_id: pref.device_id,
      cwd: pref.cwd,
      pinned: Boolean(pref.pinned),
      archived: Boolean(pref.archived),
      removed: Boolean(pref.removed),
      custom_label: pref.custom_label || "",
    })),
  });
}

async function setSessionPrefs(request, store, sessionID) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireDeviceAuth(request, store);
  const body = await request.json().catch(() => null);
  const deviceID = String(body?.device_id ?? "");
  if (!deviceID) return errorResponse("device_id is required", ErrorCode.BadRequest, { status: 400 });
  // custom_title: empty string clears back to the derived title (stored NULL
  // would be kept by COALESCE, so map "" → null only when absent; an explicit
  // "" is stored as "" and treated as unset by the reader).
  const pref = await store.upsertSessionPref({
    user_id: user.user_id,
    device_id: deviceID,
    session_id: sessionID,
    pinned: normalizeBoolPref(body?.pinned),
    archived: normalizeBoolPref(body?.archived),
    custom_title: body?.custom_title === undefined ? undefined : String(body.custom_title),
    updated_at: new Date().toISOString(),
  });
  return jsonResponse({
    device_id: pref.device_id,
    session_id: pref.session_id,
    pinned: Boolean(pref.pinned),
    archived: Boolean(pref.archived),
    custom_title: pref.custom_title || "",
  });
}

async function markSessionOpened(request, store, env, sessionID) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const body = await request.json().catch(() => null);
  const deviceID = String(body?.device_id ?? "");
  if (!deviceID) return errorResponse("device_id is required", ErrorCode.BadRequest, { status: 400 });
  const openedAt = body?.opened_at ? String(body.opened_at) : new Date().toISOString();
  const hint = await store.upsertSessionOpenHint({
    user_id: user.user_id,
    device_id: deviceID,
    session_id: sessionID,
    last_opened_at: openedAt,
    updated_at: new Date().toISOString(),
  });
  const session = await sessionWithTurnStats(store, user.user_id, deviceID, sessionID);
  await pushSyncHintToDaemon(env, user.user_id, deviceID, sessionID, session);
  return jsonResponse({
    device_id: hint.device_id,
    session_id: hint.session_id,
    last_opened_at: hint.last_opened_at,
  });
}

// Nudge the daemon over its already-open control WS so the opened session's
// lazy backfill starts immediately. Outgoing WebSocket messages are not billed,
// so pushing replaces the daemon-side hint polling loop as the default
// transport. Best-effort: an offline daemon falls back to the persisted open
// hint (consumed by the optional poll) and the regular sync flow.
async function pushSyncHintToDaemon(env, userID, daemonDeviceID, sessionID, session) {
  try {
    const control = createControlHubForUser(env, userID);
    await control.dispatch(daemonDeviceID, {
      type: "SYNC_HINT",
      sync_hint: {
        ...sessionSyncHintPayload(session, sessionID),
        reason: "recently_opened",
        preferred_min: prioritySyncHintTurnLimit,
      },
    });
  } catch {
    // Daemon offline or hub unavailable — opening still works through the
    // explicit sync path; the hint only accelerates proactive backfill.
  }
}

async function setProjectPrefs(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireDeviceAuth(request, store);
  const body = await request.json().catch(() => null);
  const deviceID = String(body?.device_id ?? "");
  const cwd = String(body?.cwd ?? "");
  if (!deviceID || !cwd) return errorResponse("device_id and cwd are required", ErrorCode.BadRequest, { status: 400 });
  const pref = await store.upsertProjectPref({
    user_id: user.user_id,
    device_id: deviceID,
    cwd,
    pinned: normalizeBoolPref(body?.pinned),
    archived: normalizeBoolPref(body?.archived),
    removed: normalizeBoolPref(body?.removed),
    custom_label: body?.custom_label === undefined ? undefined : String(body.custom_label),
    updated_at: new Date().toISOString(),
  });
  return jsonResponse({
    device_id: pref.device_id,
    cwd: pref.cwd,
    pinned: Boolean(pref.pinned),
    archived: Boolean(pref.archived),
    removed: Boolean(pref.removed),
    custom_label: pref.custom_label || "",
  });
}

async function listSessionTurns(request, store, sessionID, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store);
  const deviceID = url.searchParams.get("device_id") ?? "";
  if (!deviceID) return errorResponse("device_id is required", ErrorCode.BadRequest, { status: 400 });
  const session = await store.getSession(user.user_id, deviceID, sessionID);
  if (!session) return errorResponse("session not found", ErrorCode.NotFound, { status: 404 });
  const parsedTurns = (await store.listTurns(user.user_id, deviceID, sessionID)).map(publicTurn);
  const stats = await sessionTurnStats(store, user.user_id, deviceID, sessionID);
  const syncedTurnCount = stats.count;
  const syncedMinSeq = mergeSyncedMinSeq(session.synced_min_seq, stats.min_seq);
  const syncedMaxSeq = Math.max(Number(session.synced_max_seq ?? 0) || 0, stats.max_seq);
  const totalTurnCount = Number(session.turn_count ?? parsedTurns.length);
  const latestContiguousMinSeq = Number(stats.latest_contiguous_min_seq ?? 0) || syncedMinSeq;
  const nextBeforeSeq = nextBackfillBeforeSeq({
    total_turn_count: totalTurnCount,
    synced_turn_count: syncedTurnCount,
    actual_turn_count: stats.count,
    synced_min_seq: syncedMinSeq,
    synced_max_seq: syncedMaxSeq,
    latest_contiguous_min_seq: latestContiguousMinSeq,
    has_older_turns: session.has_older_turns,
  });
  return jsonResponse({
    session_id: sessionID,
    turns: parsedTurns,
    oldest_seq: parsedTurns[0]?.seq,
    latest_seq: parsedTurns[parsedTurns.length - 1]?.seq,
    synced_turn_count: syncedTurnCount,
    synced_min_seq: syncedMinSeq,
    synced_max_seq: syncedMaxSeq,
    latest_contiguous_min_seq: latestContiguousMinSeq,
    next_before_seq: nextBeforeSeq,
    total_turn_count: totalTurnCount,
    has_older_turns: Boolean(session.has_older_turns || (totalTurnCount > 0 && syncedMinSeq > 1)),
    needs_sync: parsedTurns.length === 0 && (session.turn_count ?? 0) > 0,
  });
}

async function listSessionEvents(request, store, sessionID, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const deviceID = requiredString(url.searchParams.get("device_id") ?? "", "device_id");
  const session = await store.getSession(user.user_id, deviceID, sessionID);
  if (!session) return errorResponse("session not found", ErrorCode.NotFound, { status: 404 });
  return jsonResponse(await sessionEventsResponse(store, user.user_id, deviceID, sessionID, {
    after: url.searchParams.get("after") ?? "",
    after_seq: url.searchParams.get("after_seq") ?? "",
    request_id: url.searchParams.get("request_id") ?? "",
    limit: url.searchParams.get("limit") ?? "",
  }));
}

async function listInjectEvents(request, store, requestID, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  return jsonResponse(await sessionEventsResponse(store, user.user_id, "", "", {
    after: url.searchParams.get("after") ?? "",
    request_id: requestID,
    limit: url.searchParams.get("limit") ?? "",
  }));
}

async function sessionEventsResponse(store, userID, deviceID, sessionID, options = {}) {
  const events = await store.listSessionEvents(userID, deviceID, sessionID, options);
  const publicEvents = events.map(publicSessionEvent);
  const response = {
    events: publicEvents,
    next_cursor: publicEvents[publicEvents.length - 1]?.cursor || String(options.after || ""),
  };
  // Session-scoped polls also carry fresh turn content from session_turns.
  // Live turns land there once (written by the event sink) instead of being
  // duplicated into a session_events row per turn.
  if (deviceID && sessionID && options.after_seq !== undefined && options.after_seq !== "") {
    const afterSeq = Number(options.after_seq) || 0;
    const turns = await store.listSessionTurnsAfter(userID, deviceID, sessionID, afterSeq, options.limit);
    response.turns = turns.map(publicTurn);
    response.next_seq = turns.length > 0 ? Number(turns[turns.length - 1].seq) : afterSeq;
  }
  return response;
}

async function listOnlineHosts(request, store, env, telemetryProvider = null) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user, device } = await requireUserFromCookieOrDevice(request, store);
  const cacheKey = hostsOnlineCacheKey(user.user_id, device?.device_id || "", env);
  const cacheTTL = hostsOnlineCacheMs(env);
  const cached = cacheTTL > 0 ? hostsOnlineCache.get(cacheKey) : null;
  const now = Date.now();
  if (cached && now - cached.fetchedAt < cacheTTL) {
    void recordPresenceTelemetry(telemetryProvider, request, {
      presence_source: "cache",
      sessions_count: cached.sessionsCount,
      unique_daemon_count: cached.uniqueDaemonCount,
      presence_batch_size: 0,
    });
    return jsonResponse({ hosts: cached.hosts });
  }
  const control = createControlHubForUser(env, user.user_id);
  const release = await daemonReleaseSnapshot(env);
  const devices = await store.listDevicesForUser(user.user_id);
  const sessions = await store.listSessionsForUser(user.user_id);
  const activeSessionsByDevice = new Map();
  for (const session of sessions) {
    activeSessionsByDevice.set(session.device_id, (activeSessionsByDevice.get(session.device_id) ?? 0) + 1);
  }
  const daemonDevices = devices.filter((entry) => entry.device_type === "daemon" && entry.status !== "revoked");
  const onlineByDeviceID = daemonDevices.length > 0 ? await control.onlineDevices(daemonDevices.map((device) => device.device_id)) : {};
  const hosts = [];
  for (const device of daemonDevices) {
    hosts.push(withDaemonReleaseInfo(
      publicHost(device, activeSessionsByDevice.get(device.device_id) ?? 0, Boolean(onlineByDeviceID[device.device_id])),
      release,
    ));
  }
  if (cacheTTL > 0) {
    hostsOnlineCache.set(cacheKey, {
      fetchedAt: now,
      hosts,
      sessionsCount: sessions.length,
      uniqueDaemonCount: daemonDevices.length,
    });
    pruneHostsOnlineCache(now, cacheTTL);
  }
  void recordPresenceTelemetry(telemetryProvider, request, {
    presence_source: daemonDevices.length > 0 ? "batch_do" : "none",
    sessions_count: sessions.length,
    unique_daemon_count: daemonDevices.length,
    presence_batch_size: daemonDevices.length,
  });
  return jsonResponse({ hosts });
}

async function hostControlAction(request, store, env, daemonDeviceID, action) {
  switch (action) {
    case "connect":
      return await connectHost(request, store, env, daemonDeviceID);
    case "disconnect":
      return await disconnectHost(request, store, daemonDeviceID);
    case "update":
      return await updateHost(request, store, env, daemonDeviceID);
    default:
      return errorResponse("not found", ErrorCode.NotFound, { status: 404 });
  }
}

async function connectHost(request, store, env, daemonDeviceID) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireWebUser(request, store);
  const control = createControlHubForUser(env, user.user_id);
  const daemon = await requireUserDaemon(store, user.user_id, daemonDeviceID);
  if (!daemon.remote_access_enabled) return errorResponse("remote access is disabled", ErrorCode.Forbidden, { status: 403 });
  if (!(await control.isDaemonOnline(daemon.device_id)) && !isOnline(daemon.last_seen_at)) {
    return errorResponse("daemon offline", ErrorCode.DaemonOffline, { status: 503 });
  }
  const body = await readJSON(request);
  const now = new Date();
  const browser = await upsertBrowserDevice(store, user, {
    browser_device_id: body.browser_device_id,
    browser_device_pubkey: requiredString(body.browser_device_pubkey, "browser_device_pubkey"),
    device_name: body.device_name || "Pockly Browser",
    user_agent: body.user_agent || request.headers.get("user-agent") || "",
  }, now);
  await bindBrowserToDaemon(store, user.user_id, daemon.device_id, browser.device_id, now);
  return jsonResponse({
    status: "connected",
    request_id: randomID("hc"),
    browser_device_id: browser.device_id,
    daemon_device_id: daemon.device_id,
    device_access_token: await issueDeviceToken(store, browser, "browser-ws", now),
  });
}

async function disconnectHost(request, store, daemonDeviceID) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user, device: browser } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  await requireUserDaemon(store, user.user_id, daemonDeviceID);
  await store.deleteDeviceBinding(user.user_id, daemonDeviceID, browser.device_id, new Date().toISOString());
  return jsonResponse({
    status: "disconnected",
    browser_device_id: browser.device_id,
    daemon_device_id: daemonDeviceID,
  });
}

async function updateHost(request, store, env, daemonDeviceID) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user, device: browser } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  const daemon = await requireUserDaemon(store, user.user_id, daemonDeviceID);
  await requireBrowserDaemonBinding(store, user.user_id, daemon.device_id, browser.device_id);
  if (!(await control.isDaemonOnline(daemon.device_id)) || !daemon.remote_access_enabled) {
    return errorResponse("daemon offline", ErrorCode.DaemonOffline, { status: 503 });
  }
  const body = await readJSON(request);
  const requestID = randomID("upd");
  await control.dispatch(daemon.device_id, {
    type: "UPDATE_REQUEST",
    update_request: {
      request_id: requestID,
      daemon_device_id: daemon.device_id,
      browser_device_id: browser.device_id,
      to_version: body.to_version || "",
    },
  });
  return jsonResponse({ status: "dispatched", request_id: requestID, daemon_device_id: daemon.device_id }, { status: 202 });
}

async function daemonControl(request, store, env) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { userID, deviceID } = await authorizeDaemonControlWebSocket(request, store);
  const control = createControlHubForUser(env, userID);
  return control.acceptDaemonWebSocket(request, { userID, deviceID });
}

async function browserWebSocket(request, store, env, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  if (!browserRealtimeEnabled(env)) {
    return errorResponse("browser realtime is disabled in this runtime", ErrorCode.UnsupportedRuntime, { status: 501 });
  }
  const { userID, deviceID } = await authorizeBrowserRealtimeWebSocket(request, store, url);
  const control = createControlHubForUser(env, userID);
  return control.acceptBrowserWebSocket(request, { userID, deviceID });
}

export async function authorizeNexusWebSocket(request, env = {}) {
  const requestRuntime = createRequestRuntime(env);
  const store = requestRuntime.store;
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  try {
    if (path === "/api/daemon/control") {
      if (request.method !== "GET") return { ok: false, response: methodNotAllowed("GET") };
      return { ok: true, endpoint: "daemon", ...(await authorizeDaemonControlWebSocket(request, store)) };
    }
    if (path === "/api/ws") {
      if (request.method !== "GET") return { ok: false, response: methodNotAllowed("GET") };
      if (!browserRealtimeEnabled(requestRuntime.env)) {
        return { ok: false, response: errorResponse("browser realtime is disabled in this runtime", ErrorCode.UnsupportedRuntime, { status: 501 }) };
      }
      return { ok: true, endpoint: "browser", ...(await authorizeBrowserRealtimeWebSocket(request, store, url)) };
    }
    return { ok: false, response: errorResponse("not found", ErrorCode.NotFound, { status: 404 }) };
  } catch (error) {
    if (error?.response instanceof Response) return { ok: false, response: error.response };
    return { ok: false, response: errorResponse(error instanceof Error ? error.message : "internal error", ErrorCode.Internal, { status: 500 }) };
  }
}

function createRequestRuntime(env = {}, ctx = {}) {
  const provided = ctx.providers || {};
  const providers = createNexusProviderBundle({
    ...provided,
    store: provided.store || env.POCKLY_NEXUS_STORE || env.POCKLY_RELAY_STORE || createStore(env),
    controlHub: provided.controlHub || env.POCKLY_CONTROL_HUB || null,
    blobStore: provided.blobStore || env.RELEASES || null,
    emailProvider: provided.emailProvider || env.POCKLY_EMAIL_PROVIDER || null,
    sttProvider: provided.sttProvider || env.POCKLY_STT_PROVIDER || null,
    pushProvider: provided.pushProvider || env.POCKLY_PUSH_PROVIDER || null,
    telemetryProvider: provided.telemetryProvider || null,
  });
  const runtimeEnv = {
    ...env,
    ...(providers.controlHub ? { POCKLY_CONTROL_HUB: providers.controlHub } : {}),
    POCKLY_CONTROL_EVENT_SINK: createSessionEventSink(requireNexusProvider(providers, "store"), {
      persistTerminalEvents: terminalEventCacheEnabled(env),
    }),
    ...(providers.blobStore ? { RELEASES: providers.blobStore } : {}),
    ...(providers.sttProvider ? { POCKLY_STT_PROVIDER: providers.sttProvider } : {}),
    ...(providers.pushProvider ? { POCKLY_PUSH_PROVIDER: providers.pushProvider } : {}),
  };
  return {
    providers,
    env: runtimeEnv,
    store: requireNexusProvider(providers, "store"),
  };
}

export function createSessionEventSink(store, options = {}) {
  const persistTerminalEvents = options.persistTerminalEvents !== false;
  return {
    async onControlEvent(payload, meta = {}) {
      // Turn content goes straight into session_turns — the same row the
      // daemon's window sync would write later (a byte-identical re-upsert is
      // a zero-write no-op under the conditional upsert). Persisting the turn
      // once instead of duplicating it inside a session_events row halves the
      // D1 row-writes of an active turn; pollers read it back via the
      // turns/next_seq fields of the events response.
      const turnRow = sessionTurnRecord(payload, meta);
      if (turnRow) {
        try {
          await store.upsertTurns([turnRow]);
        } catch {
          // The daemon window sync re-uploads the same turns from the local
          // jsonl, so a failed live write only delays content, never loses it.
        }
      }
      const event = sessionEventRecord(payload, meta, { turnPersisted: Boolean(turnRow) });
      if (!event) return;
      try {
        await store.appendSessionEvent(event);
      } catch {
        // Recent events are an active-turn optimization. The daemon catalog and
        // window sync remain the source of truth, so sink failures must not
        // break control-plane delivery.
      }
    },
    async onTerminalEvent(payload, meta = {}) {
      if (!persistTerminalEvents) return;
      const event = terminalEventRecord(payload, meta);
      if (!event) return;
      try {
        await store.appendSessionEvent(event);
      } catch {
        // Terminal event polling is only a fallback for runtimes without a long
        // terminal stream. Terminal streams and daemon-local buffers remain the
        // source of truth.
      }
    },
  };
}

// sessionTurnRecord maps a turn-carrying control event onto a session_turns
// row (the durable shape syncTurnRecord also produces). Returns null when the
// routing keys are unresolvable — the caller then falls back to persisting the
// full event row so no content is dropped.
function sessionTurnRecord(payload, meta = {}) {
  const turn = payload?.turn && typeof payload.turn === "object" ? payload.turn : null;
  if (!turn) return null;
  const userID = String(meta.userID || "");
  const deviceID = String(turn.device_id || payload.device_id || meta.daemonDeviceID || "");
  const sessionID = String(turn.session_id || payload.session_id || "");
  const seq = Number(turn.seq);
  if (!userID || !deviceID || !sessionID || !Number.isFinite(seq) || seq <= 0) return null;
  const now = new Date().toISOString();
  return {
    user_id: userID,
    device_id: deviceID,
    session_id: sessionID,
    seq,
    agent: String(turn.agent || ""),
    kind: String(turn.kind || ""),
    timestamp: String(turn.timestamp || payload.timestamp || now),
    payload: turn.payload === undefined || turn.payload === null
      ? null
      : (typeof turn.payload === "string" ? turn.payload : JSON.stringify(turn.payload)),
    updated_at: now,
  };
}

function sessionEventRecord(payload, meta = {}, options = {}) {
  if (!shouldPersistSessionEvent(payload, meta, options)) return null;
  const requestID = String(payload?.request_id || "");
  if (!requestID) return null;
  const turn = payload.turn && typeof payload.turn === "object" ? payload.turn : null;
  const sessionID = String(payload.session_id || turn?.session_id || "");
  const deviceID = String(payload.device_id || turn?.device_id || meta.daemonDeviceID || "");
  if (!deviceID) return null;
  const userID = String(meta.userID || "");
  if (!userID) return null;
  const now = new Date().toISOString();
  return {
    user_id: userID,
    device_id: deviceID,
    session_id: sessionID,
    request_id: requestID,
    event_type: String(payload.type || payload.stage || meta.kind || "control_event"),
    payload: JSON.stringify(payload),
    created_at: String(payload.timestamp || turn?.timestamp || now),
  };
}

function shouldPersistSessionEvent(payload, meta = {}, options = {}) {
  const type = String(payload?.type || payload?.stage || meta.kind || "");
  // Lifecycle/status events always persist — they drive the poller's state
  // machine and are few per inject.
  if (type === "session_created") return true;
  if (type === "approval_required") return true;
  if (type === "inject_completed" || type === "inject_failed" || type === "inject_cancelled") return true;
  if (type === "completed" || type === "failed") return true;
  if (payload?.status === "completed" || payload?.status === "failed") return true;
  // Pure turn events (stream_event) are content, not lifecycle. When the turn
  // was already written into session_turns, skip the duplicate event row;
  // keep the old behavior as a fallback when the turn keys were unresolvable.
  if (payload?.turn && typeof payload.turn === "object" && !options.turnPersisted) return true;
  return false;
}

function terminalEventRecord(payload, meta = {}) {
  if (!payload || typeof payload !== "object") return null;
  const terminalSessionID = String(payload.terminal_session_id || "");
  if (!terminalSessionID) return null;
  const userID = String(meta.userID || payload.user_id || "");
  if (!userID) return null;
  const now = new Date().toISOString();
  return {
    user_id: userID,
    device_id: String(payload.daemon_device_id || payload.device_id || meta.daemonDeviceID || ""),
    session_id: String(payload.session_id || meta.sessionID || ""),
    request_id: terminalSessionID,
    event_type: String(payload.kind || "terminal_event"),
    payload: JSON.stringify(payload),
    created_at: String(payload.timestamp || now),
  };
}

function terminalEventCacheEnabled(env = {}) {
  const configured = env.TERMINAL_EVENT_CACHE_ENABLED ?? env.POCKLY_TERMINAL_EVENT_CACHE_ENABLED;
  if (configured !== undefined && configured !== null && String(configured) !== "") {
    return enabledFlag(configured);
  }
  return String(env.POCKLY_NEXUS_RUNTIME || env.NEXUS_RUNTIME || "").trim() !== "managed";
}

async function authorizeDaemonControlWebSocket(request, store) {
  const { user, device } = await requireDeviceAuth(request, store, "daemon", "daemon-ws");
  await store.touchDevice(device.device_id, new Date().toISOString());
  return { userID: user.user_id, deviceID: device.device_id };
}

async function authorizeBrowserRealtimeWebSocket(request, store, url) {
  const token = url.searchParams.get("access_token") || "";
  const authRequest = new Request(request.url, { headers: { authorization: `Bearer ${token}` } });
  const { user, device } = await requireDeviceAuth(authRequest, store, "browser", "browser-ws");
  await store.touchDevice(device.device_id, new Date().toISOString());
  return { userID: user.user_id, deviceID: device.device_id };
}

async function agentDefaults(request, store, env, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const daemonDeviceID = url.searchParams.get("daemon_device_id") ?? "";
  if (daemonDeviceID) {
    const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
    const control = createControlHubForUser(env, user.user_id);
    await requireUserDaemon(store, user.user_id, daemonDeviceID);
    const requestID = randomID("ad");
    try {
      const result = await control.requestResponse(daemonDeviceID, {
        type: "AGENT_DEFAULTS_GET",
        agent_defaults_get: {
          request_id: requestID,
          cwd: url.searchParams.get("cwd") ?? "",
          agent: url.searchParams.get("agent") ?? "",
        },
      }, "AGENT_DEFAULTS_RESULT", requestID, 5_000);
      if (result.status !== "ok") return errorResponse(result.error || "agent defaults unavailable", ErrorCode.ServiceUnavailable, { status: 503 });
      return jsonResponse({
        default_model: result.default_model || "",
        resolved_model: result.resolved_model || "",
        available_models: result.available_models || [],
        available_model_options: result.available_model_options || [],
        available_permission_modes: result.available_permission_modes || [],
        available_efforts: result.available_efforts || [],
      });
    } catch (error) {
      return mapControlError(error);
    }
  }
  return jsonResponse({
    claude: {
      current: { model: "sonnet", permission_mode: "default", effort: "default" },
      available_models: ["sonnet", "opus", "haiku"],
      available_permission_modes: ["default", "acceptEdits", "plan"],
      available_efforts: ["default"],
    },
    codex: {
      current: { model: "default", permission_mode: "default", effort: "default" },
      available_models: ["default"],
      available_permission_modes: ["default"],
      available_efforts: ["default"],
    },
  });
}

async function sessionControlAction(request, store, env, sessionID, action, url) {
  switch (action) {
    case "inject":
      return await sessionInject(request, store, env, sessionID, url);
    case "sync":
      return await sessionSync(request, store, env, sessionID, url);
    case "agent-settings":
      return await sessionAgentSettings(request, store, env, sessionID, url);
    case "diff":
      return await sessionDiff(request, store, env, sessionID, url);
    case "delete":
      return await sessionDelete(request, store, env, sessionID, url);
    case "reveal":
      return await sessionReveal(request, store, env, sessionID, url);
    default:
      return errorResponse("not found", ErrorCode.NotFound, { status: 404 });
  }
}

// sessionDelete PERMANENTLY deletes a session: the daemon removes the local
// transcript file first; only on success does Nexus drop its own copy
// (session row + turns + prefs). The web gates this behind a confirm dialog.
async function sessionDelete(request, store, env, sessionID, url) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  const daemonDeviceID = requiredString(url.searchParams.get("device_id") ?? "", "device_id");
  const { daemon, session } = await requireUserDaemonSession(store, user.user_id, daemonDeviceID, sessionID);
  const requestID = randomID("sd");
  try {
    const result = await control.requestResponse(daemon.device_id, {
      type: "SESSION_DELETE",
      session_delete: { request_id: requestID, session_id: sessionID, agent: session.agent || "" },
    }, "SESSION_DELETE_RESULT", requestID, 30_000);
    if (result.status !== "ok") {
      return errorResponse(result.error || "session delete failed", ErrorCode.BadRequest, { status: result.error === "session_not_found" ? 404 : 400 });
    }
    await store.deleteSessionData(user.user_id, daemon.device_id, sessionID);
    return jsonResponse({ status: "ok", deleted: result.deleted || [] });
  } catch (error) {
    return mapControlError(error);
  }
}

// sessionReveal opens the session's working directory in the daemon's OS file
// browser (Finder). Path comes from the server-side session row — never from
// the client — so the surface can't be used to probe arbitrary paths.
async function sessionReveal(request, store, env, sessionID, url) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  const daemonDeviceID = requiredString(url.searchParams.get("device_id") ?? "", "device_id");
  const { daemon, session } = await requireUserDaemonSession(store, user.user_id, daemonDeviceID, sessionID);
  if (!session.cwd) return errorResponse("session has no working directory", ErrorCode.BadRequest, { status: 400 });
  const requestID = randomID("rv");
  try {
    const result = await control.requestResponse(daemon.device_id, {
      type: "REVEAL",
      reveal: { request_id: requestID, path: session.cwd },
    }, "REVEAL_RESULT", requestID, 15_000);
    if (result.status !== "ok") return errorResponse(result.error || "reveal failed", ErrorCode.BadRequest, { status: 400 });
    return jsonResponse({ status: "ok" });
  } catch (error) {
    return mapControlError(error);
  }
}

async function sessionInject(request, store, env, sessionID, url) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user, device: browser } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  const daemonDeviceID = requiredString(url.searchParams.get("device_id") ?? "", "device_id");
  const { daemon, session } = await requireUserDaemonSession(store, user.user_id, daemonDeviceID, sessionID);
  if (!(await control.isDaemonOnline(daemon.device_id)) || !daemon.remote_access_enabled) {
    return errorResponse("daemon offline", ErrorCode.DaemonOffline, { status: 503 });
  }
  const body = await readInjectBody(request);
  if (!body.text.trim() && body.files.length === 0) return errorResponse("text is required", ErrorCode.BadRequest, { status: 400 });
  const requestID = randomID("inj");
  const options = injectStreamOptions(sessionID);
  options.initialEvent = { request_id: requestID, type: "inject_started", session_id: sessionID };
  options.userID = user.user_id;
  const envelope = {
    type: "INJECT_REQUEST",
    request: {
      request_id: requestID,
      daemon_device_id: daemon.device_id,
      browser_device_id: browser.device_id,
      mode: "resume_session",
      session_id: sessionID,
      agent: session.agent || "claude-code",
      cwd: session.cwd || "",
      text: body.text,
      model: body.model,
      files: body.files,
    },
  };
  if (!controlStreamingEnabled(env)) {
    await control.dispatch(daemon.device_id, envelope);
    return jsonResponse({
      request_id: requestID,
      status: "accepted",
      type: "inject_started",
      session_id: sessionID,
      device_id: daemon.device_id,
      streaming: false,
    });
  }
  return control.streamRequest(daemon.device_id, envelope, requestID, options);
}

async function sessionSync(request, store, env, sessionID, url) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user, device: browser } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  const daemonDeviceID = requiredString(url.searchParams.get("device_id") ?? "", "device_id");
  const { daemon } = await requireUserDaemonSession(store, user.user_id, daemonDeviceID, sessionID);
  if (!(await control.isDaemonOnline(daemon.device_id)) || !daemon.remote_access_enabled) {
    return errorResponse("daemon offline", ErrorCode.DaemonOffline, { status: 503 });
  }
  const body = await readJSON(request);
  const requestID = randomID("sync");
  const options = syncStreamOptions(sessionID, daemon.device_id);
  options.initialEvent = { ...options.initialEvent, request_id: requestID };
  options.userID = user.user_id;
  const envelope = {
    type: "SYNC_SESSION_REQUEST",
    sync_request: {
      request_id: requestID,
      daemon_device_id: daemon.device_id,
      session_id: sessionID,
      browser_device_id: browser.device_id,
      mode: "window",
      limit: Number(body.limit ?? 20),
      before_seq: Number(body.before_seq ?? 0),
    },
  };
  if (!controlStreamingEnabled(env)) {
    await control.dispatch(daemon.device_id, envelope);
    return jsonResponse({
      request_id: requestID,
      session_id: sessionID,
      device_id: daemon.device_id,
      stage: "queued",
      status: "running",
      streaming: false,
    });
  }
  return control.streamRequest(daemon.device_id, envelope, requestID, options);
}

async function sessionAgentSettings(request, store, env, sessionID, url) {
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed("GET, POST");
  const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  const daemonDeviceID = requiredString(url.searchParams.get("device_id") ?? "", "device_id");
  const { daemon, session } = await requireUserDaemonSession(store, user.user_id, daemonDeviceID, sessionID);
  const requestID = randomID("as");
  let envelope;
  if (request.method === "GET") {
    envelope = {
      type: "AGENT_SETTINGS_GET",
      agent_settings_get: { request_id: requestID, session_id: sessionID, cwd: session.cwd || "", agent: session.agent || "" },
    };
  } else {
    const body = await readJSON(request);
    envelope = {
      type: "AGENT_SETTINGS_SET",
      agent_settings_set: {
        request_id: requestID,
        session_id: sessionID,
        agent: session.agent || "",
        model: body.model || "",
        permission_mode: body.permission_mode || "",
        effort: body.effort || "",
      },
    };
  }
  try {
    const result = await control.requestResponse(daemon.device_id, envelope, "AGENT_SETTINGS_RESULT", requestID, 120_000);
    if (result.status !== "ok") return agentSettingsError(result.error || "agent settings unavailable");
    return jsonResponse({
      current: {
        model: result.model || "",
        resolved_model: result.resolved_model || "",
        permission_mode: result.permission_mode || "",
        effort: result.effort || "",
      },
      available_models: result.available_models || [],
      available_model_options: result.available_model_options || [],
      available_permission_modes: result.available_permission_modes || [],
      available_efforts: result.available_efforts || [],
    });
  } catch (error) {
    return mapControlError(error);
  }
}

async function sessionDiff(request, store, env, sessionID, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  const daemonDeviceID = requiredString(url.searchParams.get("device_id") ?? "", "device_id");
  const { daemon, session } = await requireUserDaemonSession(store, user.user_id, daemonDeviceID, sessionID);
  const requestID = randomID("gd");
  try {
    const result = await control.requestResponse(daemon.device_id, {
      type: "GIT_DIFF_GET",
      git_diff_get: { request_id: requestID, session_id: sessionID, cwd: session.cwd || "" },
    }, "GIT_DIFF_RESULT", requestID, 30_000);
    if (result.status === "error") return errorResponse(result.error || "git diff failed", ErrorCode.BadRequest, { status: result.error?.includes("session_not_attached") ? 404 : 400 });
    return jsonResponse({ status: result.status || "ok", diff: result.diff || "", truncated: Boolean(result.truncated) });
  } catch (error) {
    return mapControlError(error);
  }
}

async function daemonListDir(request, store, env) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  const body = await readJSON(request);
  const daemon = await requireUserDaemon(store, user.user_id, requiredString(body.daemon_device_id, "daemon_device_id"));
  const requestID = randomID("ld");
  try {
    const result = await control.requestResponse(daemon.device_id, {
      type: "LIST_DIR_REQUEST",
      list_dir_request: { request_id: requestID, path: body.path || "" },
    }, "LIST_DIR_RESPONSE", requestID, 10_000);
    return jsonResponse(result);
  } catch (error) {
    return mapControlError(error);
  }
}

async function decidePermissionRequest(request, store, env, requestID) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  const body = await readJSON(request);
  const daemon = await requireUserDaemon(store, user.user_id, requiredString(body.daemon_device_id, "daemon_device_id"));
  const decision = String(body.decision || "");
  if (decision !== "allow" && decision !== "deny") return errorResponse("decision must be allow or deny", ErrorCode.BadRequest, { status: 400 });
  try {
    const result = await control.requestResponse(daemon.device_id, {
      type: "PERMISSION_DECIDE",
      permission_decide: { request_id: requestID, decision },
    }, "PERMISSION_DECIDE_EVENT", requestID, 5_000);
    return jsonResponse(result);
  } catch (error) {
    return mapControlError(error);
  }
}

async function startTask(request, store, env) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user, device: browser } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  const body = await readJSON(request);
  const daemon = await requireUserDaemon(store, user.user_id, requiredString(body.daemon_device_id, "daemon_device_id"));
  if (!(await control.isDaemonOnline(daemon.device_id)) || !daemon.remote_access_enabled) {
    return errorResponse("daemon offline", ErrorCode.DaemonOffline, { status: 503 });
  }
  if (!String(body.text || "").trim()) return errorResponse("text is required", ErrorCode.BadRequest, { status: 400 });
  const requestID = randomID("task");
  const sessionID = body.session_id || "";
  const options = injectStreamOptions(sessionID);
  options.initialEvent = { request_id: requestID, type: "inject_started", session_id: sessionID };
  options.userID = user.user_id;
  const envelope = {
    type: "INJECT_REQUEST",
    request: {
      request_id: requestID,
      daemon_device_id: daemon.device_id,
      browser_device_id: browser.device_id,
      mode: "start_task",
      session_id: sessionID,
      agent: body.agent || "claude-code",
      cwd: body.cwd || "",
      text: body.text,
      model: body.model || "",
      permission_mode: body.permission_mode || "",
      effort: body.effort || "",
    },
  };
  if (!controlStreamingEnabled(env)) {
    await control.dispatch(daemon.device_id, envelope);
    return jsonResponse({
      request_id: requestID,
      status: "accepted",
      type: "inject_started",
      session_id: sessionID,
      device_id: daemon.device_id,
      streaming: false,
    });
  }
  return control.streamRequest(daemon.device_id, envelope, requestID, options);
}

async function terminalSessions(request, store, env) {
  const { user, device: browser } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  if (request.method === "GET") {
    return jsonResponse({ terminal_sessions: await control.listTerminalSessions(user.user_id) });
  }
  if (request.method !== "POST") return methodNotAllowed("GET, POST");
  const body = await readJSON(request);
  const daemon = await requireUserDaemon(store, user.user_id, requiredString(body.daemon_device_id, "daemon_device_id"));
  if (!(await control.isDaemonOnline(daemon.device_id)) || !daemon.remote_access_enabled) {
    return errorResponse("daemon offline", ErrorCode.DaemonOffline, { status: 503 });
  }
  try {
    const terminal = await control.createTerminalSession({
      request_id: randomID("term"),
      terminal_session_id: randomID("ts"),
      user_id: user.user_id,
      daemon_device_id: daemon.device_id,
      browser_device_id: browser.device_id,
      session_id: body.session_id || "",
      agent: body.agent || "claude-code",
      cwd: body.cwd || "",
    });
    return jsonResponse({ terminal_session: terminal });
  } catch (error) {
    return mapControlError(error);
  }
}

async function terminalSessionByID(request, store, env, terminalSessionID, action) {
  const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  try {
    switch (action) {
      case "input": {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const body = await readJSON(request);
        await control.sendTerminalInput(user.user_id, terminalSessionID, String(body.text || ""));
        return jsonResponse({ status: "queued" });
      }
      case "stop":
        if (request.method !== "POST") return methodNotAllowed("POST");
        await control.stopTerminalSession(user.user_id, terminalSessionID);
        return jsonResponse({ status: "queued" });
      case "open-terminal":
        if (request.method !== "POST") return methodNotAllowed("POST");
        await control.openTerminalSession(user.user_id, terminalSessionID);
        return jsonResponse({ status: "queued" });
      case "subscribe":
        if (request.method !== "POST") return methodNotAllowed("POST");
        return jsonResponse(await control.subscribeTerminalSession(user.user_id, terminalSessionID));
      case "unsubscribe":
        if (request.method !== "POST") return methodNotAllowed("POST");
        return jsonResponse(await control.unsubscribeTerminalSession(user.user_id, terminalSessionID));
      case "events":
        if (request.method !== "GET") return methodNotAllowed("GET");
        return jsonResponse(await listTerminalEvents(store, control, request, user.user_id, terminalSessionID));
      case "stream":
        if (request.method !== "GET") return methodNotAllowed("GET");
        if (!terminalStreamingEnabled(env)) {
          return errorResponse("terminal streaming is disabled in this runtime", ErrorCode.UnsupportedRuntime, { status: 501 });
        }
        return control.streamTerminalSession(user.user_id, terminalSessionID);
      default:
        return errorResponse("not found", ErrorCode.NotFound, { status: 404 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "terminal session not found") {
      return errorResponse(message, ErrorCode.NotFound, { status: 404 });
    }
    return mapControlError(error);
  }
}

function browserRealtimeEnabled(env = {}) {
  return enabledFlag(env.BROWSER_REALTIME_ENABLED ?? env.REALTIME_ENABLED);
}

function controlStreamingEnabled(env = {}) {
  return enabledFlag(env.CONTROL_STREAMING_ENABLED ?? "1");
}

function terminalStreamingEnabled(env = {}) {
  return enabledFlag(env.TERMINAL_STREAMING_ENABLED ?? env.TERMINAL_ENABLED);
}

async function acceptTelemetry(request, provider) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const text = await request.text();
  if (provider) await invokeTelemetryProvider(provider, text, request);
  return jsonResponse({ ok: true });
}

async function getVAPIDPublicKey(request, env) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const publicKey = webPushPublicKey(env);
  if (!isWebPushConfigured(env) || !publicKey) return errorResponse("push notifications are not configured", ErrorCode.ServiceUnavailable, { status: 503 });
  return jsonResponse({ public_key: publicKey });
}

async function pushSubscriptions(request, store, env) {
  if (!isWebPushConfigured(env)) return errorResponse("push notifications are not configured", ErrorCode.ServiceUnavailable, { status: 503 });
  const { user, device: browser } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readJSON(request);
  const now = new Date().toISOString();
  const endpoint = requiredString(body.endpoint, "endpoint");
  const keys = body.keys && typeof body.keys === "object" ? body.keys : {};
  const subscriptionID = `ps_${await sha256Base64URL(`${user.user_id}\n${browser.device_id}\n${endpoint}`)}`;
  const subscription = await store.upsertPushSubscription({
    subscription_id: subscriptionID,
    user_id: user.user_id,
    browser_device_id: browser.device_id,
    endpoint,
    p256dh: requiredString(keys.p256dh, "keys.p256dh"),
    auth: requiredString(keys.auth, "keys.auth"),
    user_agent: body.user_agent || "",
    status: "active",
    created_at: now,
    updated_at: now,
  });
  return jsonResponse({
    subscription_id: subscription.subscription_id,
    status: subscription.status,
    endpoint: subscription.endpoint,
    created_at: subscription.created_at,
    updated_at: subscription.updated_at,
  });
}

async function pushSubscriptionByID(request, store, subscriptionID) {
  if (request.method !== "DELETE") return methodNotAllowed("DELETE");
  const { user, device: browser } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const deleted = await store.deletePushSubscription(user.user_id, browser.device_id, subscriptionID, new Date().toISOString());
  if (!deleted) return errorResponse("push subscription not found", ErrorCode.NotFound, { status: 404 });
  return jsonResponse({ status: "deleted", subscription_id: subscriptionID });
}

async function transcribeVoice(request, store, env) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  await requireDeviceAuth(request, store, "browser", "browser-ws");
  const provider = env.POCKLY_STT_PROVIDER;
  if (provider) {
    const form = await request.formData();
    try {
      const result = await invokeSTTProvider(provider, { form, env, request });
      return jsonResponse(normalizeTranscriptionResult(result, form, env));
    } catch (error) {
      return errorResponse(
        error instanceof Error ? error.message : "voice transcription failed",
        ErrorCode.ServiceUnavailable,
        { status: 502 },
      );
    }
  }
  const endpoint = env.VOICE_TRANSCRIPTION_ENDPOINT || env.POCKLY_VOICE_TRANSCRIPTION_ENDPOINT;
  if (!endpoint) {
    return errorResponse("voice transcription is not configured", ErrorCode.ServiceUnavailable, { status: 503 });
  }
  const form = await request.formData();
  const upstream = new FormData();
  for (const [key, value] of form.entries()) upstream.append(key, value);
  if (!form.has("model") && env.VOICE_TRANSCRIPTION_MODEL) upstream.set("model", env.VOICE_TRANSCRIPTION_MODEL);
  const headers = new Headers();
  if (env.VOICE_TRANSCRIPTION_API_KEY) headers.set("authorization", `Bearer ${env.VOICE_TRANSCRIPTION_API_KEY}`);
  const response = await fetch(endpoint, { method: "POST", headers, body: upstream });
  const text = await response.text();
  const parsed = text ? parsePayload(text) : {};
  if (!response.ok) {
    return errorResponse(
      parsed && typeof parsed === "object" && parsed.error ? String(parsed.error) : text.trim() || "voice transcription failed",
      ErrorCode.ServiceUnavailable,
      { status: response.status },
    );
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.text !== "string") {
    return errorResponse("voice transcription provider returned an invalid response", ErrorCode.ServiceUnavailable, { status: 502 });
  }
  return jsonResponse({
    text: parsed.text,
    provider: parsed.provider || env.VOICE_TRANSCRIPTION_PROVIDER || "configured",
    duration_ms: Number(parsed.duration_ms ?? form.get("duration_ms") ?? 0),
    fallback_used: Boolean(parsed.fallback_used),
  });
}

async function invokeTelemetryProvider(provider, text, request) {
  if (typeof provider === "function") {
    await provider({ text, request });
    return;
  }
  if (provider && typeof provider.record === "function") {
    await provider.record({ text, request });
  }
}

async function invokeSTTProvider(provider, input) {
  if (typeof provider === "function") return await provider(input);
  if (provider && typeof provider.transcribe === "function") return await provider.transcribe(input);
  throw new Error("invalid STT provider");
}

function normalizeTranscriptionResult(result, form, env) {
  if (!result || typeof result !== "object" || typeof result.text !== "string") {
    throw new Error("voice transcription provider returned an invalid response");
  }
  return {
    text: result.text,
    provider: result.provider || env.VOICE_TRANSCRIPTION_PROVIDER || "configured",
    duration_ms: Number(result.duration_ms ?? form.get("duration_ms") ?? 0),
    fallback_used: Boolean(result.fallback_used),
  };
}

async function submitFeedback(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user, device: browser } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const form = await request.formData();
  const message = requiredString(String(form.get("message") || ""), "message");
  const attachment = form.get("attachment");
  const feedback = await store.createFeedback({
    feedback_id: randomID("fb"),
    user_id: user.user_id,
    browser_device_id: browser.device_id,
    message,
    page_path: String(form.get("page_path") || ""),
    app_version: String(form.get("app_version") || ""),
    relay_environment: String(form.get("relay_environment") || ""),
    browser_name: String(form.get("browser_name") || ""),
    browser_platform: String(form.get("browser_platform") || ""),
    browser_user_agent: String(form.get("browser_user_agent") || ""),
    selected_session_id: String(form.get("selected_session_id") || ""),
    selected_device_id: String(form.get("selected_device_id") || ""),
    attachment_name: attachment instanceof File ? attachment.name : "",
    attachment_type: attachment instanceof File ? attachment.type : "",
    attachment_size: attachment instanceof File ? attachment.size : 0,
    created_at: new Date().toISOString(),
  });
  return jsonResponse({ status: "accepted", feedback_id: feedback.feedback_id });
}

async function cancelInject(request, store, env, requestID) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  try {
    return jsonResponse(await control.cancelInject(user.user_id, requestID));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "inject request not found") {
      return errorResponse(message, ErrorCode.NotFound, { status: 404 });
    }
    return mapControlError(error);
  }
}

async function listTerminalEvents(store, control, request, userID, terminalSessionID) {
  const url = new URL(request.url);
  const options = {
    after: url.searchParams.get("after") || "",
    limit: url.searchParams.get("limit") || "",
  };
  const persisted = await store.listSessionEvents(userID, "", "", {
    ...options,
    request_id: terminalSessionID,
  });
  if (persisted.length > 0) {
    const events = persisted.map(publicSessionEvent);
    return {
      events,
      next_cursor: events.at(-1)?.cursor || options.after,
    };
  }
  return control.listTerminalEvents(userID, terminalSessionID, options);
}

async function unsupportedControl(request, action) {
  if (!["GET", "POST"].includes(request.method)) return methodNotAllowed("GET, POST");
  return errorResponse(`${action} requires a live daemon control connection`, ErrorCode.DaemonOffline, { status: 503 });
}

async function issueWebSession(store, user, now) {
  return await issueWebSessionBody(store, user, now, publicUser(user));
}

async function issueWebSessionBody(store, user, now, body) {
  const token = await createOpaqueToken("ws");
  const expiresAt = new Date(now.getTime() + WEB_SESSION_TTL_SECONDS * 1000);
  await store.createWebSession({
    session_token_hash: await sha256Base64URL(token),
    user_id: user.user_id,
    expires_at: expiresAt.toISOString(),
    created_at: now.toISOString(),
  });
  return jsonResponse(body, { headers: { "set-cookie": sessionCookie(token, expiresAt) } });
}

async function requireUserDaemon(store, userID, daemonDeviceID) {
  const daemon = await store.getDevice(daemonDeviceID);
  if (!daemon || daemon.user_id !== userID || daemon.device_type !== "daemon" || daemon.status === "revoked") {
    const err = new Error("host not found");
    err.response = errorResponse("host not found", ErrorCode.NotFound, { status: 404 });
    throw err;
  }
  return daemon;
}

async function requireUserDaemonSession(store, userID, daemonDeviceID, sessionID) {
  const daemon = await requireUserDaemon(store, userID, daemonDeviceID);
  const session = await store.getSession(userID, daemonDeviceID, sessionID);
  if (!session) {
    const err = new Error("session not found");
    err.response = errorResponse("session not found", ErrorCode.NotFound, { status: 404 });
    throw err;
  }
  return { daemon, session };
}

async function bindBrowserToDaemon(store, userID, daemonDeviceID, browserDeviceID, now) {
  const browser = await store.getDevice(browserDeviceID);
  if (!browser || browser.user_id !== userID || browser.device_type !== "browser" || browser.status === "revoked") {
    throwConflict("browser access is not active");
  }
  await store.upsertDeviceBinding({
    daemon_device_id: daemonDeviceID,
    browser_device_id: browserDeviceID,
    user_id: userID,
    status: "active",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
}

async function requireBrowserDaemonBinding(store, userID, daemonDeviceID, browserDeviceID) {
  const binding = await store.getDeviceBinding(userID, daemonDeviceID, browserDeviceID);
  if (!binding) {
    const err = new Error("browser is not connected to this host");
    err.response = errorResponse("browser is not connected to this host", ErrorCode.Forbidden, { status: 403 });
    throw err;
  }
  return binding;
}

async function readInjectBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const files = [];
    for (const file of form.getAll("files")) {
      if (!(file instanceof File)) continue;
      files.push({
        filename: file.name,
        mime_type: file.type || "",
        data: base64Std(new Uint8Array(await file.arrayBuffer())),
      });
    }
    return {
      text: String(form.get("text") || ""),
      model: String(form.get("model") || ""),
      files,
    };
  }
  const body = await readJSON(request);
  return { text: String(body.text || ""), model: String(body.model || ""), files: [] };
}

function agentSettingsError(error) {
  if (error.includes("session_not_attached")) {
    return errorResponse(error, ErrorCode.NotFound, { status: 404 });
  }
  if (error.startsWith("session_drifted")) {
    const actual = error.includes("current=") ? error.slice(error.indexOf("current=") + "current=".length).trim() : "";
    return jsonResponse({ error, ...(actual ? { actual_sid: actual } : {}) }, { status: 409 });
  }
  return errorResponse(error, ErrorCode.BadRequest, { status: 400 });
}

async function upsertDaemonDevice(store, user, body, now) {
  await assertDaemonAssignable(store, requiredString(body.daemon_device_id, "daemon_device_id"), user.user_id, requiredString(body.daemon_pubkey, "daemon_pubkey"));
  const computerID = body.computer_id || `dc_${body.daemon_device_id || randomID("daemon")}`;
  await store.upsertComputer({
    computer_id: computerID,
    user_id: user.user_id,
    display_name: body.device_name || body.hostname || "Pockly Computer",
    hostname: body.hostname || "",
    os: body.os || "",
    status: "active",
    current_daemon_device_id: requiredString(body.daemon_device_id, "daemon_device_id"),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    last_seen_at: now.toISOString(),
  });
  return await store.upsertDevice({
    device_id: requiredString(body.daemon_device_id, "daemon_device_id"),
    user_id: user.user_id,
    computer_id: computerID,
    device_type: "daemon",
    device_name: body.device_name || body.hostname || "Pockly Daemon",
    public_key: requiredString(body.daemon_pubkey, "daemon_pubkey"),
    status: "active",
    remote_access_enabled: true,
    hostname: body.hostname || "",
    os: body.os || "",
    app_version: body.app_version || "",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    last_seen_at: now.toISOString(),
  });
}

async function upsertDaemonFromAuthorization(store, user, auth, now, markSeen) {
  return await upsertDaemonIdentity(store, user, {
    daemon_device_id: auth.daemon_device_id,
    daemon_pubkey: auth.daemon_public_key,
    device_name: auth.device_name,
    hostname: auth.hostname,
    os: auth.os,
    app_version: auth.app_version,
    computer_id: auth.computer_id,
    computer_public_key: auth.computer_public_key,
  }, now, markSeen);
}

async function upsertDaemonFromSetupGrant(store, user, grant, now) {
  return await upsertDaemonIdentity(store, user, {
    daemon_device_id: grant.daemon_device_id,
    daemon_pubkey: grant.daemon_public_key,
    device_name: grant.device_name,
    hostname: grant.hostname,
    os: grant.os,
    app_version: grant.app_version,
    computer_id: grant.computer_id,
    computer_public_key: grant.computer_public_key,
  }, now, true);
}

async function upsertDaemonIdentity(store, user, body, now, markSeen) {
  await assertDaemonAssignable(store, requiredString(body.daemon_device_id, "daemon_device_id"), user.user_id, requiredString(body.daemon_pubkey, "daemon_pubkey"));
  const computerID = body.computer_id || `dc_${body.daemon_device_id || randomID("daemon")}`;
  await store.upsertComputer({
    computer_id: computerID,
    user_id: user.user_id,
    display_name: body.device_name || body.hostname || "Pockly Computer",
    hostname: body.hostname || "",
    os: body.os || "",
    status: "active",
    current_daemon_device_id: requiredString(body.daemon_device_id, "daemon_device_id"),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    last_seen_at: markSeen ? now.toISOString() : undefined,
  });
  return await store.upsertDevice({
    device_id: requiredString(body.daemon_device_id, "daemon_device_id"),
    user_id: user.user_id,
    computer_id: computerID,
    device_type: "daemon",
    device_name: body.device_name || body.hostname || "Pockly Daemon",
    public_key: requiredString(body.daemon_pubkey, "daemon_pubkey"),
    status: "active",
    remote_access_enabled: true,
    hostname: body.hostname || "",
    os: body.os || "",
    app_version: body.app_version || "",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...(markSeen ? { last_seen_at: now.toISOString() } : {}),
  });
}

async function upsertBrowserDevice(store, user, body, now) {
  const browserDeviceID = body.browser_device_id || randomID("bd");
  const existing = await store.getDevice(browserDeviceID);
  const publicKey = requiredString(body.browser_device_pubkey, "browser_device_pubkey");
  if (existing && (existing.user_id !== user.user_id || existing.public_key !== publicKey || existing.device_type !== "browser")) {
    throwConflict("browser access id belongs to another key or account");
  }
  if (existing?.status === "revoked") {
    throwConflict("revoked browser access cannot be reconnected; create a new browser access key");
  }
  return await store.upsertDevice({
    device_id: browserDeviceID,
    user_id: user.user_id,
    device_type: "browser",
    device_name: body.device_name || existing?.device_name || "Browser",
    public_key: publicKey,
    status: "active",
    remote_access_enabled: false,
    user_agent: body.user_agent || existing?.user_agent || "",
    created_at: existing?.created_at || now.toISOString(),
    updated_at: now.toISOString(),
    last_seen_at: now.toISOString(),
  });
}

async function assertDaemonAssignable(store, daemonDeviceID, userID, publicKey) {
  const existing = await store.getDevice(daemonDeviceID);
  if (!existing) return;
  if (existing.public_key && existing.public_key !== publicKey) {
    throwConflict("daemon_device_id already registered with a different public key");
  }
  if (existing.user_id && existing.user_id !== userID) {
    throwConflict("daemon_device_id is already linked to another account");
  }
}

async function syncSessionRecord(store, user, device, session, now, uploadedTurnStats) {
  const existing = await store.getSession(user.user_id, device.device_id, requiredString(session.session_id, "session_id"));
  const stats = await syncSessionTurnStats(store, user.user_id, device.device_id, String(session.session_id), existing, session, uploadedTurnStats);
  const persistedTurnCount = stats
    ? stats.count
    : Number(existing?.synced_turn_count ?? 0);
  const minSeq = Number(session.min_seq ?? 0);
  const maxSeq = Number(session.max_seq ?? session.last_seq ?? 0);
  const uploadedTurnCount = Number(uploadedTurnStats?.count ?? 0) || 0;
  const uploadedSyncedMinSeq = Number(stats?.min_seq ?? uploadedTurnStats?.min_seq ?? minSeq) || 0;
  const uploadedSyncedMaxSeq = Number(stats?.max_seq ?? uploadedTurnStats?.max_seq ?? maxSeq) || 0;
  const syncedMinSeq = uploadedTurnCount > 0
    ? mergeSyncedMinSeq(existing?.synced_min_seq, uploadedSyncedMinSeq)
    : mergeSyncedMinSeq(existing?.synced_min_seq, stats?.min_seq ?? 0);
  const syncedMaxSeq = uploadedTurnCount > 0
    ? Math.max(Number(existing?.synced_max_seq ?? 0), uploadedSyncedMaxSeq)
    : Math.max(Number(existing?.synced_max_seq ?? 0), stats?.max_seq ?? 0);
  return {
    user_id: user.user_id,
    computer_id: device.computer_id ?? null,
    device_id: device.device_id,
    session_id: requiredString(session.session_id, "session_id"),
    agent: session.agent || "claude-code",
    runner_alias: session.runner_alias || "",
    cwd: session.cwd || "",
    snippet: session.snippet || session.first_message || "",
    first_message: session.first_message || "",
    title: session.title || "",
    last_seq: Number(session.last_seq ?? maxSeq),
    last_timestamp: session.last_timestamp || now,
    channel_last_seen_at: session.channel_last_seen_at || device.last_seen_at || now,
    sync_state: mergedSyncState(existing, session, uploadedTurnCount, {
      persistedTurnCount,
      syncedMinSeq,
      syncedMaxSeq,
    }),
    turn_count: Number(session.turn_count ?? 0),
    last_sync_error: "",
    synced_turn_count: persistedTurnCount,
    synced_min_seq: syncedMinSeq,
    synced_max_seq: syncedMaxSeq,
    has_older_turns: mergedHasOlderTurns(existing, session, uploadedTurnCount, {
      persistedTurnCount,
      syncedMinSeq,
      syncedMaxSeq,
    }),
    updated_at: session.last_timestamp || now,
  };
}

async function syncSessionTurnStats(store, userID, deviceID, sessionID, existing, session, uploadedTurnStats) {
  const uploadedTurnCount = Number(uploadedTurnStats?.count ?? 0) || 0;
  if (uploadedTurnCount > 0) {
    const merged = mergeUploadedTurnStats(existing, session, uploadedTurnStats);
    if (!merged.requires_full_stats) return merged;
    return await sessionTurnStats(store, userID, deviceID, sessionID);
  }
  // Repair older rows whose session metadata was left at catalog_only/0 even
  // though session_turns already contains lazy-synced content.
  if (
    existing &&
    Number(existing.synced_turn_count ?? 0) <= 0 &&
    Number(session.turn_count ?? existing.turn_count ?? 0) > 0
  ) {
    const stats = await sessionTurnStats(store, userID, deviceID, sessionID);
    if (stats.count > 0) return stats;
  }
  return null;
}

function mergeUploadedTurnStats(existing, session, uploadedTurnStats) {
  const uploadedCount = Number(uploadedTurnStats?.count ?? 0) || 0;
  const uploadedMinSeq = Number(uploadedTurnStats?.min_seq ?? session.min_seq ?? 0) || 0;
  const uploadedMaxSeq = Number(uploadedTurnStats?.max_seq ?? session.max_seq ?? session.last_seq ?? 0) || 0;
  if (uploadedCount <= 0 || uploadedMinSeq <= 0 || uploadedMaxSeq <= 0 || uploadedMaxSeq < uploadedMinSeq) {
    return { requires_full_stats: true };
  }

  const currentCount = Number(existing?.synced_turn_count ?? 0) || 0;
  const currentMinSeq = Number(existing?.synced_min_seq ?? 0) || 0;
  const currentMaxSeq = Number(existing?.synced_max_seq ?? 0) || 0;
  if (currentCount <= 0 || currentMinSeq <= 0 || currentMaxSeq <= 0 || currentMaxSeq < currentMinSeq) {
    return {
      count: uploadedCount,
      min_seq: uploadedMinSeq,
      max_seq: uploadedMaxSeq,
      latest_contiguous_min_seq: uploadedMinSeq,
    };
  }

  const currentSpan = currentMaxSeq - currentMinSeq + 1;
  const currentRangeIsComplete = currentCount >= currentSpan;
  const disjointBelow = uploadedMaxSeq < currentMinSeq;
  const disjointAbove = uploadedMinSeq > currentMaxSeq;
  if (!currentRangeIsComplete && !disjointBelow && !disjointAbove) {
    // Existing min/max can hide gaps (for example 1-40 and 141-240). In that
    // case a contained upload may fill a hole, so use the store's seq-only
    // stats query instead of guessing from the compressed session row.
    return { requires_full_stats: true };
  }

  let additionalCount = 0;
  if (uploadedMinSeq < currentMinSeq) {
    additionalCount += Math.min(uploadedMaxSeq, currentMinSeq - 1) - uploadedMinSeq + 1;
  }
  if (uploadedMaxSeq > currentMaxSeq) {
    additionalCount += uploadedMaxSeq - Math.max(uploadedMinSeq, currentMaxSeq + 1) + 1;
  }
  const nextMinSeq = Math.min(currentMinSeq, uploadedMinSeq);
  const nextMaxSeq = Math.max(currentMaxSeq, uploadedMaxSeq);
  const nextCount = currentCount + additionalCount;
  const nextSpan = nextMaxSeq - nextMinSeq + 1;
  return {
    count: Math.min(nextCount, nextSpan),
    min_seq: nextMinSeq,
    max_seq: nextMaxSeq,
    latest_contiguous_min_seq: nextCount >= nextSpan ? nextMinSeq : currentMinSeq,
  };
}

async function sessionTurnStats(store, userID, deviceID, sessionID) {
  if (typeof store.getSessionTurnStats === "function") {
    return await store.getSessionTurnStats(userID, deviceID, sessionID);
  }
  const turns = await store.listTurns(userID, deviceID, sessionID);
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

async function sessionWithTurnStats(store, userID, deviceID, sessionID) {
  const session = await store.getSession(userID, deviceID, sessionID);
  if (!session) return null;
  const stats = await sessionTurnStats(store, userID, deviceID, sessionID);
  return {
    ...session,
    synced_turn_count: stats.count,
    actual_turn_count: stats.count,
    synced_min_seq: mergeSyncedMinSeq(session.synced_min_seq, stats.min_seq),
    synced_max_seq: Math.max(Number(session.synced_max_seq ?? 0) || 0, stats.max_seq),
    latest_contiguous_min_seq: Number(stats.latest_contiguous_min_seq ?? 0) || Number(session.synced_min_seq ?? 0) || 0,
  };
}

function sessionSyncHintPayload(session, fallbackSessionID = "") {
  const totalTurnCount = Number(session?.turn_count ?? 0) || 0;
  const syncedTurnCount = Number(session?.synced_turn_count ?? 0) || 0;
  const actualTurnCount = Number(session?.actual_turn_count ?? syncedTurnCount) || 0;
  const syncedMinSeq = Number(session?.synced_min_seq ?? 0) || 0;
  const syncedMaxSeq = Number(session?.synced_max_seq ?? 0) || 0;
  const latestContiguousMinSeq = Number(session?.latest_contiguous_min_seq ?? 0) || syncedMinSeq;
  return {
    session_id: String(session?.session_id ?? fallbackSessionID),
    synced_turn_count: syncedTurnCount,
    synced_min_seq: syncedMinSeq,
    synced_max_seq: syncedMaxSeq,
    latest_contiguous_min_seq: latestContiguousMinSeq,
    next_before_seq: nextBackfillBeforeSeq({
      total_turn_count: totalTurnCount,
      synced_turn_count: syncedTurnCount,
      actual_turn_count: actualTurnCount,
      synced_min_seq: syncedMinSeq,
      synced_max_seq: syncedMaxSeq,
      latest_contiguous_min_seq: latestContiguousMinSeq,
      has_older_turns: session?.has_older_turns,
    }),
    total_turn_count: totalTurnCount,
    has_older_turns: Boolean(session?.has_older_turns),
  };
}

function nextBackfillBeforeSeq(session) {
  const total = Number(session?.total_turn_count ?? 0) || 0;
  const syncedCount = Number(session?.actual_turn_count ?? session?.synced_turn_count ?? 0) || 0;
  const syncedMinSeq = Number(session?.synced_min_seq ?? 0) || 0;
  const syncedMaxSeq = Number(session?.synced_max_seq ?? 0) || 0;
  const latestContiguousMinSeq = Number(session?.latest_contiguous_min_seq ?? 0) || syncedMinSeq;
  if (latestContiguousMinSeq > 1 && (Boolean(session?.has_older_turns) || total <= 0 || syncedCount < total)) {
    return latestContiguousMinSeq;
  }
  if (syncedMinSeq > 1 && (Boolean(session?.has_older_turns) || total <= 0 || syncedCount < total)) {
    return syncedMinSeq;
  }
  if (total > 0 && syncedMaxSeq > 0 && syncedMaxSeq < total) {
    return total + 1;
  }
  return 0;
}

function mergeSyncedMinSeq(existing, incoming) {
  const current = Number(existing ?? 0);
  const next = Number(incoming ?? 0);
  if (current <= 0) return next > 0 ? next : 0;
  if (next <= 0) return current;
  return Math.min(current, next);
}

function mergedSyncState(existing, session, uploadedTurnCount, synced = {}) {
  const incoming = session.sync_state || (uploadedTurnCount > 0 ? "ready" : "catalog_only");
  if (incoming === "failed" || incoming === "syncing") return incoming;
  if (incoming === "partial" || session.has_older) return "partial";
  if (uploadedTurnCount > 0 || Number(synced.persistedTurnCount ?? 0) > 0) {
    const total = Number(session.turn_count ?? 0);
    if (
      total > 0 &&
      Number(synced.persistedTurnCount ?? 0) >= total &&
      Number(synced.syncedMinSeq ?? 0) <= 1 &&
      Number(synced.syncedMaxSeq ?? 0) >= total
    ) {
      return "fully_synced";
    }
    return "partial";
  }
  if (incoming === "fully_synced") return "fully_synced";
  if (existing?.sync_state && existing.sync_state !== "catalog_only") return existing.sync_state;
  return incoming;
}

function mergedHasOlderTurns(existing, session, uploadedTurnCount, synced = {}) {
  if (uploadedTurnCount > 0 || Number(synced.persistedTurnCount ?? 0) > 0) {
    const total = Number(session.turn_count ?? 0);
    if (
      !session.has_older &&
      total > 0 &&
      Number(synced.persistedTurnCount ?? 0) >= total &&
      Number(synced.syncedMinSeq ?? 0) <= 1 &&
      Number(synced.syncedMaxSeq ?? 0) >= total
    ) {
      return false;
    }
    if (
      total > 0 &&
      (
        Number(synced.syncedMinSeq ?? 0) > 1 ||
        Number(synced.syncedMaxSeq ?? 0) < total ||
        Number(synced.persistedTurnCount ?? 0) < total
      )
    ) {
      return true;
    }
  }
  return Boolean(session.has_older || existing?.has_older_turns);
}

function uniqueDaemonDeviceIDs(sessions, devicesByID) {
  const ids = new Set();
  for (const session of sessions) {
    const deviceID = String(session.device_id || "");
    if (!deviceID) continue;
    const device = devicesByID.get(deviceID);
    if (!device || device.device_type !== "daemon" || device.status !== "active" || !device.remote_access_enabled) continue;
    ids.add(deviceID);
  }
  return [...ids];
}

function hostsOnlineCacheKey(userID, requesterDeviceID, env = {}) {
  return `${env.POCKLY_HOSTS_ONLINE_CACHE_SCOPE || "default"}:${userID || ""}:${requesterDeviceID || "cookie"}`;
}

function hostsOnlineCacheMs(env = {}) {
  const parsed = Number(env.POCKLY_HOSTS_ONLINE_CACHE_MS ?? defaultHostsOnlineCacheMs);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultHostsOnlineCacheMs;
  return Math.min(5000, parsed);
}

function pruneHostsOnlineCache(now, ttlMs) {
  const maxAge = Math.max(ttlMs * 4, 5000);
  for (const [key, entry] of hostsOnlineCache.entries()) {
    if (now - entry.fetchedAt > maxAge) hostsOnlineCache.delete(key);
  }
}

async function recordPresenceTelemetry(provider, request, fields) {
  if (!provider) return;
  const event = {
    name: "nexus_presence_refresh",
    command: String(fields.command || "hosts_online"),
    status: "ok",
    timestamp: new Date().toISOString(),
    presence_source: String(fields.presence_source || "none"),
    sessions_count: Number(fields.sessions_count || 0),
    unique_daemon_count: Number(fields.unique_daemon_count || 0),
    presence_batch_size: Number(fields.presence_batch_size || 0),
  };
  const payload = JSON.stringify({ events: [event] });
  try {
    await invokeTelemetryProvider(provider, payload, request);
  } catch {
    // Presence telemetry must never affect the hot path.
  }
}

function syncTurnRecord(user, device, turn, now) {
  const payload = turn.payload === undefined || turn.payload === null
    ? null
    : typeof turn.payload === "string"
      ? turn.payload
      : JSON.stringify(turn.payload);
  return {
    user_id: user.user_id,
    device_id: device.device_id,
    session_id: requiredString(turn.session_id, "session_id"),
    seq: Number(turn.seq),
    agent: turn.agent || "claude-code",
    kind: turn.kind || "meta",
    timestamp: turn.timestamp || now,
    payload,
    updated_at: now,
  };
}

function publicUser(user) {
  return {
    user_id: user.user_id,
    email: user.email,
    name: user.name ?? "",
  };
}

function publicDevice(device) {
  return {
    device_id: device.device_id,
    device_type: device.device_type,
    device_name: device.device_name ?? "",
    status: device.status,
    capabilities: device.capabilities ?? [],
    first_paired_at: device.created_at,
    last_seen_at: device.last_seen_at,
    os: device.os,
    hostname: device.hostname,
    user_agent: device.user_agent,
    app_version: device.app_version,
    remote_access_enabled: Boolean(device.remote_access_enabled),
    computer_id: device.computer_id,
    superseded_by_device_id: device.superseded_by_device_id,
  };
}

function publicDeviceAuthorization(auth) {
  return {
    device_code: auth.device_code,
    user_code: auth.user_code,
    daemon: {
      device_id: auth.daemon_device_id,
      device_name: auth.device_name,
      hostname: auth.hostname,
      os: auth.os,
      app_version: auth.app_version,
    },
    requested_capabilities: ["read", "push", "inject"],
    status: auth.status,
    expires_at: auth.expires_at,
  };
}

function publicSession(session, device, controlOnline = false) {
  const online = controlOnline || isOnline(device?.last_seen_at);
  const writable = Boolean(online && device?.remote_access_enabled && device.status === "active");
  return {
    session_id: session.session_id,
    device_id: session.device_id,
    computer_id: session.computer_id,
    agent: session.agent,
    runner_alias: session.runner_alias || undefined,
    cwd: session.cwd ?? "",
    snippet: session.snippet ?? "",
    title: session.title || undefined,
    last_seq: Number(session.last_seq ?? 0),
    last_timestamp: session.last_timestamp || session.updated_at,
    channel_last_seen_at: session.channel_last_seen_at || device?.last_seen_at,
    sync_state: session.sync_state || "catalog_only",
    connection_mode: writable ? "sdk_headless" : "read_only",
    writable,
    turn_count: Number(session.turn_count ?? 0),
    last_sync_error: session.last_sync_error || "",
    synced_turn_count: Number(session.synced_turn_count ?? 0),
    synced_min_seq: Number(session.synced_min_seq ?? 0),
    synced_max_seq: Number(session.synced_max_seq ?? 0),
    has_older_turns: Boolean(session.has_older_turns),
  };
}

function publicTurn(turn) {
  return {
    device_id: turn.device_id,
    session_id: turn.session_id,
    seq: Number(turn.seq),
    agent: turn.agent,
    kind: turn.kind,
    timestamp: turn.timestamp,
    ...(turn.payload ? { payload: parsePayload(turn.payload) } : {}),
  };
}

function publicSessionEvent(event) {
  return {
    cursor: String(event.event_id || ""),
    event_id: String(event.event_id || ""),
    request_id: event.request_id || "",
    device_id: event.device_id || "",
    session_id: event.session_id || "",
    type: event.event_type || "",
    created_at: event.created_at || "",
    payload: parsePayload(event.payload),
  };
}

function publicHost(device, activeSessionCount, controlOnline = false) {
  const online = controlOnline || isOnline(device.last_seen_at);
  return {
    device_id: device.device_id,
    device_name: device.device_name ?? "",
    hostname: device.hostname,
    os: device.os,
    app_version: device.app_version,
    status: device.status,
    presence_status: online ? "online" : "offline",
    presence_reason: controlOnline ? "control_connected" : online ? "recent_sync" : "last_seen_expired",
    control_connected: controlOnline,
    remote_access_enabled: Boolean(device.remote_access_enabled),
    last_seen_at: device.last_seen_at || device.updated_at,
    last_channel_seen_at: device.last_seen_at,
    active_session_count: activeSessionCount,
    connected: online,
  };
}

function isOnline(lastSeenAt) {
  return Boolean(lastSeenAt && Date.now() - Date.parse(lastSeenAt) <= onlineWindowMs);
}

function refreshExpirableStatus(record) {
  if (!record) return null;
  if ((record.status === "pending" || record.status === "awaiting_daemon_confirm" || record.status === "authorized") && Date.parse(record.expires_at) <= Date.now()) {
    return { ...record, status: "expired" };
  }
  return record;
}

async function readJSON(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("invalid json");
  }
}

function parsePayload(payload) {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return { text: payload };
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${name} is required`);
  }
  return value.trim();
}

function enabledFlag(value) {
  return value === "1" || value === "true" || value === true;
}

function badRequest(error) {
  const err = new Error(error);
  err.response = errorResponse(error, ErrorCode.BadRequest, { status: 400 });
  return err;
}

function throwConflict(error) {
  const err = new Error(error);
  err.response = errorResponse(error, ErrorCode.Conflict, { status: 409 });
  throw err;
}

function randomID(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

function base64Std(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function formatUserCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function publicBaseURL(request, url) {
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(/:$/, "") || "https";
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host;
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function cloneJSONRequest(request, body) {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });
}

function normalizePath(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

function methodNotAllowed(allow) {
  return errorResponse("method not allowed", ErrorCode.MethodNotAllowed, {
    status: 405,
    headers: { allow },
  });
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return `pbkdf2_sha256$${iterations}$${base64Url(salt)}$${base64Url(new Uint8Array(bits))}`;
}

async function verifyPassword(password, encoded) {
  const [scheme, iterationsRaw, saltRaw, hashRaw] = String(encoded).split("$");
  if (scheme !== "pbkdf2_sha256" || !iterationsRaw || !saltRaw || !hashRaw) return false;
  const iterations = Number(iterationsRaw);
  const salt = fromBase64Url(saltRaw);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return constantTimeEqual(base64Url(new Uint8Array(bits)), hashRaw);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
