/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { clearBrowserDeviceState, ensureBrowserDeviceState, loadBrowserDeviceState, persistBrowserTokens, signBrowserChallenge } from "./crypto";
import { trackEvent } from "./observability";

export type User = {
  user_id: string;
  email: string;
  name: string;
};

export type Device = {
  device_id: string;
  device_type: "daemon" | "browser";
  device_name: string;
  status: "active" | "offline" | "revoked";
  capabilities?: string[];
  first_paired_at?: string;
  last_seen_at?: string;
  os?: string;
  hostname?: string;
  user_agent?: string;
  app_version?: string;
  daemon_latest_version?: string;
  daemon_update_available?: boolean;
  daemon_update_checked_at?: string;
  daemon_update_source?: string;
  daemon_update_error?: string;
  remote_access_enabled?: boolean;
  computer_id?: string;
  computer_public_key?: string;
  superseded_by_device_id?: string;
};

export type HostSummary = {
  device_id: string;
  device_name: string;
  hostname?: string;
  os?: string;
  app_version?: string;
  daemon_latest_version?: string;
  daemon_update_available?: boolean;
  daemon_update_checked_at?: string;
  daemon_update_source?: string;
  daemon_update_error?: string;
  status: "active" | "offline" | "revoked";
  presence_status?: "online" | "connecting" | "degraded" | "offline";
  presence_reason?: string;
  control_connected?: boolean;
  remote_access_enabled: boolean;
  last_seen_at: string;
  last_channel_seen_at?: string;
  active_session_count: number;
  connected: boolean;
};

export type PairingGrantState = {
  pairing_grant: string;
  daemon_device_id: string;
  daemon_pubkey: string;
  relay_url: string;
  short_code: string;
  device_name: string;
  exp: string;
  status: string;
  user_id?: string;
  browser_device_id?: string;
  browser_device_name?: string;
  user_display?: string;
};

export type PairingClaim = {
  browser_device_id: string;
  device_access_token: string;
  device_refresh_token: string;
};

export type SessionListItem = {
  session_id: string;
  device_id: string;
  computer_id?: string;
  agent: string;
  runner_alias?: "claude" | "claude_ccr" | "custom";
  cwd: string;
  // snippet is the plaintext first-user-message preview the relay stores for
  // the sidebar label (E2E removed — no per-browser encrypted_snippet).
  snippet: string;
  // title is the relay-generated concise label (SiliconFlow, from the first
  // message). Preferred over the snippet-derived name; absent (omitempty)
  // until the async title worker fills it in.
  title?: string;
  last_seq: number;
  last_timestamp: string;
  channel_last_seen_at?: string;
  sync_state?: "catalog_only" | "partial" | "syncing" | "fully_synced" | "ready" | "failed";
  connection_mode?:
    // Live PTY wrapper bound; web mirrors the user's TUI.
    | "pty_backed_duplex"
    // No PTY; daemon will spawn `claude --resume` headless on next inject.
    | "sdk_headless"
    // SDK subprocess actively emitting a turn.
    | "sdk_running"
    // Daemon is offline. The only non-writable state.
    | "read_only"
    | "unknown"
    // Legacy values from pre-2026-05-25 relays; normalized to read_only /
    // unknown by sessionConnectionMode().
    | "read_only_sync"
    | "detached";
  writable?: boolean;
  turn_count?: number;
  last_sync_error?: string;
  synced_turn_count?: number;
  synced_min_seq?: number;
  synced_max_seq?: number;
  has_older_turns?: boolean;
};

export type SessionTurn = {
  device_id?: string;
  browser_device_id?: string;
  session_id: string;
  seq: number;
  agent: string;
  kind: string;
  timestamp: string;
  payload?: {
    uuid?: string;
    text?: string;
    attachment_type?: string;
    meta_type?: string;
    tool?: string;
    id?: string;
    input?: unknown;
    result?: string;
    is_error?: boolean;
    has_result?: boolean;
    append?: boolean;
    // UI-synthesized: set by mergeAdjacentToolPairs when a tool_result was
    // folded onto this tool_call so the renderer collapses them into one
    // card. Never sent over the wire.
    _paired_result?: boolean;
    // UI-synthesized: set on the carrier turn produced by
    // groupConsecutiveTools — holds the original tool_call turns that were
    // clustered. The renderer shows a summary row that expands into the
    // per-item one-liner cards. Never sent over the wire.
    _group_items?: SessionTurn[];
    // UI-synthesized: set on the Task tool_call carrier turn by
    // nestSidechainTurns — holds the subagent's blocks so the renderer
    // can show them collapsed under the Task card. Never sent over the wire.
    _sidechain_items?: SessionTurn[];
    // v0.2.0: structured fields piggy-backing on the permission_request
    // attachment so the interactive Approve/Deny card can render without
    // re-parsing the text. Empty / undefined on legacy v0.1.42 emissions
    // (which had no request_id and used decision="allow" baked into text).
    permission_request_id?: string;
    permission_tool_name?: string;
    permission_input_preview?: string;
    permission_decision?: string; // "pending" | "allow" | "deny" | "local_confirmation"
    permission_reason?: string;
    permission_daemon_device_id?: string;
    // Subagent threading. parent_tool_use_id is the tool_use id of the
    // spawning Task tool_call when this block belongs to a sidechain
    // (subagent) conversation. is_sidechain is the raw JSONL flag.
    parent_tool_use_id?: string;
    is_sidechain?: boolean;
    // Token usage. Attached to the LAST block produced from an assistant
    // message envelope; web aggregates the most-recent value into a
    // context-window meter. Zero/missing on user / tool_result / older
    // daemon emissions.
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    // Image content. Set on image-kind turns; image_data is raw base64
    // (web wraps as data URL on render), image_url is the fallback for
    // source.type=="url" emissions.
    image_media_type?: string;
    image_data?: string;
    image_url?: string;
  };
};

export type WSState = "connecting" | "live" | "reconnecting" | "disconnected" | "error";

export type InjectEvent = {
  request_id: string;
  type: "inject_started" | "stream_event" | "session_created" | "approval_required" | "inject_completed" | "inject_failed" | "inject_cancelled";
  turn?: SessionTurn;
  session_id?: string;
  message?: string;
  error?: string;
};

export type SyncSessionEvent = {
  request_id: string;
  session_id: string;
  device_id?: string;
  stage: "queued" | "locating" | "extracting" | "encrypting" | "uploading" | "completed" | "failed";
  status: "running" | "completed" | "failed";
  processed?: number;
  total?: number;
  min_seq?: number;
  max_seq?: number;
  has_older?: boolean;
  total_turn_count?: number;
  message?: string;
  error?: string;
};

export type SessionTurnsResponse = {
  session_id: string;
  turns: SessionTurn[];
  oldest_seq?: number;
  latest_seq?: number;
  synced_turn_count?: number;
  total_turn_count?: number;
  has_older_turns?: boolean;
  needs_sync?: boolean;
};

export type TerminalSession = {
  terminal_session_id: string;
  daemon_device_id: string;
  browser_device_id?: string;
  session_id?: string;
  agent: string;
  cwd: string;
  session_status: "starting" | "live" | "exited" | "error";
  turn_status: "idle" | "submitted" | "streaming" | "awaiting_input" | "interrupted";
  error?: string;
  created_at: string;
  updated_at: string;
};

export type TerminalEvent = {
  request_id?: string;
  terminal_session_id: string;
  seq?: number;
  kind: "session_started" | "session_ready" | "user_input" | "text_delta" | "message_added" | "permission_request" | "prompt_ready" | "agent_error" | "session_exited" | "session_disconnected" | "error" | "terminal_session";
  session_status?: TerminalSession["session_status"];
  turn_status?: TerminalSession["turn_status"];
  payload?: string;
  error?: string;
  timestamp?: string;
};

export type DaemonProjectSession = {
  session_id: string;
  timestamp?: string;
  snippet?: string;
};

export type DaemonProject = {
  agent: string;
  cwd: string;
  sessions: DaemonProjectSession[];
};

export type DaemonBlock = {
  kind: "user_message" | "assistant_text" | "tool_call" | "tool_result" | "thinking" | "attachment" | "meta" | "image";
  timestamp?: string;
  uuid?: string;
  text?: string;
  attachment_type?: string;
  meta_type?: string;
  tool?: string;
  id?: string;
  input?: unknown;
  result?: string;
  is_error?: boolean;
  has_result?: boolean;
  parent_tool_use_id?: string;
  is_sidechain?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  image_media_type?: string;
  image_data?: string;
  image_url?: string;
};

export type DaemonSessionBlocks = {
  session_id: string;
  cwd?: string;
  agent: string;
  blocks: DaemonBlock[];
};

export type SessionSubscription = {
  close: () => void;
};

export type PushRegistration = {
  subscription_id: string;
  status: "active";
};

export type VoiceTranscription = {
  text: string;
  provider: string;
  duration_ms: number;
  fallback_used: boolean;
};

export type FeedbackSubmission = {
  feedback_id: string;
  status: "accepted";
};

export type DaemonDeviceAuthorization = {
  device_code: string;
  user_code: string;
  daemon: {
    device_id: string;
    device_name: string;
    hostname?: string;
    os?: string;
    app_version?: string;
  };
  requested_capabilities: string[];
  status: "pending" | "authorized" | "denied" | "expired" | "consumed";
  expires_at: string;
};

type BrowserDeviceChallenge = {
  challenge_id: string;
  device_id: string;
  audience: string;
  nonce: string;
};

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  const text = await res.text();
  const data = text ? parseJSONBody(text) : null;
  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data
      ? String((data as { error: unknown }).error)
      : looksLikeHTML(text)
        ? `${res.status} ${res.statusText || "service unavailable"}`.trim()
      : text.trim() || `${res.status} ${res.statusText}`.trim();
    // v0.1.41 #2: distinguish auth expiry from generic errors so callers
    // (and the top-level app-shell auth hook) can surface a re-login
    // banner instead of swallowing the failure.
    if (res.status === 401) {
      // The bearer we sent is no longer valid — token expired, device
      // revoked, or the relay rotated its per-boot signing key on
      // restart (accessTokenKey = mustRandomBytes). Drop the cached
      // browser-device token so the NEXT authed call re-handshakes
      // instead of replaying the dead token for the rest of the cache
      // window. No-op for cookie-only (non-bearer) 401s.
      invalidateBrowserDeviceToken();
      throw new AuthExpiredError(message);
    }
    throw new Error(message);
  }
  if (!data) return undefined as T;
  return data as T;
}

function looksLikeHTML(text: string) {
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}

function parseJSONBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function getSession() {
  return fetchJSON<{ authenticated: boolean; user?: User }>("/api/auth/session", {
    method: "GET",
  });
}

export async function devLogin(email: string, name: string) {
  return fetchJSON<User>("/api/dev/login", {
    method: "POST",
    body: JSON.stringify({ email, name }),
  });
}

export async function loginWithPassword(email: string, password: string) {
  return fetchJSON<User>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function logout() {
  return fetchJSON<{ ok: boolean }>("/api/auth/logout", {
    method: "POST",
  });
}

export async function registerAccount(input: { email: string; name: string; password: string }) {
  return fetchJSON<{
    status: "verification_required";
    email: string;
    expires_at: string;
    resend_after_seconds: number;
  }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function verifyRegistration(email: string, code: string) {
  return fetchJSON<{ user: User }>("/api/auth/register/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
}

export async function resendRegistrationCode(email: string) {
  return fetchJSON<{ status: string; resend_after_seconds: number }>("/api/auth/verification/resend", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function consumePairingGrant(input: {
  pairing_grant: string;
  browser_device_pubkey: string;
  device_name: string;
  user_agent: string;
}) {
  return fetchJSON<{
    status: string;
    pairing_grant: string;
    browser_device_id: string;
    short_code: string;
    user_display: string;
    daemon_device_name: string;
  }>("/api/pairing-grants/consume", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getPairingGrant(grantId: string) {
  return fetchJSON<PairingGrantState>(`/api/pairing-grants/${grantId}`, { method: "GET" });
}

export async function claimPairingGrant(grantId: string) {
  return fetchJSON<PairingClaim>(`/api/pairing-grants/${grantId}/claim`, { method: "POST" });
}

export async function createDaemonLoginCode() {
  return fetchJSON<{ login_code: string; expires_at: string }>("/api/daemon/login-codes", { method: "POST" });
}

export async function getDaemonDeviceAuthorization(deviceCode: string) {
  return fetchJSON<DaemonDeviceAuthorization>(
    `/api/daemon/device-authorizations/${encodeURIComponent(deviceCode)}`,
    { method: "GET" },
  );
}

export async function authorizeDaemonDevice(deviceCode: string, input?: {
  browser_device_id?: string;
  browser_device_pubkey: string;
  device_name: string;
  user_agent: string;
}) {
  return fetchJSON<{
    // After the security hardening, /authorize no longer returns "authorized"
    // synchronously. The mobile claim is held until the daemon explicitly
    // confirms on the host machine; poll claim-status until terminal.
    status: "awaiting_daemon_confirm";
    daemon_device_id?: string;
    browser_device_id?: string;
    expires_at?: string;
  }>(
    `/api/daemon/device-authorizations/${encodeURIComponent(deviceCode)}/authorize`,
    {
      method: "POST",
      ...(input ? { body: JSON.stringify(input) } : {}),
    },
  );
}

export type DaemonClaimStatus =
  | "pending"
  | "awaiting_daemon_confirm"
  | "authorized"
  | "denied"
  | "denied_by_daemon"
  | "expired"
  | "consumed";

export async function getDaemonAuthClaimStatus(deviceCode: string) {
  return fetchJSON<{
    status: DaemonClaimStatus;
    daemon_device_id: string;
    browser_device_id?: string;
    device_name?: string;
    hostname?: string;
    os?: string;
    expires_at: string;
    claim_requested_at?: string | null;
    daemon_confirmed_at?: string | null;
    daemon_denied_at?: string | null;
  }>(
    `/api/daemon/device-authorizations/${encodeURIComponent(deviceCode)}/claim-status`,
    { method: "GET" },
  );
}

export async function denyDaemonDevice(deviceCode: string) {
  return fetchJSON<{ status: "denied" }>(
    `/api/daemon/device-authorizations/${encodeURIComponent(deviceCode)}/deny`,
    { method: "POST" },
  );
}

export async function listOnlineHosts(browserDeviceId?: string) {
  const url = new URL("/api/hosts/online", window.location.origin);
  if (browserDeviceId) url.searchParams.set("browser_device_id", browserDeviceId);
  return fetchJSON<{ hosts: HostSummary[] }>(url.toString(), { method: "GET" });
}

export async function connectHost(hostDeviceId: string, input: {
  browser_device_id?: string;
  browser_device_pubkey: string;
  device_name: string;
  user_agent: string;
}) {
  return fetchJSON<{
    status: string;
    request_id: string;
    browser_device_id: string;
    daemon_device_id: string;
  }>(`/api/hosts/${encodeURIComponent(hostDeviceId)}/connect`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function claimDaemonSetupGrant(grantId: string, input: {
  browser_device_id?: string;
  browser_device_pubkey: string;
  device_name: string;
  user_agent: string;
}) {
  return fetchJSON<{
    status: "claimed";
    browser_device_id: string;
    daemon_device_id: string;
  }>(`/api/daemon/setup-grants/${encodeURIComponent(grantId)}/claim`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// claimDaemonLocal completes a daemon-initiated local install. The daemon
// opened https://pockly.example/local-setup#nonce=…&cb=…&grant=… in this
// browser; the page reads the grant id + nonce out of the fragment and posts
// them here. The relay binds the daemon to the current user, mints device
// tokens, and echoes the nonce so we can hand it to the daemon's loopback
// callback in a single round trip.
export async function claimDaemonLocal(input: {
  daemon_setup: string;
  browser_nonce: string;
  browser_device_id?: string;
  browser_device_pubkey: string;
  device_name: string;
  user_agent: string;
}) {
  return fetchJSON<{
    status: "claimed";
    daemon_device_id: string;
    browser_device_id: string;
    user: { user_id: string; email: string; name: string };
    remote_access_enabled: boolean;
    device_access_token: string;
    device_refresh_token: string;
    browser_nonce: string;
  }>("/api/daemon/local-claim", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createMobileJoinQRGrant() {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<{
    grant_token: string;
    expires_at: string;
    qr_payload: string;
  }>("/api/devices/qr-grant", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
  });
}

export async function claimMobileJoinQRGrant(input: {
  grant_token: string;
  browser_device_id?: string;
  browser_device_pubkey: string;
  device_name: string;
  user_agent: string;
}) {
  return fetchJSON<{
    status: "claimed";
    user: User;
    browser_device_id: string;
    device_access_token: string;
    device_refresh_token: string;
    daemons_notified: number;
  }>("/api/devices/qr-claim", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function announceCurrentBrowserDevice() {
  const auth = await authenticateBrowserDevice();
  const browserState = await ensureBrowserDeviceState();
  return fetchJSON<{ announced: boolean; daemons_notified: number }>("/api/devices/announce", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
    body: JSON.stringify({
      browser_device_id: browserState.deviceId,
    }),
  });
}

export async function listDevices() {
  return fetchJSON<{ devices: Device[] }>("/api/devices", { method: "GET" });
}

export async function revokeDevice(deviceId: string) {
  return fetchJSON<{ status: string; device_id: string }>("/api/devices/revoke", {
    method: "POST",
    body: JSON.stringify({ device_id: deviceId }),
  });
}

export async function renameDevice(deviceId: string, deviceName: string) {
  return fetchJSON<{ device: Device }>(`/api/devices/${encodeURIComponent(deviceId)}`, {
    method: "PATCH",
    body: JSON.stringify({ device_name: deviceName }),
  });
}

export async function listSessions() {
  return fetchWithBrowserDevice<{ sessions: SessionListItem[] }>("/api/sessions");
}

export async function registerCurrentBrowserDevice() {
  const browserState = await ensureBrowserDeviceState();
  const registered = await fetchJSON<{
    status: "registered";
    browser_device_id: string;
    device_access_token: string;
  }>("/api/devices/register-browser", {
    method: "POST",
    body: JSON.stringify({
      ...(browserState.deviceId ? { browser_device_id: browserState.deviceId } : {}),
      browser_device_pubkey: browserState.devicePublicKey,
      device_name: defaultBrowserDeviceName(),
      user_agent: navigator.userAgent,
    }),
  });
  persistBrowserTokens({
    browserDeviceId: registered.browser_device_id,
    accessToken: registered.device_access_token,
  });
  cacheBrowserAccessToken(registered.device_access_token);
  return registered;
}

export async function getSessionTurns(sessionId: string, deviceId: string) {
  const response = await fetchWithBrowserDevice<SessionTurnsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/turns`,
    { device_id: deviceId },
  );
  return response;
}

export async function streamSessionInject(input: {
  sessionId: string;
  deviceId: string;
  text: string;
  model?: string;
  // Optional attachments. When present the request is sent as multipart so the
  // relay can forward the file bytes to the daemon, which writes them to disk
  // and appends @<path> references to the prompt for Claude Code / Codex.
  files?: File[];
  signal?: AbortSignal;
  onEvent: (event: InjectEvent) => void;
}) {
  const url = `/api/sessions/${encodeURIComponent(input.sessionId)}/inject`;
  const query = { device_id: input.deviceId };
  if (input.files && input.files.length > 0) {
    const form = new FormData();
    form.set("text", input.text);
    if (input.model) form.set("model", input.model);
    for (const file of input.files) form.append("files", file, file.name);
    return streamControlMultipart<InjectEvent>(url, query, form, input.onEvent, input.signal);
  }
  return streamControl(
    url,
    query,
    { text: input.text, model: input.model },
    input.onEvent,
    input.signal,
  );
}

// Composer-pills surface (v0.3.x): the daemon owns model + permission
// mode + effort per terminal session. The web reads them on session
// select and writes them whenever the user picks a different pill
// value. Effort is now carried explicitly through the relay/daemon
// wire path for both existing-session injection and first-message task
// creation; the daemon maps it to the selected agent's native launch or
// turn parameter where supported.
export type AgentSettingsSnapshot = {
  current: {
    model?: string;
    resolved_model?: string;
    permission_mode?: string;
    effort?: string;
  };
  available_models: string[];
  available_model_options?: AgentModelOption[];
  available_permission_modes: string[];
  available_efforts: string[];
};

export type AgentModelOption = {
  value: string;
  label?: string;
  resolved_model?: string;
  source?: string;
};

export async function getAgentSettings(input: {
  sessionId: string;
  deviceId: string;
  signal?: AbortSignal;
}): Promise<AgentSettingsSnapshot> {
  const auth = await authenticateBrowserDevice();
  const init: RequestInit = {
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
  };
  if (input.signal) init.signal = input.signal;
  return fetchJSON<AgentSettingsSnapshot>(
    `/api/sessions/${encodeURIComponent(input.sessionId)}/agent-settings?device_id=${encodeURIComponent(input.deviceId)}`,
    init,
  );
}

// Real working-tree diff for the Diffs drawer: the daemon runs `git diff`
// (uncommitted changes vs HEAD + untracked files) in the session cwd. Because
// it's a live git diff, committing naturally clears it. status is "ok" |
// "not_a_repo".
export type SessionGitDiff = { status: string; diff: string; truncated: boolean };

export async function getSessionDiff(input: {
  sessionId: string;
  deviceId: string;
  signal?: AbortSignal;
}): Promise<SessionGitDiff> {
  const auth = await authenticateBrowserDevice();
  const init: RequestInit = {
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
  };
  if (input.signal) init.signal = input.signal;
  return fetchJSON<SessionGitDiff>(
    `/api/sessions/${encodeURIComponent(input.sessionId)}/diff?device_id=${encodeURIComponent(input.deviceId)}`,
    init,
  );
}

// v0.3: session-less defaults for the draft composer. Returns the
// available model/permission/effort lists for a given daemon + cwd
// — used BEFORE a real session exists so the user can pick a custom
// project-config model (DeepSeek, etc.) on the first message instead
// of being stuck on the hardcoded sonnet/opus/haiku alias list.
export type AgentDefaultsSnapshot = {
  // default_model is the model claude would launch with absent an
  // explicit --model (from project/user config). Empty when no config
  // pins one. Lets the draft pill show a concrete name pre-send.
  default_model?: string;
  resolved_model?: string;
  available_models: string[];
  available_model_options?: AgentModelOption[];
  available_permission_modes: string[];
  available_efforts: string[];
};

export async function getAgentDefaults(input: {
  daemonDeviceId: string;
  cwd: string;
  agent?: string;
  signal?: AbortSignal;
}): Promise<AgentDefaultsSnapshot> {
  const auth = await authenticateBrowserDevice();
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${auth.device_access_token}` },
  };
  if (input.signal) init.signal = input.signal;
  const qs = new URLSearchParams();
  qs.set("daemon_device_id", input.daemonDeviceId);
  if (input.agent) qs.set("agent", input.agent);
  if (input.cwd) qs.set("cwd", input.cwd);
  return fetchJSON<AgentDefaultsSnapshot>(`/api/agent-defaults?${qs.toString()}`, init);
}

export async function setAgentSettings(input: {
  sessionId: string;
  deviceId: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  signal?: AbortSignal;
}): Promise<AgentSettingsSnapshot> {
  const auth = await authenticateBrowserDevice();
  const body: Record<string, string> = {};
  if (input.model !== undefined) body.model = input.model;
  if (input.permissionMode !== undefined) body.permission_mode = input.permissionMode;
  if (input.effort !== undefined) body.effort = input.effort;
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
    body: JSON.stringify(body),
  };
  if (input.signal) init.signal = input.signal;
  return fetchJSON<AgentSettingsSnapshot>(
    `/api/sessions/${encodeURIComponent(input.sessionId)}/agent-settings?device_id=${encodeURIComponent(input.deviceId)}`,
    init,
  );
}


export async function streamSessionSync(input: {
  sessionId: string;
  deviceId: string;
  limit?: number;
  beforeSeq?: number;
  signal?: AbortSignal;
  onEvent: (event: SyncSessionEvent) => void;
}) {
  return streamControl(
    `/api/sessions/${encodeURIComponent(input.sessionId)}/sync`,
    { device_id: input.deviceId },
    { limit: input.limit ?? 20, before_seq: input.beforeSeq ?? 0 },
    input.onEvent,
    input.signal,
  );
}

export async function streamNewTask(input: {
  daemonDeviceId: string;
  agent: string;
  cwd: string;
  text: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  signal?: AbortSignal;
  onEvent: (event: InjectEvent) => void;
}) {
  return streamControl(
    "/api/tasks",
    undefined,
    buildNewTaskRequestBody(input),
    input.onEvent,
    input.signal,
  );
}

export function buildNewTaskRequestBody(input: {
  daemonDeviceId: string;
  agent: string;
  cwd: string;
  text: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
}) {
  return {
    daemon_device_id: input.daemonDeviceId,
    agent: input.agent,
    cwd: input.cwd,
    text: input.text,
    model: input.model,
    permission_mode: input.permissionMode,
    effort: input.effort,
  };
}

export type DirEntry = {
  name: string;
  is_dir: boolean;
  is_git?: boolean;
  is_link?: boolean;
};

export type ListDirResult = {
  request_id?: string;
  path?: string;
  parent?: string;
  entries?: DirEntry[];
  truncated?: boolean;
  error?: string;
};

export async function listDaemonDirectory(input: {
  daemonDeviceId: string;
  path: string;
  signal?: AbortSignal;
}): Promise<ListDirResult> {
  const auth = await authenticateBrowserDevice();
  const init: RequestInit = {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.device_access_token}`,
    },
    body: JSON.stringify({
      daemon_device_id: input.daemonDeviceId,
      path: input.path,
    }),
  };
  if (input.signal) init.signal = input.signal;
  return fetchJSON<ListDirResult>("/api/daemon/list-dir", init);
}

export async function createTerminalSession(input: {
  daemonDeviceId: string;
  sessionId?: string | undefined;
  agent?: string;
  cwd: string;
}) {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<{ terminal_session: TerminalSession }>("/api/terminal-sessions", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.device_access_token}`,
    },
    body: JSON.stringify({
      daemon_device_id: input.daemonDeviceId,
      session_id: input.sessionId,
      agent: input.agent ?? "claude-code",
      cwd: input.cwd,
    }),
  });
}

export async function listTerminalSessions() {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<{ terminal_sessions: TerminalSession[] }>("/api/terminal-sessions", {
    method: "GET",
    credentials: "include",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
  });
}

export async function sendTerminalInput(terminalSessionId: string, text: string) {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<{ status: string }>(`/api/terminal-sessions/${encodeURIComponent(terminalSessionId)}/input`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.device_access_token}`,
    },
    body: JSON.stringify({ text }),
  });
}

export async function stopTerminalSession(terminalSessionId: string) {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<{ status: string }>(`/api/terminal-sessions/${encodeURIComponent(terminalSessionId)}/stop`, {
    method: "POST",
    credentials: "include",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
  });
}

export async function openTerminalSession(terminalSessionId: string) {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<{ status: string }>(`/api/terminal-sessions/${encodeURIComponent(terminalSessionId)}/open-terminal`, {
    method: "POST",
    credentials: "include",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
  });
}

export async function streamTerminalSession(input: {
  terminalSessionId: string;
  signal?: AbortSignal;
  onEvent: (event: TerminalEvent) => void;
}) {
  const auth = await authenticateBrowserDevice();
  const init: RequestInit = {
    method: "GET",
    credentials: "include",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
  };
  if (input.signal) init.signal = input.signal;
  const res = await fetch(`/api/terminal-sessions/${encodeURIComponent(input.terminalSessionId)}/stream`, init);
  if (!res.ok) {
    const text = await res.text();
    const parsed = parseJSONBody(text);
    const message = parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : text.trim() || `${res.status} ${res.statusText}`.trim();
    throw new Error(message);
  }
  if (!res.body) throw new Error("stream response missing body");
  await readSSEStream(res.body, input.onEvent);
}

export async function listDevTerminalSessions() {
  return fetchJSON<{ terminal_sessions: Array<{ id: string; session_status: TerminalSession["session_status"]; turn_status: TerminalSession["turn_status"]; created_at: string }> }>("/daemon-api/dev/terminal-sessions");
}

export async function listDaemonProjects() {
  return fetchJSON<DaemonProject[]>("/daemon-api/projects");
}

export async function getDaemonSessionBlocks(sessionId: string) {
  return fetchJSON<DaemonSessionBlocks>(`/daemon-api/sessions/${encodeURIComponent(sessionId)}/blocks`);
}

export async function streamDaemonSessionBlocks(input: {
  sessionId: string;
  signal?: AbortSignal;
  onEvent: (event: DaemonSessionBlocks) => void;
}) {
  const init: RequestInit = { method: "GET" };
  if (input.signal) init.signal = input.signal;
  const res = await fetch(`/daemon-api/sessions/${encodeURIComponent(input.sessionId)}/blocks/stream`, init);
  if (!res.ok) {
    const text = await res.text();
    const parsed = parseJSONBody(text);
    const message = parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : text.trim() || `${res.status} ${res.statusText}`.trim();
    throw new Error(message);
  }
  if (!res.body) throw new Error("stream response missing body");
  await readSSEStream(res.body, input.onEvent);
}

export async function sendDevTerminalInput(terminalSessionId: string, text: string) {
  return fetchJSON<{ status: string }>(`/daemon-api/dev/terminal-sessions/${encodeURIComponent(terminalSessionId)}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export async function streamDevTerminalSession(input: {
  terminalSessionId: string;
  signal?: AbortSignal;
  onEvent: (event: TerminalEvent) => void;
}) {
  const init: RequestInit = { method: "GET" };
  if (input.signal) init.signal = input.signal;
  const res = await fetch(`/daemon-api/dev/terminal-sessions/${encodeURIComponent(input.terminalSessionId)}/stream`, init);
  if (!res.ok) {
    const text = await res.text();
    const parsed = parseJSONBody(text);
    const message = parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : text.trim() || `${res.status} ${res.statusText}`.trim();
    throw new Error(message);
  }
  if (!res.body) throw new Error("stream response missing body");
  await readSSEStream(res.body, input.onEvent);
}

export async function cancelInject(requestId: string) {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<{ status: string; request_id: string }>(`/api/injects/${encodeURIComponent(requestId)}/cancel`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
  });
}

export async function getVAPIDPublicKey() {
  return fetchJSON<{ public_key: string }>("/api/push/vapid-public-key", { method: "GET" });
}

export async function registerPushSubscription(input: {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  user_agent: string;
}) {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<PushRegistration>("/api/push/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
    body: JSON.stringify(input),
  });
}

export async function transcribeVoice(input: {
  audio: Blob;
  filename?: string;
  durationMs?: number;
  originalDurationMs?: number;
  optimizedDurationMs?: number;
  language?: string;
  prompt?: string;
  provider?: string;
}) {
  const auth = await authenticateBrowserDevice();
  const body = new FormData();
  body.set("audio", input.audio, input.filename ?? "voice.webm");
  if (input.durationMs != null) body.set("duration_ms", String(Math.max(0, Math.round(input.durationMs))));
  if (input.originalDurationMs != null) body.set("original_duration_ms", String(Math.max(0, Math.round(input.originalDurationMs))));
  if (input.optimizedDurationMs != null) body.set("optimized_duration_ms", String(Math.max(0, Math.round(input.optimizedDurationMs))));
  if (input.language) body.set("language", input.language);
  if (input.prompt) body.set("prompt", input.prompt);
  if (input.provider) body.set("provider", input.provider);
  const res = await fetch("/api/voice/transcriptions", {
    method: "POST",
    credentials: "include",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
    body,
  });
  const text = await res.text();
  const data = text ? parseJSONBody(text) : null;
  if (!res.ok) {
    trackEvent("voice_transcription_failed", { status: res.status });
    if (res.status === 413) {
      throw new Error("Voice recording is too large to upload. Try a shorter recording.");
    }
    const message = data && typeof data === "object" && "error" in data
      ? String((data as { error: unknown }).error)
      : text.trim() || `${res.status} ${res.statusText}`.trim();
    throw new Error(message);
  }
  trackEvent("voice_transcription_completed", {
    provider: (data as VoiceTranscription).provider,
    fallback_used: (data as VoiceTranscription).fallback_used,
    duration_ms: (data as VoiceTranscription).duration_ms,
  });
  return data as VoiceTranscription;
}

export async function submitFeedback(input: {
  message: string;
  attachment?: File | Blob | null;
  attachmentName?: string;
  pagePath?: string;
  appVersion?: string;
  relayEnvironment?: string;
  browserName?: string;
  browserPlatform?: string;
  browserUserAgent?: string;
  selectedSessionId?: string;
  selectedDeviceId?: string;
}) {
  const auth = await authenticateBrowserDevice();
  const body = new FormData();
  body.set("message", input.message);
  if (input.attachment) {
    body.set("attachment", input.attachment, input.attachmentName ?? "feedback-attachment");
  }
  if (input.pagePath) body.set("page_path", input.pagePath);
  if (input.appVersion) body.set("app_version", input.appVersion);
  if (input.relayEnvironment) body.set("relay_environment", input.relayEnvironment);
  if (input.browserName) body.set("browser_name", input.browserName);
  if (input.browserPlatform) body.set("browser_platform", input.browserPlatform);
  if (input.browserUserAgent) body.set("browser_user_agent", input.browserUserAgent);
  if (input.selectedSessionId) body.set("selected_session_id", input.selectedSessionId);
  if (input.selectedDeviceId) body.set("selected_device_id", input.selectedDeviceId);
  const res = await fetch("/api/feedback", {
    method: "POST",
    credentials: "include",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
    body,
  });
  const text = await res.text();
  const data = text ? parseJSONBody(text) : null;
  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data
      ? String((data as { error: unknown }).error)
      : text.trim() || `${res.status} ${res.statusText}`.trim();
    throw new Error(message);
  }
  return data as FeedbackSubmission;
}

export function subscribeToSession(input: {
  sessionId: string;
  deviceId: string;
  afterSeq: number;
  onTurn: (turn: SessionTurn) => void;
  onStatus: (status: WSState, detail?: string) => void;
}): SessionSubscription {
  let closed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;

  const clearReconnect = () => {
    if (reconnectTimer != null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    clearReconnect();
    reconnectAttempt += 1;
    const delay = Math.min(5000, 800 * reconnectAttempt);
    input.onStatus("reconnecting", `relay disconnected, retrying in ${Math.round(delay / 1000)}s`);
    reconnectTimer = window.setTimeout(() => {
      void connect();
    }, delay);
  };

  const connect = async () => {
    if (closed) return;
    input.onStatus(reconnectAttempt > 0 ? "reconnecting" : "connecting");
    try {
      const auth = await authenticateBrowserDevice();
      const url = new URL("/api/ws", window.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("access_token", auth.device_access_token);

      const ws = new WebSocket(url.toString());
      socket = ws;
      ws.addEventListener("open", () => {
        if (closed || socket !== ws) return;
        reconnectAttempt = 0;
        trackEvent("session_ws_opened");
        input.onStatus("connecting");
        ws.send(JSON.stringify({
          type: "SUBSCRIBE",
          session_id: input.sessionId,
          device_id: input.deviceId,
          after_seq: input.afterSeq,
        }));
      });
      ws.addEventListener("message", (event) => {
        if (closed || socket !== ws) return;
        const payload = JSON.parse(String(event.data)) as {
          type?: string;
          turn?: SessionTurn;
          message?: string;
        };
        switch (payload.type) {
          case "TURN":
            if (payload.turn) {
              input.onTurn(payload.turn);
            }
            break;
          case "SESSION_STATUS":
            input.onStatus("live", payload.message);
            break;
          case "ERROR":
            input.onStatus("error", payload.message ?? "subscription error");
            break;
          default:
            break;
        }
      });
      ws.addEventListener("close", () => {
        if (socket === ws) {
          socket = null;
        }
        trackEvent("session_ws_closed");
        if (!closed) scheduleReconnect();
      });
      ws.addEventListener("error", () => {
        if (closed || socket !== ws || ws.readyState >= WebSocket.CLOSING) return;
        trackEvent("session_ws_error");
      });
    } catch (error) {
      input.onStatus("error", error instanceof Error ? error.message : "failed to connect");
      scheduleReconnect();
    }
  };

  void connect();

  return {
    close() {
      closed = true;
      clearReconnect();
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: "UNSUBSCRIBE",
          session_id: input.sessionId,
          device_id: input.deviceId,
        }));
      }
      socket?.close();
    },
  };
}

// requestDaemonUpdate triggers a remote `pockly-daemon update` on the
// given daemon. Relay forwards the request through the daemon's control
// WS; daemon downloads, verifies, installs, and restarts itself.
//
// Returns 202 (dispatched) — actual completion is NOT signaled
// synchronously because the daemon restart kills the WS connection
// mid-process. Callers poll /api/sessions afterwards and watch for the
// host's app_version to bump as the "did it land" signal.
export async function requestDaemonUpdate(hostDeviceId: string, toVersion?: string) {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<{ status: string; request_id: string; hint?: string }>(
    `/api/hosts/${encodeURIComponent(hostDeviceId)}/update`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.device_access_token}` },
      body: JSON.stringify(toVersion ? { to_version: toVersion } : {}),
    },
  );
}

// Relay the user's allow/deny click on a pending Claude permission card.
// Pockly forwards this to the daemon and does not persist or infer policy.
export async function decidePermissionRequest(
  requestId: string,
  daemonDeviceId: string,
  decision: "allow" | "deny",
) {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<{ request_id: string; status: string; error?: string }>(
    `/api/permission-requests/${encodeURIComponent(requestId)}/decide`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.device_access_token}` },
      body: JSON.stringify({ daemon_device_id: daemonDeviceId, decision }),
    },
  );
}

async function fetchWithBrowserDevice<T>(url: string, query?: Record<string, string>): Promise<T> {
  const auth = await authenticateBrowserDevice();
  const finalURL = new URL(url, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      finalURL.searchParams.set(key, value);
    }
  }
  return fetchJSON<T>(finalURL.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
  });
}

// InjectControlError carries the relay's structured error body alongside
// the message string so callers can branch on details like session_drifted
// (which ships an actual_sid the UI needs to bounce the user to).
export class InjectControlError extends Error {
  status?: number;
  details?: Record<string, unknown>;
  constructor(message: string) {
    super(message);
    this.name = "InjectControlError";
  }
}

// AuthExpiredError flags HTTP 401 from any of the relay's bearer-required
// endpoints (terminal-sessions list, inject, SSE stream). v0.1.41: pre-this,
// these surfaced as generic fetch errors that callers silently swallowed
// (attachExistingLiveSessionBridge's empty catch), so the user saw a frozen
// workspace with no UI hint that their cookie had expired. App.tsx's top-level
// auth state hook treats this as "logged out" and re-routes to /login.
export class AuthExpiredError extends Error {
  status = 401;
  constructor(message = "session expired") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

function buildControlURL(url: string, query: Record<string, string> | undefined) {
  const finalURL = new URL(url, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) finalURL.searchParams.set(key, value);
  }
  return finalURL;
}

async function streamControl<TEvent extends InjectEvent | SyncSessionEvent>(
  url: string,
  query: Record<string, string> | undefined,
  body: unknown,
  onEvent: (event: TEvent) => void,
  signal?: AbortSignal,
) {
  const auth = await authenticateBrowserDevice();
  const init: RequestInit = {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.device_access_token}`,
    },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  return runControlStream<TEvent>(buildControlURL(url, query), init, onEvent);
}

// Same control stream, but the body is multipart/form-data (file attachments).
// The browser sets the Content-Type + boundary, so we must NOT set it here.
async function streamControlMultipart<TEvent extends InjectEvent | SyncSessionEvent>(
  url: string,
  query: Record<string, string> | undefined,
  form: FormData,
  onEvent: (event: TEvent) => void,
  signal?: AbortSignal,
) {
  const auth = await authenticateBrowserDevice();
  const init: RequestInit = {
    method: "POST",
    credentials: "include",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
    body: form,
  };
  if (signal) init.signal = signal;
  return runControlStream<TEvent>(buildControlURL(url, query), init, onEvent);
}

async function runControlStream<TEvent extends InjectEvent | SyncSessionEvent>(
  finalURL: URL,
  init: RequestInit,
  onEvent: (event: TEvent) => void,
) {
  const res = await fetch(finalURL.toString(), init);
  if (!res.ok) {
    trackEvent("inject_request_failed", { status: res.status });
    const text = await res.text();
    const parsed = parseJSONBody(text);
    const message = parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : text.trim() || `${res.status} ${res.statusText}`.trim();
    // Preserve structured fields (e.g. session_drifted carries
    // actual_sid + requested_sid) on the thrown error so callers can do
    // more than show a string — they can bounce the user to the live sid.
    const err = new InjectControlError(message);
    if (parsed && typeof parsed === "object") {
      err.details = parsed as Record<string, unknown>;
    }
    err.status = res.status;
    throw err;
  }
  if (!res.body) throw new Error("stream response missing body");
  trackEvent("inject_stream_started");
  await readSSEStream(res.body, (evt: TEvent) => {
    if ("type" in evt && (evt.type === "approval_required" || evt.type === "inject_completed" || evt.type === "inject_failed" || evt.type === "inject_cancelled")) {
      trackEvent("inject_" + evt.type, { agent: evt.turn?.agent, has_error: Boolean(evt.error) });
    }
    onEvent(evt);
  });
}

async function readSSEStream<TEvent>(body: ReadableStream<Uint8Array>, onEvent: (event: TEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      const data = parseJSONBody(dataLine.slice(6));
      if (data && typeof data === "object") {
        const evt = data as TEvent;
        onEvent(evt);
      }
    }
  }
}

// reportWebTelemetry ships one observability event to the relay so the
// cloud has a chance of seeing browser-side failures (SSE disconnects,
// inject errors, render gaps) that would otherwise be invisible. v0.1.37.
//
// Fire-and-forget: never throws, never blocks, never logs more than once
// per minute on transport failure. Auth via the existing browser device
// bearer (same dance as every other authenticated call); if the bearer
// dance itself fails we silently drop the event — we don't want telemetry
// to surface auth errors to a user who was just trying to read their chat.
//
// IMPORTANT: do NOT call this from inside event-loop hot paths (e.g. each
// message_added render). Only call on transition events — first inject
// failure for a session, SSE disconnect, gap detection, render error.
let lastTelemetryErrLog = 0;
export function reportWebTelemetry(input: {
  name: "web_sse_disconnected" | "web_sse_visibility_resume" | "web_inject_attempt" | "web_inject_error" | "web_presence_refresh_failed" | "web_stream_gap_detected" | "web_page_error" | "web_bootstrap" | "web_bootstrap_phase";
  path?: string;
  status?: "ok" | "error";
  errorCode?: string;
  sessionId?: string;
  durationMs?: number;
}) {
  // Non-blocking: run the auth + POST on a microtask so the caller never
  // waits on us. Browsers will GC the promise after it resolves/rejects.
  void (async () => {
    try {
      const postTelemetry = (token: string) => fetch("/api/telemetry/web", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        // keepalive lets the browser flush this POST during page-unload
        // (the most interesting moment for telemetry — the user closed
        // the tab right after an error).
        keepalive: true,
        body: JSON.stringify({
          version: "web",
          user_agent: navigator.userAgent.slice(0, 200),
          events: [{
            name: input.name,
            path: input.path ?? location.pathname,
            status: input.status ?? "error",
            error_code: (input.errorCode ?? "").slice(0, 80),
            session_id: input.sessionId ?? "",
            duration_ms: input.durationMs ?? 0,
            timestamp: new Date().toISOString(),
          }],
        }),
      });
      let token = loadBrowserDeviceState()?.accessToken ?? "";
      if (!token) {
        const auth = await authenticateBrowserDevice();
        token = auth.device_access_token;
      }
      let res = await postTelemetry(token);
      if (res.status === 401 || res.status === 403) {
        // Stale token — invalidate before re-auth so we re-handshake
        // rather than replay the same dead cached token.
        invalidateBrowserDeviceToken();
        const auth = await authenticateBrowserDevice();
        res = await postTelemetry(auth.device_access_token);
      }
    } catch (err) {
      // Rate-limit transport-failure logs to once a minute so a bad
      // network doesn't flood the console. The telemetry itself dropping
      // is fine; logging about it forever is not.
      const now = Date.now();
      if (now - lastTelemetryErrLog > 60_000) {
        lastTelemetryErrLog = now;
        console.debug("[telemetry] report failed:", err);
      }
    }
  })();
}

// Browser-device access-token cache. The relay issues a 15-minute
// token (see issueAccessToken); we reuse it for 10 minutes — a 5-minute
// safety margin so a cached token is always still valid when used, no
// 401-from-expiry. Before this, EVERY authenticated request (sessions,
// agent-settings, hosts, turns, …) re-ran the full
// device-challenge → sign → verify handshake. A burst of concurrent
// workspace calls therefore fired a burst of challenges, tripping the
// relay's device-challenge rate limiter (30/min) →
// "too many challenge requests" → retry storms that stalled the UI for
// ~10s (most visibly: switching the model pill). Caching the token and
// de-duping concurrent handshakes collapses that to one handshake per
// 10 minutes.
let browserAccessToken: { token: string; expiresAt: number } | null = null;
let browserAccessInflight: Promise<string> | null = null;
const BROWSER_ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000;

function cacheBrowserAccessToken(token: string) {
  if (!token) return;
  browserAccessToken = { token, expiresAt: Date.now() + BROWSER_ACCESS_TOKEN_TTL_MS };
}

// invalidateBrowserDeviceToken drops the cached access token so the next
// authenticated call re-handshakes. Call on logout / device revoke, or
// when a token-bearing request comes back 401.
export function invalidateBrowserDeviceToken() {
  browserAccessToken = null;
  browserAccessInflight = null;
}

async function authenticateBrowserDevice(): Promise<{ device_access_token: string }> {
  const cached = browserAccessToken;
  if (cached && Date.now() < cached.expiresAt) {
    return { device_access_token: cached.token };
  }
  // Share one in-flight handshake across all concurrent callers so a
  // burst of workspace requests does a single challenge, not N.
  const inflight =
    browserAccessInflight ??
    (browserAccessInflight = runBrowserDeviceHandshake()
      .then((token) => {
        browserAccessToken = { token, expiresAt: Date.now() + BROWSER_ACCESS_TOKEN_TTL_MS };
        return token;
      })
      .finally(() => {
        browserAccessInflight = null;
      }));
  return { device_access_token: await inflight };
}

// runBrowserDeviceHandshake performs the device-challenge → sign →
// verify dance and returns a fresh access token. Run only on a cache
// miss (was previously the whole body of authenticateBrowserDevice).
async function runBrowserDeviceHandshake(): Promise<string> {
  let state = loadBrowserDeviceState();
  if (!state?.deviceId) {
    await registerCurrentBrowserDevice();
    state = loadBrowserDeviceState();
  }
  if (!state?.deviceId) {
    throw new Error("encrypted access setup failed");
  }
  let challenge: BrowserDeviceChallenge;
  try {
    challenge = await fetchJSON<BrowserDeviceChallenge>("/api/device-challenge", {
      method: "POST",
      body: JSON.stringify({
        device_id: state.deviceId,
        audience: "browser-ws",
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("eligible device not found") && !message.includes("device_revoked")) throw error;
    await clearBrowserDeviceState();
    await registerCurrentBrowserDevice();
    state = loadBrowserDeviceState();
    if (!state?.deviceId) throw new Error("encrypted access setup failed", { cause: error });
    challenge = await fetchJSON<BrowserDeviceChallenge>("/api/device-challenge", {
      method: "POST",
      body: JSON.stringify({
        device_id: state.deviceId,
        audience: "browser-ws",
      }),
    });
  }
  const message = `${challenge.challenge_id}:${challenge.device_id}:${challenge.audience}:${challenge.nonce}`;
  const signature = await signBrowserChallenge(message);
  const verified = await fetchJSON<{ verified: boolean; device_access_token: string }>("/api/device-challenge/verify", {
    method: "POST",
    body: JSON.stringify({
      device_id: state.deviceId,
      audience: "browser-ws",
      challenge_id: challenge.challenge_id,
      signature,
    }),
  });
  return verified.device_access_token;
}

function defaultBrowserDeviceName() {
  const platform = navigator.platform || "Device";
  return `Pockly ${platform}`;
}
