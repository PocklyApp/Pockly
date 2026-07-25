/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { clearBrowserDeviceState, ensureBrowserDeviceState, loadBrowserDeviceState, persistBrowserTokens, signBrowserChallenge } from "./crypto";
import { telemetryNetworkEnabled, trackEvent } from "./observability";
import { configuredNexusURL } from "./runtime-config";

export const CONTROL_EVENT_POLL_MAX_MS = 35 * 60 * 1000;
export const DEFAULT_INITIAL_TURN_LIMIT = 20;
export const SESSION_TURNS_WINDOW_LIMIT = 100;
export const CONTROL_EVENT_POLL_INITIAL_DELAY_MS = 300;
export const CONTROL_EVENT_POLL_INTERVAL_MS = 2000;
// Steady cadence when a live realtime subscription already delivers turns and
// the poll only needs lifecycle events (completed/failed/approval).
export const CONTROL_EVENT_POLL_RELAXED_MS = 5000;
export const TERMINAL_EVENT_POLL_INTERVAL_MS = 2000;

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
  machine_fingerprint_bound?: boolean;
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
  // snippet is the first-user-message preview Nexus stores for the sidebar
  // label. Legacy per-browser snippets are no longer part of the product
  // model.
  snippet: string;
  // title is the Nexus-generated concise label (from the first
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
    // Legacy values from older Nexus builds; normalized to read_only /
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
    // Structured fields piggy-back on the permission_request attachment so
    // the interactive Allow/Deny card can render without re-parsing text.
    // Older events may omit request_id and structured decision fields.
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
  type: "inject_started" | "stream_event" | "session_created" | "approval_required" | "inject_completed" | "inject_ready" | "inject_failed" | "inject_cancelled";
  status?: string;
  streaming?: boolean;
  turn?: SessionTurn;
  session_id?: string;
  message?: string;
  error?: string;
};

export type SyncSessionEvent = {
  request_id: string;
  session_id: string;
  device_id?: string;
  stage: "queued" | "locating" | "extracting" | "uploading" | "completed" | "failed";
  status: "running" | "completed" | "failed";
  processed?: number;
  total?: number;
  min_seq?: number;
  max_seq?: number;
  has_older?: boolean;
  total_turn_count?: number;
  message?: string;
  error?: string;
  streaming?: boolean;
  turns?: SessionTurn[];
};

export type CursorEventResponse<TEvent> = {
  events: Array<{
    cursor: string;
    event_id?: string;
    request_id?: string;
    device_id?: string;
    session_id?: string;
    type?: string;
    created_at?: string;
    payload: TEvent;
  }>;
  next_cursor?: string;
  // Session-scoped polls also deliver fresh turn rows (written once into
  // session_turns by the server-side event sink) instead of duplicating turn
  // payloads inside event rows.
  turns?: SessionTurn[];
  next_seq?: number;
};

export type SessionEventCursorResponse<TEvent extends InjectEvent | SyncSessionEvent> = CursorEventResponse<TEvent>;

export type SessionTurnsResponse = {
  session_id: string;
  turns: SessionTurn[];
  // Distinguishes durable cloud hot-window rows from transient local daemon
  // history windows. Transient windows are never proof that Nexus has persisted
  // the full range.
  source?: "remote_hot_window" | "local_transient" | "mixed";
  oldest_seq?: number;
  latest_seq?: number;
  window_limit?: number;
  after_seq?: number;
  next_loaded_before_seq?: number;
  synced_turn_count?: number;
  synced_min_seq?: number;
  synced_max_seq?: number;
  latest_contiguous_min_seq?: number;
  next_before_seq?: number;
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
  event_id?: string;
  request_id?: string;
  terminal_session_id: string;
  seq?: number;
  seq_start?: number;
  seq_end?: number;
  kind: "session_started" | "session_ready" | "user_input" | "text_delta" | "message_added" | "permission_request" | "prompt_ready" | "agent_error" | "session_exited" | "session_disconnected" | "error" | "terminal_session";
  session_status?: TerminalSession["session_status"];
  turn_status?: TerminalSession["turn_status"];
  payload?: string;
  error?: string;
  timestamp?: string;
  truncated?: boolean;
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
  sendCommand?: <TEvent = unknown>(input: RealtimeCommandInput<TEvent>) => Promise<RealtimeCommandAccepted>;
  subscribeSession?: (sessionId: string, deviceId: string, afterSeq?: number) => void;
  unsubscribeSession?: (sessionId: string, deviceId: string) => void;
  subscribeTerminal?: (terminalSessionId: string, onEvent: (event: TerminalEvent) => void, options?: { notifyServer?: boolean }) => Promise<void>;
  unsubscribeTerminal?: (terminalSessionId: string) => Promise<void>;
};

export type RealtimeCommandAccepted = {
  request_id: string;
  command: string;
  status: string;
  session_id?: string;
  device_id?: string;
  terminal_session_id?: string;
  terminal_session?: TerminalSession;
};

export type RealtimeCommandInput<TEvent = unknown> = {
  requestId?: string;
  command: string;
  daemonDeviceId: string;
  sessionId?: string;
  terminalSessionId?: string;
  payload?: Record<string, unknown>;
  onEvent?: (event: TEvent) => void;
  signal?: AbortSignal | undefined;
  ackTimeoutMs?: number;
};

let activeWorkspaceRealtime: SessionSubscription | null = null;

export function setActiveWorkspaceRealtime(subscription: SessionSubscription | null) {
  activeWorkspaceRealtime = subscription;
}

function preferredRealtime(input?: SessionSubscription | null) {
  return input ?? activeWorkspaceRealtime;
}

function realtimeSessionKey(sessionId: string, deviceId: string) {
  return `${deviceId}:${sessionId}`;
}

function randomRealtimeID(prefix: string) {
  const cryptoLike = globalThis.crypto as Crypto | undefined;
  const randomUUID = cryptoLike && typeof cryptoLike.randomUUID === "function" ? cryptoLike.randomUUID.bind(cryptoLike) : null;
  return `${prefix}_${randomUUID ? randomUUID() : Math.random().toString(36).slice(2)}`;
}

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

export type NexusRuntimeCapabilities = {
  runtime: string;
  realtime?: boolean;
  browser_realtime?: boolean;
  browser_realtime_control?: boolean;
  control_streaming?: boolean;
  terminal?: boolean;
  terminal_streaming?: boolean;
  web_push?: boolean;
  stt?: boolean;
  release_update?: boolean;
  contract_version?: string;
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

const configuredNexusBaseURL = normalizeConfiguredNexusBaseURL(
  configuredNexusURL() || import.meta.env?.VITE_POCKLY_NEXUS_URL || import.meta.env?.VITE_POCKLY_RELAY_URL || "",
);

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolveNexusHTTPURL(url), {
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
    // Distinguish auth expiry from generic errors so callers and the
    // top-level app-shell auth hook can surface a re-login banner instead
    // of swallowing the failure.
    if (res.status === 401) {
      // The bearer we sent is no longer valid — token expired, device
      // revoked, or Nexus rotated its per-boot signing key on
      // restart (accessTokenKey = mustRandomBytes). Drop the cached
      // browser access token so the NEXT authed call re-handshakes
      // instead of replaying the dead token for the rest of the cache
      // window. No-op for cookie-only (non-bearer) 401s.
      invalidateBrowserDeviceToken();
      throw new AuthExpiredError(message);
    }
    throw new ApiError(message, res.status, data);
  }
  if (!data) return undefined as T;
  return data as T;
}

function resolveNexusHTTPURL(input: string) {
  if (!configuredNexusBaseURL) return input;
  const url = new URL(input, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return input;
  return new URL(`${url.pathname}${url.search}${url.hash}`, configuredNexusBaseURL).toString();
}

function resolveNexusWebSocketURL(path: string) {
  const base = configuredNexusBaseURL || window.location.origin;
  const url = new URL(path, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function normalizeConfiguredNexusBaseURL(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(/\/+$/g, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/g, "");
  } catch {
    return "";
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function getSession() {
  return fetchJSON<{ authenticated: boolean; user?: User }>("/api/auth/session", {
    method: "GET",
  });
}

export async function getRuntimeCapabilities() {
  return fetchJSON<NexusRuntimeCapabilities>("/api/runtime", { method: "GET" });
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
  return fetchJSON<
    | {
        status: "active";
        user: User;
        email: string;
      }
    | {
        status: "verification_required";
        email: string;
        expires_at: string;
        resend_after_seconds: number;
      }
  >("/api/auth/register", {
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
// opened <nexus>/local-setup#nonce=…&cb=…&grant=… in this
// browser; the page reads the grant id + nonce out of the fragment and posts
// them here. Nexus binds the daemon to the current user, mints device
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

export type SessionCatalogDelete = {
  device_id: string;
  session_id: string;
};

export type SessionCatalogDelta = {
  upserts: SessionListItem[];
  deletes: SessionCatalogDelete[];
  next_cursor: string;
  next_page_cursor?: string;
  has_more: boolean;
  reset?: boolean;
};

export async function listSessionsDelta(input: { since?: string; limit?: number; pageCursor?: string } = {}) {
  const params = new URLSearchParams();
  if (input.since) params.set("since", input.since);
  if (input.limit) params.set("limit", String(input.limit));
  if (input.pageCursor) params.set("page_cursor", input.pageCursor);
  const query = params.toString();
  return fetchWithBrowserDevice<SessionCatalogDelta>(`/api/sessions/delta${query ? `?${query}` : ""}`);
}

export async function getSessionCatalogItem(sessionId: string, deviceId: string) {
  return fetchWithBrowserDevice<{ session: SessionListItem }>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    { device_id: deviceId },
  );
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

export async function getSessionTurns(sessionId: string, deviceId: string, options: { limit?: number; beforeSeq?: number; afterSeq?: number } = {}) {
  return await fetchWithBrowserDevice<SessionTurnsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/turns`,
    {
      device_id: deviceId,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.beforeSeq !== undefined ? { before_seq: options.beforeSeq } : {}),
      ...(options.afterSeq !== undefined ? { after_seq: options.afterSeq } : {}),
    },
  );
}

export async function streamSessionInject(input: {
  sessionId: string;
  deviceId: string;
  text: string;
  model?: string;
  // Optional attachments. When present the request is sent as multipart so the
  // Nexus can forward the file bytes to the daemon, which writes them to disk
  // and appends @<path> references to the prompt for Claude Code / Codex.
  files?: File[];
  signal?: AbortSignal;
  // Last turn seq the reader already has — the polling fallback delivers only
  // newer turns from session_turns. Omit/0 redelivers from the start (the
  // reader merges by seq, so that is wasteful but harmless).
  afterSeq?: number;
  // Relaxed steady poll cadence (e.g. CONTROL_EVENT_POLL_RELAXED_MS) when a
  // live realtime subscription already carries the turns.
  pollIntervalMs?: number;
  realtime?: SessionSubscription | null;
  onEvent: (event: InjectEvent) => void;
}) {
  const url = `/api/sessions/${encodeURIComponent(input.sessionId)}/inject`;
  const query = { device_id: input.deviceId };
  const pollOptions = {
    afterSeq: input.afterSeq ?? 0,
    ...(input.pollIntervalMs ? { pollIntervalMs: input.pollIntervalMs } : {}),
  };
  if (input.files && input.files.length > 0) {
    const form = new FormData();
    form.set("text", input.text);
    if (input.model) form.set("model", input.model);
    for (const file of input.files) form.append("files", file, file.name);
    return streamControlMultipart<InjectEvent>(url, query, form, input.onEvent, input.signal, pollOptions);
  }
  const realtime = preferredRealtime(input.realtime);
  if (realtime?.sendCommand) {
    try {
      const accepted = await realtime.sendCommand<InjectEvent>({
        command: "inject_session",
        daemonDeviceId: input.deviceId,
        sessionId: input.sessionId,
        payload: { session_id: input.sessionId, text: input.text, model: input.model },
        onEvent: input.onEvent,
        signal: input.signal,
      });
      input.onEvent({
        request_id: accepted.request_id,
        type: "inject_started",
        session_id: accepted.session_id || input.sessionId,
        streaming: true,
      });
      await pollAcceptedControlEvents(buildControlURL(url, query), {
        request_id: accepted.request_id,
        type: "inject_started",
        session_id: accepted.session_id || input.sessionId,
        device_id: accepted.device_id || input.deviceId,
        streaming: false,
      } as InjectEvent, input.onEvent, input.signal, {
        ...pollOptions,
        pollIntervalMs: Math.max(CONTROL_EVENT_POLL_RELAXED_MS, pollOptions.pollIntervalMs || 0),
      });
      return;
    } catch (error) {
      if (!(error instanceof RealtimeNotOpenError)) throw error;
    }
  }
  return streamControl(
    url,
    query,
    { text: input.text, model: input.model },
    input.onEvent,
    input.signal,
    pollOptions,
  );
}

// Composer-pills surface: the daemon owns model, permission mode, and
// effort per terminal session. The web reads them on session select and
// writes them whenever the user picks a different pill value. Effort is
// carried explicitly through the Nexus/daemon
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
  codex_app_server_source?: string;
  codex_app_server_fallback_reason?: string;
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

// ── UI preferences (pin / archive / rename) ────────────────────────────
// Per-user, server-synced (so they follow the account across browsers).
// Stored in dedicated tables the daemon catalog sync never touches.

export type SessionPref = {
  device_id: string;
  session_id: string;
  pinned: boolean;
  archived: boolean;
  custom_title: string;
};

export type ProjectPref = {
  device_id: string;
  cwd: string;
  pinned: boolean;
  archived: boolean;
  removed: boolean;
  custom_label: string;
};

export type PrefsSnapshot = { session_prefs: SessionPref[]; project_prefs: ProjectPref[] };

export async function getPrefs(): Promise<PrefsSnapshot> {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<PrefsSnapshot>("/api/prefs", {
    headers: { Authorization: `Bearer ${auth.device_access_token}` },
  });
}

// Partial updates: omitted fields keep their stored value (server-side
// COALESCE), so a pin toggle can't clobber a rename and vice versa.
export async function setSessionPref(input: {
  sessionId: string;
  deviceId: string;
  pinned?: boolean;
  archived?: boolean;
  customTitle?: string;
}): Promise<SessionPref> {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<SessionPref>(`/api/sessions/${encodeURIComponent(input.sessionId)}/prefs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.device_access_token}` },
    body: JSON.stringify({
      device_id: input.deviceId,
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.archived === undefined ? {} : { archived: input.archived }),
      ...(input.customTitle === undefined ? {} : { custom_title: input.customTitle }),
    }),
  });
}

export async function markSessionOpened(input: {
  sessionId: string;
  deviceId: string;
  openedAt?: string;
  realtime?: SessionSubscription | null;
}): Promise<{ device_id: string; session_id: string; last_opened_at: string }> {
  const realtime = preferredRealtime(input.realtime);
  if (realtime?.sendCommand) {
    try {
      const accepted = await realtime.sendCommand({
        command: "session_opened_hint",
        daemonDeviceId: input.deviceId,
        sessionId: input.sessionId,
        payload: { session_id: input.sessionId, opened_at: input.openedAt },
      });
      return {
        device_id: accepted.device_id || input.deviceId,
        session_id: accepted.session_id || input.sessionId,
        last_opened_at: String((accepted as { last_opened_at?: string }).last_opened_at || input.openedAt || new Date().toISOString()),
      };
    } catch (error) {
      if (!(error instanceof RealtimeNotOpenError)) throw error;
    }
  }
  const auth = await authenticateBrowserDevice();
  return fetchJSON<{ device_id: string; session_id: string; last_opened_at: string }>(`/api/sessions/${encodeURIComponent(input.sessionId)}/opened`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.device_access_token}` },
    body: JSON.stringify({
      device_id: input.deviceId,
      ...(input.openedAt === undefined ? {} : { opened_at: input.openedAt }),
    }),
  });
}

export async function setProjectPref(input: {
  deviceId: string;
  cwd: string;
  pinned?: boolean;
  archived?: boolean;
  removed?: boolean;
  customLabel?: string;
}): Promise<ProjectPref> {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<ProjectPref>("/api/projects/prefs", {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.device_access_token}` },
    body: JSON.stringify({
      device_id: input.deviceId,
      cwd: input.cwd,
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.archived === undefined ? {} : { archived: input.archived }),
      ...(input.removed === undefined ? {} : { removed: input.removed }),
      ...(input.customLabel === undefined ? {} : { custom_label: input.customLabel }),
    }),
  });
}

// PERMANENT session deletion: the daemon removes the local transcript file,
// then Nexus drops its own copy (session + turns + prefs). Irreversible —
// always confirm with the user first.
export async function deleteSession(input: { sessionId: string; deviceId: string }): Promise<{ status: string; deleted: string[] }> {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<{ status: string; deleted: string[] }>(
    `/api/sessions/${encodeURIComponent(input.sessionId)}/delete?device_id=${encodeURIComponent(input.deviceId)}`,
    { method: "POST", headers: { Authorization: `Bearer ${auth.device_access_token}` } },
  );
}

// Reveal the session's working directory in the daemon's file browser (Finder).
export async function revealSessionInFinder(input: { sessionId: string; deviceId: string }): Promise<{ status: string }> {
  const auth = await authenticateBrowserDevice();
  return fetchJSON<{ status: string }>(
    `/api/sessions/${encodeURIComponent(input.sessionId)}/reveal?device_id=${encodeURIComponent(input.deviceId)}`,
    { method: "POST", headers: { Authorization: `Bearer ${auth.device_access_token}` } },
  );
}

// Session-less defaults for the draft composer. Returns the available
// model/permission/effort lists for a daemon + cwd before a real session
// exists, so the first message can use project/user model aliases.
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
  realtime?: SessionSubscription | null;
  onEvent: (event: SyncSessionEvent) => void;
}) {
  const realtime = preferredRealtime(input.realtime);
  if (realtime?.sendCommand) {
    try {
      const accepted = await realtime.sendCommand<SyncSessionEvent>({
        command: "sync_session",
        daemonDeviceId: input.deviceId,
        sessionId: input.sessionId,
        payload: { session_id: input.sessionId, limit: input.limit ?? DEFAULT_INITIAL_TURN_LIMIT, before_seq: input.beforeSeq ?? 0 },
        onEvent: input.onEvent,
        signal: input.signal,
      });
      const event = {
        request_id: accepted.request_id,
        session_id: accepted.session_id || input.sessionId,
        device_id: accepted.device_id || input.deviceId,
        stage: "queued",
        status: "running",
        streaming: true,
      } as SyncSessionEvent;
      input.onEvent(event);
      await pollAcceptedControlEvents(
        buildControlURL(`/api/sessions/${encodeURIComponent(input.sessionId)}/sync`, { device_id: input.deviceId }),
        { ...event, streaming: false },
        input.onEvent,
        input.signal,
        { afterSeq: input.beforeSeq ?? 0, pollIntervalMs: CONTROL_EVENT_POLL_RELAXED_MS },
      );
      return;
    } catch (error) {
      if (!(error instanceof RealtimeNotOpenError)) throw error;
    }
  }
  return streamControl(
    `/api/sessions/${encodeURIComponent(input.sessionId)}/sync`,
    { device_id: input.deviceId },
    { limit: input.limit ?? DEFAULT_INITIAL_TURN_LIMIT, before_seq: input.beforeSeq ?? 0 },
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
  realtime?: SessionSubscription | null;
  onEvent: (event: InjectEvent) => void;
}) {
  const realtime = preferredRealtime(input.realtime);
  if (realtime?.sendCommand) {
    try {
      const accepted = await realtime.sendCommand<InjectEvent>({
        command: "start_task",
        daemonDeviceId: input.daemonDeviceId,
        payload: buildNewTaskRequestBody(input),
        onEvent: input.onEvent,
        signal: input.signal,
      });
      input.onEvent({
        request_id: accepted.request_id,
        type: "inject_started",
        session_id: accepted.session_id || "",
        streaming: true,
      });
      await pollAcceptedControlEvents(
        buildControlURL("/api/tasks", undefined),
        {
          request_id: accepted.request_id,
          type: "inject_started",
          session_id: accepted.session_id || "",
          device_id: accepted.device_id || input.daemonDeviceId,
          streaming: false,
        } as InjectEvent,
        input.onEvent,
        input.signal,
        { afterSeq: 0, pollIntervalMs: CONTROL_EVENT_POLL_RELAXED_MS },
      );
      return;
    } catch (error) {
      if (!(error instanceof RealtimeNotOpenError)) throw error;
    }
  }
  return streamControl(
    "/api/tasks",
    undefined,
    buildNewTaskRequestBody(input),
    input.onEvent,
    input.signal,
    // Brand-new session: every turn is new. The poll starts on the
    // request_id feed and switches to the session feed at session_created.
    { afterSeq: 0 },
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
  realtime?: SessionSubscription | null;
}) {
  const realtime = preferredRealtime(input.realtime);
  if (realtime?.sendCommand) {
    try {
      const accepted = await realtime.sendCommand<TerminalEvent>({
        command: "terminal_create",
        daemonDeviceId: input.daemonDeviceId,
        payload: {
          session_id: input.sessionId,
          agent: input.agent ?? "claude-code",
          cwd: input.cwd,
        },
      });
      if (accepted.terminal_session) return { terminal_session: accepted.terminal_session };
    } catch (error) {
      if (!(error instanceof RealtimeNotOpenError)) throw error;
    }
  }
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

export async function sendTerminalInput(terminalSessionId: string, text: string, realtime?: SessionSubscription | null, daemonDeviceId?: string) {
  const preferred = preferredRealtime(realtime);
  if (preferred?.sendCommand && daemonDeviceId) {
    try {
      await preferred.sendCommand({
        command: "terminal_input",
        daemonDeviceId,
        terminalSessionId,
        payload: { terminal_session_id: terminalSessionId, text },
      });
      return { status: "queued" };
    } catch (error) {
      if (!(error instanceof RealtimeNotOpenError)) throw error;
    }
  }
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

export async function stopTerminalSession(terminalSessionId: string, realtime?: SessionSubscription | null, daemonDeviceId?: string) {
  const preferred = preferredRealtime(realtime);
  if (preferred?.sendCommand && daemonDeviceId) {
    try {
      await preferred.sendCommand({
        command: "terminal_stop",
        daemonDeviceId,
        terminalSessionId,
        payload: { terminal_session_id: terminalSessionId },
      });
      return { status: "queued" };
    } catch (error) {
      if (!(error instanceof RealtimeNotOpenError)) throw error;
    }
  }
  const auth = await authenticateBrowserDevice();
  return fetchJSON<{ status: string }>(`/api/terminal-sessions/${encodeURIComponent(terminalSessionId)}/stop`, {
    method: "POST",
    credentials: "include",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
  });
}

export async function openTerminalSession(terminalSessionId: string, realtime?: SessionSubscription | null, daemonDeviceId?: string) {
  const preferred = preferredRealtime(realtime);
  if (preferred?.sendCommand && daemonDeviceId) {
    try {
      await preferred.sendCommand({
        command: "terminal_open",
        daemonDeviceId,
        terminalSessionId,
        payload: { terminal_session_id: terminalSessionId },
      });
      return { status: "queued" };
    } catch (error) {
      if (!(error instanceof RealtimeNotOpenError)) throw error;
    }
  }
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
  daemonDeviceId?: string;
  realtime?: SessionSubscription | null;
  signal?: AbortSignal;
  onEvent: (event: TerminalEvent) => void;
}) {
  const realtime = preferredRealtime(input.realtime);
  if (realtime?.subscribeTerminal && input.daemonDeviceId) {
    try {
      await realtime.subscribeTerminal(input.terminalSessionId, input.onEvent, { notifyServer: false });
      await realtime.sendCommand?.({
        command: "terminal_subscribe",
        daemonDeviceId: input.daemonDeviceId,
        terminalSessionId: input.terminalSessionId,
        payload: { terminal_session_id: input.terminalSessionId },
        signal: input.signal,
      });
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          realtime?.unsubscribeTerminal?.(input.terminalSessionId).catch(() => undefined);
          resolve();
        };
        if (input.signal?.aborted) {
          resolve();
          return;
        }
        input.signal?.addEventListener("abort", onAbort, { once: true });
        // The caller owns this stream lifetime through AbortController. Keep the
        // promise pending so UI code mirrors the existing SSE behavior.
      });
      return;
    } catch (error) {
      await realtime?.unsubscribeTerminal?.(input.terminalSessionId).catch(() => undefined);
      if (!(error instanceof RealtimeNotOpenError)) throw error;
    }
  }
  const auth = await authenticateBrowserDevice();
  const token = auth.device_access_token;
  const init: RequestInit = {
    method: "GET",
    credentials: "include",
    headers: {
      Authorization: `Bearer ${token}`,
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
    if (res.status === 501 && parsed && typeof parsed === "object" && (parsed as { code?: unknown }).code === "unsupported_runtime") {
      await pollTerminalSession(input, token);
      return;
    }
    throw new Error(message);
  }
  if (!res.body) throw new Error("stream response missing body");
  await readSSEStream(res.body, input.onEvent);
}

async function pollTerminalSession(input: {
  terminalSessionId: string;
  signal?: AbortSignal;
  onEvent: (event: TerminalEvent) => void;
}, token: string) {
  const base = `/api/terminal-sessions/${encodeURIComponent(input.terminalSessionId)}`;
  const authHeaders = { Authorization: `Bearer ${token}` };
  await fetchJSON<{ status: string }>(`${base}/subscribe`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders,
  });
  let cursor = "";
  try {
    for (;;) {
      if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await sleep(TERMINAL_EVENT_POLL_INTERVAL_MS, input.signal);
      const eventsURL = new URL(`${base}/events`, window.location.origin);
      eventsURL.searchParams.set("after", cursor);
      eventsURL.searchParams.set("limit", "100");
      const response = await fetchJSON<CursorEventResponse<TerminalEvent>>(eventsURL.pathname + eventsURL.search, {
        method: "GET",
        credentials: "include",
        headers: authHeaders,
      });
      cursor = response.next_cursor || cursor;
      for (const event of response.events || []) {
        if (event.cursor) cursor = event.cursor;
        if (event.payload) {
          input.onEvent(event.payload);
          if (terminalEventEndsPolling(event.payload)) return;
        }
      }
    }
  } finally {
    await fetch(`${base}/unsubscribe`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders,
    }).catch(() => undefined);
  }
}

function terminalEventEndsPolling(event: TerminalEvent) {
  return event.kind === "session_exited" || event.kind === "session_disconnected" || event.session_status === "exited" || event.session_status === "error";
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

// Keepalive for the realtime socket. Some hosted realtime backends can answer
// this literal ping/pong pair without waking the application handler, so this
// doubles as a low-cost dead-link detector: a missing PONG within the liveness
// window means the link is gone and the socket reconnects.
export const REALTIME_KEEPALIVE_PING = "POCKLY_PING";
export const REALTIME_KEEPALIVE_PONG = "POCKLY_PONG";
export const REALTIME_KEEPALIVE_INTERVAL_MS = 30_000;
export const REALTIME_LIVENESS_TIMEOUT_MS = 75_000;
export const REALTIME_COMMAND_ACK_TIMEOUT_MS = 8_000;

export type HostStatusUpdate = {
  device_id: string;
  presence_status?: string | undefined;
  presence_reason?: string | undefined;
  control_connected?: boolean | undefined;
  app_version?: string | undefined;
};

export type SessionCatalogChangedEvent = {
  session_ids?: string[] | undefined;
  device_ids?: string[] | undefined;
  reason?: string | undefined;
};

export function subscribeToSession(input: {
  sessionId?: string;
  deviceId?: string;
  afterSeq?: number;
  onTurn: (turn: SessionTurn) => void;
  onStatus: (status: WSState, detail?: string) => void;
  // Presence pushes for the user's daemons. While the subscription is live
  // these replace most foreground presence polling.
  onHostStatus?: (status: HostStatusUpdate) => void;
  onSessionCatalogChanged?: (event: SessionCatalogChangedEvent) => void;
}): SessionSubscription {
  let closed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let keepaliveTimer: number | null = null;
  const pendingCommands = new Map<string, {
    command: string;
    resolve: (accepted: RealtimeCommandAccepted) => void;
    reject: (error: Error) => void;
    onEvent?: (event: unknown) => void;
    waitsForFinalEvent: boolean;
    timer: number;
  }>();
  const sessionSubscriptions = new Map<string, { sessionId: string; deviceId: string; afterSeq: number }>();
  const terminalSubscriptions = new Map<string, (event: TerminalEvent) => void>();
  if (input.sessionId && input.deviceId) {
    sessionSubscriptions.set(realtimeSessionKey(input.sessionId, input.deviceId), {
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      afterSeq: input.afterSeq ?? 0,
    });
  }

  const clearReconnect = () => {
    if (reconnectTimer != null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearKeepalive = () => {
    if (keepaliveTimer != null) {
      window.clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  };

  const sendJSON = (payload: unknown) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };

  const sendSessionSubscription = (subscription: { sessionId: string; deviceId: string; afterSeq: number }) => {
    return sendJSON({
      type: "SUBSCRIBE_SESSION",
      session_id: subscription.sessionId,
      device_id: subscription.deviceId,
      after_seq: subscription.afterSeq,
    });
  };

  const scheduleReconnect = () => {
    if (closed) return;
    clearReconnect();
    reconnectAttempt += 1;
    const delay = Math.min(5000, 800 * reconnectAttempt);
    input.onStatus("reconnecting", `Nexus disconnected, retrying in ${Math.round(delay / 1000)}s`);
    reconnectTimer = window.setTimeout(() => {
      void connect();
    }, delay);
  };

  const connect = async () => {
    if (closed) return;
    input.onStatus(reconnectAttempt > 0 ? "reconnecting" : "connecting");
    try {
      const auth = await authenticateBrowserDevice();
      const url = resolveNexusWebSocketURL("/api/ws");
      url.searchParams.set("access_token", auth.device_access_token);

      const ws = new WebSocket(url.toString());
      socket = ws;
      let lastLiveAt = Date.now();
      ws.addEventListener("open", () => {
        if (closed || socket !== ws) return;
        reconnectAttempt = 0;
        lastLiveAt = Date.now();
        trackEvent("session_ws_opened");
        input.onStatus("connecting");
        for (const subscription of sessionSubscriptions.values()) sendSessionSubscription(subscription);
        for (const terminalSessionId of terminalSubscriptions.keys()) {
          ws.send(JSON.stringify({ type: "SUBSCRIBE_TERMINAL", terminal_session_id: terminalSessionId }));
        }
        clearKeepalive();
        keepaliveTimer = window.setInterval(() => {
          if (closed || socket !== ws || ws.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastLiveAt > REALTIME_LIVENESS_TIMEOUT_MS) {
            // Half-open link: no PONG (or any frame) inside the window.
            // Closing triggers the reconnect path.
            ws.close();
            return;
          }
          ws.send(REALTIME_KEEPALIVE_PING);
        }, REALTIME_KEEPALIVE_INTERVAL_MS);
      });
      ws.addEventListener("message", (event) => {
        if (closed || socket !== ws) return;
        lastLiveAt = Date.now();
        const raw = String(event.data);
        // Edge-answered keepalive (and any other non-JSON frame) only counts
        // as liveness; it carries no payload.
        if (raw === REALTIME_KEEPALIVE_PONG || !raw.startsWith("{")) return;
        let payload: { type?: string; turn?: SessionTurn; message?: string; request_id?: string; command?: string; status?: string; event?: unknown; code?: string; error?: string; terminal_session_id?: string; session_ids?: unknown; device_ids?: unknown; reason?: string } & Partial<HostStatusUpdate>;
        try {
          payload = JSON.parse(raw);
        } catch {
          return;
        }
        switch (payload.type) {
          case "TURN":
            if (payload.turn) {
              input.onTurn(payload.turn);
            }
            break;
          case "SESSION_STATUS":
            input.onStatus("live", payload.message);
            break;
          case "HOST_STATUS":
            if (payload.device_id) {
              input.onHostStatus?.({
                device_id: payload.device_id,
                presence_status: payload.presence_status,
                presence_reason: payload.presence_reason,
                control_connected: payload.control_connected,
                app_version: payload.app_version,
              });
            }
            break;
          case "SESSION_CATALOG_CHANGED":
            input.onSessionCatalogChanged?.({
              session_ids: Array.isArray(payload.session_ids) ? payload.session_ids.filter((value): value is string => typeof value === "string" && value !== "") : undefined,
              device_ids: Array.isArray(payload.device_ids) ? payload.device_ids.filter((value): value is string => typeof value === "string" && value !== "") : undefined,
              reason: typeof payload.reason === "string" ? payload.reason : undefined,
            });
            break;
          case "COMMAND_ACK": {
            const requestID = String(payload.request_id || "");
            const pending = pendingCommands.get(requestID);
            if (pending) {
              window.clearTimeout(pending.timer);
              pending.resolve(payload as RealtimeCommandAccepted);
              if (!pending.waitsForFinalEvent) pendingCommands.delete(requestID);
            }
            break;
          }
          case "COMMAND_EVENT": {
            const requestID = String(payload.request_id || "");
            const pending = pendingCommands.get(requestID);
            pending?.onEvent?.(payload.event);
            if (isRealtimeCommandFinalEvent(payload.event)) {
              window.clearTimeout(pending?.timer);
              pendingCommands.delete(requestID);
            }
            break;
          }
          case "COMMAND_ERROR": {
            const requestID = String(payload.request_id || "");
            const pending = pendingCommands.get(requestID);
            if (pending) {
              window.clearTimeout(pending.timer);
              pendingCommands.delete(requestID);
              pending.reject(new InjectControlError(payload.error || payload.code || "realtime command failed"));
            }
            break;
          }
          case "TERMINAL_EVENT": {
            if (payload.terminal_session_id && isRecord(payload.event)) {
              terminalSubscriptions.get(payload.terminal_session_id)?.(payload.event as TerminalEvent);
            }
            break;
          }
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
        clearKeepalive();
        for (const [requestID, pending] of pendingCommands) {
          window.clearTimeout(pending.timer);
          pendingCommands.delete(requestID);
          pending.reject(new Error("realtime socket disconnected before command acknowledgement"));
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
    sendCommand<TEvent = unknown>(commandInput: RealtimeCommandInput<TEvent>) {
      if (closed || !socket || socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new RealtimeNotOpenError());
      }
      const requestID = commandInput.requestId || randomRealtimeID("bcmd");
      const message = {
        type: "COMMAND",
        request_id: requestID,
        command: commandInput.command,
        daemon_device_id: commandInput.daemonDeviceId,
        ...(commandInput.sessionId ? { session_id: commandInput.sessionId } : {}),
        ...(commandInput.terminalSessionId ? { terminal_session_id: commandInput.terminalSessionId } : {}),
        payload: commandInput.payload || {},
      };
      return new Promise<RealtimeCommandAccepted>((resolve, reject) => {
        let abortListenerAttached = false;
        const cleanupAbort = () => {
          const pending = pendingCommands.get(requestID);
          if (!pending) return;
          window.clearTimeout(pending.timer);
          pendingCommands.delete(requestID);
          commandInput.signal?.removeEventListener("abort", cleanupAbort);
          reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = window.setTimeout(() => {
          pendingCommands.delete(requestID);
          if (abortListenerAttached) commandInput.signal?.removeEventListener("abort", cleanupAbort);
          reject(new RealtimeAckTimeoutError("realtime command acknowledgement timed out"));
        }, Math.max(1, commandInput.ackTimeoutMs ?? REALTIME_COMMAND_ACK_TIMEOUT_MS));
        const pendingEntry: {
          command: string;
          resolve: (accepted: RealtimeCommandAccepted) => void;
          reject: (error: Error) => void;
          onEvent?: (event: unknown) => void;
          waitsForFinalEvent: boolean;
          timer: number;
        } = {
          command: commandInput.command,
          resolve: (accepted) => {
            commandInput.signal?.removeEventListener("abort", cleanupAbort);
            resolve(accepted);
          },
          reject: (error) => {
            commandInput.signal?.removeEventListener("abort", cleanupAbort);
            reject(error);
          },
          waitsForFinalEvent: typeof commandInput.onEvent === "function",
          timer,
        };
        if (commandInput.onEvent) pendingEntry.onEvent = commandInput.onEvent as (event: unknown) => void;
        pendingCommands.set(requestID, pendingEntry);
        if (commandInput.signal) {
          abortListenerAttached = true;
          commandInput.signal.addEventListener("abort", cleanupAbort, { once: true });
        }
        try {
          socket?.send(JSON.stringify(message));
        } catch (error) {
          window.clearTimeout(timer);
          pendingCommands.delete(requestID);
          commandInput.signal?.removeEventListener("abort", cleanupAbort);
          reject(error instanceof Error ? error : new Error("failed to send realtime command"));
        }
      });
    },
    subscribeSession(sessionId: string, deviceId: string, afterSeq = 0) {
      const subscription = { sessionId, deviceId, afterSeq };
      sessionSubscriptions.set(realtimeSessionKey(sessionId, deviceId), subscription);
      sendSessionSubscription(subscription);
    },
    unsubscribeSession(sessionId: string, deviceId: string) {
      sessionSubscriptions.delete(realtimeSessionKey(sessionId, deviceId));
      sendJSON({ type: "UNSUBSCRIBE_SESSION", session_id: sessionId, device_id: deviceId });
    },
    async subscribeTerminal(terminalSessionId: string, onEvent: (event: TerminalEvent) => void, options: { notifyServer?: boolean } = {}) {
      terminalSubscriptions.set(terminalSessionId, onEvent);
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        terminalSubscriptions.delete(terminalSessionId);
        throw new RealtimeNotOpenError();
      }
      if (options.notifyServer !== false && !sendJSON({ type: "SUBSCRIBE_TERMINAL", terminal_session_id: terminalSessionId })) {
        terminalSubscriptions.delete(terminalSessionId);
        throw new RealtimeNotOpenError();
      }
    },
    async unsubscribeTerminal(terminalSessionId: string) {
      terminalSubscriptions.delete(terminalSessionId);
      sendJSON({ type: "UNSUBSCRIBE_TERMINAL", terminal_session_id: terminalSessionId });
    },
    close() {
      closed = true;
      clearReconnect();
      clearKeepalive();
      for (const [requestID, pending] of pendingCommands) {
        window.clearTimeout(pending.timer);
        pendingCommands.delete(requestID);
        pending.reject(new Error("realtime socket closed"));
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        for (const subscription of sessionSubscriptions.values()) {
          socket.send(JSON.stringify({
            type: "UNSUBSCRIBE_SESSION",
            session_id: subscription.sessionId,
            device_id: subscription.deviceId,
          }));
        }
        for (const terminalSessionId of terminalSubscriptions.keys()) {
          socket.send(JSON.stringify({ type: "UNSUBSCRIBE_TERMINAL", terminal_session_id: terminalSessionId }));
        }
      }
      socket?.close();
    },
  };
}

// requestDaemonUpdate triggers a remote `pockly-daemon update` on the
// given daemon. Nexus forwards the request through the daemon's control
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

// Forward the user's allow/deny click on a pending Claude permission card.
// Pockly forwards this to the daemon and does not persist or infer policy.
export async function decidePermissionRequest(
  requestId: string,
  daemonDeviceId: string,
  decision: "allow" | "deny",
  realtime?: SessionSubscription | null,
) {
  const preferred = preferredRealtime(realtime);
  if (preferred?.sendCommand) {
    try {
      await preferred.sendCommand({
        command: "permission_decide",
        daemonDeviceId,
        payload: { permission_request_id: requestId, decision },
      });
      return { request_id: requestId, status: "accepted" };
    } catch (error) {
      if (!(error instanceof RealtimeNotOpenError)) throw error;
    }
  }
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

async function fetchWithBrowserDevice<T>(url: string, query?: Record<string, string | number | boolean>): Promise<T> {
  const auth = await authenticateBrowserDevice();
  const finalURL = new URL(url, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      finalURL.searchParams.set(key, String(value));
    }
  }
  return fetchJSON<T>(finalURL.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${auth.device_access_token}`,
    },
  });
}

// InjectControlError carries the Nexus structured error body alongside
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

// AuthExpiredError flags HTTP 401 from any Nexus bearer-required endpoint so
// the top-level auth state hook can show the logged-out path instead of
// leaving the workspace in a stale state.
export class AuthExpiredError extends Error {
  status = 401;
  constructor(message = "session expired") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(message: string, status: number, data: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export class RealtimeNotOpenError extends Error {
  constructor(message = "realtime socket is not open") {
    super(message);
    this.name = "RealtimeNotOpenError";
  }
}

export class RealtimeAckTimeoutError extends Error {
  constructor(message = "realtime command acknowledgement timed out") {
    super(message);
    this.name = "RealtimeAckTimeoutError";
  }
}

function buildControlURL(url: string, query: Record<string, string> | undefined) {
  const finalURL = new URL(url, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) finalURL.searchParams.set(key, value);
  }
  return new URL(resolveNexusHTTPURL(finalURL.toString()));
}

// pollOptions tunes the JSON-accepted fallback poll. afterSeq opts the poll
// into turn delivery from session_turns (the reader's last known seq).
// pollIntervalMs relaxes the steady-state cadence — used when a live realtime
// subscription already delivers turns and the poll only tracks lifecycle.
type ControlPollOptions = {
  afterSeq?: number;
  pollIntervalMs?: number;
};

async function streamControl<TEvent extends InjectEvent | SyncSessionEvent>(
  url: string,
  query: Record<string, string> | undefined,
  body: unknown,
  onEvent: (event: TEvent) => void,
  signal?: AbortSignal,
  pollOptions?: ControlPollOptions,
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
  return runControlStream<TEvent>(buildControlURL(url, query), init, onEvent, pollOptions);
}

// Same control stream, but the body is multipart/form-data (file attachments).
// The browser sets the Content-Type + boundary, so we must NOT set it here.
async function streamControlMultipart<TEvent extends InjectEvent | SyncSessionEvent>(
  url: string,
  query: Record<string, string> | undefined,
  form: FormData,
  onEvent: (event: TEvent) => void,
  signal?: AbortSignal,
  pollOptions?: ControlPollOptions,
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
  return runControlStream<TEvent>(buildControlURL(url, query), init, onEvent, pollOptions);
}

async function runControlStream<TEvent extends InjectEvent | SyncSessionEvent>(
  finalURL: URL,
  init: RequestInit,
  onEvent: (event: TEvent) => void,
  pollOptions?: ControlPollOptions,
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
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const payload = await res.json().catch(() => null);
    if (payload && typeof payload === "object") {
      onEvent(payload as TEvent);
      await pollAcceptedControlEvents(finalURL, payload as TEvent, onEvent, init.signal as AbortSignal | undefined, pollOptions);
      return;
    }
    throw new Error("control response missing stream events");
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

async function pollAcceptedControlEvents<TEvent extends InjectEvent | SyncSessionEvent>(
  finalURL: URL,
  accepted: TEvent,
  onEvent: (event: TEvent) => void,
  signal?: AbortSignal,
  pollOptions?: ControlPollOptions,
) {
  if ((accepted as { streaming?: boolean }).streaming !== false) return;
  const requestID = String((accepted as { request_id?: string }).request_id || "");
  if (!requestID) return;
  let pollURL = controlEventsURL(finalURL, accepted, requestID);
  if (!pollURL) return;
  const wantTurns = pollOptions?.afterSeq !== undefined;
  const steadyIntervalMs = Math.max(CONTROL_EVENT_POLL_INTERVAL_MS, Number(pollOptions?.pollIntervalMs) || 0);
  let cursor = "";
  let seqCursor = Math.max(0, Number(pollOptions?.afterSeq) || 0);
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < CONTROL_EVENT_POLL_MAX_MS) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await sleep(attempt < 2 ? CONTROL_EVENT_POLL_INITIAL_DELAY_MS : steadyIntervalMs, signal);
    attempt += 1;
    pollURL.searchParams.set("after", cursor);
    pollURL.searchParams.set("limit", "100");
    const sessionScoped = pollURL.pathname.startsWith("/api/sessions/");
    if (wantTurns && sessionScoped) {
      pollURL.searchParams.set("after_seq", String(seqCursor));
    }
    const response = await fetchWithBrowserDevice<SessionEventCursorResponse<TEvent>>(pollURL.pathname + pollURL.search);
    cursor = response.next_cursor || cursor;
    // Turn content arrives from the server's active-turn feed: stable turns
    // from session_turns plus transient stream deltas from the control cache.
    // Both are surfaced as stream_event so the append/merge logic is shared
    // with the SSE path.
    for (const turn of response.turns || []) {
      seqCursor = Math.max(seqCursor, Number(turn.seq) || 0);
      onEvent({ request_id: requestID, type: "stream_event", turn } as unknown as TEvent);
    }
    if (typeof response.next_seq === "number") {
      seqCursor = Math.max(seqCursor, response.next_seq);
    }
    for (const event of response.events || []) {
      if (event.cursor) cursor = event.cursor;
      if (event.payload && typeof event.payload === "object") {
        onEvent(event.payload);
        // A new-session task starts on the request_id-only feed; once
        // session_created names the session, switch to the session-scoped
        // feed so turn delivery picks up. The event cursor stays valid —
        // both paths filter the same rows by request_id.
        const created = event.payload as { type?: string; session_id?: string; device_id?: string };
        if (created.type === "session_created" && created.session_id && !pollURL.pathname.startsWith("/api/sessions/")) {
          const next = controlEventsURL(finalURL, { ...(accepted as object), ...created } as TEvent, requestID);
          if (next?.pathname.startsWith("/api/sessions/")) pollURL = next;
        }
        for (const turn of (event.payload as { turns?: SessionTurn[] }).turns || []) {
          seqCursor = Math.max(seqCursor, Number(turn.seq) || 0);
          onEvent({ request_id: requestID, type: "stream_event", turn } as unknown as TEvent);
        }
        if (isTerminalControlEvent(event.payload)) return;
      }
    }
  }
  throw new Error("control event polling timed out");
}

function controlEventsURL<TEvent extends InjectEvent | SyncSessionEvent>(finalURL: URL, accepted: TEvent, requestID: string): URL | null {
  const sessionID = String((accepted as { session_id?: string }).session_id || "");
  const deviceID = finalURL.searchParams.get("device_id") || String((accepted as { device_id?: string }).device_id || "");
  if (sessionID && deviceID) {
    const url = new URL(`/api/sessions/${encodeURIComponent(sessionID)}/events`, window.location.origin);
    url.searchParams.set("device_id", deviceID);
    url.searchParams.set("request_id", requestID);
    return url;
  }
  return new URL(`/api/injects/${encodeURIComponent(requestID)}/events`, window.location.origin);
}

function isRealtimeCommandFinalEvent(event: unknown) {
  if (!isRecord(event)) return false;
  const type = String(event.type || event.stage || "");
  const status = String(event.status || "");
  if (type === "stream_event" && isRecord(event.turn) && event.turn.kind === "assistant_text") return true;
  return ["inject_ready", "inject_failed", "inject_cancelled", "completed", "failed"].includes(type) ||
    ["completed", "failed", "cancelled"].includes(status);
}

function isTerminalControlEvent(event: InjectEvent | SyncSessionEvent) {
  const inject = event as InjectEvent;
  if (inject.type === "inject_ready" || inject.type === "inject_failed" || inject.type === "inject_cancelled") return true;
  const sync = event as SyncSessionEvent;
  return sync.status === "completed" || sync.status === "failed" || sync.stage === "completed" || sync.stage === "failed";
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const setTimer = typeof window !== "undefined" && typeof window.setTimeout === "function"
      ? window.setTimeout.bind(window)
      : globalThis.setTimeout.bind(globalThis);
    const clearTimer = typeof window !== "undefined" && typeof window.clearTimeout === "function"
      ? window.clearTimeout.bind(window)
      : globalThis.clearTimeout.bind(globalThis);
    const timer = setTimer(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimer(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
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

// reportWebTelemetry optionally ships one diagnostic event to the configured
// Nexus telemetry provider. Open-source builds default to no network telemetry;
// self-hosted operators must explicitly enable their own provider.
//
// Fire-and-forget: never throws, never blocks, never logs more than once
// per minute on transport failure. Auth via the existing browser access
// bearer (same dance as every other authenticated call); if the bearer
// dance itself fails we silently drop the event — we don't want telemetry
// to surface auth errors to a user who was just trying to read their chat.
//
// IMPORTANT: do NOT call this from inside event-loop hot paths (e.g. each
// message_added render). Only call on transition events — first inject
// failure for a session, SSE disconnect, gap detection, render error.
// safeTelemetryErrorCode is the last line of defense on the diagnostics wire
// format. Callers are expected to pass an enumerated code, but a caller that
// forwards a raw exception message would otherwise ship whatever that message
// contains — a path, a URL with a query string, a token in an upstream error.
//
// Rather than blocklisting substrings (which fails open on anything unforeseen),
// this fails closed: the value must look like an enum token, or it is replaced.
// Keep this in sync with docs/security-model.md.
export function safeTelemetryErrorCode(value: string | undefined) {
  const code = (value ?? "").trim();
  if (!code) return "";
  // Enumerated codes only: lowercase words joined by _ . : - and digits.
  // Anything with whitespace, quotes, slashes, @, or non-ASCII is not an enum.
  if (!/^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(code)) return "unspecified_error";
  return code;
}

let lastTelemetryErrLog = 0;
export function reportWebTelemetry(input: {
  name: "web_sse_disconnected" | "web_sse_visibility_resume" | "web_inject_attempt" | "web_inject_error" | "web_presence_refresh_failed" | "web_stream_gap_detected" | "web_page_error" | "web_bootstrap" | "web_bootstrap_phase";
  path?: string;
  status?: "ok" | "error";
  errorCode?: string;
  sessionId?: string;
  durationMs?: number;
}) {
  if (!telemetryNetworkEnabled()) return;
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
            error_code: safeTelemetryErrorCode(input.errorCode),
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

// Browser-device access-token cache. Nexus issues a 15-minute
// token (see issueAccessToken); we reuse it for 10 minutes — a 5-minute
// safety margin so a cached token is always still valid when used, no
// 401-from-expiry. Before this, EVERY authenticated request (sessions,
// agent-settings, hosts, turns, …) re-ran the full
// device-challenge → sign → verify handshake. A burst of concurrent
// workspace calls therefore fired a burst of challenges, tripping the
  // Nexus device-challenge rate limiter (30/min) →
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
    throw new Error("device access setup failed");
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
    if (!state?.deviceId) throw new Error("device access setup failed", { cause: error });
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
