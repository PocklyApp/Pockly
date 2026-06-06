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
  managedRuntimeCapabilities,
} from "./contract.js";
import { createStore } from "./store.js";

const onlineWindowMs = 2 * 60 * 1000;

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  const store = createStore(env);

  try {
    if (path === "/healthz") return await healthz(request);
    if (path === "/api/runtime") return await runtime(request, env);
    if (path === "/api/auth/session") return await authSession(request, store);
    if (path === "/api/auth/logout") return await authLogout(request, store);
    if (path === "/api/dev/login") return await devLogin(request, store);
    if (path === "/api/auth/login") return await passwordLogin(request, store);
    if (path === "/api/auth/register") return await registerAccount(request, store);
    if (path === "/api/auth/register/verify") return await verifyRegistration(request, store);
    if (path === "/api/auth/verification/resend") return await resendVerification(request);
    if (path === "/api/daemon/login-codes") return await createDaemonLoginCode(request, store);
    if (path === "/api/daemon/login") return await daemonLogin(request, store);
    if (path === "/api/daemon/remote-access") return await setDaemonRemoteAccess(request, store);
    if (path === "/api/daemon/sync") return await daemonSync(request, store);
    if (path === "/api/devices/register-browser") return await registerBrowser(request, store);
    if (path === "/api/devices/announce") return await announceBrowser(request, store);
    if (path === "/api/devices") return await listDevices(request, store);
    if (path === "/api/devices/revoke") return await revokeDevice(request, store);
    if (path === "/api/device-challenge") return await createDeviceChallenge(request, store);
    if (path === "/api/device-challenge/verify") return await verifyDeviceChallenge(request, store);
    if (path === "/api/hosts/online") return await listOnlineHosts(request, store);
    if (path === "/api/sessions") return await listSessions(request, store);
    if (path === "/api/agent-defaults") return await agentDefaults(request);
    if (path === "/api/telemetry/web" || path === "/api/telemetry/daemon") return await acceptTelemetry(request);

    const devicePatch = path.match(/^\/api\/devices\/([^/]+)$/);
    if (devicePatch) return await patchDevice(request, store, decodeURIComponent(devicePatch[1]));

    const sessionTurns = path.match(/^\/api\/sessions\/([^/]+)\/turns$/);
    if (sessionTurns) return await listSessionTurns(request, store, decodeURIComponent(sessionTurns[1]), url);

    const sessionAction = path.match(/^\/api\/sessions\/([^/]+)\/(inject|sync|agent-settings|diff)$/);
    if (sessionAction) return await unsupportedControl(request, sessionAction[2]);

    if (path === "/api/ws" || path === "/api/daemon/control") {
      return errorResponse("realtime control is not enabled in this worker build", ErrorCode.UnsupportedRuntime, { status: 501 });
    }

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
  return jsonResponse({ ok: true, service: "pockly-managed-runtime" });
}

async function runtime(request, env) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  return jsonResponse(managedRuntimeCapabilities(env));
}

async function devLogin(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
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
  await store.upsertUser({
    user_id: randomID("usr"),
    email,
    name: body.name || email.split("@")[0],
    password_hash: await hashPassword(requiredString(body.password, "password")),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
  return jsonResponse({
    status: "verification_required",
    email,
    expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    resend_after_seconds: 30,
  });
}

async function verifyRegistration(request, store) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await readJSON(request);
  const user = await store.getUserByEmail(requiredString(body.email, "email").toLowerCase());
  if (!user) return errorResponse("registration not found", ErrorCode.NotFound, { status: 404 });
  return jsonResponse({ user: publicUser(user) });
}

async function resendVerification(request) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  return jsonResponse({ status: "queued", resend_after_seconds: 30 });
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
  const browserDeviceID = body.browser_device_id || randomID("bd");
  const device = await store.upsertDevice({
    device_id: browserDeviceID,
    user_id: user.user_id,
    device_type: "browser",
    device_name: body.device_name || "Browser",
    public_key: requiredString(body.browser_device_pubkey, "browser_device_pubkey"),
    status: "active",
    remote_access_enabled: false,
    user_agent: body.user_agent || "",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    last_seen_at: now.toISOString(),
  });
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
  await store.touchDevice(device.device_id, new Date().toISOString());
  return jsonResponse({ announced: true, daemons_notified: 0 });
}

async function listDevices(request, store) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireWebUser(request, store);
  const devices = await store.listDevicesForUser(user.user_id);
  return jsonResponse({ devices: devices.map(publicDevice) });
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
  const uploadedTurnsBySession = new Map();
  for (const turn of turns) {
    const sessionID = String(turn.session_id ?? "");
    uploadedTurnsBySession.set(sessionID, (uploadedTurnsBySession.get(sessionID) ?? 0) + 1);
  }
  if (body.full_reconcile) {
    await store.deleteMissingDeviceSessions(user.user_id, device.device_id, sessions.map((session) => String(session.session_id)));
  }
  for (const session of sessions) {
    await store.upsertSession(syncSessionRecord(user, device, session, now, uploadedTurnsBySession.get(String(session.session_id)) ?? 0));
  }
  for (const turn of turns) {
    await store.upsertTurn(syncTurnRecord(user, device, turn, now));
  }
  return jsonResponse({
    ok: true,
    session_count: sessions.length,
    turn_count: turns.length,
    daemon_device: device.device_id,
    daemon_version: body.hello?.version ?? "",
  });
}

async function listSessions(request, store) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store);
  const sessions = await store.listSessionsForUser(user.user_id);
  const devices = new Map((await store.listDevicesForUser(user.user_id)).map((device) => [device.device_id, device]));
  return jsonResponse({ sessions: sessions.map((session) => publicSession(session, devices.get(session.device_id))) });
}

async function listSessionTurns(request, store, sessionID, url) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireDeviceAuth(request, store);
  const deviceID = url.searchParams.get("device_id") ?? "";
  if (!deviceID) return errorResponse("device_id is required", ErrorCode.BadRequest, { status: 400 });
  const session = await store.getSession(user.user_id, deviceID, sessionID);
  if (!session) return errorResponse("session not found", ErrorCode.NotFound, { status: 404 });
  const turns = await store.listTurns(user.user_id, deviceID, sessionID);
  const parsedTurns = turns.map(publicTurn);
  return jsonResponse({
    session_id: sessionID,
    turns: parsedTurns,
    oldest_seq: parsedTurns[0]?.seq,
    latest_seq: parsedTurns[parsedTurns.length - 1]?.seq,
    synced_turn_count: session.synced_turn_count ?? parsedTurns.length,
    total_turn_count: session.turn_count ?? parsedTurns.length,
    has_older_turns: Boolean(session.has_older_turns),
    needs_sync: parsedTurns.length === 0 && (session.turn_count ?? 0) > 0,
  });
}

async function listOnlineHosts(request, store) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { user } = await requireUserFromCookieOrDevice(request, store);
  const devices = await store.listDevicesForUser(user.user_id);
  const sessions = await store.listSessionsForUser(user.user_id);
  const activeSessionsByDevice = new Map();
  for (const session of sessions) {
    activeSessionsByDevice.set(session.device_id, (activeSessionsByDevice.get(session.device_id) ?? 0) + 1);
  }
  return jsonResponse({
    hosts: devices
      .filter((device) => device.device_type === "daemon" && device.status !== "revoked")
      .map((device) => publicHost(device, activeSessionsByDevice.get(device.device_id) ?? 0)),
  });
}

async function agentDefaults(request) {
  if (request.method !== "GET") return methodNotAllowed("GET");
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

async function acceptTelemetry(request) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  await request.text();
  return jsonResponse({ ok: true });
}

async function unsupportedControl(request, action) {
  if (!["GET", "POST"].includes(request.method)) return methodNotAllowed("GET, POST");
  return errorResponse(`${action} requires a live daemon control connection`, ErrorCode.DaemonOffline, { status: 503 });
}

async function issueWebSession(store, user, now) {
  const token = await createOpaqueToken("ws");
  const expiresAt = new Date(now.getTime() + WEB_SESSION_TTL_SECONDS * 1000);
  await store.createWebSession({
    session_token_hash: await sha256Base64URL(token),
    user_id: user.user_id,
    expires_at: expiresAt.toISOString(),
    created_at: now.toISOString(),
  });
  return jsonResponse(publicUser(user), { headers: { "set-cookie": sessionCookie(token, expiresAt) } });
}

async function upsertDaemonDevice(store, user, body, now) {
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

function syncSessionRecord(user, device, session, now, uploadedTurnCount) {
  const minSeq = Number(session.min_seq ?? 0);
  const maxSeq = Number(session.max_seq ?? session.last_seq ?? 0);
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
    sync_state: session.sync_state || (uploadedTurnCount > 0 ? "ready" : "catalog_only"),
    turn_count: Number(session.turn_count ?? 0),
    last_sync_error: "",
    synced_turn_count: uploadedTurnCount,
    synced_min_seq: uploadedTurnCount > 0 ? minSeq : 0,
    synced_max_seq: uploadedTurnCount > 0 ? maxSeq : 0,
    has_older_turns: Boolean(session.has_older),
    updated_at: session.last_timestamp || now,
  };
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

function publicSession(session, device) {
  const online = isOnline(device?.last_seen_at);
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

function publicHost(device, activeSessionCount) {
  const online = isOnline(device.last_seen_at);
  return {
    device_id: device.device_id,
    device_name: device.device_name ?? "",
    hostname: device.hostname,
    os: device.os,
    app_version: device.app_version,
    status: device.status,
    presence_status: online ? "online" : "offline",
    presence_reason: online ? "recent_sync" : "last_seen_expired",
    control_connected: false,
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

function badRequest(error) {
  const err = new Error(error);
  err.response = errorResponse(error, ErrorCode.BadRequest, { status: 400 });
  return err;
}

function randomID(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
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
