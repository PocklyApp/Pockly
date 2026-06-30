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
const automaticSessionBackfillTurnLimit = 1000;
const defaultSessionTurnWindowLimit = 100;
const maxSessionTurnWindowLimit = 500;
const defaultHostsOnlineCacheMs = 1000;
const defaultTurnPayloadBatchRawBytes = 1024 * 1024;
const defaultEdgeRetentionProfile = "standard";
const defaultHotTurnMaxPayloadBytes = 32 * 1024;
const defaultGlobalHotTurnPruneIntervalMs = 10 * 60 * 1000;
const maxScopedHotTurnPruneSessions = 25;
const defaultSessionEventBatchMs = 200;
const defaultSessionEventBatchMax = 64;
const machineFingerprintPattern = /^[a-f0-9]{32,128}$/i;
const edgeRetentionProfiles = Object.freeze({
  standard: Object.freeze({
    hotTurnsPerSession: 100,
    hotTurnsPerUser: 5_000,
    hotTurnTTLDays: 30,
  }),
  extended: Object.freeze({
    hotTurnsPerSession: 300,
    hotTurnsPerUser: 50_000,
    hotTurnTTLDays: 90,
  }),
  max: Object.freeze({
    hotTurnsPerSession: 300,
    hotTurnsPerUser: 100_000,
    hotTurnTTLDays: 90,
  }),
});
const hostsOnlineCache = new Map();
const turnPayloadBlobPointerVersion = 1;
const primaryPayloadStorageGBMonthUSD = 0.75;
const archivePayloadStorageGBMonthUSD = 0.015;
const globalHotTurnPruneLastRun = new Map();

export async function handleRequest(request, env = {}, ctx = {}) {
  const startedAt = Date.now();
  const telemetryProvider = resolveTelemetryProvider(ctx);
  const costTracker = telemetryProvider ? createEndpointCostTracker() : null;
  const providers = resolveRequestProviders(ctx, costTracker);
  const requestContext = providers
    ? { ...ctx, ...(costTracker ? { costTracker } : {}), providers }
    : (costTracker ? { ...ctx, costTracker } : ctx);
  const response = await routeRequest(request, env, requestContext);
  const telemetry = recordEndpointCostTelemetry(telemetryProvider, request, response, {
    durationMs: Date.now() - startedAt,
    costTracker,
  });
  if (typeof ctx?.waitUntil === "function") ctx.waitUntil(telemetry);
  else void telemetry;
  return response;
}

function resolveTelemetryProvider(ctx = {}) {
  if (ctx?.providers?.telemetryProvider) return ctx.providers.telemetryProvider;
  if (typeof ctx?.providersFactory !== "function") return null;
  return ctx.providersFactory({ telemetryOnly: true })?.telemetryProvider || null;
}

function resolveRequestProviders(ctx = {}, costTracker = null) {
  if (typeof ctx?.providersFactory !== "function") return ctx.providers;
  return ctx.providersFactory({ costTracker });
}

async function routeRequest(request, env = {}, ctx = {}) {
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
    if (path === "/api/daemon/sync") return await daemonSync(request, store, env, requestRuntime.providers);
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
    if (path === "/api/history-usage") return await historyUsage(request, store, url);
    if (path === "/api/push/vapid-public-key") return await getVAPIDPublicKey(request, env);
    if (path === "/api/push/subscriptions") return await pushSubscriptions(request, store, env);
    if (path === "/api/voice/transcriptions") return await transcribeVoice(request, store, env);
    if (path === "/api/feedback") return await submitFeedback(request, store);
    if (path === "/api/sessions") return await listSessions(request, store, env, requestRuntime.providers.telemetryProvider);
    if (path === "/api/sessions/delta") return await listSessionsDelta(request, store, env, url);
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
    if (injectEvents) return await listInjectEvents(request, store, env, requestRuntime.providers, decodeURIComponent(injectEvents[1]), url);

    const sessionTurns = path.match(/^\/api\/sessions\/([^/]+)\/turns$/);
    if (sessionTurns) return await listSessionTurns(request, store, env, requestRuntime.providers, decodeURIComponent(sessionTurns[1]), url);

    const sessionEvents = path.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (sessionEvents) return await listSessionEvents(request, store, requestRuntime.env, requestRuntime.providers, decodeURIComponent(sessionEvents[1]), url);

    const sessionCatalogItem = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionCatalogItem) return await getSessionCatalogItem(request, store, decodeURIComponent(sessionCatalogItem[1]), url);

    const sessionPrefs = path.match(/^\/api\/sessions\/([^/]+)\/prefs$/);
    if (sessionPrefs) return await setSessionPrefs(request, store, decodeURIComponent(sessionPrefs[1]));

    const sessionOpened = path.match(/^\/api\/sessions\/([^/]+)\/opened$/);
    if (sessionOpened) return await markSessionOpened(request, store, env, decodeURIComponent(sessionOpened[1]));

    const sessionAction = path.match(/^\/api\/sessions\/([^/]+)\/(inject|sync|agent-settings|diff|delete|reveal)$/);
    if (sessionAction) return await sessionControlAction(request, store, env, requestRuntime.providers, decodeURIComponent(sessionAction[1]), sessionAction[2], url);

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
    machine_fingerprint: safeMachineFingerprint(body.machine_fingerprint),
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
    machine_fingerprint: safeMachineFingerprint(body.machine_fingerprint),
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
    machine_fingerprint: safeMachineFingerprint(body.machine_fingerprint) || existing?.machine_fingerprint || null,
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
    machine_fingerprint: safeMachineFingerprint(body.machine_fingerprint),
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
    machine_fingerprint: grant.machine_fingerprint,
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
  if (!device || device.status === "revoked" || device.superseded_by_device_id) {
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
  if (!device || device.status === "revoked" || device.superseded_by_device_id || device.device_id !== challenge.device_id || body.audience !== challenge.audience) {
    return errorResponse("challenge mismatch", ErrorCode.Unauthorized, { status: 401 });
  }
  const verified = await verifyDeviceSignature(device, challengeMessage(challenge), requiredString(body.signature, "signature"));
  if (!verified) return errorResponse("invalid signature", ErrorCode.Unauthorized, { status: 401 });
  await store.consumeDeviceChallenge(challenge.challenge_id, new Date().toISOString());
  const token = await issueDeviceToken(store, device, challenge.audience, new Date());
  return jsonResponse({ verified: true, device_access_token: token });
}

async function daemonSync(request, store, env = {}, providers = {}) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const timings = syncTimings();
  const { user, device } = await requireDeviceAuth(request, store, "daemon");
  timings.mark("auth");
  const body = await readJSON(request);
  timings.mark("read_json");
  if (body.hello?.device_id && body.hello.device_id !== device.device_id) {
    return errorResponse("daemon device mismatch", ErrorCode.Forbidden, { status: 403 });
  }
  const now = new Date().toISOString();
  await store.touchDevice(device.device_id, now);
  timings.mark("touch_device");
  const sessions = Array.isArray(body.sessions) ? body.sessions : [];
  const turns = Array.isArray(body.turns) ? body.turns : [];
  const sessionIDs = sessions.map((session) => String(session?.session_id || "").trim()).filter(Boolean);
  let existingSessionsForBody = null;
  let existingSessionsForDevice = null;
  const getExistingSessionsForDevice = async () => {
    existingSessionsForDevice ??= await listDeviceSessionSyncSnapshots(store, user.user_id, device.device_id);
    return existingSessionsForDevice;
  };
  const getExistingSessionsForBody = async () => {
    if (existingSessionsForBody) return existingSessionsForBody;
    if (body.full_reconcile) {
      existingSessionsForBody = await getExistingSessionsForDevice();
    } else if (typeof store.listDeviceSessionSyncSnapshotsByIDs === "function") {
      existingSessionsForBody = await store.listDeviceSessionSyncSnapshotsByIDs(user.user_id, device.device_id, sessionIDs);
    } else {
      existingSessionsForBody = await listDeviceSessionSyncSnapshots(store, user.user_id, device.device_id);
    }
    return existingSessionsForBody;
  };
  const existingBySessionID = sessions.length > 0
    ? new Map((await getExistingSessionsForBody()).map((session) => [String(session.session_id), session]))
    : new Map();
  const openedBackfillSessionIDs = await openedBackfillSessionIDsForDaemonSync(
    store,
    user.user_id,
    device.device_id,
    sessions,
    existingBySessionID,
    turns,
  );
  const durableSessionIDs = durableDaemonSyncSessionIDs(sessions, existingBySessionID, openedBackfillSessionIDs);
  const durableTurns = turns.filter((turn) => durableSessionIDs.has(String(turn?.session_id ?? "")));
  const receivedTurnStatsBySession = turnStatsBySession(turns);
  const uploadedTurnStatsBySession = turnStatsBySession(durableTurns);
  const turnRecords = durableTurns.map((turn) => syncTurnRecord(user, device, turn, now));
  const turnWrite = await upsertChangedTurns(store, turnRecords, env, providers);
  const changedTurns = turnWrite.changedTurns ?? [];
  const changedTurnStatsBySession = turnStatsBySession(changedTurns);
  const prunedTurnSessions = turnWrite.prunedSessions ?? [];
  timings.mark("upsert_turns");
  let deletedSessionCount = 0;
  let deletedSessions = [];
  if (body.full_reconcile) {
    const keepSessionIDs = sessions.map((session) => String(session.session_id));
    const currentExistingSessions = await getExistingSessionsForDevice();
    const deletedHistoryBlobKeys = await collectMissingSessionHistoryBlobKeys(
      store,
      providers,
      user.user_id,
      device.device_id,
      keepSessionIDs,
      currentExistingSessions,
    );
    if (typeof store.deleteMissingDeviceSessionsFromExisting === "function") {
      deletedSessions = missingDeviceSessions(currentExistingSessions, keepSessionIDs);
      deletedSessionCount = Number(await store.deleteMissingDeviceSessionsFromExisting(user.user_id, device.device_id, keepSessionIDs, currentExistingSessions) ?? 0) || 0;
    } else {
      deletedSessions = missingDeviceSessions(currentExistingSessions, keepSessionIDs);
      deletedSessionCount = Number(await store.deleteMissingDeviceSessions(user.user_id, device.device_id, keepSessionIDs) ?? 0) || 0;
    }
    if (deletedSessionCount > 0) {
      await deleteHistoryBlobsBestEffort(providers, deletedHistoryBlobKeys);
      await appendSessionCatalogChanges(store, deletedSessions.map((session) => ({
        type: "delete",
        user_id: user.user_id,
        device_id: device.device_id,
        session_id: session.session_id,
        session: null,
        at: now,
      })), env);
    }
  }
  timings.mark("reconcile");
  timings.mark("load_existing_sessions");
  let sessionFastPathCount = 0;
  const changedSessionRecords = [];
  const catalogChangedSessionRecords = [];
  const currentSessionRecords = [];
  for (const session of sessions) {
    const sessionID = String(session.session_id);
    const uploadedTurnStats = uploadedTurnStatsBySession.get(sessionID);
    const receivedTurnStats = receivedTurnStatsBySession.get(sessionID);
    const changedTurnStats = changedTurnStatsBySession.get(sessionID);
    const existing = existingBySessionID.get(sessionID) ?? null;
    const durableSession = durableSessionIDs.has(sessionID);
    if (unchangedCatalogSession(device, session, existing, changedTurnStats, durableSession, receivedTurnStats)) {
      sessionFastPathCount += 1;
      if (existing) currentSessionRecords.push(existing);
      continue;
    }
    const record = await syncSessionRecord(
      store,
      user,
      device,
      session,
      now,
      uploadedTurnStats,
      receivedTurnStats,
      changedTurnStats,
      existing,
      durableSession,
    );
    currentSessionRecords.push(record);
    if (!sessionMatchesExisting(record, existing)) {
      changedSessionRecords.push(record);
      if (!sessionCatalogMatchesExisting(record, existing)) catalogChangedSessionRecords.push(record);
    }
  }
  timings.mark("build_session_records");
  const changedSessionCount = changedSessionRecords.length;
  timings.mark("filter_unchanged_sessions");
  if (changedSessionCount > 0) {
    await store.upsertSessions(changedSessionRecords);
    if (catalogChangedSessionRecords.length > 0) {
      await appendSessionCatalogChanges(store, catalogChangedSessionRecords.map((session) => ({
        type: "upsert",
        user_id: user.user_id,
        device_id: session.device_id,
        session_id: session.session_id,
        session,
        at: now,
      })), env);
    }
  }
  await deleteSessionOpenHintsBestEffort(store, user.user_id, device.device_id, openedBackfillSessionIDs);
  const repairedPrunedSessions = await repairPrunedTurnSessions(
    store,
    user,
    device,
    prunedTurnSessions,
    new Set(changedSessionRecords.map((session) => String(session.session_id))),
    now,
    env,
  );
  timings.mark("upsert_sessions");
  const currentSessionsForWindows = repairedPrunedSessions.length
    ? mergeSessionRecordsByID(currentSessionRecords, repairedPrunedSessions)
    : currentSessionRecords;
  const knownWindowSessions = turns.length === 0
    ? await loadKnownWindowSessions(store, user.user_id, device.device_id, body.known_window_session_ids)
    : filterKnownWindowSessions(currentSessionsForWindows, body.known_window_session_ids);
  const knownWindows = turns.length === 0
    ? await knownSessionWindows(store, user.user_id, device.device_id, knownWindowSessions)
    : [];
  return jsonResponse({
    ok: true,
    session_count: sessions.length,
    session_upsert_count: changedSessionCount,
    session_repair_count: repairedPrunedSessions.length,
    session_delete_count: deletedSessionCount,
    session_fast_path_count: sessionFastPathCount,
    turn_count: changedTurns.length,
    received_turn_count: turns.length,
    daemon_device: device.device_id,
    daemon_version: body.hello?.version ?? "",
    timings_ms: timings.finish(),
    ...(knownWindows.length ? { known_windows: knownWindows } : {}),
  });
}

function mergeSessionRecordsByID(base = [], updates = []) {
  const byID = new Map(base.map((session) => [String(session.session_id), session]));
  for (const session of updates) byID.set(String(session.session_id), session);
  return [...byID.values()];
}

function missingDeviceSessions(existingSessions, keepSessionIDs) {
  const keep = new Set(keepSessionIDs.map((id) => String(id)));
  return existingSessions.filter((session) => !keep.has(String(session.session_id)));
}

function turnStatsBySession(turns = []) {
  const out = new Map();
  for (const turn of turns) {
    const sessionID = String(turn?.session_id ?? "");
    const seq = Number(turn?.seq ?? 0) || 0;
    if (!sessionID) continue;
    const stats = out.get(sessionID) || { count: 0, min_seq: 0, max_seq: 0 };
    stats.count += 1;
    if (seq > 0) {
      stats.min_seq = stats.min_seq > 0 ? Math.min(stats.min_seq, seq) : seq;
      stats.max_seq = Math.max(stats.max_seq, seq);
    }
    out.set(sessionID, stats);
  }
  return out;
}

async function openedBackfillSessionIDsForDaemonSync(store, userID, deviceID, sessions = [], existingBySessionID = new Map(), turns = []) {
  if (!turns.length || !sessions.length) return new Set();
  const candidates = new Set();
  for (const session of sessions) {
    const sessionID = String(session?.session_id ?? "");
    if (!sessionID) continue;
    const existing = existingBySessionID.get(sessionID);
    if (!existing || Number(existing.synced_turn_count ?? 0) > 0) continue;
    const total = Number(session?.turn_count ?? session?.last_seq ?? 0) || 0;
    const maxSeq = Number(session?.max_seq ?? 0) || 0;
    if (total > 0 && maxSeq > 0 && maxSeq >= total) candidates.add(sessionID);
  }
  if (!candidates.size) return new Set();
  const hints = await listSessionOpenHintsForDevice(store, userID, deviceID);
  if (!hints.length) return new Set();
  const cutoff = Date.now() - recentlyOpenedSyncHintMs;
  const recentlyOpened = new Set();
  for (const hint of hints) {
    const opened = Date.parse(hint.last_opened_at || "");
    if (Number.isFinite(opened) && opened >= cutoff) recentlyOpened.add(String(hint.session_id));
  }
  if (!recentlyOpened.size) return new Set();
  const out = new Set([...candidates].filter((sessionID) => recentlyOpened.has(sessionID)));
  return out;
}

async function deleteSessionOpenHintsBestEffort(store, userID, deviceID, sessionIDs = new Set()) {
  if (!sessionIDs?.size || typeof store.deleteSessionOpenHint !== "function") return;
  await Promise.all([...sessionIDs].map((sessionID) =>
    store.deleteSessionOpenHint(userID, deviceID, sessionID).catch(() => undefined),
  ));
}

function durableDaemonSyncSessionIDs(sessions = [], existingBySessionID = new Map(), openedBackfillSessionIDs = new Set()) {
  const out = new Set();
  for (const session of sessions) {
    const sessionID = String(session?.session_id ?? "");
    if (!sessionID) continue;
    if (daemonSyncSessionIsDurable(session, existingBySessionID.get(sessionID) ?? null, openedBackfillSessionIDs.has(sessionID))) out.add(sessionID);
  }
  return out;
}

function daemonSyncSessionIsDurable(session, existing = null, openedBackfill = false) {
  const total = Number(session?.turn_count ?? session?.last_seq ?? 0) || 0;
  const maxSeq = Number(session?.max_seq ?? 0) || 0;
  if (total <= 0 || maxSeq <= 0) return true;
  // Only the latest contiguous tail belongs in the durable hot cache. Older
  // backfill windows are delivered through request-scoped control events or
  // future archive storage; writing them here causes D1 insert-then-prune
  // amplification on large sessions.
  if (maxSeq < total) return false;
  if (!existing) return true;
  const existingSynced = Number(existing.synced_turn_count ?? 0) || 0;
  // Existing catalog-only sessions are historical placeholders. Opening one may
  // ask the daemon for its latest local tail, but that backfill should not enter
  // the durable hot cache until an active/newer sync advances the session.
  if (openedBackfill && existingSynced <= 0) return false;
  return true;
}

function filterKnownWindowSessions(sessions = [], requestedSessionIDs) {
  if (!Array.isArray(requestedSessionIDs)) return [];
  const wanted = new Set(requestedSessionIDs.map((id) => String(id || "").trim()).filter(Boolean));
  if (!wanted.size) return [];
  return sessions.filter((session) => wanted.has(String(session?.session_id || "")));
}

async function loadKnownWindowSessions(store, userID, deviceID, requestedSessionIDs) {
  if (!Array.isArray(requestedSessionIDs) || requestedSessionIDs.length === 0) return [];
  const seen = new Set();
  const ids = [];
  for (const rawID of requestedSessionIDs) {
    const sessionID = String(rawID || "").trim();
    if (!sessionID || seen.has(sessionID)) continue;
    seen.add(sessionID);
    ids.push(sessionID);
  }
  if (!ids.length) return [];
  if (typeof store.listDeviceSessionSyncSnapshotsByIDs === "function") {
    const rows = await store.listDeviceSessionSyncSnapshotsByIDs(userID, deviceID, ids);
    const byID = new Map(rows.map((session) => [String(session.session_id), session]));
    return ids.map((sessionID) => byID.get(sessionID)).filter(Boolean);
  }
  const out = [];
  for (const sessionID of ids) {
    const session = await store.getSession(userID, deviceID, sessionID);
    if (session) out.push(session);
  }
  return out;
}

async function appendSessionCatalogChanges(store, changes, env = null) {
  const rows = coalescedCatalogChanges(changes).map((change) => ({
    user_id: change.user_id,
    device_id: change.device_id,
    session_id: change.session_id,
    change_type: change.type,
    session_row: change.session ? publicCatalogChangeSessionRow(change.session) : null,
    created_at: change.at,
  }));
  if (rows.length === 0) return;
  if (typeof store.appendSessionCatalogChanges === "function") {
    await store.appendSessionCatalogChanges(rows);
    await notifySessionCatalogChanged(env, rows);
    return;
  }
  if (typeof store.appendSessionCatalogChange !== "function") return;
  for (const row of rows) await store.appendSessionCatalogChange(row);
  await notifySessionCatalogChanged(env, rows);
}

function coalescedCatalogChanges(changes = []) {
  const bySession = new Map();
  for (const change of changes) {
    const key = `${change.user_id}\x00${change.device_id}\x00${change.session_id}`;
    bySession.set(key, change);
  }
  return [...bySession.values()];
}

async function notifySessionCatalogChanged(env, rows) {
  if (!env || !browserRealtimeEnabled(env) || !rows?.length) return;
  const byUser = new Map();
  for (const row of rows) {
    const userID = String(row.user_id || "");
    if (!userID) continue;
    const entry = byUser.get(userID) ?? { userID, sessionIDs: new Set(), deviceIDs: new Set() };
    if (row.session_id) entry.sessionIDs.add(String(row.session_id));
    if (row.device_id) entry.deviceIDs.add(String(row.device_id));
    byUser.set(userID, entry);
  }
  for (const entry of byUser.values()) {
    try {
      const control = createControlHubForUser(env, entry.userID);
      if (typeof control?.broadcastSessionCatalogChanged !== "function") continue;
      control.broadcastSessionCatalogChanged({
        userID: entry.userID,
        session_ids: [...entry.sessionIDs],
        device_ids: [...entry.deviceIDs],
        reason: "daemon_sync",
      });
    } catch {
      // Realtime catalog hints are best-effort; /api/sessions/delta remains
      // the authoritative recovery path.
    }
  }
}

function publicCatalogChangeSessionRow(session) {
  return {
    user_id: session.user_id,
    computer_id: session.computer_id ?? null,
    device_id: session.device_id,
    session_id: session.session_id,
    agent: session.agent,
    runner_alias: session.runner_alias ?? null,
    cwd: session.cwd ?? "",
    snippet: session.snippet ?? "",
    first_message: session.first_message ?? "",
    title: session.title ?? null,
    last_seq: Number(session.last_seq ?? 0),
    last_timestamp: session.last_timestamp ?? null,
    channel_last_seen_at: session.channel_last_seen_at ?? null,
    sync_state: session.sync_state ?? "catalog_only",
    turn_count: Number(session.turn_count ?? 0),
    last_sync_error: session.last_sync_error ?? "",
    synced_turn_count: Number(session.synced_turn_count ?? 0),
    synced_min_seq: Number(session.synced_min_seq ?? 0),
    synced_max_seq: Number(session.synced_max_seq ?? 0),
    has_older_turns: Boolean(session.has_older_turns),
    updated_at: session.updated_at,
  };
}

function syncTimings() {
  const start = performance.now();
  let prev = start;
  const steps = {};
  return {
    mark(name) {
      const now = performance.now();
      steps[name] = Math.round((now - prev) * 1000) / 1000;
      prev = now;
    },
    finish() {
      const now = performance.now();
      steps.total = Math.round((now - start) * 1000) / 1000;
      return steps;
    },
  };
}

function sessionMatchesExisting(session, existing) {
  if (!existing) return false;
  const checks = [
    ["computer_id", stringOrNull],
    ["agent", stringOrEmpty],
    ["runner_alias", stringOrNull],
    ["cwd", stringOrEmpty],
    ["snippet", stringOrEmpty],
    ["first_message", stringOrEmpty],
    ["title", stringOrNull],
    ["last_seq", numberValue],
    ["last_timestamp", stringOrNull],
    ["channel_last_seen_at", stringOrNull],
    ["sync_state", stringOrNull],
    ["turn_count", numberValue],
    ["last_sync_error", stringOrNull],
    ["synced_turn_count", numberValue],
    ["actual_turn_count", numberValue],
    ["synced_min_seq", numberValue],
    ["synced_max_seq", numberValue],
    ["synced_window_hash", stringOrEmpty],
    ["latest_contiguous_min_seq", numberValue],
    ["has_older_turns", boolIntValue],
  ];
  return checks.every(([field, normalize]) => normalize(session[field]) === normalize(existing[field]));
}

function sessionCatalogMatchesExisting(session, existing) {
  if (!existing) return false;
  const checks = [
    ["computer_id", stringOrNull],
    ["agent", stringOrEmpty],
    ["runner_alias", stringOrNull],
    ["cwd", stringOrEmpty],
    ["snippet", stringOrEmpty],
    ["first_message", stringOrEmpty],
    ["title", stringOrNull],
    ["last_seq", numberValue],
    ["last_timestamp", stringOrNull],
    ["channel_last_seen_at", stringOrNull],
    ["sync_state", stringOrNull],
    ["turn_count", numberValue],
    ["last_sync_error", stringOrNull],
    ["synced_turn_count", numberValue],
    ["synced_min_seq", numberValue],
    ["synced_max_seq", numberValue],
    ["has_older_turns", boolIntValue],
  ];
  return checks.every(([field, normalize]) => normalize(session[field]) === normalize(existing[field]));
}

function unchangedCatalogSession(device, session, existing, changedTurnStats, durableSession = true, receivedTurnStats = null) {
  if (!existing) return false;
  if (Number(changedTurnStats?.count ?? 0) > 0) return false;
  if (!durableSession && Number(receivedTurnStats?.count ?? 0) > 0) return true;
  const maxSeq = Number(session.max_seq ?? session.last_seq ?? 0);
  const lastTimestamp = session.last_timestamp || "";
  const windowHash = String(session.window_hash || "");
  const minSeq = Number(session.min_seq ?? 0) || 0;
  if (
    windowHash &&
    minSeq > 0 &&
    maxSeq >= minSeq &&
    (
      String(existing.synced_window_hash || "") !== windowHash ||
      Number(existing.synced_min_seq ?? 0) !== minSeq ||
      Number(existing.synced_max_seq ?? 0) !== maxSeq
    )
  ) {
    return false;
  }
  const expected = {
    computer_id: device.computer_id ?? null,
    agent: session.agent || "claude-code",
    runner_alias: session.runner_alias || "",
    cwd: session.cwd || "",
    snippet: session.snippet || session.first_message || "",
    first_message: session.first_message ?? existing?.first_message ?? "",
    title: session.title || "",
    last_seq: Number(session.last_seq ?? maxSeq),
    last_timestamp: lastTimestamp || null,
    channel_last_seen_at: session.channel_last_seen_at || existing.channel_last_seen_at || lastTimestamp || null,
    turn_count: Number(session.turn_count ?? 0),
    last_sync_error: "",
  };
  const checks = [
    ["computer_id", stringOrNull],
    ["agent", stringOrEmpty],
    ["runner_alias", stringOrNull],
    ["cwd", stringOrEmpty],
    ["snippet", stringOrEmpty],
    ["first_message", stringOrEmpty],
    ["title", stringOrNull],
    ["last_seq", numberValue],
    ["last_timestamp", stringOrNull],
    ["channel_last_seen_at", stringOrNull],
    ["turn_count", numberValue],
    ["last_sync_error", stringOrNull],
  ];
  return checks.every(([field, normalize]) => normalize(expected[field]) === normalize(existing[field]));
}

function stringOrEmpty(value) {
  return value == null ? "" : String(value);
}

function stringOrNull(value) {
  return value == null ? null : String(value);
}

function numberValue(value) {
  return Number(value ?? 0) || 0;
}

function boolIntValue(value) {
  return value ? 1 : 0;
}

async function listDeviceSessions(store, userID, deviceID) {
  if (typeof store.listDeviceSessions === "function") return await store.listDeviceSessions(userID, deviceID);
  const sessions = await store.listSessionsForUser(userID);
  return sessions.filter((session) => String(session.device_id) === String(deviceID));
}

async function listDeviceSessionSyncSnapshots(store, userID, deviceID) {
  if (typeof store.listDeviceSessionSyncSnapshots === "function") {
    return await store.listDeviceSessionSyncSnapshots(userID, deviceID);
  }
  return await listDeviceSessions(store, userID, deviceID);
}

async function listDeviceSessionHintSnapshots(store, userID, deviceID) {
  if (typeof store.listDeviceSessionHintSnapshots === "function") {
    return await store.listDeviceSessionHintSnapshots(userID, deviceID);
  }
  return await listDeviceSessions(store, userID, deviceID);
}

async function daemonSyncHints(request, store) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user, device } = await requireDeviceAuth(request, store, "daemon");
  const [sessions, prefs, openHints] = await Promise.all([
    listDeviceSessionHintSnapshots(store, user.user_id, device.device_id),
    listSessionPrefsForDevice(store, user.user_id, device.device_id),
    listSessionOpenHintsForDevice(store, user.user_id, device.device_id),
  ]);
  const sessionIDs = new Set(
    sessions
      .map((session) => String(session.session_id)),
  );
  const sessionsByID = new Map(
    sessions
      .map((session) => [String(session.session_id), session]),
  );
  const cutoff = Date.now() - recentlyOpenedSyncHintMs;
  const hintsBySessionID = new Map();
  for (const pref of prefs) {
    if (!sessionIDs.has(String(pref.session_id))) continue;
    if (!pref.pinned) continue;
    hintsBySessionID.set(String(pref.session_id), {
      ...sessionSyncHintPayload(sessionsByID.get(String(pref.session_id)), String(pref.session_id)),
      reason: "pinned",
      preferred_min: prioritySyncHintTurnLimit,
    });
  }
  for (const hint of openHints) {
    if (!sessionIDs.has(String(hint.session_id)) || hintsBySessionID.has(String(hint.session_id))) continue;
    const opened = Date.parse(hint.last_opened_at || "");
    if (!Number.isFinite(opened) || opened < cutoff) continue;
    const session = sessionsByID.get(String(hint.session_id));
    if (isLargeSessionForAutomaticBackfill(session)) continue;
    hintsBySessionID.set(String(hint.session_id), {
      ...sessionSyncHintPayload(session, String(hint.session_id)),
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
    const windowHash = await sessionWindowHash(store, user.user_id, device.device_id, String(hint.session_id), sessionWithStats);
    hints.push({
      ...hint,
      ...sessionSyncHintPayload(sessionWithStats, String(hint.session_id)),
      ...(windowHash ? { window_hash: windowHash } : {}),
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

async function listSessionPrefsForDevice(store, userID, deviceID) {
  if (typeof store.listSessionPrefsForDevice === "function") {
    return await store.listSessionPrefsForDevice(userID, deviceID);
  }
  return (await store.listSessionPrefsForUser(userID)).filter((pref) => String(pref.device_id) === String(deviceID));
}

async function listSessionOpenHintsForDevice(store, userID, deviceID) {
  if (typeof store.listSessionOpenHintsForDevice === "function") {
    return await store.listSessionOpenHintsForDevice(userID, deviceID);
  }
  return (await store.listSessionOpenHintsForUser(userID)).filter((hint) => String(hint.device_id) === String(deviceID));
}

async function listSessions(request, store, env, telemetryProvider = null) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store);
  const sessions = await store.listSessionsForUser(user.user_id);
  const devices = new Map((await store.listDevicesForUser(user.user_id)).map((device) => [device.device_id, device]));
  const daemonDeviceIDs = uniqueDaemonDeviceIDs(sessions, devices);
  const rows = [];
  for (const session of sessions) {
    rows.push(publicSession(session, devices.get(session.device_id), false));
  }
  void recordPresenceTelemetry(telemetryProvider, request, {
    command: "sessions",
    presence_source: daemonDeviceIDs.length > 0 ? "device_last_seen" : "none",
    sessions_count: sessions.length,
    unique_daemon_count: daemonDeviceIDs.length,
    presence_batch_size: 0,
  });
  return jsonResponse({ sessions: rows });
}

async function listSessionsDelta(request, store, env, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store);
  const limit = sessionCatalogDeltaLimit(url.searchParams);
  const since = String(url.searchParams.get("since") ?? "");
  if (!since) {
    const pageCursor = url.searchParams.get("page_cursor");
    return await sessionCatalogInitialPageResponse(
      store,
      user.user_id,
      limit,
      pageCursor,
      pageCursor ? {} : { reset: true },
    );
  }
  if (typeof store.listSessionCatalogChanges !== "function") {
    return errorResponse("session catalog delta unavailable", ErrorCode.NotSupported, { status: 501 });
  }
  if (await sessionCatalogCursorExpired(store, user.user_id, since)) {
    return await sessionCatalogInitialPageResponse(store, user.user_id, limit, "", { reset: true });
  }
  const changes = await store.listSessionCatalogChanges(user.user_id, { since, limit: limit + 1 });
  const page = changes.slice(0, limit);
  const hasMore = changes.length > limit;
  const upsertRows = [];
  const deletes = [];
  for (const change of page) {
    const type = String(change.change_type || "");
    if (type === "delete") {
      deletes.push({
        device_id: change.device_id,
        session_id: change.session_id,
      });
      continue;
    }
    const row = parsePayload(change.session_row);
    if (row && typeof row === "object") upsertRows.push(row);
  }
  return jsonResponse({
    // Catalog deltas are a data-plane API. Realtime daemon presence is served
    // by /api/hosts/online and projected client-side, so large catalog paging
    // does not wake the realtime coordinator once per page.
    upserts: upsertRows.map(publicCatalogSession),
    deletes,
    next_cursor: page[page.length - 1]?.change_id || since,
    has_more: hasMore,
  });
}

async function getSessionCatalogItem(request, store, sessionID, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store);
  const deviceID = url.searchParams.get("device_id") ?? "";
  if (!deviceID) return errorResponse("device_id is required", ErrorCode.BadRequest, { status: 400 });
  const session = await store.getSession(user.user_id, deviceID, sessionID);
  if (!session) return errorResponse("session not found", ErrorCode.NotFound, { status: 404 });
  return jsonResponse({ session: publicCatalogSession(session) });
}

async function sessionCatalogInitialPageResponse(store, userID, limit, rawPageCursor, extra = {}) {
  const pageCursor = parseSessionCatalogPageCursor(rawPageCursor);
  const cursor = typeof store.currentSessionCatalogCursor === "function"
    ? await store.currentSessionCatalogCursor(userID)
    : "";
  const sessions = typeof store.listSessionCatalogPage === "function"
    ? await store.listSessionCatalogPage(userID, { limit: limit + 1, after: pageCursor })
    : pageSessionCatalogRows(await store.listSessionsForUser(userID), { limit: limit + 1, after: pageCursor });
  const page = sessions.slice(0, limit);
  const hasMore = sessions.length > limit;
  return jsonResponse({
    upserts: page.map(publicCatalogSession),
    deletes: [],
    next_cursor: cursor,
    next_page_cursor: hasMore ? encodeSessionCatalogPageCursor(page[page.length - 1]) : "",
    has_more: hasMore,
    ...extra,
  });
}

async function sessionCatalogCursorExpired(store, userID, since) {
  if (!since || since === "sc_0000000000000_000000_000000") return false;
  if (typeof store.sessionCatalogCursorBounds !== "function") return false;
  const bounds = await store.sessionCatalogCursorBounds(userID);
  return Boolean(bounds.oldest && since < bounds.oldest);
}

function sessionCatalogDeltaLimit(params) {
  const parsed = Number(params.get("limit") ?? 50);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(200, Math.max(1, Math.floor(parsed)));
}

function pageSessionCatalogRows(sessions, options = {}) {
  const after = options.after ?? null;
  return sessions
    .filter((session) => !after || sessionCatalogRowAfterCursor(session, after))
    .slice(0, options.limit ?? sessions.length);
}

function encodeSessionCatalogPageCursor(session) {
  if (!session) return "";
  return base64Url(new TextEncoder().encode(JSON.stringify({
    updated_at: String(session.updated_at || ""),
    device_id: String(session.device_id || ""),
    session_id: String(session.session_id || ""),
  })));
}

function parseSessionCatalogPageCursor(value) {
  const raw = String(value || "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(raw)));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      updated_at: String(parsed.updated_at || ""),
      device_id: String(parsed.device_id || ""),
      session_id: String(parsed.session_id || ""),
    };
  } catch {
    return null;
  }
}

function sessionCatalogRowAfterCursor(session, cursor) {
  const updatedAt = String(session.updated_at || "");
  if (updatedAt !== cursor.updated_at) return updatedAt < cursor.updated_at;
  const deviceID = String(session.device_id || "");
  if (deviceID !== cursor.device_id) return deviceID > cursor.device_id;
  return String(session.session_id || "") > cursor.session_id;
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
  const session = await sessionWithTurnStats(store, user.user_id, deviceID, sessionID);
  if (isLargeSessionForAutomaticBackfill(session)) {
    return jsonResponse({
      device_id: deviceID,
      session_id: sessionID,
      last_opened_at: openedAt,
    });
  }
  const hint = await store.upsertSessionOpenHint({
    user_id: user.user_id,
    device_id: deviceID,
    session_id: sessionID,
    last_opened_at: openedAt,
    updated_at: new Date().toISOString(),
  });
  await pushSyncHintToDaemon(env, store, user.user_id, deviceID, sessionID, session);
  return jsonResponse({
    device_id: hint.device_id,
    session_id: hint.session_id,
    last_opened_at: hint.last_opened_at,
  });
}

function isLargeSessionForAutomaticBackfill(session) {
  const total = Number(session?.turn_count ?? session?.last_seq ?? 0) || 0;
  const loaded = Number(session?.synced_turn_count ?? 0) || 0;
  return total > automaticSessionBackfillTurnLimit && loaded < total;
}

// Nudge the daemon over its already-open control WS so the opened session's
// lazy backfill starts immediately. Outgoing WebSocket messages are not billed,
// so pushing replaces the daemon-side hint polling loop as the default
// transport. Best-effort: an offline daemon falls back to the persisted open
// hint (consumed by the optional poll) and the regular sync flow.
async function pushSyncHintToDaemon(env, store, userID, daemonDeviceID, sessionID, session) {
  try {
    const control = createControlHubForUser(env, userID);
    const windowHash = await sessionWindowHash(store, userID, daemonDeviceID, sessionID, session);
    await control.dispatch(daemonDeviceID, {
      type: "SYNC_HINT",
      sync_hint: {
        ...sessionSyncHintPayload(session, sessionID),
        ...(windowHash ? { window_hash: windowHash } : {}),
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

async function listSessionTurns(request, store, env, providers, sessionID, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store);
  const deviceID = url.searchParams.get("device_id") ?? "";
  if (!deviceID) return errorResponse("device_id is required", ErrorCode.BadRequest, { status: 400 });
  const limit = sessionTurnsWindowLimit(url.searchParams);
  const beforeSeq = Number(url.searchParams.get("before_seq") ?? 0) || 0;
  const afterSeq = Number(url.searchParams.get("after_seq") ?? 0) || 0;
  if (afterSeq > 0) {
    return await listSessionTurnsAfterSeq(store, providers, user.user_id, deviceID, sessionID, afterSeq, limit);
  }
  const session = await sessionWithTurnStats(store, user.user_id, deviceID, sessionID, { repairMetadata: true });
  if (!session) return errorResponse("session not found", ErrorCode.NotFound, { status: 404 });
  const turns = await store.listTurns(user.user_id, deviceID, sessionID, {
    ...(limit > 0 ? { limit } : {}),
    ...(beforeSeq > 0 ? { beforeSeq } : {}),
  });
  const parsedTurns = await publicTurns(turns, providers);
  const stats = {
    count: Number(session.actual_turn_count ?? session.synced_turn_count ?? 0) || 0,
    min_seq: Number(session.synced_min_seq ?? 0) || 0,
    max_seq: Number(session.synced_max_seq ?? 0) || 0,
    latest_contiguous_min_seq: Number(session.latest_contiguous_min_seq ?? session.synced_min_seq ?? 0) || 0,
  };
  const syncedTurnCount = stats.count;
  const syncedMinSeq = Number(stats.min_seq ?? 0) || 0;
  const syncedMaxSeq = Number(stats.max_seq ?? 0) || 0;
  const totalTurnCount = Number(session.turn_count ?? parsedTurns.length);
  const oldestLoadedSeq = Number(parsedTurns[0]?.seq ?? 0) || 0;
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
    source: "remote_hot_window",
    oldest_seq: parsedTurns[0]?.seq,
    latest_seq: parsedTurns[parsedTurns.length - 1]?.seq,
    window_limit: limit,
    ...(afterSeq > 0 ? { after_seq: afterSeq } : {}),
    next_loaded_before_seq: oldestLoadedSeq > syncedMinSeq ? oldestLoadedSeq : 0,
    synced_turn_count: syncedTurnCount,
    synced_min_seq: syncedMinSeq,
    synced_max_seq: syncedMaxSeq,
    latest_contiguous_min_seq: latestContiguousMinSeq,
    next_before_seq: nextBeforeSeq,
    total_turn_count: totalTurnCount,
    has_older_turns: Boolean(session.has_older_turns || totalTurnCount > syncedTurnCount || (totalTurnCount > 0 && syncedMinSeq > 1)),
    needs_sync: parsedTurns.length === 0 && (session.turn_count ?? 0) > 0,
  });
}

async function listSessionTurnsAfterSeq(store, providers, userID, deviceID, sessionID, afterSeq, limit) {
  const session = await store.getSession(userID, deviceID, sessionID);
  if (!session) return errorResponse("session not found", ErrorCode.NotFound, { status: 404 });
  const turns = await store.listSessionTurnsAfter(userID, deviceID, sessionID, afterSeq, limit);
  const parsedTurns = await publicTurns(turns, providers);
  const syncedTurnCount = Number(session.synced_turn_count ?? 0) || 0;
  const syncedMinSeq = Number(session.synced_min_seq ?? 0) || 0;
  const syncedMaxSeq = Number(session.synced_max_seq ?? 0) || 0;
  const totalTurnCount = Number(session.turn_count ?? session.last_seq ?? syncedTurnCount) || 0;
  return jsonResponse({
    session_id: sessionID,
    turns: parsedTurns,
    source: "remote_hot_window",
    oldest_seq: parsedTurns[0]?.seq,
    latest_seq: parsedTurns[parsedTurns.length - 1]?.seq,
    window_limit: limit,
    after_seq: afterSeq,
    synced_turn_count: syncedTurnCount,
    synced_min_seq: syncedMinSeq,
    synced_max_seq: syncedMaxSeq,
    latest_contiguous_min_seq: Number(session.latest_contiguous_min_seq ?? syncedMinSeq) || 0,
    total_turn_count: totalTurnCount,
    has_older_turns: Boolean(session.has_older_turns || (totalTurnCount > 0 && syncedMinSeq > 1)),
  });
}

function sessionTurnsWindowLimit(params) {
  const value = params.get("limit");
  const full = params.get("full") === "1" || params.get("full") === "true";
  if (full && value === "0") return 0;
  if (value === null || value === undefined || value === "") return defaultSessionTurnWindowLimit;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultSessionTurnWindowLimit;
  return Math.min(maxSessionTurnWindowLimit, Math.max(1, Math.floor(parsed)));
}

async function listSessionEvents(request, store, env, providers, sessionID, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const deviceID = requiredString(url.searchParams.get("device_id") ?? "", "device_id");
  const session = await store.getSession(user.user_id, deviceID, sessionID);
  if (!session) return errorResponse("session not found", ErrorCode.NotFound, { status: 404 });
  const control = createControlHubForUser(env, user.user_id);
  return jsonResponse(await sessionEventsResponse(store, providers, user.user_id, deviceID, sessionID, {
    after: url.searchParams.get("after") ?? "",
    after_seq: url.searchParams.get("after_seq") ?? "",
    request_id: url.searchParams.get("request_id") ?? "",
    limit: url.searchParams.get("limit") ?? "",
  }, control));
}

async function listInjectEvents(request, store, env, providers, requestID, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store, "browser", "browser-ws");
  const control = createControlHubForUser(env, user.user_id);
  return jsonResponse(await sessionEventsResponse(store, providers, user.user_id, "", "", {
    after: url.searchParams.get("after") ?? "",
    request_id: requestID,
    limit: url.searchParams.get("limit") ?? "",
  }, control));
}

async function sessionEventsResponse(store, providers, userID, deviceID, sessionID, options = {}, control = null) {
  const events = await store.listSessionEvents(userID, deviceID, sessionID, options);
  const transientEvents = await listTransientSessionEventsBestEffort(control, userID, deviceID, sessionID, options);
  const publicEvents = mergeTransientSessionEvents(
    events.map(publicSessionEvent),
    transientEvents,
  );
  const response = {
    events: publicEvents,
    next_cursor: persistedEventCursor(publicEvents) || String(options.after || ""),
  };
  // Session-scoped polls carry stable turns from session_turns plus active
  // stream deltas from the short-lived control cache. Stream deltas are not
  // durable remote history; the final completed block is persisted separately.
  if (deviceID && sessionID && options.after_seq !== undefined && options.after_seq !== "") {
    const afterSeq = Number(options.after_seq) || 0;
    const turns = await store.listSessionTurnsAfter(userID, deviceID, sessionID, afterSeq, options.limit);
    const mergedTurns = mergeSessionTurnsWithTransientTurns(turns, transientEvents, afterSeq, options.limit);
    response.turns = await publicTurns(mergedTurns, providers);
    response.next_seq = mergedTurns.length > 0 ? Number(mergedTurns[mergedTurns.length - 1].seq) : afterSeq;
  }
  return response;
}

async function listTransientSessionEventsBestEffort(control, userID, deviceID, sessionID, options) {
  if (typeof control?.listTransientSessionEvents !== "function") return [];
  try {
    return await control.listTransientSessionEvents(userID, deviceID, sessionID, options);
  } catch {
    // Transient events carry request-scoped old-history windows and active
    // stream deltas for the current page. Persisted lifecycle events and final
    // durable turns remain the source of truth; a cache miss must not turn
    // polling into a hard 500.
    return [];
  }
}

function mergeTransientSessionEvents(persistedEvents, transientEvents) {
  if (!Array.isArray(transientEvents) || transientEvents.length === 0) return persistedEvents;
  const eventPayloads = transientEvents;
  const byRequestID = new Map();
  for (const event of eventPayloads) {
    const key = sessionEventMergeKey(event);
    if (key) byRequestID.set(key, event);
  }
  if (!byRequestID.size) return persistedEvents;
  const merged = persistedEvents.map((event) => {
    const key = sessionEventMergeKey(event);
    const transient = byRequestID.get(key);
    if (!transient) return event;
    byRequestID.delete(key);
    return {
      ...event,
      payload: transient.payload,
    };
  });
  for (const transient of byRequestID.values()) {
    if (isTransientSingleTurnEvent(transient)) continue;
    merged.push(publicTransientSessionEvent(transient));
  }
  return merged;
}

function sessionEventMergeKey(event) {
  const requestID = String(event?.request_id || event?.payload?.request_id || "");
  if (!requestID) return "";
  const type = String(event?.type || event?.payload?.type || event?.payload?.stage || event?.payload?.status || "");
  return `${requestID}\x00${type}`;
}

function publicTransientSessionEvent(event) {
  return {
    // Do not expose the transient tev_* cursor to clients. Persistent event
    // cursors use ev_*; mixing prefixes can make later persistent events
    // unreachable when clients pass the transient cursor back as "after".
    cursor: "",
    event_id: "",
    request_id: event.request_id || event.payload?.request_id || "",
    device_id: event.device_id || event.payload?.device_id || "",
    session_id: event.session_id || event.payload?.session_id || "",
    type: event.type || event.payload?.type || event.payload?.stage || "",
    created_at: event.created_at || event.payload?.timestamp || "",
    payload: event.payload,
  };
}

function isTransientSingleTurnEvent(event) {
  return Boolean(event?.payload?.turn && typeof event.payload.turn === "object");
}

function mergeSessionTurnsWithTransientTurns(persistedTurns = [], transientEvents = [], afterSeq = 0, limit = "") {
  const max = eventTurnLimit(limit);
  const bySeq = new Map();
  for (const turn of persistedTurns || []) {
    const seq = Number(turn?.seq);
    if (!Number.isFinite(seq) || seq <= afterSeq) continue;
    bySeq.set(seq, turn);
  }
  for (const turn of transientSessionTurns(transientEvents)) {
    const seq = Number(turn?.seq);
    if (!Number.isFinite(seq) || seq <= afterSeq) continue;
    // Stable persisted rows win over transient deltas for the same seq.
    if (!bySeq.has(seq)) bySeq.set(seq, transientTurnRecord(turn));
  }
  return [...bySeq.values()]
    .sort((left, right) => Number(left.seq) - Number(right.seq))
    .slice(0, max);
}

function eventTurnLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultSessionTurnWindowLimit;
  return Math.min(maxSessionTurnWindowLimit, Math.max(1, Math.floor(parsed)));
}

function transientSessionTurns(transientEvents = []) {
  const turns = [];
  for (const event of transientEvents || []) {
    const payload = event?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (Array.isArray(payload.turns)) {
      turns.push(...payload.turns.filter((turn) => turn && typeof turn === "object"));
    }
    if (payload.turn && typeof payload.turn === "object") {
      turns.push(payload.turn);
    }
  }
  return turns;
}

function transientTurnRecord(turn) {
  return {
    device_id: String(turn.device_id || ""),
    session_id: String(turn.session_id || ""),
    seq: Number(turn.seq),
    agent: String(turn.agent || ""),
    kind: String(turn.kind || ""),
    timestamp: String(turn.timestamp || ""),
    payload: turn.payload === undefined || turn.payload === null
      ? null
      : (typeof turn.payload === "string" ? turn.payload : JSON.stringify(turn.payload)),
  };
}

function persistedEventCursor(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const cursor = String(events[index]?.cursor || "");
    if (cursor) return cursor;
  }
  return "";
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
  const release = await daemonReleaseSnapshot(env);
  const devices = await store.listDevicesForUser(user.user_id);
  const daemonDevices = devices.filter((entry) => entry.device_type === "daemon" && entry.status !== "revoked" && !entry.superseded_by_device_id);
  const daemonDeviceIDs = daemonDevices.map((device) => device.device_id);
  const control = daemonDeviceIDs.length > 0 ? createControlHubForUser(env, user.user_id) : null;
  const presenceMap = control
    ? await control.onlineDevices(daemonDeviceIDs).catch(() => ({}))
    : {};
  const activeSessionsByDevice = daemonDeviceIDs.length > 0
    ? await sessionCountsByDevice(store, user.user_id, daemonDeviceIDs)
    : new Map();
  const hosts = [];
  for (const device of daemonDevices) {
    const controlOnline = Boolean(presenceMap?.[device.device_id]);
    hosts.push(withDaemonReleaseInfo(
      publicHost(device, activeSessionsByDevice.get(device.device_id) ?? 0, controlOnline),
      release,
    ));
  }
  if (cacheTTL > 0) {
    hostsOnlineCache.set(cacheKey, {
      fetchedAt: now,
      hosts,
      sessionsCount: sumSessionCounts(activeSessionsByDevice),
      uniqueDaemonCount: daemonDevices.length,
    });
    pruneHostsOnlineCache(now, cacheTTL);
  }
  void recordPresenceTelemetry(telemetryProvider, request, {
    presence_source: daemonDevices.length > 0 ? "batch_control" : "none",
    sessions_count: sumSessionCounts(activeSessionsByDevice),
    unique_daemon_count: daemonDevices.length,
    presence_batch_size: daemonDeviceIDs.length,
  });
  return jsonResponse({ hosts });
}

async function sessionCountsByDevice(store, userID, deviceIDs) {
  if (typeof store.countSessionsByDeviceForUser === "function") {
    return normalizeSessionCountMap(await store.countSessionsByDeviceForUser(userID, deviceIDs));
  }
  const allowed = new Set(deviceIDs.map((id) => String(id)));
  const counts = new Map();
  for (const session of await store.listSessionsForUser(userID)) {
    const deviceID = String(session.device_id || "");
    if (!allowed.has(deviceID)) continue;
    counts.set(deviceID, (counts.get(deviceID) ?? 0) + 1);
  }
  return counts;
}

function normalizeSessionCountMap(value) {
  if (value instanceof Map) {
    return new Map([...value.entries()].map(([key, count]) => [String(key), Number(count) || 0]));
  }
  if (Array.isArray(value)) {
    return new Map(value.map((row) => [String(row.device_id || ""), Number(row.count ?? row.session_count ?? 0) || 0]).filter(([deviceID]) => deviceID));
  }
  if (value && typeof value === "object") {
    return new Map(Object.entries(value).map(([key, count]) => [String(key), Number(count) || 0]));
  }
  return new Map();
}

function sumSessionCounts(counts) {
  let total = 0;
  for (const count of counts.values()) total += Number(count) || 0;
  return total;
}

async function historyUsage(request, store, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireUserFromCookieOrDevice(request, store);
  if (typeof store.getHistoryStorageUsage !== "function") {
    return errorResponse("history_usage_unavailable", ErrorCode.NotSupported, { status: 501 });
  }
  const deviceID = url.searchParams.get("device_id") || "";
  const sessionID = url.searchParams.get("session_id") || "";
  if (!deviceID) return errorResponse("device_id is required", ErrorCode.BadRequest, { status: 400 });
  if (!sessionID) return errorResponse("session_id is required", ErrorCode.BadRequest, { status: 400 });
  const usage = await store.getHistoryStorageUsage(user.user_id, {
    ...(deviceID ? { device_id: deviceID } : {}),
    ...(sessionID ? { session_id: sessionID } : {}),
  });
  return jsonResponse(withHistoryStorageCostEstimate(usage));
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
  const costTracker = ctx.costTracker || null;
  const store = instrumentCostProvider(
    provided.store || env.POCKLY_NEXUS_STORE || env.POCKLY_RELAY_STORE || createStore(env),
    costTracker,
    "store",
  );
  const controlHub = instrumentCostProvider(
    provided.controlHub || env.POCKLY_CONTROL_HUB || null,
    costTracker,
    "control",
  );
  const controlHubFactory = instrumentCostProvider(env.POCKLY_CONTROL_HUB_FACTORY || null, costTracker, "control_factory");
  const providers = createNexusProviderBundle({
    ...provided,
    store,
    controlHub,
    blobStore: instrumentCostProvider(provided.blobStore || env.RELEASES || null, costTracker, "object"),
    historyBlobStore: instrumentCostProvider(provided.historyBlobStore || env.HISTORY_BLOBS || env.POCKLY_HISTORY_BLOBS || null, costTracker, "object"),
    emailProvider: provided.emailProvider || env.POCKLY_EMAIL_PROVIDER || null,
    sttProvider: provided.sttProvider || env.POCKLY_STT_PROVIDER || null,
    pushProvider: provided.pushProvider || env.POCKLY_PUSH_PROVIDER || null,
    telemetryProvider: provided.telemetryProvider || null,
  });
  const runtimeEnv = {
    ...env,
    ...(providers.controlHub ? { POCKLY_CONTROL_HUB: providers.controlHub } : {}),
    ...(!providers.controlHub && controlHubFactory ? { POCKLY_CONTROL_HUB_FACTORY: controlHubFactory } : {}),
    POCKLY_BROWSER_COMMAND_HANDLER: createBrowserRealtimeCommandHandler(requireNexusProvider(providers, "store"), env),
    POCKLY_CONTROL_EVENT_SINK: createSessionEventSink(requireNexusProvider(providers, "store"), {
      persistTerminalEvents: terminalEventCacheEnabled(env),
      env,
      providers,
    }),
    ...(providers.blobStore ? { RELEASES: providers.blobStore } : {}),
    ...(providers.historyBlobStore ? { HISTORY_BLOBS: providers.historyBlobStore } : {}),
    ...(providers.sttProvider ? { POCKLY_STT_PROVIDER: providers.sttProvider } : {}),
    ...(providers.pushProvider ? { POCKLY_PUSH_PROVIDER: providers.pushProvider } : {}),
  };
  return {
    providers,
    env: runtimeEnv,
    store: requireNexusProvider(providers, "store"),
  };
}

export function createBrowserRealtimeCommandHandler(store, env = {}) {
  return async ({ userID, browserDeviceID, message }) => {
    const command = String(message?.command || "");
    const requestID = requiredString(String(message?.request_id || ""), "request_id");
    const payload = message?.payload && typeof message.payload === "object" ? message.payload : {};
    const daemonDeviceID = requiredString(String(message?.daemon_device_id || payload.daemon_device_id || ""), "daemon_device_id");
    const daemon = await requireUserDaemon(store, userID, daemonDeviceID);
    await requireBrowserDaemonBinding(store, userID, daemon.device_id, browserDeviceID);
    if (!daemon.remote_access_enabled) throw new Error("remote access is disabled");

    switch (command) {
      case "inject_session":
        return await buildRealtimeInjectCommand(store, userID, browserDeviceID, daemon, requestID, message, payload);
      case "start_task":
        return buildRealtimeStartTaskCommand(browserDeviceID, daemon, requestID, payload);
      case "sync_session":
        return await buildRealtimeSyncCommand(store, userID, browserDeviceID, daemon, requestID, message, payload);
      case "permission_decide":
        return buildRealtimePermissionCommand(daemon, requestID, payload);
      case "session_opened_hint":
        return await buildRealtimeSessionOpenedHintCommand(store, userID, daemon, requestID, payload);
      case "terminal_create":
        return buildRealtimeTerminalCreate(userID, browserDeviceID, daemon, requestID, payload);
      case "terminal_input":
        return { mode: "terminal_action", action: "input", terminalSessionID: requiredString(String(message.terminal_session_id || payload.terminal_session_id || ""), "terminal_session_id"), text: String(payload.text || "") };
      case "terminal_open":
        return { mode: "terminal_action", action: "open", terminalSessionID: requiredString(String(message.terminal_session_id || payload.terminal_session_id || ""), "terminal_session_id") };
      case "terminal_stop":
        return { mode: "terminal_action", action: "stop", terminalSessionID: requiredString(String(message.terminal_session_id || payload.terminal_session_id || ""), "terminal_session_id") };
      case "terminal_subscribe":
        return { mode: "terminal_action", action: "subscribe", terminalSessionID: requiredString(String(message.terminal_session_id || payload.terminal_session_id || ""), "terminal_session_id") };
      case "terminal_unsubscribe":
        return { mode: "terminal_action", action: "unsubscribe", terminalSessionID: requiredString(String(message.terminal_session_id || payload.terminal_session_id || ""), "terminal_session_id") };
      default:
        throw new Error("unsupported browser command");
    }
  };
}

async function buildRealtimeInjectCommand(store, userID, browserDeviceID, daemon, requestID, message, payload) {
  const sessionID = requiredString(String(message.session_id || payload.session_id || ""), "session_id");
  const { session } = await requireUserDaemonSession(store, userID, daemon.device_id, sessionID);
  const text = String(payload.text || "");
  if (!text.trim()) throw new Error("text is required");
  const options = injectStreamOptions(sessionID);
  return {
    mode: "stream",
    daemonDeviceID: daemon.device_id,
    daemonRequestID: requestID,
    sessionID,
    timeoutMs: options.timeoutMs,
    closeWhen: options.closeWhen,
    timeoutEvent: options.timeoutEvent,
    errorEvent: options.errorEvent,
    initialEvent: { request_id: requestID, type: "inject_started", session_id: sessionID },
    ack: { status: "accepted", type: "inject_started", session_id: sessionID, device_id: daemon.device_id, streaming: true },
    envelope: {
      type: "INJECT_REQUEST",
      request: {
        request_id: requestID,
        daemon_device_id: daemon.device_id,
        browser_device_id: browserDeviceID,
        mode: "resume_session",
        session_id: sessionID,
        agent: session.agent || "claude-code",
        cwd: session.cwd || "",
        text,
        model: payload.model || "",
        files: [],
      },
    },
  };
}

function buildRealtimeStartTaskCommand(browserDeviceID, daemon, requestID, payload) {
  const text = String(payload.text || "");
  if (!text.trim()) throw new Error("text is required");
  const sessionID = String(payload.session_id || "");
  const options = injectStreamOptions(sessionID);
  return {
    mode: "stream",
    daemonDeviceID: daemon.device_id,
    daemonRequestID: requestID,
    sessionID,
    timeoutMs: options.timeoutMs,
    closeWhen: options.closeWhen,
    timeoutEvent: options.timeoutEvent,
    errorEvent: options.errorEvent,
    initialEvent: { request_id: requestID, type: "inject_started", session_id: sessionID },
    ack: { status: "accepted", type: "inject_started", session_id: sessionID, device_id: daemon.device_id, streaming: true },
    envelope: {
      type: "INJECT_REQUEST",
      request: {
        request_id: requestID,
        daemon_device_id: daemon.device_id,
        browser_device_id: browserDeviceID,
        mode: "start_task",
        session_id: sessionID,
        agent: payload.agent || "claude-code",
        cwd: payload.cwd || "",
        text,
        model: payload.model || "",
        permission_mode: payload.permission_mode || "",
        effort: payload.effort || "",
      },
    },
  };
}

async function buildRealtimeSyncCommand(store, userID, browserDeviceID, daemon, requestID, message, payload) {
  const sessionID = requiredString(String(message.session_id || payload.session_id || ""), "session_id");
  await requireUserDaemonSession(store, userID, daemon.device_id, sessionID);
  const options = syncStreamOptions(sessionID, daemon.device_id);
  return {
    mode: "stream",
    daemonDeviceID: daemon.device_id,
    daemonRequestID: requestID,
    sessionID,
    timeoutMs: options.timeoutMs,
    closeWhen: options.closeWhen,
    timeoutEvent: options.timeoutEvent,
    errorEvent: options.errorEvent,
    initialEvent: { ...options.initialEvent, request_id: requestID },
    ack: { request_id: requestID, session_id: sessionID, device_id: daemon.device_id, stage: "queued", status: "running", streaming: true },
    envelope: {
      type: "SYNC_SESSION_REQUEST",
      sync_request: {
        request_id: requestID,
        daemon_device_id: daemon.device_id,
        session_id: sessionID,
        browser_device_id: browserDeviceID,
        mode: "window",
        limit: Number(payload.limit ?? 20),
        before_seq: Number(payload.before_seq ?? 0),
      },
    },
  };
}

function buildRealtimePermissionCommand(daemon, requestID, payload) {
  const decision = String(payload.decision || "");
  if (decision !== "allow" && decision !== "deny") throw new Error("decision must be allow or deny");
  const permissionRequestID = requiredString(String(payload.permission_request_id || requestID || ""), "permission_request_id");
  return {
    mode: "request_response",
    daemonDeviceID: daemon.device_id,
    daemonRequestID: permissionRequestID,
    responseType: "PERMISSION_DECIDE_EVENT",
    timeoutMs: 5_000,
    ack: { status: "accepted", device_id: daemon.device_id },
    envelope: {
      type: "PERMISSION_DECIDE",
      permission_decide: { request_id: permissionRequestID, decision },
    },
  };
}

async function buildRealtimeSessionOpenedHintCommand(store, userID, daemon, requestID, payload) {
  const sessionID = requiredString(String(payload.session_id || ""), "session_id");
  const session = await sessionWithTurnStats(store, userID, daemon.device_id, sessionID);
  const openedAt = payload.opened_at ? String(payload.opened_at) : new Date().toISOString();
  if (isLargeSessionForAutomaticBackfill(session)) {
    return {
      mode: "ack",
      daemonDeviceID: daemon.device_id,
      sessionID,
      ack: { status: "accepted", device_id: daemon.device_id, session_id: sessionID, last_opened_at: openedAt },
    };
  }
  await store.upsertSessionOpenHint({
    user_id: userID,
    device_id: daemon.device_id,
    session_id: sessionID,
    last_opened_at: openedAt,
    updated_at: new Date().toISOString(),
  });
  const windowHash = await sessionWindowHash(store, userID, daemon.device_id, sessionID, session);
  return {
    mode: "dispatch",
    daemonDeviceID: daemon.device_id,
    sessionID,
    ack: { status: "accepted", device_id: daemon.device_id, session_id: sessionID, last_opened_at: openedAt },
    envelope: {
      type: "SYNC_HINT",
      sync_hint: {
        ...sessionSyncHintPayload(session, sessionID),
        ...(windowHash ? { window_hash: windowHash } : {}),
        reason: "recently_opened",
        preferred_min: prioritySyncHintTurnLimit,
        request_id: requestID,
      },
    },
  };
}

function buildRealtimeTerminalCreate(userID, browserDeviceID, daemon, requestID, payload) {
  return {
    mode: "terminal_create",
    terminalSession: {
      request_id: requestID,
      terminal_session_id: randomID("ts"),
      user_id: userID,
      daemon_device_id: daemon.device_id,
      browser_device_id: browserDeviceID,
      session_id: payload.session_id || "",
      agent: payload.agent || "claude-code",
      cwd: payload.cwd || "",
    },
  };
}

export function createSessionEventSink(store, options = {}) {
  const persistTerminalEvents = options.persistTerminalEvents !== false;
  const env = options.env || {};
  const providers = options.providers || {};
  const persistActiveFinalTurns = activeFinalTurnPersistenceEnabled(env);
  const eventBatcher = createSessionEventBatcher(store, env);
  return {
    async onControlEvent(payload, meta = {}) {
      // Active stream deltas stay in the control hub's short-lived cache. Only
      // stable final turns are written into session_turns in runtimes where
      // immediate durability is cheap. Managed runtimes let the daemon's
      // bounded hot-window sync batch those writes instead.
      const turnRow = sessionTurnRecord(payload, meta);
      if (turnRow && persistActiveFinalTurns) {
        try {
          await upsertChangedTurns(store, [turnRow], env, providers);
        } catch {
          // The daemon window sync re-uploads the same turns from the local
          // jsonl, so a failed live write only delays content, never loses it.
        }
      }
      const event = sessionEventRecord(payload, meta, { turnPersisted: Boolean(turnRow && persistActiveFinalTurns) });
      if (!event) return;
      try {
        await eventBatcher.append(event);
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
        await eventBatcher.append(event);
      } catch {
        // Terminal event polling is only a fallback for runtimes without a long
        // terminal stream. Terminal streams and daemon-local buffers remain the
        // source of truth.
      }
    },
  };
}

function createSessionEventBatcher(store, env = {}) {
  const delayMs = sessionEventBatchDelayMs(env);
  const maxBatchSize = sessionEventBatchMax(env);
  let queue = [];
  let flushTimer = null;
  let flushPromise = null;
  let flushResolve = null;
  let flushReject = null;
  const flush = async () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const events = queue;
    queue = [];
    const resolve = flushResolve;
    const reject = flushReject;
    flushPromise = null;
    flushResolve = null;
    flushReject = null;
    try {
      if (events.length) {
        if (typeof store.appendSessionEvents === "function") {
          await store.appendSessionEvents(events);
        } else {
          for (const event of events) await store.appendSessionEvent(event);
        }
      }
      resolve?.();
    } catch (error) {
      reject?.(error);
    }
  };
  return {
    append(event) {
      queue.push(event);
      if (!flushPromise) {
        flushPromise = new Promise((resolve, reject) => {
          flushResolve = resolve;
          flushReject = reject;
        });
        flushTimer = setTimeout(() => {
          void flush();
        }, delayMs);
      }
      const pending = flushPromise;
      if (queue.length >= maxBatchSize) void flush();
      return pending;
    },
  };
}

function sessionEventBatchDelayMs(env = {}) {
  const fallback = managedRuntime(env) ? defaultSessionEventBatchMs : 0;
  const parsed = Number(env.POCKLY_SESSION_EVENT_BATCH_MS ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(1000, Math.floor(parsed));
}

function sessionEventBatchMax(env = {}) {
  return boundedPositiveInteger(env.POCKLY_SESSION_EVENT_BATCH_MAX, defaultSessionEventBatchMax);
}

function activeFinalTurnPersistenceEnabled(env = {}) {
  const configured = env.POCKLY_PERSIST_ACTIVE_FINAL_TURNS ?? env.PERSIST_ACTIVE_FINAL_TURNS;
  if (configured !== undefined && configured !== null && String(configured) !== "") {
    return enabledFlag(configured);
  }
  return !managedRuntime(env);
}

// sessionTurnRecord maps a stable final turn onto a session_turns row (the
// durable shape syncTurnRecord also produces). Mid-turn stream deltas return
// null and are served from the transient control cache instead.
function sessionTurnRecord(payload, meta = {}) {
  if (Array.isArray(payload?.turns)) return null;
  const turn = payload?.turn && typeof payload.turn === "object" ? payload.turn : null;
  if (!turn) return null;
  if (!isStableTurnEvent(payload, meta)) return null;
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

function isStableTurnEvent(payload, meta = {}) {
  const type = String(payload?.type || payload?.stage || meta.kind || "");
  const status = String(payload?.status || "");
  return type === "inject_completed" ||
    type === "completed" ||
    type === "turn_completed" ||
    status === "completed";
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
    payload: JSON.stringify(sessionEventPayloadForStorage(payload, options)),
    created_at: String(payload.timestamp || turn?.timestamp || now),
  };
}

function sessionEventPayloadForStorage(payload, options = {}) {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload.turns)) {
    // SYNC_SESSION_EVENT turns are transient older-history windows. They are
    // delivered to the waiting page through the live control/event cache, but
    // must not become durable session_events payloads. Hot-window history stays
    // bounded in session_turns; full old history remains daemon-local.
    const { turns, ...rest } = payload;
    return {
      ...rest,
      turns_omitted: true,
      turns_omitted_count: turns.length,
    };
  }
  if (options.turnPersisted === false && payload.turn && typeof payload.turn === "object") {
    const { turn, ...rest } = payload;
    return {
      ...rest,
      turn_omitted: true,
    };
  }
  return payload;
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
  // Pure turn events (stream_event) are active content, not lifecycle. They
  // stay in the short-lived control cache and must not become durable rows.
  if (payload?.turn && typeof payload.turn === "object") return false;
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

async function sessionControlAction(request, store, env, providers, sessionID, action, url) {
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
      return await sessionDelete(request, store, env, providers, sessionID, url);
    case "reveal":
      return await sessionReveal(request, store, env, sessionID, url);
    default:
      return errorResponse("not found", ErrorCode.NotFound, { status: 404 });
  }
}

// sessionDelete PERMANENTLY deletes a session: the daemon removes the local
// transcript file first; only on success does Nexus drop its own copy
// (session row + turns + prefs). The web gates this behind a confirm dialog.
async function sessionDelete(request, store, env, providers, sessionID, url) {
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
    const historyBlobKeys = await collectSessionHistoryBlobKeys(store, providers, user.user_id, daemon.device_id, sessionID);
    await store.deleteSessionData(user.user_id, daemon.device_id, sessionID);
    await appendSessionCatalogChanges(store, [{
      type: "delete",
      user_id: user.user_id,
      device_id: daemon.device_id,
      session_id: sessionID,
      session: null,
      at: new Date().toISOString(),
    }], env);
    await deleteHistoryBlobsBestEffort(providers, historyBlobKeys);
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
        return jsonResponse(await listTerminalEvents(store, control, request, env, user.user_id, terminalSessionID));
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
    if (error?.response instanceof Response) return error.response;
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

function createEndpointCostTracker() {
  return {
    store_reads: 0,
    store_writes: 0,
    sql_rows_read: 0,
    sql_rows_written: 0,
    object_reads: 0,
    object_writes: 0,
    control_requests: 0,
  };
}

function instrumentCostProvider(provider, tracker, kind) {
  if (!provider || !tracker || (typeof provider !== "object" && typeof provider !== "function")) return provider;
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args) => {
        const method = String(prop);
        recordProviderCost(tracker, kind, method);
        const result = value.apply(target, args);
        if (kind === "control_factory" && (method === "forUser" || method === "get")) {
          return instrumentCostProvider(result, tracker, "control");
        }
        return result;
      };
    },
  });
}

function recordProviderCost(tracker, kind, method) {
  if (kind === "store") {
    if (isStoreWriteMethod(method)) tracker.store_writes += 1;
    else tracker.store_reads += 1;
    return;
  }
  if (kind === "object") {
    if (isObjectWriteMethod(method)) tracker.object_writes += 1;
    else if (isObjectReadMethod(method)) tracker.object_reads += 1;
    return;
  }
  if (kind === "control") {
    tracker.control_requests += 1;
  }
}

function isStoreWriteMethod(method) {
  return /^(upsert|create|delete|append|touch|consume|revoke|set|update|save|mark|prune)/.test(method);
}

function isObjectWriteMethod(method) {
  return /^(put|delete|write|upload|remove)/.test(method);
}

function isObjectReadMethod(method) {
  return /^(get|head|list|text|read|download)/.test(method);
}

async function recordEndpointCostTelemetry(provider, request, response, fields = {}) {
  if (!provider) return;
  const endpoint = endpointCostName(new URL(request.url).pathname);
  if (!endpoint) return;
  const costTracker = fields.costTracker || {};
  const event = {
    name: "nexus_endpoint_cost",
    endpoint,
    method: request.method,
    status: Number(response.status || 0),
    duration_ms: Math.max(0, Math.round(Number(fields.durationMs || 0))),
    worker_requests: 1,
    worker_wall_duration_ms: Math.max(0, Math.round(Number(fields.durationMs || 0))),
    worker_cpu_time_ms_estimate: Math.max(0, Math.round(Number(fields.durationMs || 0))),
    worker_cpu_time_source: "wall_clock_proxy",
    request_bytes: headerBytes(request.headers, "content-length"),
    response_bytes: headerBytes(response.headers, "content-length"),
    store_reads: Number(costTracker.store_reads || 0),
    store_writes: Number(costTracker.store_writes || 0),
    sql_rows_read: Number(costTracker.sql_rows_read || 0),
    sql_rows_written: Number(costTracker.sql_rows_written || 0),
    object_reads: Number(costTracker.object_reads || 0),
    object_writes: Number(costTracker.object_writes || 0),
    control_requests: Number(costTracker.control_requests || 0),
    do_requests: Number(costTracker.control_requests || 0),
    timestamp: new Date().toISOString(),
  };
  const payload = JSON.stringify({ events: [event] });
  try {
    await invokeTelemetryProvider(provider, payload, request);
  } catch {
    // Endpoint cost telemetry is advisory and must never affect API behavior.
  }
}

function endpointCostName(pathname) {
  const path = normalizePath(pathname);
  if (path === "/api/telemetry/web" || path === "/api/telemetry/daemon") return "";
  if (path === "/healthz") return "healthz";
  const exact = {
    "/api/runtime": "runtime",
    "/api/auth/session": "auth_session",
    "/api/daemon/control": "daemon_control",
    "/api/daemon/sync": "daemon_sync",
    "/api/daemon/sync-hints": "daemon_sync_hints",
    "/api/hosts/online": "hosts_online",
    "/api/sessions": "sessions",
    "/api/sessions/delta": "sessions_delta",
    "/api/terminal-sessions": "terminal_sessions",
  };
  if (exact[path]) return exact[path];
  if (/^\/api\/sessions\/[^/]+\/turns$/.test(path)) return "session_turns";
  if (/^\/api\/sessions\/[^/]+\/events$/.test(path)) return "session_events";
  if (/^\/api\/sessions\/[^/]+\/opened$/.test(path)) return "session_opened";
  if (/^\/api\/sessions\/[^/]+$/.test(path)) return "session_catalog_item";
  const sessionAction = path.match(/^\/api\/sessions\/[^/]+\/(inject|sync|agent-settings|diff|delete|reveal)$/);
  if (sessionAction) return `session_${sessionAction[1].replace(/-/g, "_")}`;
  if (/^\/api\/injects\/[^/]+\/events$/.test(path)) return "inject_events";
  const terminalAction = path.match(/^\/api\/terminal-sessions\/[^/]+\/(input|stop|open-terminal|stream|subscribe|unsubscribe|events)$/);
  if (terminalAction) return `terminal_${terminalAction[1].replace(/-/g, "_")}`;
  if (/^\/api\/permission-requests\/[^/]+\/decide$/.test(path)) return "permission_decide";
  const hostAction = path.match(/^\/api\/hosts\/[^/]+\/(connect|disconnect|update)$/);
  if (hostAction) return `host_${hostAction[1]}`;
  if (path.startsWith("/api/")) return "api_other";
  return "other";
}

function headerBytes(headers, name) {
  const value = Number(headers.get(name) || 0);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
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

async function listTerminalEvents(store, control, request, env, userID, terminalSessionID) {
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
  if (managedRuntime(env) && !terminalEventCacheEnabled(env)) {
    throw unsupportedTerminalPollingError();
  }
  return control.listTerminalEvents(userID, terminalSessionID, options);
}

function managedRuntime(env = {}) {
  const value = String(env.POCKLY_NEXUS_RUNTIME || env.NEXUS_RUNTIME || "");
  return value === "managed";
}

function unsupportedTerminalPollingError() {
  const error = new Error("terminal event polling requires browser realtime or terminal event cache in this runtime");
  error.response = errorResponse(error.message, ErrorCode.UnsupportedRuntime, { status: 501 });
  return error;
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
    machine_fingerprint: safeMachineFingerprint(body.machine_fingerprint),
    status: "active",
    current_daemon_device_id: requiredString(body.daemon_device_id, "daemon_device_id"),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    last_seen_at: now.toISOString(),
  });
  const daemon = await store.upsertDevice({
    device_id: requiredString(body.daemon_device_id, "daemon_device_id"),
    user_id: user.user_id,
    computer_id: computerID,
    machine_fingerprint: safeMachineFingerprint(body.machine_fingerprint),
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
  await supersedeDaemonDevicesForMachine(store, user.user_id, daemon, now.toISOString());
  return daemon;
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
    machine_fingerprint: auth.machine_fingerprint,
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
    machine_fingerprint: grant.machine_fingerprint,
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
    machine_fingerprint: safeMachineFingerprint(body.machine_fingerprint),
    status: "active",
    current_daemon_device_id: requiredString(body.daemon_device_id, "daemon_device_id"),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    last_seen_at: markSeen ? now.toISOString() : undefined,
  });
  const daemon = await store.upsertDevice({
    device_id: requiredString(body.daemon_device_id, "daemon_device_id"),
    user_id: user.user_id,
    computer_id: computerID,
    machine_fingerprint: safeMachineFingerprint(body.machine_fingerprint),
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
  await supersedeDaemonDevicesForMachine(store, user.user_id, daemon, now.toISOString());
  return daemon;
}

async function supersedeDaemonDevicesForMachine(store, userID, currentDaemon, at, env = null) {
  const machineFingerprint = currentDaemon?.machine_fingerprint || "";
  if (!machineFingerprint || typeof store.listDaemonDevicesByMachineFingerprint !== "function") return;
  const devices = await store.listDaemonDevicesByMachineFingerprint(userID, machineFingerprint);
  for (const device of devices) {
    if (device.device_id === currentDaemon.device_id || device.superseded_by_device_id || device.status === "revoked") continue;
    const result = typeof store.supersedeDaemonDevice === "function"
      ? await store.supersedeDaemonDevice(userID, device.device_id, currentDaemon.device_id, at)
      : {
          superseded: Boolean(await store.patchDevice(userID, device.device_id, {
            superseded_by_device_id: currentDaemon.device_id,
            status: "offline",
            updated_at: at,
          })),
          deleted_sessions: [],
          upserted_sessions: [],
        };
    if (!result?.superseded) continue;
    await appendSessionCatalogChanges(store, [
      ...(result.deleted_sessions ?? []).map((session) => ({
        type: "delete",
        user_id: userID,
        device_id: device.device_id,
        session_id: session.session_id,
        session: null,
        at,
      })),
      ...(result.upserted_sessions ?? []).map((session) => ({
        type: "upsert",
        user_id: userID,
        device_id: currentDaemon.device_id,
        session_id: session.session_id,
        session,
        at,
      })),
    ], env);
  }
}

function safeMachineFingerprint(value) {
  const fingerprint = String(value || "").trim();
  if (!fingerprint || !machineFingerprintPattern.test(fingerprint)) return "";
  return fingerprint.toLowerCase();
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

async function syncSessionRecord(store, user, device, session, now, uploadedTurnStats, receivedTurnStats, changedTurnStats, existing = null, durableSession = true) {
  const sessionID = requiredString(session.session_id, "session_id");
  const durableTail = Boolean(durableSession);
  const stats = await syncSessionTurnStats(store, user.user_id, device.device_id, String(session.session_id), existing, session, uploadedTurnStats, changedTurnStats);
  const persistedTurnCount = stats
    ? stats.count
    : Number(existing?.synced_turn_count ?? 0);
  const minSeq = Number(session.min_seq ?? 0);
  const maxSeq = Number(session.max_seq ?? session.last_seq ?? 0);
  const uploadedTurnCount = Number(uploadedTurnStats?.count ?? 0) || 0;
  const uploadedSyncedMinSeq = Number(stats?.min_seq ?? uploadedTurnStats?.min_seq ?? minSeq) || 0;
  const uploadedSyncedMaxSeq = Number(stats?.max_seq ?? uploadedTurnStats?.max_seq ?? maxSeq) || 0;
  const syncedMinSeq = stats
    ? uploadedSyncedMinSeq
    : Number(existing?.synced_min_seq ?? 0) || 0;
  const syncedMaxSeq = stats
    ? uploadedSyncedMaxSeq
    : Number(existing?.synced_max_seq ?? 0) || 0;
  const syncedWindowHash = syncedWindowHashForSession(session, stats, syncedMinSeq, syncedMaxSeq, existing, durableTail);
  const preserveCatalogMetadata = !durableTail && existing && Number(receivedTurnStats?.count ?? 0) > 0;
  return {
    user_id: user.user_id,
    computer_id: device.computer_id ?? null,
    device_id: device.device_id,
    session_id: sessionID,
    agent: preserveCatalogMetadata ? existing.agent : (session.agent || existing?.agent || "claude-code"),
    runner_alias: preserveCatalogMetadata ? (existing.runner_alias || "") : (session.runner_alias ?? existing?.runner_alias ?? ""),
    cwd: preserveCatalogMetadata ? (existing.cwd || "") : (session.cwd ?? existing?.cwd ?? ""),
    snippet: preserveCatalogMetadata ? (existing.snippet || "") : (session.snippet ?? session.first_message ?? existing?.snippet ?? ""),
    first_message: preserveCatalogMetadata ? (existing.first_message || "") : (session.first_message ?? existing?.first_message ?? ""),
    title: preserveCatalogMetadata ? (existing.title || "") : (session.title ?? existing?.title ?? ""),
    last_seq: durableTail || !existing ? Number(session.last_seq ?? maxSeq) : Number(existing.last_seq ?? 0),
    last_timestamp: durableTail || !existing ? (session.last_timestamp || now) : (existing.last_timestamp || session.last_timestamp || now),
    channel_last_seen_at: durableTail
      ? (session.channel_last_seen_at || existing?.channel_last_seen_at || session.last_timestamp || now)
      : (existing?.channel_last_seen_at || session.channel_last_seen_at || session.last_timestamp || now),
    sync_state: durableTail
      ? mergedSyncState(existing, session, uploadedTurnCount, {
          persistedTurnCount,
          syncedMinSeq,
          syncedMaxSeq,
        })
      : (existing?.sync_state || "catalog_only"),
    turn_count: durableTail || !existing ? Number(session.turn_count ?? 0) : Number(existing.turn_count ?? session.turn_count ?? 0),
    last_sync_error: durableTail || !existing ? "" : (existing.last_sync_error || ""),
    synced_turn_count: persistedTurnCount,
    actual_turn_count: Number(stats?.count ?? existing?.actual_turn_count ?? persistedTurnCount) || 0,
    synced_min_seq: syncedMinSeq,
    synced_max_seq: syncedMaxSeq,
    synced_window_hash: syncedWindowHash,
    latest_contiguous_min_seq: Number(stats?.latest_contiguous_min_seq ?? existing?.latest_contiguous_min_seq ?? syncedMinSeq) || 0,
    has_older_turns: durableTail
      ? mergedHasOlderTurns(existing, session, uploadedTurnCount, {
          persistedTurnCount,
          syncedMinSeq,
          syncedMaxSeq,
        })
      : Boolean(existing?.has_older_turns),
    updated_at: durableTail || !existing ? (session.last_timestamp || now) : (existing.updated_at || now),
  };
}

function syncedWindowHashForSession(session, stats, syncedMinSeq, syncedMaxSeq, existing = null, durableTail = true) {
  if (!durableTail) return existing?.synced_window_hash || "";
  const windowHash = String(session?.window_hash || "");
  const windowMinSeq = Number(session?.min_seq ?? 0) || 0;
  const windowMaxSeq = Number(session?.max_seq ?? session?.last_seq ?? 0) || 0;
  if (windowHash && windowMinSeq > 0 && windowMaxSeq >= windowMinSeq && syncedMinSeq === windowMinSeq && syncedMaxSeq === windowMaxSeq) {
    return windowHash;
  }
  if (!stats && syncedMinSeq === Number(existing?.synced_min_seq ?? 0) && syncedMaxSeq === Number(existing?.synced_max_seq ?? 0)) {
    return existing?.synced_window_hash || "";
  }
  return "";
}

async function syncSessionTurnStats(store, userID, deviceID, sessionID, existing, session, uploadedTurnStats, changedTurnStats) {
  const uploadedTurnCount = Number(uploadedTurnStats?.count ?? 0) || 0;
  const changedTurnCount = Number(changedTurnStats?.count ?? 0) || 0;
  if (changedTurnCount > 0 && existing) {
    const merged = mergeUploadedTurnStats(existing, session, changedTurnStats);
    if (!merged.requires_full_stats) return merged;
  }
  if (changedTurnCount > 0) {
    return await sessionTurnStats(store, userID, deviceID, sessionID);
  }
  if (uploadedTurnCount > 0 && existing) {
    return {
      count: Number(existing.synced_turn_count ?? 0) || 0,
      min_seq: Number(existing.synced_min_seq ?? 0) || 0,
      max_seq: Number(existing.synced_max_seq ?? 0) || 0,
      latest_contiguous_min_seq: Number(existing.latest_contiguous_min_seq ?? existing.synced_min_seq ?? 0) || 0,
    };
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
  const uploadedSpan = uploadedMaxSeq - uploadedMinSeq + 1;
  if (uploadedCount < uploadedSpan) return { requires_full_stats: true };

  const currentCount = Number(existing?.synced_turn_count ?? 0) || 0;
  const currentMinSeq = Number(existing?.synced_min_seq ?? 0) || 0;
  const currentMaxSeq = Number(existing?.synced_max_seq ?? 0) || 0;
  const currentLatestContiguousMinSeq = Number(existing?.latest_contiguous_min_seq ?? currentMinSeq) || currentMinSeq;
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
  let latestContiguousMinSeq = currentLatestContiguousMinSeq;
  if (uploadedMaxSeq > currentMaxSeq) {
    latestContiguousMinSeq = uploadedMinSeq <= currentMaxSeq + 1
      ? Math.min(uploadedMinSeq, currentLatestContiguousMinSeq)
      : uploadedMinSeq;
  } else if (uploadedMinSeq <= currentLatestContiguousMinSeq && uploadedMaxSeq >= currentMaxSeq) {
    latestContiguousMinSeq = uploadedMinSeq;
  } else if (uploadedMaxSeq >= currentLatestContiguousMinSeq - 1 && uploadedMinSeq <= currentLatestContiguousMinSeq) {
    latestContiguousMinSeq = Math.min(uploadedMinSeq, currentLatestContiguousMinSeq);
  }
  return {
    count: Math.min(nextCount, nextSpan),
    min_seq: nextMinSeq,
    max_seq: nextMaxSeq,
    latest_contiguous_min_seq: nextCount >= nextSpan ? nextMinSeq : latestContiguousMinSeq,
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

async function sessionWithTurnStats(store, userID, deviceID, sessionID, options = {}) {
  const session = await store.getSession(userID, deviceID, sessionID);
  if (!session) return null;
  if (sessionHasMaterializedTurnStats(session)) {
    return {
      ...session,
      actual_turn_count: Number(session.actual_turn_count ?? session.synced_turn_count ?? 0) || 0,
      latest_contiguous_min_seq: Number(session.latest_contiguous_min_seq ?? session.synced_min_seq ?? 0) || 0,
    };
  }
  const stats = await sessionTurnStats(store, userID, deviceID, sessionID);
  const syncedMinSeq = Number(stats.min_seq ?? 0) || 0;
  const syncedMaxSeq = Number(stats.max_seq ?? 0) || 0;
  const next = {
    ...session,
    synced_turn_count: stats.count,
    actual_turn_count: stats.count,
    synced_min_seq: syncedMinSeq,
    synced_max_seq: syncedMaxSeq,
    latest_contiguous_min_seq: Number(stats.latest_contiguous_min_seq ?? 0) || syncedMinSeq,
  };
  if (options.repairMetadata && sessionNeedsStatsRepair(session, next)) {
    await store.upsertSession({
      ...session,
      sync_state: mergedSyncState(session, session, 0, {
        persistedTurnCount: next.synced_turn_count,
        syncedMinSeq: next.synced_min_seq,
        syncedMaxSeq: next.synced_max_seq,
      }),
      synced_turn_count: next.synced_turn_count,
      actual_turn_count: next.actual_turn_count,
      synced_min_seq: next.synced_min_seq,
      synced_max_seq: next.synced_max_seq,
      latest_contiguous_min_seq: next.latest_contiguous_min_seq,
      synced_window_hash: "",
      has_older_turns: mergedHasOlderTurns(session, session, 0, {
        persistedTurnCount: next.synced_turn_count,
        syncedMinSeq: next.synced_min_seq,
        syncedMaxSeq: next.synced_max_seq,
      }),
    });
  }
  return next;
}

async function repairPrunedTurnSessions(store, user, device, prunedSessions = [], alreadyUpdatedSessionIDs = new Set(), now = new Date().toISOString(), env = null) {
  const out = [];
  const seen = new Set();
  for (const pruned of prunedSessions) {
    if (String(pruned.user_id || "") !== user.user_id) continue;
    if (String(pruned.device_id || "") !== device.device_id) continue;
    const sessionID = String(pruned.session_id || "");
    if (!sessionID || alreadyUpdatedSessionIDs.has(sessionID) || seen.has(sessionID)) continue;
    seen.add(sessionID);
    const existing = await store.getSession(user.user_id, device.device_id, sessionID);
    if (!existing) continue;
    const stats = await sessionTurnStats(store, user.user_id, device.device_id, sessionID);
    const hasRetainedTurns = Number(stats.count ?? 0) > 0;
    const repaired = {
      ...existing,
      sync_state: hasRetainedTurns
        ? mergedSyncState(existing, existing, 0, {
            persistedTurnCount: stats.count,
            syncedMinSeq: stats.min_seq,
            syncedMaxSeq: stats.max_seq,
          })
        : "catalog_only",
      synced_turn_count: stats.count,
      actual_turn_count: stats.count,
      synced_min_seq: Number(stats.min_seq ?? 0) || 0,
      synced_max_seq: Number(stats.max_seq ?? 0) || 0,
      latest_contiguous_min_seq: Number(stats.latest_contiguous_min_seq ?? stats.min_seq ?? 0) || 0,
      synced_window_hash: "",
      has_older_turns: hasRetainedTurns
        ? mergedHasOlderTurns(existing, existing, 0, {
            persistedTurnCount: stats.count,
            syncedMinSeq: stats.min_seq,
            syncedMaxSeq: stats.max_seq,
          })
        : false,
      updated_at: existing.updated_at || now,
    };
    if (!sessionMatchesExisting(repaired, existing)) out.push(repaired);
  }
  if (!out.length) return [];
  await store.upsertSessions(out);
  await appendSessionCatalogChanges(store, out.map((session) => ({
    type: "upsert",
    user_id: user.user_id,
    device_id: session.device_id,
    session_id: session.session_id,
    session,
    at: now,
  })), env);
  return out;
}

function sessionNeedsStatsRepair(session, next) {
  return Number(session.synced_turn_count ?? 0) !== Number(next.synced_turn_count ?? 0) ||
    Number(session.actual_turn_count ?? session.synced_turn_count ?? 0) !== Number(next.actual_turn_count ?? next.synced_turn_count ?? 0) ||
    Number(session.synced_min_seq ?? 0) !== Number(next.synced_min_seq ?? 0) ||
    Number(session.synced_max_seq ?? 0) !== Number(next.synced_max_seq ?? 0) ||
    Number(session.latest_contiguous_min_seq ?? session.synced_min_seq ?? 0) !== Number(next.latest_contiguous_min_seq ?? next.synced_min_seq ?? 0);
}

function sessionHasMaterializedTurnStats(session) {
  const actual = Number(session?.actual_turn_count ?? 0) || 0;
  const synced = Number(session?.synced_turn_count ?? 0) || 0;
  const minSeq = Number(session?.synced_min_seq ?? 0) || 0;
  const maxSeq = Number(session?.synced_max_seq ?? 0) || 0;
  const contiguousMin = Number(session?.latest_contiguous_min_seq ?? 0) || 0;
  if (synced === 0 && actual === 0 && minSeq === 0 && maxSeq === 0) return true;
  return actual > 0 && maxSeq > 0 && contiguousMin > 0;
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

async function sessionWindowHash(store, userID, deviceID, sessionID, session) {
  const stored = storedWindowHash(session);
  if (stored) return stored;
  if (typeof store.listTurnPayloadsForWindow !== "function") return "";
  const minSeq = Number(session?.synced_min_seq ?? 0) || 0;
  const maxSeq = Number(session?.synced_max_seq ?? 0) || 0;
  const count = Number(session?.synced_turn_count ?? 0) || 0;
  if (minSeq <= 0 || maxSeq < minSeq || count < maxSeq - minSeq + 1) return "";
  const turns = await store.listTurnPayloadsForWindow(userID, deviceID, sessionID, minSeq, maxSeq);
  if (turns.length !== maxSeq - minSeq + 1) return "";
  return await turnWindowHash(turns);
}

async function knownSessionWindows(store, userID, deviceID, sessions = []) {
  const candidates = sessions
    .map((session) => knownWindowCandidate(session))
    .filter(Boolean);
  if (!candidates.length) return [];
  const out = [];
  const unresolved = [];
  for (const candidate of candidates) {
    if (candidate.window_hash) {
      out.push({
        session_id: candidate.session_id,
        synced_min_seq: candidate.synced_min_seq,
        synced_max_seq: candidate.synced_max_seq,
        synced_turn_count: candidate.synced_turn_count,
        window_hash: candidate.window_hash,
      });
    } else {
      unresolved.push(candidate);
    }
  }
  if (!unresolved.length || typeof store.listTurnPayloadPointers !== "function") return out;
  const bySessionID = new Map(unresolved.map((candidate) => [candidate.session_id, candidate]));
  const turnsBySessionID = new Map();
  for (const turn of await store.listTurnPayloadPointers(userID, deviceID, unresolved.map((candidate) => candidate.session_id))) {
    const candidate = bySessionID.get(String(turn.session_id || ""));
    if (!candidate) continue;
    const seq = Number(turn.seq ?? 0) || 0;
    if (seq <= 0 || seq > candidate.synced_max_seq) continue;
    const turns = turnsBySessionID.get(candidate.session_id) || [];
    turns.push(turn);
    turnsBySessionID.set(candidate.session_id, turns);
  }
  for (const candidate of unresolved) {
    const turns = latestContiguousTurnTail(turnsBySessionID.get(candidate.session_id) || [], candidate.synced_max_seq);
    if (!turns.length) continue;
    out.push({
      session_id: candidate.session_id,
      synced_min_seq: Number(turns[0].seq ?? 0) || 0,
      synced_max_seq: Number(turns[turns.length - 1].seq ?? 0) || 0,
      synced_turn_count: turns.length,
      window_hash: await turnWindowHash(turns),
    });
  }
  return out;
}

function latestContiguousTurnTail(turns = [], maxSeq = 0) {
  const sorted = turns
    .sort((left, right) => Number(left.seq) - Number(right.seq));
  let expected = Number(maxSeq ?? 0) || Number(sorted[sorted.length - 1]?.seq ?? 0) || 0;
  const tail = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const turn = sorted[index];
    const seq = Number(turn.seq ?? 0) || 0;
    if (seq !== expected) {
      if (tail.length > 0) break;
      if (seq > expected) continue;
      break;
    }
    tail.push(turn);
    expected -= 1;
  }
  return tail.reverse();
}

function knownWindowCandidate(session) {
  const sessionID = String(session?.session_id || "");
  const minSeq = Number(session?.synced_min_seq ?? 0) || 0;
  const maxSeq = Number(session?.synced_max_seq ?? 0) || 0;
  const count = Number(session?.synced_turn_count ?? 0) || 0;
  if (!sessionID || maxSeq <= 0 || count <= 0) return null;
  return {
    session_id: sessionID,
    synced_min_seq: minSeq,
    synced_max_seq: maxSeq,
    synced_turn_count: count,
    window_hash: storedWindowHash(session),
  };
}

function storedWindowHash(session) {
  const hash = String(session?.synced_window_hash || "");
  if (!hash) return "";
  const minSeq = Number(session?.synced_min_seq ?? 0) || 0;
  const maxSeq = Number(session?.synced_max_seq ?? 0) || 0;
  const count = Number(session?.synced_turn_count ?? 0) || 0;
  if (minSeq <= 0 || maxSeq < minSeq || count < maxSeq - minSeq + 1) return "";
  return hash;
}

async function turnWindowHash(turns) {
  const parts = [];
  for (const turn of turns) {
    parts.push(
      String(turn.session_id ?? ""),
      String(turn.agent ?? ""),
      String(Number(turn.seq ?? 0) || 0),
      String(turn.kind ?? ""),
      String(turn.timestamp ?? ""),
      await turnPayloadDigest(turn.payload),
    );
  }
  return `sha256:${await sha256Base64URL(`${parts.join("\0")}\0`)}`;
}

async function turnPayloadDigest(payload) {
  const raw = payload == null ? "" : String(payload);
  const parsed = parsePayload(raw);
  if (isLocalOnlyPayloadPlaceholder(parsed) && parsed.sha256) return String(parsed.sha256);
  if (isTurnPayloadPointerObject(parsed) && parsed.sha256) return String(parsed.sha256);
  return await sha256Base64URL(raw);
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
    machine_fingerprint_bound: Boolean(device.machine_fingerprint),
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
  const turnCount = Number(session.turn_count ?? 0);
  const syncedTurnCount = Number(session.synced_turn_count ?? 0);
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
    turn_count: turnCount,
    last_sync_error: session.last_sync_error || "",
    synced_turn_count: syncedTurnCount,
    synced_min_seq: Number(session.synced_min_seq ?? 0),
    synced_max_seq: Number(session.synced_max_seq ?? 0),
    has_older_turns: Boolean(session.has_older_turns || turnCount > syncedTurnCount),
  };
}

function publicCatalogSession(session) {
  // Catalog deltas intentionally do not carry realtime presence. The browser
  // projects /api/hosts/online onto cached catalog rows, keeping catalog paging
  // independent of realtime-coordinator wakeups and stale last_seen_at heuristics.
  return publicSession(session, null, false);
}

async function publicTurns(turns, providers = {}) {
  const blobCache = new Map();
  return await Promise.all(turns.map((turn) => publicTurn(turn, providers, blobCache)));
}

async function publicTurn(turn, providers = {}, blobCache = new Map()) {
  const payload = await resolveTurnPayload(turn.payload, providers, blobCache, turn);
  return {
    device_id: turn.device_id,
    session_id: turn.session_id,
    seq: Number(turn.seq),
    agent: turn.agent,
    kind: turn.kind,
    timestamp: turn.timestamp,
    ...(payload !== undefined ? { payload } : {}),
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

function withHistoryStorageCostEstimate(usage) {
  const estimated = estimateHistoryStorageCostUSD(usage);
  return {
    ...usage,
    estimated_storage_cost_usd_per_month: estimated.total,
    estimated_storage_cost_components: estimated.components,
  };
}

function estimateHistoryStorageCostUSD(usage) {
  const primary = bytesToGiB(Number(usage?.primary_payload_bytes ?? 0) || 0) * primaryPayloadStorageGBMonthUSD;
  const archive = bytesToGiB(Number(usage?.archived_encoded_bytes ?? 0) || 0) * archivePayloadStorageGBMonthUSD;
  return {
    total: roundCost(primary + archive),
    components: {
      primary_payload_storage: roundCost(primary),
      archive_payload_storage: roundCost(archive),
    },
  };
}

function bytesToGiB(bytes) {
  return Math.max(0, bytes) / 1024 / 1024 / 1024;
}

function roundCost(value) {
  return Number(value.toFixed(8));
}

async function externalizeTurnPayloads(turns, env = {}, providers = {}) {
  if (!historyBlobStorageEnabled(env)) {
    return await applyHotTurnPayloadPolicy(turns, env);
  }
  const threshold = turnPayloadBlobThreshold(env);
  const blobStore = providers.historyBlobStore;
  if (!blobStore || threshold <= 0 || !turns.length) return await applyHotTurnPayloadPolicy(turns, env);
  return await externalizeTurnPayloadBatch(turns, blobStore, threshold, turnPayloadBatchRawBytes(env));
}

async function upsertChangedTurns(store, turns, env = {}, providers = {}) {
  const deduped = dedupeTurnRecords(turns);
  if (!deduped.length) return { changedTurns: [], prunedSessions: [] };
  const hotCandidates = selectHotTurnCandidates(deduped, env);
  if (!hotCandidates.length) return { changedTurns: [], prunedSessions: [] };
  const useHistoryBlobStorage = historyBlobStorageEnabled(env) && providers.historyBlobStore;
  const candidates = useHistoryBlobStorage ? hotCandidates : await applyHotTurnPayloadPolicy(hotCandidates, env);
  const changed = await filterChangedTurnRecords(store, candidates);
  if (!changed.length) return { changedTurns: [], prunedSessions: [] };
  await store.upsertTurns(useHistoryBlobStorage ? await externalizeTurnPayloads(changed, env, providers) : changed);
  let prunedSessions = [];
  if (typeof store.pruneHotTurnCache === "function") {
    const perUser = hotTurnsPerUser(env);
    const userIDs = [...new Set(changed.map((turn) => String(turn.user_id)).filter(Boolean))];
    const changedSessionKeys = [...new Set(changed.map((turn) => turnSessionKey(turn)).filter(Boolean))];
    const sessionKeys = changedSessionKeys.length <= maxScopedHotTurnPruneSessions ? changedSessionKeys : [];
    const runGlobalPrune = shouldRunGlobalHotTurnPrune(userIDs, changed.length, perUser, env);
    prunedSessions = await store.pruneHotTurnCache({
      perSession: hotTurnsPerSession(env),
      perUser: runGlobalPrune ? perUser : 0,
      inactiveBefore: runGlobalPrune ? hotTurnInactiveBefore(env) : "",
      userIDs,
      sessionKeys,
    });
  }
  return { changedTurns: changed, prunedSessions };
}

function shouldRunGlobalHotTurnPrune(userIDs, changedCount, perUser, env = {}, nowMs = Date.now()) {
  if (env.POCKLY_FORCE_GLOBAL_HOT_TURN_PRUNE === "1") return true;
  if (changedCount >= perUser) return true;
  const intervalMs = globalHotTurnPruneIntervalMs(env);
  if (intervalMs <= 0) return true;
  for (const userID of userIDs) {
    const last = globalHotTurnPruneLastRun.get(userID) ?? 0;
    if (nowMs - last >= intervalMs) {
      globalHotTurnPruneLastRun.set(userID, nowMs);
      return true;
    }
  }
  return false;
}

function selectHotTurnCandidates(turns, env = {}) {
  const perSession = hotTurnsPerSession(env);
  const perUser = hotTurnsPerUser(env);
  const sessionScoped = newestTurnRecordsByGroup(
    turns,
    (turn) => `${turn.user_id}\x00${turn.device_id}\x00${turn.session_id}`,
    perSession,
    compareTurnSeqNewestFirst,
  );
  return newestTurnRecordsByGroup(sessionScoped, (turn) => String(turn.user_id || ""), perUser);
}

function newestTurnRecordsByGroup(turns, keyFn, limit, compareFn = compareTurnRecordsNewestFirst) {
  if (!Number.isFinite(limit) || limit <= 0 || turns.length <= limit) return turns;
  const groups = new Map();
  for (const turn of turns) {
    const key = keyFn(turn);
    const group = groups.get(key) || [];
    group.push(turn);
    groups.set(key, group);
  }
  const keep = new Set();
  for (const group of groups.values()) {
    const selected = group.length > limit
      ? [...group].sort(compareFn).slice(0, limit)
      : group;
    for (const turn of selected) keep.add(turnRecordKey(turn));
  }
  return turns.filter((turn) => keep.has(turnRecordKey(turn)));
}

function compareTurnSeqNewestFirst(left, right) {
  return (Number(right.seq) || 0) - (Number(left.seq) || 0);
}

function compareTurnRecordsNewestFirst(left, right) {
  const timeDiff = (Date.parse(right.timestamp || "") || 0) - (Date.parse(left.timestamp || "") || 0);
  if (timeDiff !== 0) return timeDiff;
  return (Number(right.seq) || 0) - (Number(left.seq) || 0);
}

async function filterChangedTurnRecords(store, turns) {
  if (typeof store.listExistingTurnKeys === "function") {
    const existingKeys = await store.listExistingTurnKeys(turns);
    if (!existingKeys?.size) return turns;
    const newTurns = [];
    const existingTurns = [];
    for (const turn of turns) {
      if (existingKeys.has(turnRecordKey(turn))) existingTurns.push(turn);
      else newTurns.push(turn);
    }
    if (!existingTurns.length || typeof store.listExistingTurnPayloads !== "function") return newTurns;
    const changedExisting = await filterChangedExistingTurnRecords(store, existingTurns);
    return [...newTurns, ...changedExisting];
  }
  return await filterChangedExistingTurnRecords(store, turns);
}

async function filterChangedExistingTurnRecords(store, turns) {
  if (typeof store.listExistingTurnPayloads !== "function") return turns;
  const existingPayloads = await store.listExistingTurnPayloads(turns);
  if (!existingPayloads?.size) return turns;
  const out = [];
  for (const turn of turns) {
    const existing = existingPayloads.get(turnRecordKey(turn));
    if (existing === undefined || !await turnPayloadsEquivalent(existing, turn.payload)) out.push(turn);
  }
  return out;
}

async function turnPayloadsEquivalent(existingPayload, nextPayload) {
  if (existingPayload === nextPayload) return true;
  const existingPointer = parsePayload(existingPayload);
  if (isLocalOnlyPayloadPlaceholder(existingPointer)) {
    return existingPointer.sha256 && existingPointer.sha256 === await sha256Base64URL(String(nextPayload ?? ""));
  }
  if (isTurnPayloadPointerObject(existingPointer)) {
    return existingPointer.sha256 && existingPointer.sha256 === await sha256Base64URL(String(nextPayload ?? ""));
  }
  const nextPointer = parsePayload(nextPayload);
  if (isTurnPayloadPointerObject(nextPointer)) {
    return nextPointer.sha256 && nextPointer.sha256 === await sha256Base64URL(String(existingPayload ?? ""));
  }
  return false;
}

function dedupeTurnRecords(turns = []) {
  return [...new Map(turns.map((turn) => [turnRecordKey(turn), turn])).values()];
}

function turnRecordKey(turn) {
  return `${turn.user_id}\x00${turn.device_id}\x00${turn.session_id}\x00${turn.seq}`;
}

function turnSessionKey(turn) {
  const userID = String(turn.user_id || "");
  const deviceID = String(turn.device_id || "");
  const sessionID = String(turn.session_id || "");
  if (!userID || !deviceID || !sessionID) return "";
  return `${userID}\x00${deviceID}\x00${sessionID}`;
}

async function externalizeTurnPayloadBatch(turns, blobStore, threshold, maxBatchRawBytes) {
  const out = [...turns];
  const candidates = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn?.payload) continue;
    const payload = String(turn.payload);
    if (utf8ByteLength(payload) < threshold && !isTurnPayloadPointerObject(parsePayload(payload))) continue;
    candidates.push({
      index,
      turn,
      payload,
      bytes: utf8ByteLength(payload),
      sessionKey: `${turn.user_id}\x00${turn.device_id}\x00${turn.session_id}`,
    });
  }
  const singles = [];
  for (const group of groupedPayloadCandidates(candidates)) {
    let batch = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 1) {
        singles.push(batch[0]);
      } else if (batch.length > 1) {
        const pointers = await externalizeTurnPayloadCandidateBatch(batch, blobStore);
        for (const [index, pointer] of pointers) out[index] = { ...out[index], payload: JSON.stringify(pointer) };
      }
      batch = [];
      batchBytes = 0;
    };
    for (const candidate of group) {
      if (batch.length > 0 && batchBytes + candidate.bytes > maxBatchRawBytes) await flush();
      batch.push(candidate);
      batchBytes += candidate.bytes;
    }
    await flush();
  }
  await Promise.all(singles.map(async (candidate) => {
    out[candidate.index] = await externalizeTurnPayload(candidate.turn, blobStore, threshold);
  }));
  return out;
}

function groupedPayloadCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const group = groups.get(candidate.sessionKey) || [];
    group.push(candidate);
    groups.set(candidate.sessionKey, group);
  }
  return [...groups.values()].map((group) => group.sort((left, right) => Number(left.turn.seq) - Number(right.turn.seq)));
}

async function externalizeTurnPayloadCandidateBatch(candidates, blobStore) {
  const items = [];
  for (const candidate of candidates) {
    items.push({
      seq: Number(candidate.turn.seq) || 0,
      sha256: await sha256Base64URL(candidate.payload),
      bytes: candidate.bytes,
      payload: candidate.payload,
    });
  }
  const manifest = JSON.stringify({
    pockly_payload_batch: "turn_payloads",
    version: turnPayloadBlobPointerVersion,
    items,
  });
  const batchHash = await sha256Base64URL(manifest);
  const encoded = await encodeTurnPayloadBlob(manifest);
  const first = candidates[0].turn;
  const last = candidates[candidates.length - 1].turn;
  const key = turnPayloadBatchBlobKey(first, last, batchHash, encoded.encoding);
  await blobStore.put(key, encoded.data, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      ...(encoded.encoding ? { contentEncoding: encoded.encoding } : {}),
    },
  });
  return new Map(candidates.map((candidate, index) => [candidate.index, {
    pockly_payload_ref: "blob_batch",
    version: turnPayloadBlobPointerVersion,
    key,
    batch_sha256: batchHash,
    item_seq: items[index].seq,
    sha256: items[index].sha256,
    bytes: items[index].bytes,
    encoded_bytes: encoded.byteLength,
    ...(encoded.encoding ? { encoding: encoded.encoding } : {}),
  }]));
}

async function externalizeTurnPayload(turn, blobStore, threshold) {
  if (!turn?.payload) return turn;
  const payload = String(turn.payload);
  if (utf8ByteLength(payload) < threshold && !isTurnPayloadPointerObject(parsePayload(payload))) return turn;
  const hash = await sha256Base64URL(payload);
  const encoded = await encodeTurnPayloadBlob(payload);
  const key = turnPayloadBlobKey(turn, hash, encoded.encoding);
  await blobStore.put(key, encoded.data, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      ...(encoded.encoding ? { contentEncoding: encoded.encoding } : {}),
    },
  });
  return {
    ...turn,
    payload: JSON.stringify({
      pockly_payload_ref: "blob",
      version: turnPayloadBlobPointerVersion,
      key,
      sha256: hash,
      bytes: utf8ByteLength(payload),
      encoded_bytes: encoded.byteLength,
      ...(encoded.encoding ? { encoding: encoded.encoding } : {}),
    }),
  };
}

async function resolveTurnPayload(payload, providers = {}, blobCache = new Map(), turn = null) {
  if (!payload) return undefined;
  const parsed = parsePayload(payload);
  if (!isTurnPayloadPointerObject(parsed)) return parsed;
  if (turn && !isCurrentTurnPayloadPointer(parsed, turn)) return { payload_ref_invalid: true };
  const blobStore = providers.historyBlobStore;
  if (!blobStore) return { payload_ref_unavailable: true };
  try {
    const text = await cacheBlobText(blobCache, parsed.key, blobStore, parsed);
    if (text === null) return { payload_ref_missing: true };
    if (parsed.pockly_payload_ref === "blob_batch") {
      return await resolveTurnPayloadBatchItem(text, parsed);
    }
    if (parsed.sha256 && await sha256Base64URL(text) !== parsed.sha256) {
      return { payload_ref_invalid: true };
    }
    return parsePayload(text);
  } catch {
    return { payload_ref_unavailable: true };
  }
}

async function cacheBlobText(blobCache, key, blobStore, pointer) {
  const cacheKey = `text:${key}`;
  if (blobCache.has(cacheKey)) return await blobCache.get(cacheKey);
  return await cacheBlobGet(blobCache, cacheKey, (async () => {
    const object = await blobStore.get(key);
    if (!object) return null;
    return await decodeTurnPayloadBlob(object, pointer);
  })());
}

async function resolveTurnPayloadBatchItem(text, pointer) {
  if (pointer.batch_sha256 && await sha256Base64URL(text) !== pointer.batch_sha256) {
    return { payload_ref_invalid: true };
  }
  const batch = parsePayload(text);
  if (
    !batch ||
    typeof batch !== "object" ||
    batch.pockly_payload_batch !== "turn_payloads" ||
    batch.version !== turnPayloadBlobPointerVersion ||
    !Array.isArray(batch.items)
  ) {
    return { payload_ref_invalid: true };
  }
  const item = batch.items.find((candidate) => Number(candidate?.seq) === Number(pointer.item_seq));
  if (!item || typeof item.payload !== "string") return { payload_ref_missing: true };
  if (pointer.sha256 && await sha256Base64URL(item.payload) !== pointer.sha256) {
    return { payload_ref_invalid: true };
  }
  return parsePayload(item.payload);
}

async function encodeTurnPayloadBlob(payload) {
  const fallback = {
    data: payload,
    byteLength: utf8ByteLength(payload),
    encoding: "",
  };
  if (typeof CompressionStream !== "function" || typeof Blob !== "function") return fallback;
  try {
    const compressed = await new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    return {
      data: new Uint8Array(compressed),
      byteLength: compressed.byteLength,
      encoding: "gzip",
    };
  } catch {
    return fallback;
  }
}

async function decodeTurnPayloadBlob(object, pointer) {
  if (pointer?.encoding === "gzip") {
    if (typeof DecompressionStream !== "function") throw new Error("gzip payload refs require DecompressionStream");
    const source = await blobObjectArrayBuffer(object);
    return await new Response(new Blob([source]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  }
  return typeof object.text === "function" ? await object.text() : String(object);
}

async function blobObjectArrayBuffer(object) {
  if (typeof object?.arrayBuffer === "function") return await object.arrayBuffer();
  if (typeof object?.text === "function") return new TextEncoder().encode(await object.text()).buffer;
  if (object instanceof ArrayBuffer) return object;
  if (ArrayBuffer.isView(object)) {
    return object.buffer.slice(object.byteOffset, object.byteOffset + object.byteLength);
  }
  return new TextEncoder().encode(String(object)).buffer;
}

async function cacheBlobGet(blobCache, key, promise) {
  blobCache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    blobCache.delete(key);
    throw error;
  }
}

function turnPayloadBlobThreshold(env = {}) {
  const value = Number(env.POCKLY_TURN_PAYLOAD_BLOB_THRESHOLD_BYTES ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function historyBlobStorageEnabled(env = {}) {
  const value = env.POCKLY_HISTORY_BLOBS_ENABLED ?? "";
  return value === true || value === "1" || value === "true";
}

async function applyHotTurnPayloadPolicy(turns, env = {}) {
  const maxPayloadBytes = hotTurnMaxPayloadBytes(env);
  if (maxPayloadBytes <= 0) return turns;
  return await Promise.all(turns.map(async (turn) => {
    const payload = turn?.payload == null ? "" : String(turn.payload);
    const bytes = utf8ByteLength(payload);
    if (bytes <= maxPayloadBytes || isLocalOnlyPayloadPlaceholder(parsePayload(payload))) return turn;
    return {
      ...turn,
      payload: JSON.stringify({
        pockly_payload_ref: "local_only",
        reason: "payload_too_large",
        bytes,
        sha256: await sha256Base64URL(payload),
        preview: payloadPreview(payload),
        text: localOnlyPayloadText(bytes, payload),
      }),
    };
  }));
}

function hotTurnsPerSession(env = {}) {
  const profile = edgeRetentionProfile(env);
  return boundedPositiveInteger(env.POCKLY_HOT_TURNS_PER_SESSION, profile.hotTurnsPerSession);
}

function hotTurnsPerUser(env = {}) {
  const profile = edgeRetentionProfile(env);
  return boundedPositiveInteger(env.POCKLY_HOT_TURNS_PER_USER, profile.hotTurnsPerUser);
}

function hotTurnMaxPayloadBytes(env = {}) {
  return boundedPositiveInteger(env.POCKLY_HOT_TURN_MAX_PAYLOAD_BYTES, defaultHotTurnMaxPayloadBytes);
}

function hotTurnInactiveBefore(env = {}) {
  const profile = edgeRetentionProfile(env);
  const days = boundedPositiveInteger(env.POCKLY_HOT_TURN_TTL_DAYS, profile.hotTurnTTLDays);
  if (days <= 0) return "";
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function globalHotTurnPruneIntervalMs(env = {}) {
  const parsed = Number(env.POCKLY_GLOBAL_HOT_TURN_PRUNE_INTERVAL_MS ?? defaultGlobalHotTurnPruneIntervalMs);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultGlobalHotTurnPruneIntervalMs;
  return Math.floor(parsed);
}

function edgeRetentionProfile(env = {}) {
  const profile = String(env.POCKLY_EDGE_RETENTION_PROFILE || defaultEdgeRetentionProfile).trim().toLowerCase();
  return edgeRetentionProfiles[profile] || edgeRetentionProfiles[defaultEdgeRetentionProfile];
}

function boundedPositiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function isLocalOnlyPayloadPlaceholder(value) {
  return Boolean(value && typeof value === "object" && value.pockly_payload_ref === "local_only");
}

function payloadPreview(payload) {
  const parsed = parsePayload(payload);
  const text = typeof parsed?.text === "string" ? parsed.text : payload;
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 240)}...` : normalized;
}

function localOnlyPayloadText(bytes, payload) {
  const preview = payloadPreview(payload);
  const size = bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`;
  return [
    `[Large message omitted from the remote hot window: ${size}.]`,
    "Open the local daemon and load this history window again to fetch the full content from your computer.",
    preview ? `Preview: ${preview}` : "",
  ].filter(Boolean).join("\n\n");
}

function turnPayloadBatchRawBytes(env = {}) {
  const value = Number(env.POCKLY_TURN_PAYLOAD_BATCH_RAW_BYTES ?? defaultTurnPayloadBatchRawBytes);
  if (!Number.isFinite(value) || value <= 0) return defaultTurnPayloadBatchRawBytes;
  return Math.max(1, Math.floor(value));
}

function turnPayloadBlobKey(turn, hash, encoding = "") {
  return `${turnPayloadBlobKeyPrefix(turn)}/${hash}.json${encoding === "gzip" ? ".gz" : ""}`;
}

function turnPayloadBatchBlobKey(firstTurn, lastTurn, hash, encoding = "") {
  const firstSeq = String(Number(firstTurn.seq) || 0).padStart(12, "0");
  const lastSeq = String(Number(lastTurn.seq) || 0).padStart(12, "0");
  return `${turnPayloadBatchBlobKeyPrefix(firstTurn)}/${firstSeq}-${lastSeq}-${hash}.json${encoding === "gzip" ? ".gz" : ""}`;
}

function turnPayloadBlobKeyPrefix(turn) {
  return [
    "session-turns",
    encodeBlobKeyPart(turn.user_id),
    encodeBlobKeyPart(turn.device_id),
    encodeBlobKeyPart(turn.session_id),
    String(Number(turn.seq) || 0).padStart(12, "0"),
  ].join("/");
}

function turnPayloadBatchBlobKeyPrefix(turn) {
  return [
    "session-turn-batches",
    encodeBlobKeyPart(turn.user_id),
    encodeBlobKeyPart(turn.device_id),
    encodeBlobKeyPart(turn.session_id),
  ].join("/");
}

function encodeBlobKeyPart(value) {
  return encodeURIComponent(String(value || "").replace(/%/g, "%25"));
}

function isTurnPayloadPointerObject(value, turn = null) {
  const validShape = Boolean(
    value &&
    typeof value === "object" &&
    (value.pockly_payload_ref === "blob" || value.pockly_payload_ref === "blob_batch") &&
    value.version === turnPayloadBlobPointerVersion &&
    typeof value.key === "string" &&
    (value.key.startsWith("session-turns/") || value.key.startsWith("session-turn-batches/")) &&
    (value.key.endsWith(".json") || value.key.endsWith(".json.gz"))
  );
  if (!validShape) return false;
  if (!turn) return true;
  if (value.pockly_payload_ref === "blob_batch") {
    return Number(value.item_seq) === Number(turn.seq) && value.key.startsWith(`${turnPayloadBatchBlobKeyPrefix(turn)}/`);
  }
  return value.key.startsWith(`${turnPayloadBlobKeyPrefix(turn)}/`);
}

function isCurrentTurnPayloadPointer(value, turn) {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value.pockly_payload_ref === "blob" || value.pockly_payload_ref === "blob_batch") &&
    value.version === turnPayloadBlobPointerVersion &&
    isTurnPayloadPointerObject(value, turn),
  );
}

async function collectMissingSessionHistoryBlobKeys(store, providers = {}, userID, deviceID, keepSessionIDs = [], existingSessions = []) {
  if (!providers.historyBlobStore) return [];
  const keep = new Set(keepSessionIDs.map((id) => String(id)));
  const staleSessionIDs = existingSessions
    .map((session) => String(session.session_id || ""))
    .filter((sessionID) => sessionID && !keep.has(sessionID));
  return await collectHistoryBlobKeysForSessions(store, userID, deviceID, staleSessionIDs);
}

async function collectSessionHistoryBlobKeys(store, providers = {}, userID, deviceID, sessionID) {
  if (!providers.historyBlobStore) return [];
  return await collectHistoryBlobKeysForSessions(store, userID, deviceID, [sessionID]);
}

async function collectHistoryBlobKeysForSessions(store, userID, deviceID, sessionIDs = []) {
  const keys = new Set();
  const ids = sessionIDs.map((id) => String(id)).filter(Boolean);
  if (!ids.length) return [];
  if (typeof store.listTurnPayloadPointers === "function") {
    for (const turn of await store.listTurnPayloadPointers(userID, deviceID, ids)) {
      const pointer = parsePayload(turn.payload);
      if (isCurrentTurnPayloadPointer(pointer, { user_id: userID, device_id: deviceID, ...turn })) keys.add(pointer.key);
    }
    return [...keys];
  }
  for (const sessionID of ids) {
    const turns = await store.listTurns(userID, deviceID, sessionID);
    for (const turn of turns) {
      const pointer = parsePayload(turn.payload);
      if (isCurrentTurnPayloadPointer(pointer, turn)) keys.add(pointer.key);
    }
  }
  return [...keys];
}

async function deleteHistoryBlobsBestEffort(providers = {}, keys = []) {
  const blobStore = providers.historyBlobStore;
  if (!blobStore || typeof blobStore.delete !== "function" || !keys.length) return;
  await Promise.all([...new Set(keys)].map(async (key) => {
    try {
      await blobStore.delete(key);
    } catch {
      // History blob GC is best-effort: stale objects are cheaper than making a
      // successful session deletion or reconcile fail because object storage is
      // transiently unavailable.
    }
  }));
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
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
