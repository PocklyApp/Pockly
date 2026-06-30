/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import type { Terminal as XTermInstance } from "@xterm/xterm";
import type { FitAddon as XTermFitAddon } from "@xterm/addon-fit";
import QRCode from "qrcode";
import {
  authorizeDaemonDevice,
  getDaemonAuthClaimStatus,
  claimDaemonSetupGrant,
  claimDaemonLocal,
  createMobileJoinQRGrant,
  claimMobileJoinQRGrant,
  announceCurrentBrowserDevice,
  connectHost,
  createTerminalSession,
  denyDaemonDevice,
  getDaemonDeviceAuthorization,
  getVAPIDPublicKey,
  getSession,
  getDaemonSessionBlocks,
  getSessionCatalogItem,
  getSessionTurns,
  listDaemonDirectory,
  listDevices,
  listDaemonProjects,
  listDevTerminalSessions,
  listOnlineHosts,
  listSessions,
  listSessionsDelta,
  listTerminalSessions,
  loginWithPassword,
  logout,
  openTerminalSession,
  registerAccount,
  registerCurrentBrowserDevice,
  registerPushSubscription,
  renameDevice,
  reportWebTelemetry,
  resendRegistrationCode,
  revokeDevice,
  cancelInject,
  CONTROL_EVENT_POLL_RELAXED_MS,
  SESSION_TURNS_WINDOW_LIMIT,
  getAgentSettings,
  getSessionDiff,
  getRuntimeCapabilities,
  getAgentDefaults,
  getPrefs,
  markSessionOpened,
  setAgentSettings,
  setActiveWorkspaceRealtime,
  setSessionPref,
  setProjectPref,
  deleteSession,
  sendTerminalInput,
  sendDevTerminalInput,
  stopTerminalSession,
  subscribeToSession,
  streamNewTask,
  streamTerminalSession,
  streamDaemonSessionBlocks,
  streamDevTerminalSession,
  streamSessionInject,
  streamSessionSync,
  requestDaemonUpdate,
  decidePermissionRequest,
  submitFeedback,
  transcribeVoice,
  verifyRegistration,
  ApiError,
  AuthExpiredError,
  InjectControlError,
  type AgentModelOption,
  type AgentSettingsSnapshot,
  type DaemonDeviceAuthorization,
  type DaemonBlock,
  type Device,
  type InjectEvent,
  type ListDirResult,
  type HostStatusUpdate,
  type HostSummary,
  type NexusRuntimeCapabilities,
  type SessionCatalogChangedEvent,
  type SessionListItem,
  type SessionPref,
  type ProjectPref,
  type SessionSubscription,
  type SessionTurnsResponse,
  type SyncSessionEvent,
  type TerminalEvent,
  type TerminalSession,
  type SessionTurn,
} from "./api";
import {
  clearSessionCatalogCache,
  loadSessionCatalogCache,
  mergeSessionCatalogDelta,
  mergeSessionCatalogPage,
  replaceSessionCatalogPage,
  saveSessionCatalogCache,
  type SessionCatalogSnapshot,
} from "./session-catalog-cache";
import {
  clearSessionTurnsCache,
  loadSessionTurnsCache,
  mergeSessionTurnsCache,
  saveSessionTurnsCache,
} from "./session-turns-cache";
import {
  createWorkspaceTabLeader,
  type WorkspaceTabLeaderHandle,
} from "./workspace-tab-leader";
import { clearBrowserDeviceState, ensureBrowserDeviceState, loadBrowserDeviceState, persistBrowserTokens } from "./crypto";
import { AppShell, Workspace } from "./components/layout/app-shell";
import { ThemeToggle } from "./components/layout/theme-toggle";
import { useTheme, type ThemeMode } from "./theme";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Notice, Select, Textarea } from "./components/ui";
import { resolveToolSpec } from "./content/tools/registry";
import { trackEvent } from "./observability";
import { configuredInstallUnixCommand, configuredInstallWindowsCommand } from "./runtime-config";
import { i18n as appI18n, isSupportedLanguage, setDocumentLanguage, type SupportedLanguage } from "./i18n";
import { Trans, useTranslation } from "react-i18next";
import {
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Check,
  Copy,
  FileText,
  Folder,
  Info,
  AlertCircle,
  Keyboard,
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
  Mic,
  MonitorOff,
  MoreHorizontal,
  Palette,
  Pin,
  PlusCircle,
  RefreshCw,
  SendHorizontal,
  Settings,
  Trash2,
  UserRound,
  Smartphone,
  SquarePen,
  Square,
  Terminal,
  Volume2,
  X,
} from "lucide-react";

type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; email: string; name: string };

export type Route =
  | { view: "login" }
  | { view: "cliLogin"; deviceCode: string }
  | { view: "duplexTest" }
  | { view: "workspaceConnect"; setupGrant?: string }
  | { view: "localSetup"; grant: string; nonce: string; cb: string }
  | { view: "mobileJoin"; grant: string }
  | { view: "workspaceDevices" }
  | { view: "workspaceLive" }
  | { view: "workspaceSettings" }
  | { view: "workspaceSessions" }
  | { view: "workspaceSession"; sessionId: string; deviceId: string }
  | { view: "routeError"; title: string; body: string };

export type ReaderSelection = { sessionId: string; deviceId: string };
// DraftConversation owns its own composer-pill state so the user's
// pre-send choices (model / permission_mode / effort) survive
// navigating to a historical session and back. Without this the
// global composer state was clobbered when ClaudeCodePillsRow
// mounted for the real session (the snapshot.current reset path).
type DraftConversation = SessionListItem & {
  isDraft: true;
  draft_model?: string;
  draft_permission_mode?: string;
  draft_effort?: string;
};
type AgentKind = "claude-code" | "codex";
type PushStatus = "checking" | "unsupported" | "blocked" | "not_enabled" | "enabled";
type VoiceStatus = "idle" | "recording" | "transcribing";
type MicStatusKind = "idle" | "checking" | "ready" | "blocked";
type InjectPhase = "idle" | "started" | "streaming" | "completed" | "failed" | "cancelled";

const BOOTSTRAP_LOADING_STATUS = "__pockly_workspace_bootstrap_loading__";

// Composer attachments: up to N files, each capped to keep the multipart
// upload (and the daemon control envelope) small. No accept restriction — the
// daemon references files by path so the agent can open any type the user picks.
const MAX_COMPOSER_ATTACHMENTS = 10;
const MAX_COMPOSER_ATTACHMENT_BYTES = 10 * 1024 * 1024;
type LocalSetupState =
  | { phase: "idle" }
  | { phase: "claiming"; message: string }
  | { phase: "done"; daemonDeviceID: string; userEmail: string }
  | { phase: "error"; message: string; retryable: boolean };

// shouldClaimLocalSetup gates the daemon-binding claim on a FRESH password
// re-auth performed on the /local-setup page (setupReauthed) — even when a
// session already exists. Binding a new device to the account must require the
// password each time and must never silently reuse the logged-in state.
export function shouldClaimLocalSetup(opts: {
  authStatus: AuthState["status"];
  routeView: string;
  setupReauthed: boolean;
  phase: LocalSetupState["phase"];
}): boolean {
  return (
    opts.authStatus === "authenticated" &&
    opts.routeView === "localSetup" &&
    opts.setupReauthed &&
    opts.phase !== "claiming" &&
    opts.phase !== "done"
  );
}
type MobileJoinState =
  | { phase: "claiming"; message: string }
  | { phase: "done"; email: string; daemonsNotified: number }
  | { phase: "error"; message: string };
type LiveSessionBridge = {
  terminalSession: TerminalSession;
  abort: AbortController;
  pendingPrompt?: string;
  ignoreEventsBefore?: number;
  // Auto-reconnect bookkeeping. attempt is the current backoff index
  // (0 = first try); reconnectTimer is the pending setTimeout id we can
  // cancel on intentional abort or on a new attachLiveSessionBridge call
  // replacing this bridge. attemptToken is an identity check the timer
  // uses to confirm it still owns this key, protecting against the race
  // where a fresh attachLiveSessionBridge happens while an old retry was
  // sleeping, then both end up trying to reconnect.
  attempt?: number;
  reconnectTimer?: number;
  attemptToken?: number;
  // Force a fresh attempt=0 reconnect. Set by connectStream so the
  // visibilitychange handler can force-recover after iOS Safari quietly
  // killed the background fetch without abort propagating.
  forceReconnect?: () => void;
};

export type SessionGroup = {
  key: string;
  label: string;
  agent: string;
  cwd: string;
  deviceId: string;
  sessionId?: string;
  sessions: SessionListItem[];
};

export type DevicePresenceStatus = "offline" | "connecting" | "online" | "degraded";
export type BrowserBindingStatus = "unpaired" | "pairing_required" | "paired" | "revoked";
export type SessionContinuationContext = {
  devicesById: Map<string, Device>;
  hostsById: Map<string, HostSummary>;
};

const codeBlockRE = /<pre><code class="language-([^"]+)">/g;

function tx(key: string, options?: Record<string, unknown>) {
  return String(options ? appI18n.t(key, options) : appI18n.t(key));
}

function logSessionHydration(event: string, details: Record<string, unknown>) {
  console.info(`[pockly:session-hydration] ${event}`, details);
}

function routeTelemetryPath(route: Route) {
  switch (route.view) {
    case "workspaceSession":
      return "/workspace/s/:session_id";
    case "workspaceSessions":
      return "/workspace/sessions";
    case "workspaceDevices":
      return "/workspace/devices";
    case "workspaceSettings":
      return "/workspace/settings";
    case "workspaceConnect":
      return "/workspace/connect";
    case "workspaceLive":
      return "/workspace/live";
    case "cliLogin":
      return "/cli/login";
    case "localSetup":
      return "/local-setup";
    case "mobileJoin":
      return "/mobile-join";
    case "duplexTest":
      return "/duplex-test";
    case "login":
      return "/login";
    case "routeError":
      return "/route-error";
  }
}

function trackBootstrapPhase(route: Route, stage: string, status: "ok" | "error", durationMs: number) {
  const roundedDuration = Math.max(0, Math.round(durationMs));
  trackEvent("web_bootstrap_phase", {
    route: routeTelemetryPath(route),
    stage,
    status,
    duration_ms: roundedDuration,
  });
  reportWebTelemetry({
    name: "web_bootstrap_phase",
    path: routeTelemetryPath(route),
    status,
    errorCode: stage,
    durationMs: roundedDuration,
  });
}

// MIN_RECOMMENDED_DAEMON_VERSION is a safety fallback for older Nexus versions
// that do not yet attach release latest metadata to /api/hosts/online.
// Current Nexus versions drive the daemon update prompt from daemon_latest_version
// / daemon_update_available so users are notified when release latest moves.
const MIN_RECOMMENDED_DAEMON_VERSION = "v0.1.37";

// SSE reconnect backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... (capped at 30s).
// No attempt cap — Nexus session_disconnected events + the user closing the
// tab are the actual stop signals. Previously capped at 12 (~3.5min) and then
// gave up with "refresh to reconnect", but that punished users coming back
// after a 10-min meeting on a still-live session. Each disconnect still
// fires web_sse_disconnected telemetry so we can spot sessions stuck in a
// reconnect loop.
const SSE_RECONNECT_MAX_BACKOFF_MS = 30000;
// After this many attempts we soften the UI copy to "still reconnecting"
// so the user knows we haven't silently spun forever, but we keep trying.
const SSE_RECONNECT_PERSISTENT_AFTER = 12;
export const PRESENCE_REFRESH_FOREGROUND_MS = 15000;
export const PRESENCE_REFRESH_BACKGROUND_MS = 60000;
export const BACKGROUND_PRESENCE_PAUSE_AFTER_MS = 10 * 60_000;
const REALTIME_HIDDEN_IDLE_CLOSE_AFTER_MS = 10 * 60_000;
// While the realtime socket is live, HOST_STATUS pushes carry presence and
// the poll drops to a slow safety net.
export const PRESENCE_REFRESH_REALTIME_MS = 60000;
export const SESSION_CATALOG_REFRESH_MS = 60000;
export const LARGE_SESSION_CATALOG_REFRESH_MS = 120000;
export const SELECTED_SESSION_TAIL_REFRESH_MS = 5000;
export const SELECTED_SESSION_OPEN_HINT_REFRESH_MS = 15000;
export const SELECTED_SESSION_TAIL_OVERLAP_TURNS = 5;
const SELECTED_SESSION_OPEN_HINT_STORAGE_PREFIX = "pockly.selectedSessionOpenHint.v1.";
export const SESSION_CATALOG_PAGE_LIMIT = 50;
export const SESSION_CATALOG_PREFETCH_PX = 240;
export const LARGE_SESSION_ACTIVE_EVENT_POLL_MS = 3000;
const MANUAL_LAZY_BACKFILL_TURN_LIMIT = 100;

// isDaemonOutdated returns true if currentVer < recommendedVer, parsing
// "vX.Y.Z" semver labels. Returns false on parse failure — we'd rather
// stay silent than scream-warn the user on an unrecognized label (could
// be a dev build like "v0.0.0-dev" or a future schema).
function isDaemonOutdated(currentVer: string, recommendedVer: string): boolean {
  const current = parseSemverParts(currentVer);
  const minimum = parseSemverParts(recommendedVer);
  if (!current || !minimum) return false;
  for (let i = 0; i < 3; i += 1) {
    if (current[i] < minimum[i]) return true;
    if (current[i] > minimum[i]) return false;
  }
  return false;
}

function parseSemverParts(label: string): [number, number, number] | null {
  // Accepts both "v0.1.28" and "0.1.28". Returns null for anything that
  // isn't three numeric segments (e.g. "v0.0.0-dev" or "pockly-daemon
  // v0.1.28 (commit, date)"). Caller treats null as "skip the check."
  const trimmed = label.trim().replace(/^v/, "");
  const head = trimmed.split(/[\s+-]/, 1)[0];
  const parts = head.split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n) || n < 0)) return null;
  return [nums[0], nums[1], nums[2]];
}

export type DaemonUpdateTarget = {
  device_id: string;
  device_name: string;
  hostname?: string;
  app_version?: string;
  daemon_latest_version?: string;
  daemon_update_source?: string;
};

export function daemonUpdateTargets(
  devices: Device[],
  hosts: HostSummary[],
  minimumRecommendedVersion = MIN_RECOMMENDED_DAEMON_VERSION,
): DaemonUpdateTarget[] {
  const hostsById = new Map(hosts.map((host) => [host.device_id, host]));
  return devices.flatMap((device) => {
    const host = hostsById.get(device.device_id);
    const currentVersion = host?.app_version || device.app_version || "";
    const latestVersion = host?.daemon_latest_version || device.daemon_latest_version || "";
    const cdnSaysUpdate = Boolean(latestVersion && (
      host?.daemon_update_available ?? device.daemon_update_available ?? isDaemonOutdated(currentVersion, latestVersion)
    ));
    const fallbackRecommendedUpdate = !latestVersion && Boolean(currentVersion) && isDaemonOutdated(currentVersion, minimumRecommendedVersion);
    if (!cdnSaysUpdate && !fallbackRecommendedUpdate) return [];
    const target: DaemonUpdateTarget = {
      device_id: device.device_id,
      device_name: host?.device_name || device.device_name,
      app_version: currentVersion,
      daemon_latest_version: latestVersion || minimumRecommendedVersion,
      daemon_update_source: latestVersion ? (host?.daemon_update_source || device.daemon_update_source || "cdn_latest") : "minimum_recommended",
    };
    const hostname = host?.hostname || device.hostname;
    if (hostname) target.hostname = hostname;
    return [target];
  });
}

function daemonUpdateRecommendation(targets: DaemonUpdateTarget[]) {
  return targets.reduce((latest, target) => {
    const candidate = target.daemon_latest_version || "";
    if (!candidate) return latest;
    return !latest || isDaemonOutdated(latest, candidate) ? candidate : latest;
  }, "");
}

// DaemonOutdatedBanner renders above the app shell whenever at least one
// of the user's paired daemons is older than Nexus-observed release latest
// or the fallback MIN_RECOMMENDED_DAEMON_VERSION.
// One-click copy of `pockly-daemon update` lets the user paste and run on
// their machine; the remote button asks Nexus to forward UPDATE_REQUEST
// over the daemon control WS.
function DaemonOutdatedBanner({
  devices,
  recommended,
  onTriggerRefresh,
}: {
  devices: DaemonUpdateTarget[];
  recommended: string;
  // onTriggerRefresh, when called, asks the parent App to re-fetch
  // /api/sessions so we can detect that the daemon's app_version has
  // bumped (which makes outdatedDaemons go empty and the banner
  // unmount). Optional — without it the user has to refresh manually
  // after running `pockly-daemon update` in their terminal.
  onTriggerRefresh?: () => void;
}) {
  const command = "pockly-daemon update";
  const [copied, setCopied] = useState(false);
  // Dismiss persists per recommended version (localStorage) so the modal
  // doesn't re-nag on every load — a newer recommended version re-prompts.
  const dismissKey = `pockly.daemonUpdateDismissed.${recommended}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(dismissKey) === "1"; } catch { return false; }
  });
  const onDismiss = useCallback(() => {
    try { localStorage.setItem(dismissKey, "1"); } catch { /* private mode */ }
    setDismissed(true);
  }, [dismissKey]);
  // updateState tracks the remote-update click for the FIRST outdated
  // daemon. The button shows "Update remotely" → "Dispatching..." →
  // "Waiting for daemon to come back" → unmount when version refreshes.
  // We only support a single in-flight update at a time.
  const [updateState, setUpdateState] = useState<"idle" | "dispatching" | "waiting" | "failed">("idle");
  const [updateError, setUpdateError] = useState("");
  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      },
      () => undefined,
    );
  }, [command]);
  const onRemoteUpdate = useCallback(async () => {
    const target = devices[0];
    if (!target) return;
    setUpdateState("dispatching");
    setUpdateError("");
    try {
      await requestDaemonUpdate(target.device_id);
      setUpdateState("waiting");
      // Poll the sessions list (and thus hosts) until either the
      // daemon comes back with a newer app_version (banner unmounts
      // naturally) or 90s pass. The daemon's launchctl-kickstart
      // restart usually finishes in <15s.
      let elapsed = 0;
      const interval = window.setInterval(() => {
        elapsed += 3;
        if (onTriggerRefresh) onTriggerRefresh();
        if (elapsed >= 90) {
          window.clearInterval(interval);
          setUpdateState("idle"); // give up signalling; banner may or may not still be visible
        }
      }, 3000);
    } catch (err) {
      setUpdateState("failed");
      setUpdateError(err instanceof Error ? err.message : String(err));
    }
  }, [devices, onTriggerRefresh]);
  const list = devices
    .map((d) => `${d.hostname || d.device_name || d.device_id.slice(0, 8)} (${d.app_version})`)
    .join(", ");
  const remoteLabel = updateState === "dispatching" ? tx("daemonUpdate.dispatching")
    : updateState === "waiting" ? tx("daemonUpdate.waiting")
    : updateState === "failed" ? tx("daemonUpdate.retry")
    : tx("daemonUpdate.updateNow");
  const updating = updateState === "dispatching" || updateState === "waiting";
  return (
    <Dialog open={!dismissed} onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <DialogContent className="ws-modal">
        <DialogTitle asChild><h3>{tx("daemonUpdate.title", { recommended })}</h3></DialogTitle>
        <DialogDescription asChild><p>{tx("daemonUpdate.body", { list })}</p></DialogDescription>
        {updateError ? <p className="ws-modal-error">{updateError}</p> : null}
        <div className="ws-modal-cmd">
          <code>{command}</code>
          <button type="button" className="pockly-empty-inline-link" onClick={onCopy}>
            {copied ? tx("daemonUpdate.copied") : tx("daemonUpdate.copyCommand")}
          </button>
        </div>
        <div className="ws-modal-actions">
          <button type="button" className="ws-modal-btn is-cancel" onClick={onDismiss}>{tx("common.cancel")}</button>
          <button type="button" className="ws-modal-btn is-primary" onClick={() => void onRemoteUpdate()} disabled={updating}>
            {remoteLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function App() {
  useTranslation();
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  // workspaceBootstrapped flips true as soon as an authenticated workspace
  // route is known. Metadata still loads in the background, but the app shell
  // can render a loading empty-state instead of keeping users on a full-screen
  // splash while devices / hosts / sessions settle. We do NOT reset this on
  // subsequent refreshes (only on logout) — once the user has seen a real
  // workspace, momentary list re-fetches must NOT bounce them back to splash.
  const [workspaceBootstrapped, setWorkspaceBootstrapped] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register" | "verify">("login");
  const [verificationEmail, setVerificationEmail] = useState("");
  const [resendAfterSeconds, setResendAfterSeconds] = useState(0);
  const [devices, setDevices] = useState<Device[]>([]);
  const [hosts, setHosts] = useState<HostSummary[]>([]);
  const hostsRef = useRef<HostSummary[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [runtimeCapabilities, setRuntimeCapabilities] = useState<NexusRuntimeCapabilities | null>(null);
  const runtimeCapabilitiesRef = useRef<NexusRuntimeCapabilities | null>(null);
  const [draftConversation, setDraftConversation] = useState<DraftConversation | null>(null);
  const [selected, setSelected] = useState<ReaderSelection | null>(null);
  // 'active' = a live terminal_session matches selectedSession; 'dead' =
  // the wrapper is not running for this session (chat history loads but new
  // prompts cannot send); 'unknown' = could not determine (network error,
  // daemon offline). Drives the optional banner over the chat view.
  const [sessionLivenessHint, setSessionLivenessHint] = useState<"active" | "dead" | "unknown">("unknown");
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  // sessionTitles holds web-derived short titles, keyed by session_id.
  // These are derived locally from loaded turns. The daemon also uploads a
  // short catalog snippet so the sidebar has a useful label before a session
  // is opened.
  //
  // Persistence is scoped per-user (see sessionTitlesStorageKey) so
  // multi-account browsers don't share each other's prompt-derived
  // labels. Population happens via the auth-aware effect below; mount
  // starts empty so the cache is never visible to an anonymous user.
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>({});
  // Server-synced UI preferences (pin / archive / rename), keyed
  // `${device_id}:${session_id}` and `${device_id}:${cwd}`. Loaded once per
  // login; mutations apply optimistically then POST, refetching on failure.
  const [sessionPrefs, setSessionPrefs] = useState<Record<string, SessionPref>>({});
  const [projectPrefs, setProjectPrefs] = useState<Record<string, ProjectPref>>({});
  const [turnsHydration, setTurnsHydration] = useState<SessionTurnsResponse | null>(null);
  const [pairStatus, setPairStatus] = useState("");
  const [sessionsStatus, setSessionsStatus] = useState("");
  const [turnsStatus, setTurnsStatus] = useState("");
  const [syncProgress, setSyncProgress] = useState<SyncSessionEvent | null>(null);
  const [syncingEarlier, setSyncingEarlier] = useState(false);
  // The rail now uses the computer picker as its primary filter. `query` stays
  // as a constant empty string so the existing filter plumbing remains a
  // harmless no-op instead of leaving an invisible stale query active.
  const query = "";
  // User's explicit computer dropdown pick. Empty = no explicit pick yet;
  // the derived `deviceFilter` below falls through to selected-session /
  // first-daemon. Keep this separate from selected.deviceId so opening a
  // session does not immediately undo a user's dropdown switch.
  const [explicitDeviceFilter, setExplicitDeviceFilter] = useState("");
  const [composerText, setComposerText] = useState("");
  // Prompt attachments (images + any file the agent can read). Sent with the
  // next message via multipart; the daemon writes them locally and references
  // them by @path. Capped to keep the upload small.
  const [composerAttachments, setComposerAttachments] = useState<File[]>([]);
  const addComposerFiles = useCallback((incoming: File[]) => {
    const accepted = incoming.filter((file) => file.size <= MAX_COMPOSER_ATTACHMENT_BYTES);
    if (accepted.length === 0) return;
    setComposerAttachments((current) => [...current, ...accepted].slice(0, MAX_COMPOSER_ATTACHMENTS));
  }, []);
  const removeComposerAttachment = useCallback((index: number) => {
    setComposerAttachments((current) => current.filter((_, i) => i !== index));
  }, []);
  // Selected effort level for the next prompt sent to a claude-code
  // session. Mirrored by ClaudeCodePillsRow from the daemon's
  // agent-settings snapshot on session select. "none" = claude's default
  // effort (don't override); a real level (low/medium/high/xhigh/max) is
  // applied via the pill's agent-settings call (PTY /effort, SDK --effort).
  const [composerEffort, setComposerEffort] = useState("none");
  const [composerModel, setComposerModel] = useState("");
  const [composerPermissionMode, setComposerPermissionMode] = useState("default");
  const [newConversationDaemon, setNewConversationDaemon] = useState("");
  const [newConversationAgent, setNewConversationAgent] = useState<AgentKind>("claude-code");
  const [newConversationDrawerOpen, setNewConversationDrawerOpen] = useState(false);
  // Rail drawer open/close (mobile). Lifted here so the workspace header's
  // hamburger (in SessionsPage) can open the rail's drawer.
  const [railDrawerOpen, setRailDrawerOpen] = useState(false);
  const [injectStatus, setInjectStatus] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  // Live AnalyserNode tapped off the recording stream so the composer can
  // draw an audio-reactive waveform while recording. Null when not recording
  // (or when Web Audio is unavailable — the waveform then falls back to a CSS
  // animation so there's still clear "recording" feedback).
  const [voiceAnalyser, setVoiceAnalyser] = useState<AnalyserNode | null>(null);
  const [voiceError, setVoiceError] = useState("");
  const [pushStatus, setPushStatus] = useState<PushStatus>("checking");
  const [pushDetail, setPushDetail] = useState("");
  const [activeInjectID, setActiveInjectID] = useState("");
  // driftPrompt holds an in-flight prompt that Nexus bounced with
  // session_drifted. We show SessionDriftDialog so the user can confirm
  // the redirect; on confirm we navigate to actualSid and refill the
  // composer with savedText, but never auto-resend. If the input box has
  // the user's text, the text is safe.
  const [driftPrompt, setDriftPrompt] = useState<{ savedText: string; actualSid: string; deviceId: string } | null>(null);
  const [claimedSetupGrant, setClaimedSetupGrant] = useState("");
  const [localSetupState, setLocalSetupState] = useState<LocalSetupState>({ phase: "idle" });
  // Whether the user has re-entered their password ON the /local-setup page for
  // the current grant. Device binding requires this even if a session already
  // exists — see shouldClaimLocalSetup.
  const [setupReauthed, setSetupReauthed] = useState(false);
  const [mobileJoinState, setMobileJoinState] = useState<MobileJoinState>({ phase: "claiming", message: tx("mobileJoin.joining") });
  const [cliAuthorization, setCliAuthorization] = useState<DaemonDeviceAuthorization | null>(null);
  const [cliStatus, setCliStatus] = useState("");
  const [realtimeVisibilityTick, setRealtimeVisibilityTick] = useState(0);
  const [workspaceLeaderTick, setWorkspaceLeaderTick] = useState(0);
  const workspaceLeaderRef = useRef<WorkspaceTabLeaderHandle | null>(null);
  const workspaceLeaderSubscriptionsRef = useRef<Map<string, { sessionId: string; deviceId: string; afterSeq: number }>>(new Map());
  const workspaceRouteActive = auth.status === "authenticated" && isAuthenticatedWorkspaceRoute(route);
  const injectRefreshRef = useRef<number | null>(null);
  const subscriptionRef = useRef<SessionSubscription | null>(null);
  const realtimeSessionSubscriptionRef = useRef<{ sessionId: string; deviceId: string } | null>(null);
  // True while the realtime browser socket is live. Presence pushes and TURN
  // pushes then cover what polling otherwise does, so the presence loop drops
  // to a slow safety cadence and inject polls relax to lifecycle-only.
  const realtimeLiveRef = useRef(false);
  const injectAbortRef = useRef<AbortController | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);
  const liveSessionBridgesRef = useRef<Map<string, LiveSessionBridge>>(new Map());
  // Keys with an attachExistingLiveSessionBridge() call in flight. The attach
  // awaits listTerminalSessions() before populating liveSessionBridgesRef, so
  // two triggers firing in that window (e.g. the session-switch attach effect
  // and the disconnect-recovery effect both running for the same session)
  // would each create a bridge and orphan one. This dedupes them by key.
  const attachInFlightRef = useRef<Set<string>>(new Set());
  const visibilityResumeForTestRef = useRef<((wasHiddenMs: number) => number) | null>(null);
  const injectPhaseRef = useRef<{ requestId: string; phase: InjectPhase }>({
    requestId: "",
    phase: "idle",
  });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceStartedAtRef = useRef(0);
  const voiceTimeoutRef = useRef<number | null>(null);
  const voiceAudioCtxRef = useRef<AudioContext | null>(null);
  const loadRequestRef = useRef(0);
  const optimisticSeqRef = useRef(900_000_000);
  // Maps jsonl-record UUID → optimistic seq we assigned the first time
  // we saw that UUID in a message_added event. Re-emits of the same
  // UUID reuse the same seq so mergeTurns dedupes (replaces) instead
  // of appending a second bubble. Catalog sync wipes these entries
  // when it resets turns from the server (setTurns(hydrated)); we
  // accept the unbounded-Map growth between hydrations because total
  // messages-per-session is small.
  const messageUUIDSeqRef = useRef<Map<string, number>>(new Map());
  const turnsRef = useRef<SessionTurn[]>([]);
  const turnsHydrationRef = useRef<SessionTurnsResponse | null>(null);
  const selectedSessionRef = useRef<SessionListItem | null>(null);
  // Live mirror of `selected` for event handlers that fire from stale
  // closures / long-lived refs (the live SSE bridge, the inject onEvent
  // callback). Those handlers must gate rendering on the CURRENTLY-displayed
  // session, not the one that was selected when they were created — otherwise
  // a background session's stream leaks into whatever conversation is on screen.
  const selectedRef = useRef<ReaderSelection | null>(null);
  const emptySessionSyncRef = useRef("");
  const selectedTailRefreshInFlightRef = useRef(false);
  const selectedTailHintAtRef = useRef<Map<string, number>>(new Map());
  const loadingEarlierRef = useRef(false);
  const pendingDraftRef = useRef<DraftConversation | null>(null);
  const lastPresenceTelemetryAtRef = useRef(0);
  const autoConnectGenerationRef = useRef(0);
  const workspaceMetadataGenerationRef = useRef(0);
  const sessionCatalogSnapshotRef = useRef<SessionCatalogSnapshot | null>(null);
  const sessionCatalogCacheLoadedForRef = useRef("");
  const sessionCatalogRealtimeRefreshInFlightRef = useRef(false);
  const sessionCatalogRealtimeRefreshQueuedRef = useRef(false);
  const [sessionCatalogHasMore, setSessionCatalogHasMore] = useState(false);
  const [sessionCatalogLoadingMore, setSessionCatalogLoadingMore] = useState(false);

  const selectedSession = useMemo(
    () => {
      if (
        draftConversation &&
        selected?.sessionId === draftConversation.session_id &&
        selected.deviceId === draftConversation.device_id
      ) {
        return draftConversation;
      }
      return sessions.find((session) => session.session_id === selected?.sessionId && session.device_id === selected.deviceId) ?? null;
    },
    [draftConversation, selected, sessions],
  );
  const sessionsWithDraft = useMemo(
    () => {
      const base = draftConversation ? [draftConversation, ...sessions.filter((session) => session.session_id !== draftConversation.session_id || session.device_id !== draftConversation.device_id)] : sessions;
      // Apply user renames by overriding the server `title` field — every
      // consumer (rail, list, header) displays the rename with no per-site
      // changes, because sessionDisplayName already prefers `title`.
      return base.map((session) => {
        const customTitle = sessionPrefs[`${session.device_id}:${session.session_id}`]?.custom_title?.trim();
        return customTitle ? { ...session, title: customTitle } : session;
      });
    },
    [draftConversation, sessions, sessionPrefs],
  );

  // When the currently-selected session is the active draft, the
  // composer pills (model / permission_mode / effort) read+write the
  // draft's own per-pill state instead of the global composer state.
  // Without this, navigating away to a historical session and back
  // wiped the user's pre-send choices (the real-session pills row
  // resets the global composer when it mounts, see ClaudeCodePillsRow's
  // non-draft useEffect).
  const isSelectedDraft = Boolean(
    draftConversation &&
      selected?.sessionId === draftConversation.session_id &&
      selected?.deviceId === draftConversation.device_id,
  );
  const effectiveComposerModel = isSelectedDraft
    ? (draftConversation?.draft_model ?? "")
    : composerModel;
  const effectiveComposerPermissionMode = isSelectedDraft
    ? (draftConversation?.draft_permission_mode ?? "default")
    : composerPermissionMode;
  const effectiveComposerEffort = isSelectedDraft
    ? (draftConversation?.draft_effort ?? "none")
    : composerEffort;
  const handleComposerModelChange = useCallback((value: string) => {
    if (isSelectedDraft) {
      setDraftConversation((current) => (current ? { ...current, draft_model: value } : current));
      return;
    }
    setComposerModel(value);
  }, [isSelectedDraft]);
  const handleComposerPermissionModeChange = useCallback((value: string) => {
    if (isSelectedDraft) {
      setDraftConversation((current) => (current ? { ...current, draft_permission_mode: value } : current));
      return;
    }
    setComposerPermissionMode(value);
  }, [isSelectedDraft]);
  const handleComposerEffortChange = useCallback((value: string) => {
    if (isSelectedDraft) {
      setDraftConversation((current) => (current ? { ...current, draft_effort: value } : current));
      return;
    }
    setComposerEffort(value);
  }, [isSelectedDraft]);
  const sessionContinuationContext = useMemo(
    () => ({
      devicesById: new Map(devices.map((device) => [device.device_id, device])),
      hostsById: new Map(hosts.map((host) => [host.device_id, host])),
    }),
    [devices, hosts],
  );
  const daemonDevices = useMemo(() => visibleComputerDevices(devices), [devices]);
  // Derived from explicit user pick + selected session's deviceId
  // (URL-driven) + daemonDevices. Precedence:
  //   1. explicit dropdown pick (if still in daemonDevices)
  //   2. URL-selected session's deviceId (if in daemonDevices)
  //   3. first daemon device
  //   4. "all" when no daemons are registered
  // This replaces two useEffects (the prior "ensure valid or fall to
  // first" and "follow selected.deviceId") that fought for control of
  // a useState and caused the dropdown to snap back when the URL had
  // a session open on a different device than the user just picked.
  const deviceFilter = useMemo(() => {
    if (daemonDevices.length === 0) return "all";
    if (explicitDeviceFilter && daemonDevices.some((device) => device.device_id === explicitDeviceFilter)) {
      return explicitDeviceFilter;
    }
    if (selected?.deviceId && daemonDevices.some((device) => device.device_id === selected.deviceId)) {
      return selected.deviceId;
    }
    return daemonDevices[0].device_id;
  }, [daemonDevices, explicitDeviceFilter, selected?.deviceId]);
  const filteredSessions = useMemo(
    () => filterSessions(sessionsWithDraft, query, "all", deviceFilter, sessionContinuationContext, sessionTitles),
    [deviceFilter, query, sessionContinuationContext, sessionTitles, sessionsWithDraft],
  );
  const sessionsForSelectedDevice = useMemo(
    () => filterSessions(sessionsWithDraft, "", "all", deviceFilter, sessionContinuationContext, sessionTitles),
    [deviceFilter, sessionContinuationContext, sessionTitles, sessionsWithDraft],
  );
  const sessionGroups = useMemo(() => groupSessions(filteredSessions, sessionContinuationContext), [filteredSessions, sessionContinuationContext]);

  function clearReaderState(status = "") {
    loadRequestRef.current += 1;
    syncAbortRef.current?.abort();
    syncAbortRef.current = null;
    setSelected(null);
    setTurns([]);
    setTurnsStatus(status);
    setSyncProgress(null);
  }

  useEffect(() => {
    let stopped = false;
    void getRuntimeCapabilities()
      .then((capabilities) => {
        if (!stopped) setRuntimeCapabilities(capabilities);
      })
      .catch(() => {
        if (!stopped) setRuntimeCapabilities(null);
      });
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    void refreshApp(parseRoute());
    const onPopState = () => {
      const next = parseRoute();
      setRoute(next);
      void refreshApp(next, true);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (injectRefreshRef.current != null) window.clearInterval(injectRefreshRef.current);
      subscriptionRef.current?.close();
      injectAbortRef.current?.abort();
      syncAbortRef.current?.abort();
      liveSessionBridgesRef.current.forEach((bridge) => bridge.abort.abort());
      liveSessionBridgesRef.current.clear();
      cleanupVoiceRecorder();
    };
  }, []);

  // visibilitychange: iOS Safari (and increasingly aggressive Chrome
  // mobile heuristics) kill background fetch streams without sending
  // an error frame, so the in-flight ReadableStream just sits on a
  // half-open socket and never fires .catch. When the user foregrounds
  // the tab we can't tell from inside JS whether the stream is dead or
  // alive, so we conservatively force-recover every live bridge if the
  // page was hidden long enough to matter (>3s — short tab swaps don't
  // count). Cheap on Nexus because the catalog rarely has more than
  // 1-2 live bridges open at once.
  useEffect(() => {
    let hiddenSince: number | null = null;
    const forceResumeLiveBridges = (wasHiddenMs: number) => {
      if (wasHiddenMs < 3000) return 0;
      const bridges = Array.from(liveSessionBridgesRef.current.values());
      let kicked = 0;
      for (const bridge of bridges) {
        if (bridge.forceReconnect) {
          bridge.forceReconnect();
          kicked += 1;
        }
      }
      if (kicked > 0) {
        reportWebTelemetry({
          name: "web_sse_visibility_resume",
          status: "ok",
          errorCode: kicked > 1 ? "visibility_resume_multi_bridge" : "visibility_resume",
          durationMs: wasHiddenMs,
        });
      }
      return kicked;
    };
    visibilityResumeForTestRef.current = forceResumeLiveBridges;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenSince = Date.now();
        return;
      }
      const wasHiddenMs = hiddenSince != null ? Date.now() - hiddenSince : 0;
      hiddenSince = null;
      forceResumeLiveBridges(wasHiddenMs);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      visibilityResumeForTestRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    void refreshPushStatus();
  }, [auth.status]);

  useEffect(() => {
    if (resendAfterSeconds <= 0) return;
    const timer = window.setTimeout(() => setResendAfterSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [resendAfterSeconds]);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    turnsHydrationRef.current = turnsHydration;
  }, [turnsHydration]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    runtimeCapabilitiesRef.current = runtimeCapabilities;
  }, [runtimeCapabilities]);

  async function refreshSelectedSessionTail(selection: ReaderSelection, options: { refreshHint?: boolean } = {}) {
    if (selectedTailRefreshInFlightRef.current) return;
    selectedTailRefreshInFlightRef.current = true;
    try {
      const now = Date.now();
      const hintKey = `${selection.deviceId}:${selection.sessionId}`;
      const lastHintAt = selectedTailHintAtRef.current.get(hintKey) ?? 0;
      if (
        shouldRefreshSelectedSessionOpenHint({
          now,
          lastHintAt,
          refreshHint: Boolean(options.refreshHint),
        }) &&
        claimSelectedSessionOpenHint(selection, now)
      ) {
        void markSessionOpened({
          sessionId: selection.sessionId,
          deviceId: selection.deviceId,
          openedAt: new Date().toISOString(),
          realtime: shouldUseBrowserRealtimeControl(runtimeCapabilitiesRef.current) ? subscriptionRef.current : null,
        }).then(() => {
          selectedTailHintAtRef.current.set(hintKey, now);
        }).catch(() => {
          // The hint only prioritizes daemon-side window sync. Tail polling
          // still works with the latest durable rows already in Nexus.
        });
      }
      const refreshed = await getSessionTurns(selection.sessionId, selection.deviceId, selectedSessionTailFetchOptions(turnsRef.current));
      const current = selectedRef.current;
      if (!current || current.sessionId !== selection.sessionId || current.deviceId !== selection.deviceId) return;
      const hydrated = refreshed.turns.map((turn) => ({ ...turn, device_id: selection.deviceId }));
      if (hydrated.length > 0) {
        mergeSessionTurnsIntoState(selection, hydrated, refreshed, isCompleteTurnsResponse(refreshed));
        setTurnsStatus("");
      } else if (refreshed.synced_max_seq !== undefined || refreshed.total_turn_count !== undefined) {
        setTurnsHydrationState((currentHydration) =>
          currentHydration ? incrementalTurnsHydration(currentHydration, refreshed, turnsRef.current) : refreshed,
        );
      }
    } catch (error) {
      if (error instanceof AuthExpiredError) {
        handleWorkspaceAuthExpired(error);
      }
      // Transient misses keep the current transcript stable; the next tick
      // and realtime stream remain the fallback.
    } finally {
      selectedTailRefreshInFlightRef.current = false;
    }
  }

  useEffect(() => {
    const selection = selected;
    if (!selection) return;
    if (!shouldPollSelectedSessionTail({
      authenticated: auth.status === "authenticated",
      readerRoute: isReaderRoute(route),
      selected: selection,
      turnsStatus,
    })) return;
    let stopped = false;
    const tick = (refreshHint = true) => {
      if (stopped) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refreshSelectedSessionTail(selection, { refreshHint });
    };
    tick(false);
    const timer = window.setInterval(() => tick(true), SELECTED_SESSION_TAIL_REFRESH_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") tick(true);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    auth.status,
    route.view,
    selected?.deviceId,
    selected?.sessionId,
    turnsStatus,
  ]);

  useEffect(() => {
    if (auth.status !== "authenticated" || !isReaderRoute(route) || !selected || !selectedSession) return;
    if (turnsStatus === "loading" || turnsStatus === "syncing") return;
    const expectedTurns = selectedSession.turn_count || selectedSession.last_seq || 0;
    if (expectedTurns <= 0 || turns.length > 0) return;
    if (!shouldSyncSessionOnOpen(selectedSession, turns)) return;
    const syncKey = `${selected.deviceId}:${selected.sessionId}:${selectedSession.last_seq}:${selectedSession.turn_count ?? 0}`;
    if (emptySessionSyncRef.current === syncKey) return;
    emptySessionSyncRef.current = syncKey;
    logSessionHydration("empty-session watchdog requesting sync", {
      sessionId: selected.sessionId,
      deviceId: selected.deviceId,
      expectedTurns,
      lastSeq: selectedSession.last_seq,
      renderedTurns: turns.length,
      turnsStatus,
    });
    const requestID = ++loadRequestRef.current;
    void syncSelectedSession(selected, requestID, 0);
  }, [
    auth.status,
    route.view,
    selected?.deviceId,
    selected?.sessionId,
    selectedSession?.last_seq,
    selectedSession?.turn_count,
    turns.length,
    turnsStatus,
  ]);

  useEffect(() => {
    if (auth.status !== "authenticated" || !isReaderRoute(route) || !selectedSession || selectedSession.agent !== "claude-code") return;
    if (!shouldAutoAttachReaderTerminalBridge(runtimeCapabilities)) return;
    const key = liveSessionBridgeKey(selectedSession);
    void attachExistingLiveSessionBridge(selectedSession);
    // Detach THIS session's bridge when the selection changes or we unmount —
    // mirrors how the WS turns subscription is torn down per-switch. Without
    // it, every visited live session leaks its SSE stream + reconnect loop.
    return () => {
      detachLiveSessionBridge(key);
    };
  }, [auth.status, route.view, runtimeCapabilities?.runtime, selectedSession?.device_id, selectedSession?.session_id, selectedSession?.agent]);

  // #47 recovery: re-attach the live SSE bridge after a session_disconnected.
  // handleLiveSessionEvent tears the bridge down when Nexus reports the host
  // unreachable (the deliberate stop-reconnect signal), but the attach effect
  // above keys only on device/session/agent — which don't change across a
  // disconnect→reconnect of the SAME session — so it never re-attaches. When the
  // catalog/presence refresh later reports the session writable again (daemon
  // back online, terminal re-announced live), re-attach so the live mirror
  // resumes instead of staying frozen on "host unreachable" until a manual nav.
  //
  // No cleanup here: the attach effect above owns detach-on-switch; this only
  // fills a *missing* bridge. Guarded on writable (daemon online) + no existing
  // bridge, and attachExistingLiveSessionBridge is idempotent and de-duped via
  // attachInFlightRef, so it never double-attaches alongside the effect above
  // (e.g. on a switch where both fire).
  useEffect(() => {
    if (auth.status !== "authenticated" || !isReaderRoute(route) || !selectedSession || selectedSession.agent !== "claude-code") return;
    if (!shouldAutoAttachReaderTerminalBridge(runtimeCapabilities)) return;
    if (selectedSession.writable !== true) return;
    if (liveSessionBridgesRef.current.has(liveSessionBridgeKey(selectedSession))) return;
    void attachExistingLiveSessionBridge(selectedSession);
  }, [auth.status, route.view, runtimeCapabilities?.runtime, selectedSession?.device_id, selectedSession?.session_id, selectedSession?.agent, selectedSession?.writable, selectedSession?.connection_mode]);

  // Opt-in test hooks for local browser automation. Activated only
  // when the URL has `?test=1`, so production users never see this
  // surface. Mounted on window so Playwright-style drivers can simulate
  // state changes (SSE drop, auth expiry, multi-bridge races) without
  // monkey-patching fetch or React internals.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).has("test")) return;
    const hooks = {
      // Snapshot of currently-attached live SSE bridges, keyed by
      // device::session — same key the production code uses internally.
      getBridges: () => Array.from(liveSessionBridgesRef.current.entries()).map(([key, b]) => ({
        key,
        terminalSessionId: b.terminalSession.terminal_session_id,
        sessionStatus: b.terminalSession.session_status,
        attempt: b.attempt ?? 0,
        hasReconnectTimer: b.reconnectTimer != null,
        attemptToken: b.attemptToken,
      })),
      // Force-abort an SSE to exercise reconnect behavior without
      // monkey-patching fetch.
      dropSSE: (key: string) => {
        const b = liveSessionBridgesRef.current.get(key);
        if (!b) return { ok: false, reason: "no bridge for key" };
        b.abort.abort();
        return { ok: true };
      },
      simulateVisibilityResumeForTest: (wasHiddenMs: number) => {
        const kicked = visibilityResumeForTestRef.current?.(Number(wasHiddenMs) || 0) ?? 0;
        return { ok: kicked > 0, kicked };
      },
      // Read-only state probes for assertions.
      getAuth: () => auth,
      getTurnCount: () => turns.length,
      getInjectStatus: () => injectStatus,
      getSessionLivenessHint: () => sessionLivenessHint,
      getBundleVersion: () => Array.from(document.scripts)
        .map((s) => s.src).filter((s) => s.includes("index-"))
        .pop()?.split("/").pop() ?? "unknown",
      // Expose a compact turn summary so browser automation can assert
      // specific kinds/payloads without scraping rendered DOM. Returns
      // the last N turns as `{kind, attachment_type, text_preview}`
      // triples; full payloads can be megabytes for jsonl-heavy sessions.
      getTurns: (limit = 20) => {
        const slice = turns.slice(-limit);
        return slice.map((t) => {
          const p = (t as { payload?: Record<string, unknown> }).payload ?? {};
          const text = typeof p.text === "string" ? p.text : "";
          return {
            kind: (t as { kind?: string }).kind ?? "",
            attachment_type: typeof p.attachment_type === "string" ? p.attachment_type : "",
            text_preview: text.length > 200 ? text.slice(0, 200) + "…" : text,
            seq: (t as { seq?: number }).seq ?? 0,
          };
        });
      },
      // Convenience helper for permission bridge tests: returns true iff
      // a permission_request attachment turn contains the marker substring.
      findPermissionRequestTurn: (marker: string) => {
        const needle = String(marker || "").trim();
        if (needle === "") return { found: false, reason: "empty marker" };
        for (const t of turns) {
          const tt = t as { kind?: string; payload?: { text?: string; attachment_type?: string } };
          if (tt.kind !== "attachment") continue;
          if (tt.payload?.attachment_type !== "permission_request") continue;
          const text = tt.payload?.text ?? "";
          if (text.includes(needle)) return { found: true, text_preview: text.slice(0, 200) };
        }
        return { found: false, scanned: turns.length };
      },
      setActiveInjectIDForTest: (requestID: string) => {
        setActiveInjectID(String(requestID || ""));
        return { ok: true };
      },
      simulateTerminalEvent: (key: string, patch: Partial<TerminalEvent>) => {
        const session = selectedSession;
        if (!session) return { ok: false, reason: "no selected session" };
        const bridge = liveSessionBridgesRef.current.get(key);
        if (!bridge) return { ok: false, reason: "no bridge for key" };
        handleLiveSessionEvent(session, {
          terminal_session_id: bridge.terminalSession.terminal_session_id,
          daemon_device_id: session.device_id,
          session_id: session.session_id,
          kind: "message_added",
          timestamp: new Date().toISOString(),
          ...patch,
        } as TerminalEvent);
        return { ok: true };
      },
      simulateInjectEvent: (patch: Partial<InjectEvent>) => {
        const turn = patch.turn && selectedSession
          ? {
              ...patch.turn,
              session_id: selectedSession.session_id,
              device_id: selectedSession.device_id,
            }
          : patch.turn;
        handleInjectEvent({
          request_id: "inj_playwright",
          type: "stream_event",
          ...patch,
          ...(turn ? { turn } : {}),
        } as InjectEvent, "session");
        return { ok: true };
      },
    };
    (window as unknown as { __pocklyTestHooks: typeof hooks }).__pocklyTestHooks = hooks;
    return () => {
      delete (window as unknown as { __pocklyTestHooks?: unknown }).__pocklyTestHooks;
    };
  }, [auth, turns.length, injectStatus, sessionLivenessHint, selectedSession]);

  function updateHosts(nextHosts: HostSummary[]) {
    hostsRef.current = nextHosts;
    setHosts(nextHosts);
  }

  function clearHosts() {
    updateHosts([]);
  }

  useEffect(() => {
    workspaceLeaderRef.current?.close();
    workspaceLeaderRef.current = null;
    workspaceLeaderSubscriptionsRef.current.clear();
    setWorkspaceLeaderTick((value) => value + 1);
    if (!workspaceRouteActive || auth.status !== "authenticated") return;
    const leader = createWorkspaceTabLeader(auth.email);
    workspaceLeaderRef.current = leader;
    const unsubscribe = leader.onChange(() => setWorkspaceLeaderTick((value) => value + 1));
    const unsubscribeMessages = leader.onMessage((message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "host_status" && !leader.isLeader && isHostStatusUpdate(message.host)) {
        applyRealtimeHostStatus(message.host);
        return;
      }
      if (message.type === "turn" && !leader.isLeader && isSessionTurn(message.turn)) {
        applyRealtimeTurn(message.turn);
        return;
      }
      if (message.type === "session_status" && !leader.isLeader) {
        realtimeLiveRef.current = message.status === "live";
        return;
      }
      if (message.type === "session_catalog_changed" && !leader.isLeader && isSessionCatalogChangedEvent(message.event)) {
        void refreshSessionCatalogFromRealtime(message.event);
        return;
      }
      if (leader.isLeader) {
        if (message.type === "subscribe_session" && message.tab_id !== leader.tabID) {
          workspaceLeaderSubscriptionsRef.current.set(`${message.tab_id}:${message.device_id}:${message.session_id}`, {
            sessionId: message.session_id,
            deviceId: message.device_id,
            afterSeq: message.after_seq,
          });
          subscriptionRef.current?.subscribeSession?.(message.session_id, message.device_id, message.after_seq);
        } else if (message.type === "unsubscribe_session" && message.tab_id !== leader.tabID) {
          workspaceLeaderSubscriptionsRef.current.delete(`${message.tab_id}:${message.device_id}:${message.session_id}`);
          if (!leaderStillNeedsSessionSubscription(message.device_id, message.session_id)) {
            subscriptionRef.current?.unsubscribeSession?.(message.session_id, message.device_id);
          }
        }
      }
    });
    return () => {
      unsubscribe();
      unsubscribeMessages();
      leader.close();
      if (workspaceLeaderRef.current === leader) workspaceLeaderRef.current = null;
      workspaceLeaderSubscriptionsRef.current.clear();
      setWorkspaceLeaderTick((value) => value + 1);
    };
  }, [auth.status, auth.status === "authenticated" ? auth.email : "", workspaceRouteActive]);

  function isWorkspaceLeaderTab() {
    return shouldRunWorkspaceNetworkLeader(workspaceLeaderRef.current?.isLeader !== false);
  }

  function leaderStillNeedsSessionSubscription(deviceId: string, sessionId: string) {
    const own = realtimeSessionSubscriptionRef.current;
    if (own?.deviceId === deviceId && own.sessionId === sessionId) return true;
    for (const subscription of workspaceLeaderSubscriptionsRef.current.values()) {
      if (subscription.deviceId === deviceId && subscription.sessionId === sessionId) return true;
    }
    return false;
  }

  function applyRealtimeTurn(turn: SessionTurn) {
    const current = selectedRef.current;
    if (!current) return;
    if (turn.session_id !== current.sessionId || (turn.device_id && turn.device_id !== current.deviceId)) return;
    const hydratedTurn = { ...turn, device_id: current.deviceId };
    setTurns((currentTurns) => reconcileHydratedTurns(currentTurns, [hydratedTurn]));
  }

  function applyRealtimeHostStatus(status: HostStatusUpdate) {
    setHosts((current) => {
      const next = current.map((host) => host.device_id === status.device_id
        ? {
            ...host,
            ...(status.presence_status ? { presence_status: status.presence_status as NonNullable<HostSummary["presence_status"]> } : {}),
            ...(status.presence_reason ? { presence_reason: status.presence_reason } : {}),
            ...(status.control_connected === undefined ? {} : { control_connected: status.control_connected }),
            ...(status.app_version ? { app_version: status.app_version } : {}),
          }
        : host);
      hostsRef.current = next;
      queueMicrotask(() => setSessions((sessions) => mergeHostPresenceIntoSessions(sessions, next)));
      return next;
    });
  }

  useEffect(() => {
    subscriptionRef.current?.close();
    subscriptionRef.current = null;
    realtimeSessionSubscriptionRef.current = null;
    if (
      !shouldUseBrowserRealtime(runtimeCapabilities) ||
      !isWorkspaceLeaderTab() ||
      auth.status !== "authenticated"
    ) {
      return;
    }
    const subscription = subscribeToSession({
      onTurn: (turn) => {
        applyRealtimeTurn(turn);
        workspaceLeaderRef.current?.post({ type: "turn", turn });
      },
      onStatus: (status) => {
        realtimeLiveRef.current = status === "live";
        workspaceLeaderRef.current?.post({ type: "session_status", status });
      },
      onHostStatus: (status) => {
        // Presence pushed over the socket replaces most foreground polling.
        applyRealtimeHostStatus(status);
        workspaceLeaderRef.current?.post({ type: "host_status", host: status });
      },
      onSessionCatalogChanged: (event) => {
        void refreshSessionCatalogFromRealtime(event);
        workspaceLeaderRef.current?.post({ type: "session_catalog_changed", event });
      },
    });
    subscriptionRef.current = subscription;
    setActiveWorkspaceRealtime(subscription);
    return () => {
      realtimeLiveRef.current = false;
      if (subscriptionRef.current === subscription) setActiveWorkspaceRealtime(null);
      if (subscriptionRef.current === subscription) realtimeSessionSubscriptionRef.current = null;
      subscription.close();
    };
  }, [auth.status, runtimeCapabilities?.browser_realtime, runtimeCapabilities?.browser_realtime_control, realtimeVisibilityTick, workspaceLeaderTick]);

  useEffect(() => {
    const subscription = subscriptionRef.current;
    const previous = realtimeSessionSubscriptionRef.current;
    const next = isReaderRoute(route) && selected && turnsStatus !== "loading"
      ? { sessionId: selected.sessionId, deviceId: selected.deviceId, afterSeq: turns.at(-1)?.seq ?? 0 }
      : null;
    if (previous && (!next || previous.sessionId !== next.sessionId || previous.deviceId !== next.deviceId)) {
      if (subscription) {
        subscription.unsubscribeSession?.(previous.sessionId, previous.deviceId);
      } else if (!isWorkspaceLeaderTab()) {
        workspaceLeaderRef.current?.post({
          type: "unsubscribe_session",
          tab_id: workspaceLeaderRef.current.tabID,
          session_id: previous.sessionId,
          device_id: previous.deviceId,
        });
      }
      realtimeSessionSubscriptionRef.current = null;
    }
    if (next && (!previous || previous.sessionId !== next.sessionId || previous.deviceId !== next.deviceId)) {
      if (subscription) {
        subscription.subscribeSession?.(next.sessionId, next.deviceId, next.afterSeq);
      } else if (!isWorkspaceLeaderTab()) {
        const leader = workspaceLeaderRef.current;
        leader?.post({
          type: "subscribe_session",
          tab_id: leader.tabID,
          session_id: next.sessionId,
          device_id: next.deviceId,
          after_seq: next.afterSeq,
        });
      }
      realtimeSessionSubscriptionRef.current = { sessionId: next.sessionId, deviceId: next.deviceId };
    }
  }, [route.view, selected?.deviceId, selected?.sessionId, turnsStatus, workspaceLeaderTick]);

  useEffect(() => {
    if (!realtimeLiveRef.current || document.visibilityState !== "hidden") return;
    if (activeInjectID || isWorkspaceLiveRoute(route) || summarizePendingPermissions(turns).count > 0) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== "hidden") return;
      if (activeInjectID || isWorkspaceLiveRoute(route) || summarizePendingPermissions(turnsRef.current).count > 0) return;
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
      realtimeSessionSubscriptionRef.current = null;
      realtimeLiveRef.current = false;
      setActiveWorkspaceRealtime(null);
    }, REALTIME_HIDDEN_IDLE_CLOSE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [activeInjectID, route.view, turns]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && shouldUseBrowserRealtime(runtimeCapabilities)) {
        setRealtimeVisibilityTick((value) => value + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [runtimeCapabilities?.browser_realtime, runtimeCapabilities?.browser_realtime_control]);

  // Derive a session title from the loaded turns once they land. This keeps
  // opened sessions labeled consistently with catalog snippets.
  useEffect(() => {
    if (auth.status !== "authenticated") return;
    if (!selected || turns.length === 0) return;
    const firstUser = turns.find((turn) =>
      turn.kind === "user_message"
      && turn.session_id === selected.sessionId
      && turn.payload?.text
    );
    const text = firstUser?.payload?.text;
    if (!text) return;
    const derived = deriveSessionTitle(text);
    if (!derived) return;
    const sid = selected.sessionId;
    const userKey = auth.email;
    setSessionTitles((previous) => {
      if (previous[sid] === derived) return previous;
      // Trim once, then persist + return the same trimmed map so React
      // state and localStorage never diverge. Previous implementation
      // bounded only the persisted copy, letting the in-memory map grow
      // past the cap.
      const next = boundSessionTitles({ ...previous, [sid]: derived });
      saveSessionTitlesToStorage(userKey, next);
      return next;
    });
  }, [selected?.sessionId, turns, auth.status, auth.status === "authenticated" ? auth.email : ""]);

  // Derive sidebar titles from the first-user-message snippet Nexus returns on
  // the session-list API. Titles feed the same sessionTitles cache that
  // opened-session derivation populates, so sessionDisplayName picks them up
  // with no rendering changes. Sessions whose title is already cached are
  // skipped.
  useEffect(() => {
    if (auth.status !== "authenticated") return;
    if (sessions.length === 0) return;
    const userKey = auth.email;
    const decoded = new Map<string, string>();
    for (const session of sessions) {
      // Skip when already cached, when there's no snippet to derive from, or
      // when Nexus already supplies a generated title (which wins in
      // sessionDisplayName, so a client-derived fallback would never show).
      if (sessionTitles[session.session_id] || session.title || !session.snippet) continue;
      const derived = deriveSessionTitle(session.snippet);
      if (derived) decoded.set(session.session_id, derived);
    }
    if (decoded.size === 0) return;
    setSessionTitles((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const [sid, label] of decoded) {
        if (next[sid] !== label) {
          next[sid] = label;
          changed = true;
        }
      }
      if (!changed) return previous;
      const bounded = boundSessionTitles(next);
      saveSessionTitlesToStorage(userKey, bounded);
      return bounded;
    });
  }, [sessions, sessionTitles, auth.status, auth.status === "authenticated" ? auth.email : ""]);

  useEffect(() => {
    if (daemonDevices.length === 0) {
      if (newConversationDaemon) setNewConversationDaemon("");
      return;
    }
    const selectedDaemon = deviceFilter !== "all" && daemonDevices.some((device) => device.device_id === deviceFilter)
      ? deviceFilter
      : daemonDevices[0].device_id;
    if (newConversationDaemon !== selectedDaemon) {
      setNewConversationDaemon(selectedDaemon);
    }
  }, [daemonDevices, deviceFilter, newConversationDaemon]);

  useEffect(() => {
    if (auth.status === "authenticated" && route.view === "workspaceConnect" && route.setupGrant) {
      void onClaimDaemonSetupGrant(route.setupGrant);
    }
  }, [auth.status, route]);

  // AskUserQuestion answer bridge. Children deep in the turn renderer dispatch
  // a pockly:answer-question CustomEvent on click; this listener routes the
  // answer through sendPromptForSession against the currently selected session
  // without prop-drilling through several component layers.
  useEffect(() => {
    const onAnswer = (e: Event) => {
      const detail = (e as CustomEvent<AnswerQuestionDetail>).detail;
      if (!detail?.text || !selectedSession) return;
      // The picker's contract is "send exactly the option text". That's
      // automatic now — effort is applied via the pill's agent-settings
      // call, not prepended to the prompt, so the option text is sent verbatim.
      void sendPromptForSession(selectedSession, detail.text);
    };
    window.addEventListener(ANSWER_QUESTION_EVENT, onAnswer);
    return () => window.removeEventListener(ANSWER_QUESTION_EVENT, onAnswer);
  }, [selectedSession]);

  // Every new setup grant must re-prove the password — clear any prior re-auth
  // so a fresh `pockly-daemon setup` can never ride an earlier one's state.
  useEffect(() => {
    setSetupReauthed(false);
  }, [route.view === "localSetup" ? route.grant : null]);

  // /local-setup is opened by `pockly-daemon setup` on the user's local
  // machine. Run the claim and POST the resulting tokens to the daemon's
  // loopback callback ONLY after a fresh password re-auth on this page
  // (setupReauthed) — binding a new device must not silently reuse an existing
  // login. setupReauthed is set by onPasswordLogin when the route is localSetup.
  useEffect(() => {
    if (route.view !== "localSetup") return;
    if (!shouldClaimLocalSetup({ authStatus: auth.status, routeView: route.view, setupReauthed, phase: localSetupState.phase })) return;
    void runLocalSetup(route.grant, route.nonce, route.cb);
  }, [
    auth.status,
    route.view,
    setupReauthed,
    route.view === "localSetup" ? route.grant : "",
    route.view === "localSetup" ? route.nonce : "",
    route.view === "localSetup" ? route.cb : "",
  ]);

  useEffect(() => {
    if (route.view !== "mobileJoin") return;
    if (mobileJoinState.phase === "done") return;
    void runMobileJoin(route.grant);
  }, [route.view, route.view === "mobileJoin" ? route.grant : ""]);

  // Per-user session title cache, derived from loaded turns.
  // Loads the current account's titles whenever auth resolves; clears
  // immediately on signout. Storage stays scoped by email so multiple
  // accounts on one browser don't share or leak prompt-derived labels.
  useEffect(() => {
    if (auth.status === "authenticated") {
      setSessionTitles(loadSessionTitlesFromStorage(auth.email));
    } else {
      setSessionTitles({});
    }
  }, [auth.status, auth.status === "authenticated" ? auth.email : ""]);

  // Server-synced pin/archive/rename prefs: load once per login.
  const refreshPrefs = useCallback(async () => {
    try {
      const snapshot = await getPrefs();
      setSessionPrefs(Object.fromEntries(snapshot.session_prefs.map((pref) => [`${pref.device_id}:${pref.session_id}`, pref])));
      setProjectPrefs(Object.fromEntries(snapshot.project_prefs.map((pref) => [`${pref.device_id}:${pref.cwd}`, pref])));
    } catch {
      // Prefs are cosmetic — a transient failure just leaves defaults.
    }
  }, []);
  useEffect(() => {
    if (auth.status === "authenticated") {
      void refreshPrefs();
    } else {
      setSessionPrefs({});
      setProjectPrefs({});
    }
  }, [auth.status, refreshPrefs]);

  // Optimistic pref mutators: update local state immediately, POST in the
  // background, re-pull server truth on failure so the UI never lies.
  const applySessionPref = useCallback((deviceId: string, sessionId: string, patch: { pinned?: boolean; archived?: boolean; customTitle?: string }) => {
    const key = `${deviceId}:${sessionId}`;
    setSessionPrefs((current) => ({
      ...current,
      [key]: {
        device_id: deviceId,
        session_id: sessionId,
        pinned: patch.pinned ?? current[key]?.pinned ?? false,
        archived: patch.archived ?? current[key]?.archived ?? false,
        custom_title: patch.customTitle ?? current[key]?.custom_title ?? "",
      },
    }));
    setSessionPref({ sessionId, deviceId, ...patch }).catch(() => void refreshPrefs());
  }, [refreshPrefs]);
  const applyProjectPref = useCallback((deviceId: string, cwd: string, patch: { pinned?: boolean; archived?: boolean; removed?: boolean; customLabel?: string }) => {
    const key = `${deviceId}:${cwd}`;
    setProjectPrefs((current) => ({
      ...current,
      [key]: {
        device_id: deviceId,
        cwd,
        pinned: patch.pinned ?? current[key]?.pinned ?? false,
        archived: patch.archived ?? current[key]?.archived ?? false,
        removed: patch.removed ?? current[key]?.removed ?? false,
        custom_label: patch.customLabel ?? current[key]?.custom_label ?? "",
      },
    }));
    setProjectPref({ deviceId, cwd, ...patch }).catch(() => void refreshPrefs());
  }, [refreshPrefs]);

  // Pending PERMANENT session delete, gated behind the confirm modal.
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; deviceId: string; title: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const confirmDeleteSession = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await deleteSession({ sessionId: deleteTarget.sessionId, deviceId: deleteTarget.deviceId });
      setSessions((current) => current.filter((session) => !(session.session_id === deleteTarget.sessionId && session.device_id === deleteTarget.deviceId)));
      setSelected((current) => {
        if (current?.sessionId === deleteTarget.sessionId && current.deviceId === deleteTarget.deviceId) {
          setTurns([]);
          setTurnsHydrationState(null);
          setTurnsStatus("");
          replaceRoute({ view: "workspaceSessions" });
          return null;
        }
        return current;
      });
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget]);
  function handleWorkspaceAuthExpired(error: AuthExpiredError) {
    const message = error.message || "session expired";
    autoConnectGenerationRef.current += 1;
    workspaceMetadataGenerationRef.current += 1;
    setAuth({ status: "anonymous" });
    setWorkspaceBootstrapped(false);
    setDevices([]);
    clearHosts();
    setSessions([]);
    // Tear down live bridges on auth expiry (Nexus redeploy / session expiry).
    // clearReaderState doesn't touch them, so without this each orphaned
    // bridge keeps reconnect-looping through 401s, and a stale "live" bridge
    // blocks a correct reattach after the user logs back in.
    [...liveSessionBridgesRef.current.keys()].forEach(detachLiveSessionBridge);
    setDraftConversation(null);
    pendingDraftRef.current = null;
    setSessionsStatus(message);
    clearReaderState(message);
    if (!isPublicRoute(route) && route.view !== "login") {
      sessionStorage.setItem("pockly.return_after_login", routeToPath(route));
      replaceRoute({ view: "login" });
    }
  }

  async function refreshWorkspacePresence(options: { includeSessions?: boolean } = {}) {
    const startedAt = Date.now();
    const browserDeviceID = loadBrowserDeviceState()?.deviceId;
    const includeSessions = options.includeSessions === true;
    const userKey = auth.status === "authenticated" ? auth.email : "";
    const [hostResult, sessionResult] = await Promise.allSettled([
      listOnlineHosts(browserDeviceID),
      includeSessions && userKey ? refreshSessionCatalog(userKey) : Promise.resolve(null),
    ]);
    for (const result of [hostResult, sessionResult]) {
      if (result.status === "rejected" && result.reason instanceof AuthExpiredError) {
        throw result.reason;
      }
    }
    const failed = [hostResult, sessionResult].find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) {
      const now = Date.now();
      if (now - lastPresenceTelemetryAtRef.current > 60_000) {
        lastPresenceTelemetryAtRef.current = now;
        reportWebTelemetry({
          name: "web_presence_refresh_failed",
          errorCode: normalizeTelemetryError(failed.reason instanceof Error ? failed.reason.message : "presence_refresh_failed"),
          durationMs: now - startedAt,
        });
      }
    }
    return {
      hosts: hostResult.status === "fulfilled" ? hostResult.value.hosts ?? [] : null,
      sessions: includeSessions && sessionResult.status === "fulfilled" && sessionResult.value ? sessionResult.value.sessions ?? [] : null,
    };
  }

  function applyWorkspacePresence(snapshot: Awaited<ReturnType<typeof refreshWorkspacePresence>>) {
    workspaceMetadataGenerationRef.current += 1;
    if (snapshot.hosts) {
      updateHosts(snapshot.hosts);
      if (!snapshot.sessions) {
        setSessions((current) => mergeHostPresenceIntoSessions(current, snapshot.hosts ?? []));
      }
    }
    if (!snapshot.sessions) return;
    applyListedSessions(snapshot.sessions);
  }

  function applyListedSessions(listedSessions: SessionListItem[]) {
    const sessionsWithPresence = mergeHostPresenceIntoSessions(listedSessions, hostsRef.current);
    setSessions(sessionsWithPresence);
    setDraftConversation((current) => current && hasSession(sessionsWithPresence, { sessionId: current.session_id, deviceId: current.device_id }) ? null : current);
    setSessionsStatus("");
  }

  async function refreshSessionCatalog(userKey: string, options: { useCachedSnapshot?: boolean } = {}) {
    if (options.useCachedSnapshot !== false) {
      await ensureSessionCatalogCacheLoaded(userKey);
    }
    const current = sessionCatalogSnapshotRef.current ?? { sessions, cursor: "", updated_at: 0 };
    if (current.cursor) {
      try {
        const delta = await listSessionsDelta({ since: current.cursor, limit: SESSION_CATALOG_PAGE_LIMIT });
        const merged = mergeSessionCatalogDelta(current, delta);
        setSessionCatalogSnapshot(userKey, merged);
        void saveSessionCatalogCache(userKey, merged);
        return { sessions: merged.sessions };
      } catch (error) {
        if (!shouldFallbackToFullSessionCatalog(error, Boolean(current.sessions.length))) {
          return { sessions: current.sessions };
        }
        // Old Nexus builds fall back to the compatibility full list. Transient
        // managed-runtime failures keep the cached catalog instead of turning a
        // short delta outage into a high-cost full catalog request.
      }
    }
    try {
      const initialDelta = await listSessionsDelta({ limit: SESSION_CATALOG_PAGE_LIMIT });
      const snapshot = replaceSessionCatalogPage(initialDelta);
      setSessionCatalogSnapshot(userKey, snapshot);
      void saveSessionCatalogCache(userKey, snapshot);
      return { sessions: snapshot.sessions };
    } catch (error) {
      if (!shouldFallbackToFullSessionCatalog(error, Boolean(current.sessions.length))) {
        return { sessions: current.sessions };
      }
      const full = await listSessions();
      const snapshot: SessionCatalogSnapshot = {
        sessions: full.sessions ?? [],
        cursor: "",
        page_cursor: "",
        has_more_pages: false,
        updated_at: Date.now(),
      };
      setSessionCatalogSnapshot(userKey, snapshot);
      void saveSessionCatalogCache(userKey, snapshot);
      return full;
    }
  }

  async function refreshSessionCatalogFromRealtime(_event?: SessionCatalogChangedEvent) {
    if (auth.status !== "authenticated" || !workspaceRouteActive) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const userKey = auth.email;
    const current = sessionCatalogSnapshotRef.current;
    if (!current?.cursor) {
      // Realtime catalog hints are a cheap delta trigger, not a bootstrap path.
      // If this tab has no catalog cursor yet, the existing workspace load or
      // 60s fallback refresh will establish one without forcing a full list here.
      return;
    }
    if (sessionCatalogRealtimeRefreshInFlightRef.current) {
      sessionCatalogRealtimeRefreshQueuedRef.current = true;
      return;
    }
    sessionCatalogRealtimeRefreshInFlightRef.current = true;
    try {
      const delta = await listSessionsDelta({ since: current.cursor, limit: SESSION_CATALOG_PAGE_LIMIT });
      const merged = mergeSessionCatalogDelta(sessionCatalogSnapshotRef.current ?? current, delta);
      setSessionCatalogSnapshot(userKey, merged);
      applyListedSessions(merged.sessions);
      void saveSessionCatalogCache(userKey, merged);
    } catch (error) {
      if (error instanceof AuthExpiredError) {
        handleWorkspaceAuthExpired(error);
      }
      // Transient realtime catalog refresh failures keep the last visible
      // catalog. The normal 60s catalog refresh remains the fallback.
    } finally {
      sessionCatalogRealtimeRefreshInFlightRef.current = false;
      if (sessionCatalogRealtimeRefreshQueuedRef.current) {
        sessionCatalogRealtimeRefreshQueuedRef.current = false;
        window.setTimeout(() => void refreshSessionCatalogFromRealtime(_event), 0);
      }
    }
  }

  async function ensureSessionCatalogCacheLoaded(userKey: string) {
    const normalizedUserKey = userKey.trim().toLowerCase();
    if (!normalizedUserKey || sessionCatalogCacheLoadedForRef.current === normalizedUserKey) return;
    sessionCatalogSnapshotRef.current = null;
    sessionCatalogCacheLoadedForRef.current = normalizedUserKey;
    const cached = await loadSessionCatalogCache(normalizedUserKey);
    if (!cached) return;
    setSessionCatalogSnapshot(normalizedUserKey, cached);
    setSessions((current) => current.length > 0 ? current : mergeHostPresenceIntoSessions(cached.sessions, hostsRef.current));
  }

  async function loadSessionCatalogItem(userKey: string, selection: ReaderSelection) {
    const item = await getSessionCatalogItem(selection.sessionId, selection.deviceId);
    const session = item.session;
    const current = sessionCatalogSnapshotRef.current ?? { sessions, cursor: "", updated_at: 0 };
    const snapshot = mergeSessionCatalogDelta(current, {
      upserts: [session],
      deletes: [],
      next_cursor: current.cursor || "",
      has_more: false,
    });
    setSessionCatalogSnapshot(userKey, snapshot);
    void saveSessionCatalogCache(userKey, snapshot);
    return session;
  }

  function setSessionCatalogSnapshot(userKey: string, snapshot: SessionCatalogSnapshot | null) {
    sessionCatalogSnapshotRef.current = snapshot;
    setSessionCatalogHasMore(Boolean(snapshot?.has_more_pages && snapshot.page_cursor));
    if (!snapshot && userKey) {
      void clearSessionCatalogCache(userKey);
    }
  }

  function cacheTurnsSnapshot(selection: ReaderSelection, nextTurns: SessionTurn[], hydration: SessionTurnsResponse | null) {
    if (auth.status !== "authenticated" || selection.sessionId.startsWith("draft_")) return;
    const snapshot = mergeSessionTurnsCache(null, {
      deviceId: selection.deviceId,
      sessionId: selection.sessionId,
      turns: nextTurns,
      hydration,
    });
    void saveSessionTurnsCache(auth.email, snapshot);
  }

  function setTurnsHydrationState(next: SessionTurnsResponse | null | ((current: SessionTurnsResponse | null) => SessionTurnsResponse | null)) {
    if (typeof next === "function") {
      setTurnsHydration((current) => {
        const updated = next(current);
        turnsHydrationRef.current = updated;
        return updated;
      });
      return;
    }
    turnsHydrationRef.current = next;
    setTurnsHydration(next);
  }

  function replaceSessionTurns(selection: ReaderSelection, nextTurns: SessionTurn[], hydration: SessionTurnsResponse | null) {
    turnsRef.current = nextTurns;
    setTurns(nextTurns);
    setTurnsHydrationState(hydration);
    cacheTurnsSnapshot(selection, nextTurns, hydration);
  }

  function mergeSessionTurnsIntoState(selection: ReaderSelection, incoming: SessionTurn[], hydration: SessionTurnsResponse | null, authoritative = false) {
    const merged = reconcileHydratedTurns(turnsRef.current, incoming, authoritative);
    const mergedHydration = hydration
      ? incrementalTurnsHydration(turnsHydrationRef.current, hydration, merged)
      : turnsHydrationRef.current
        ? { ...turnsHydrationRef.current, turns: merged }
        : null;
    turnsRef.current = merged;
    setTurns(merged);
    if (mergedHydration) setTurnsHydrationState(mergedHydration);
    cacheTurnsSnapshot(selection, merged, mergedHydration);
  }

  async function loadMoreSessionCatalogPage() {
    if (auth.status !== "authenticated" || sessionCatalogLoadingMore) return;
    const current = sessionCatalogSnapshotRef.current;
    if (!current?.page_cursor || !current.has_more_pages) return;
    setSessionCatalogLoadingMore(true);
    try {
      const page = await listSessionsDelta({ limit: SESSION_CATALOG_PAGE_LIMIT, pageCursor: current.page_cursor });
      const merged = mergeSessionCatalogPage(current, page);
      setSessionCatalogSnapshot(auth.email, merged);
      applyListedSessions(merged.sessions);
      void saveSessionCatalogCache(auth.email, merged);
    } catch (error) {
      setSessionsStatus(error instanceof Error ? error.message : tx("errors.failedLoadSessions"));
    } finally {
      setSessionCatalogLoadingMore(false);
    }
  }

  async function autoConnectWorkspaceHosts(connectableHosts: HostSummary[], autoConnectGeneration: number, metadataGeneration: number) {
    if (connectableHosts.length === 0) return;
    try {
      const browserState = await ensureBrowserDeviceState();
      for (const host of connectableHosts) {
        if (autoConnectGeneration !== autoConnectGenerationRef.current) return;
        const connected = await connectHost(host.device_id, {
	        ...(browserState.deviceId ? { browser_device_id: browserState.deviceId } : {}),
	        browser_device_pubkey: browserState.devicePublicKey,
	        device_name: browserDeviceName(),
          user_agent: navigator.userAgent,
        });
        persistBrowserTokens({ browserDeviceId: connected.browser_device_id });
      }
      if (autoConnectGeneration !== autoConnectGenerationRef.current) return;
      const userKey = auth.status === "authenticated" ? auth.email : "";
      const [hostSnapshot, sessionSnapshot] = await Promise.allSettled([
        listOnlineHosts(loadBrowserDeviceState()?.deviceId),
        userKey ? refreshSessionCatalog(userKey) : listSessions(),
      ]);
      if (
        autoConnectGeneration !== autoConnectGenerationRef.current ||
        metadataGeneration !== workspaceMetadataGenerationRef.current
      ) {
        return;
      }
      workspaceMetadataGenerationRef.current += 1;
      if (hostSnapshot.status === "fulfilled") {
        updateHosts(hostSnapshot.value.hosts ?? []);
      }
      if (sessionSnapshot.status === "fulfilled") {
        const listedSessions = sessionSnapshot.value.sessions ?? [];
        applyListedSessions(listedSessions);
      }
      for (const result of [hostSnapshot, sessionSnapshot]) {
        if (result.status === "rejected" && result.reason instanceof AuthExpiredError) {
          handleWorkspaceAuthExpired(result.reason);
          return;
        }
      }
    } catch (error) {
      if (autoConnectGeneration !== autoConnectGenerationRef.current) return;
      if (error instanceof AuthExpiredError) {
        handleWorkspaceAuthExpired(error);
        return;
      }
      console.debug("[pockly:hosts] auto-connect failed", error);
    }
  }

  useEffect(() => {
    if (!workspaceRouteActive || auth.status !== "authenticated") return;
    if (!isWorkspaceLeaderTab()) return;
    let stopped = false;
    let refreshTimer: number | null = null;
    let inFlight = false;
    let lastSessionRefreshAt = 0;
    let lastPresenceRunAt = 0;
    let hiddenSinceAt = document.visibilityState === "hidden" ? Date.now() : 0;
    const run = (options: { forceSessions?: boolean } = {}) => {
      if (stopped || inFlight) return;
      const now = Date.now();
      const visible = document.visibilityState === "visible";
      const force = options.forceSessions === true;
      if (!shouldPollWorkspacePresence({
        now,
        visible,
        hiddenSinceAt,
        force,
      })) {
        return;
      }
      // With a live realtime socket, presence arrives as HOST_STATUS pushes;
      // keep only a slow safety poll (and never skip an explicit force).
      if (
        realtimeLiveRef.current &&
        !force &&
        now - lastPresenceRunAt < PRESENCE_REFRESH_REALTIME_MS
      ) {
        return;
      }
      lastPresenceRunAt = now;
      const includeSessions = shouldRefreshSessionCatalog({
        now,
        lastSessionRefreshAt,
        visible,
        force,
        intervalMs: sessionCatalogRefreshIntervalForSession(selectedSessionRef.current),
      });
      if (includeSessions) lastSessionRefreshAt = now;
      inFlight = true;
      void refreshWorkspacePresence({ includeSessions })
        .then((snapshot) => {
          if (!stopped) applyWorkspacePresence(snapshot);
        })
        .catch((error) => {
          if (!stopped && error instanceof AuthExpiredError) handleWorkspaceAuthExpired(error);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const schedule = () => {
      if (refreshTimer != null) window.clearInterval(refreshTimer);
      const intervalMs = document.visibilityState === "visible" ? PRESENCE_REFRESH_FOREGROUND_MS : PRESENCE_REFRESH_BACKGROUND_MS;
      refreshTimer = window.setInterval(run, intervalMs);
    };
    const onVisibilityChange = () => {
      hiddenSinceAt = document.visibilityState === "hidden" ? Date.now() : 0;
      schedule();
      if (document.visibilityState === "visible") run({ forceSessions: true });
    };
    schedule();
    if (document.visibilityState === "visible") run({ forceSessions: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      if (refreshTimer != null) window.clearInterval(refreshTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [auth.status, auth.status === "authenticated" ? auth.email : "", workspaceRouteActive, workspaceLeaderTick]);

  async function refreshApp(targetRoute = route, preserveCurrentSelection = false) {
    autoConnectGenerationRef.current += 1;
    // Close the session-switch gap. Both nav paths (navigate() and the
    // popstate handler) change the route BEFORE this function's first
    // await (getSession()), so for the whole fetch window the route
    // points at the new session while `selected`/`turns`/`turnsStatus`
    // still describe the previous one — the conversation pane renders the
    // PREVIOUS session's full header+body (no loading state) until the
    // new turns land. Flipping to "loading" + dropping stale turns
    // synchronously here makes the render fall straight to
    // <ReaderPlaceholder/> instead of showing the wrong session. Skipped
    // when re-opening the current session or a draft (no stale-content
    // risk there, and we don't want a needless loading flash).
    if (
      targetRoute.view === "workspaceSession" &&
      targetRoute.sessionId &&
      (selected?.sessionId !== targetRoute.sessionId || selected?.deviceId !== targetRoute.deviceId) &&
      !(draftConversation && targetRoute.sessionId === draftConversation.session_id)
    ) {
      setTurnsStatus("loading");
      setTurns([]);
      // Advance the header/selection too when the target is already in the
      // catalog, so the title bar + badge reflect the new session right
      // away instead of lingering on the previous one. Guarded by
      // hasSession so a not-yet-synced session can't blank selectedSession
      // into the idle "pick a conversation" state mid-load.
      const switchTarget = { sessionId: targetRoute.sessionId, deviceId: targetRoute.deviceId };
      if (hasSession(sessions, switchTarget)) {
        setSelected(switchTarget);
      }
    }
    const firstWorkspaceBootstrap = !workspaceBootstrapped && isAuthenticatedWorkspaceRoute(targetRoute);
    const bootstrapStartedAt = performance.now();
    const markBootstrap = (stage: string, status: "ok" | "error", startedAt: number) => {
      if (!firstWorkspaceBootstrap) return;
      trackBootstrapPhase(targetRoute, stage, status, performance.now() - startedAt);
    };
    const reportBootstrap = (status: "ok" | "error", outcome: string) => {
      if (!firstWorkspaceBootstrap) return;
      reportWebTelemetry({
        name: "web_bootstrap",
        path: routeTelemetryPath(targetRoute),
        status,
        errorCode: outcome,
        durationMs: Math.round(performance.now() - bootstrapStartedAt),
      });
    };
    const timed = async <T,>(stage: string, fn: () => Promise<T>): Promise<T> => {
      const startedAt = performance.now();
      try {
        const value = await fn();
        markBootstrap(stage, "ok", startedAt);
        return value;
      } catch (error) {
        markBootstrap(stage, "error", startedAt);
        throw error;
      }
    };
    let session: Awaited<ReturnType<typeof getSession>>;
    try {
      session = await timed("auth_session", getSession);
    } catch (error) {
      setAuth({ status: "anonymous" });
      setWorkspaceBootstrapped(false);
      setSessionsStatus(error instanceof Error ? tx("errors.relayUnavailable", { message: error.message }) : tx("errors.relayUnavailableShort"));
      reportBootstrap("error", "auth_session");
      if (!isPublicRoute(targetRoute) && targetRoute.view !== "login") replaceRoute({ view: "login" });
      return;
    }

    if (!session.authenticated || !session.user) {
      autoConnectGenerationRef.current += 1;
      workspaceMetadataGenerationRef.current += 1;
      setAuth({ status: "anonymous" });
      // Reset bootstrap so the NEXT login goes splash→workspace cleanly
      // rather than briefly showing the previous user's (now-empty)
      // workspace before this user's list calls land.
      setWorkspaceBootstrapped(false);
      setDevices([]);
      clearHosts();
      setSessions([]);
      clearReaderState();
      if (!isPublicRoute(targetRoute) && targetRoute.view !== "login") {
        sessionStorage.setItem("pockly.return_after_login", routeToPath(targetRoute));
        replaceRoute({ view: "login" });
      }
      return;
    }

    setAuth({ status: "authenticated", email: session.user.email, name: session.user.name });
    if (isAuthenticatedWorkspaceRoute(targetRoute) && !workspaceBootstrapped) {
      setWorkspaceBootstrapped(true);
      if (sessions.length === 0) {
        setSessionsStatus(BOOTSTRAP_LOADING_STATUS);
      }
    }

    if (targetRoute.view === "login") {
      replaceRoute({ view: "workspaceSessions" });
      await refreshApp({ view: "workspaceSessions" });
      return;
    }

    if (isPublicRoute(targetRoute)) {
      return;
    }

    if (targetRoute.view === "cliLogin") {
      await loadCLIAuth(targetRoute.deviceCode);
      return;
    }

    try {
      await timed("browser_register", registerCurrentBrowserDevice);
    } catch (error) {
      setSessionsStatus(error instanceof Error ? error.message : tx("errors.deviceSetupFailed"));
    }
    void timed("browser_announce", announceCurrentBrowserDevice).catch(() => undefined);

    const authenticatedUser = session.user;
    const browserDeviceID = loadBrowserDeviceState()?.deviceId;
    const [deviceResult, hostResult, sessionResult] = await Promise.allSettled([
      timed("devices", listDevices),
      timed("hosts", () => listOnlineHosts(browserDeviceID)),
      timed("sessions", () => refreshSessionCatalog(authenticatedUser.email)),
    ]);
    for (const result of [deviceResult, hostResult, sessionResult]) {
      if (result.status === "rejected" && result.reason instanceof AuthExpiredError) {
        reportBootstrap("error", "auth_expired");
        handleWorkspaceAuthExpired(result.reason);
        return;
      }
    }

    workspaceMetadataGenerationRef.current += 1;

    let listedDevices: Device[] = devices;
    if (deviceResult.status === "fulfilled") {
      listedDevices = deviceResult.value.devices ?? [];
      setDevices(listedDevices);
    } else {
      setSessionsStatus(deviceResult.reason instanceof Error ? deviceResult.reason.message : tx("errors.failedLoadDevices"));
    }

    let connectableHosts: HostSummary[] = [];
    let listedHosts: HostSummary[] = hosts;
    if (hostResult.status === "fulfilled") {
      listedHosts = hostResult.value.hosts ?? [];
      updateHosts(listedHosts);
      connectableHosts = listedHosts.filter((host) =>
        !host.connected &&
        host.remote_access_enabled &&
        host.status === "active" &&
        (host.presence_status ? host.presence_status === "online" : true)
      );
    } else {
      console.debug("[pockly:hosts] list hosts failed", hostResult.reason);
    }

    let listedSessions: SessionListItem[] = sessions;
    if (sessionResult.status === "fulfilled") {
      listedSessions = sessionResult.value.sessions ?? [];
      if (targetRoute.view === "workspaceSession" && !hasSession(listedSessions, { sessionId: targetRoute.sessionId, deviceId: targetRoute.deviceId })) {
        const selectedItem = await loadSessionCatalogItem(session.user.email, { sessionId: targetRoute.sessionId, deviceId: targetRoute.deviceId });
        listedSessions = mergeHostPresenceIntoSessions([...listedSessions, selectedItem], hostsRef.current);
      }
      applyListedSessions(listedSessions);
      reportBootstrap("ok", "complete");
    } else {
      setSessions([]);
      const message = sessionResult.reason instanceof Error ? sessionResult.reason.message : tx("errors.pairBeforeReading");
      setSessionsStatus(message);
      clearReaderState(targetRoute.view === "workspaceSession" ? message : "");
      reportBootstrap("error", "sessions");
      return;
    }
    if (connectableHosts.length > 0) {
      void autoConnectWorkspaceHosts(connectableHosts, autoConnectGenerationRef.current, workspaceMetadataGenerationRef.current);
    }

    const selectedIsDraft =
      draftConversation &&
      selected?.sessionId === draftConversation.session_id &&
      selected.deviceId === draftConversation.device_id;
    if (selected && !selectedIsDraft && !hasSession(listedSessions, selected)) {
      clearReaderState(tx("errors.sessionNoLongerAvailable"));
    }

    if (!isReaderRoute(targetRoute)) {
      clearReaderState();
      return;
    }

    if (targetRoute.view !== "workspaceSession") {
      const preservedSelection = preserveCurrentSelection ? selected : selected && (selectedIsDraft || hasSession(listedSessions, selected)) ? selected : null;
      const nextSelection = pickSelection(listedSessions, targetRoute, preservedSelection, listedDevices, listedHosts);
      if (!nextSelection) {
        clearReaderState();
        return;
      }
      await openSession(
        nextSelection,
        false,
        listedSessions.find((item) => item.session_id === nextSelection.sessionId && item.device_id === nextSelection.deviceId) ?? null,
      );
      return;
    }

    const nextSelection = pickSelection(listedSessions, targetRoute, preserveCurrentSelection ? selected : null, listedDevices, listedHosts);
    if (!nextSelection) {
      clearReaderState(targetRoute.view === "workspaceSession" ? tx("errors.sessionNotFound") : "");
      return;
    }
    if (
      targetRoute.view === "workspaceSession" &&
      (nextSelection.sessionId !== targetRoute.sessionId || nextSelection.deviceId !== targetRoute.deviceId)
    ) {
      replaceRoute({ view: "workspaceSession", sessionId: nextSelection.sessionId, deviceId: nextSelection.deviceId });
    }
    await openSession(
      nextSelection,
      false,
      listedSessions.find((item) => item.session_id === nextSelection.sessionId && item.device_id === nextSelection.deviceId) ?? null,
    );
  }

  function pushRoute(next: Route) {
    setRoute(next);
    window.history.pushState({}, "", routeToPath(next));
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }

  async function navigate(next: Route) {
    pushRoute(next);
    await refreshApp(next);
  }

  function replaceRoute(next: Route) {
    setRoute(next);
    window.history.replaceState({}, "", routeToPath(next));
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }

  async function openSession(next: ReaderSelection, push = true, sessionHint: SessionListItem | null = null) {
    const requestID = ++loadRequestRef.current;
    syncAbortRef.current?.abort();
    syncAbortRef.current = null;
    setSelected(next);
    setSyncProgress(null);
    setSyncingEarlier(false);
    setTurnsHydrationState(null);
    if (draftConversation && next.sessionId === draftConversation.session_id && next.deviceId === draftConversation.device_id) {
      if (push) {
        pushRoute({ view: "workspaceSessions" });
      }
      setTurnsStatus("");
      setTurnsHydrationState({ session_id: draftConversation.session_id, turns: [], synced_turn_count: 0, total_turn_count: 0, has_older_turns: false });
      return;
    }
    if (push) {
      pushRoute({ view: "workspaceSession", sessionId: next.sessionId, deviceId: next.deviceId });
    }
    const initialSession = sessionHint ?? sessions.find((item) => item.session_id === next.sessionId && item.device_id === next.deviceId);
    markSessionOpened({
      sessionId: next.sessionId,
      deviceId: next.deviceId,
      openedAt: new Date().toISOString(),
      realtime: shouldUseBrowserRealtimeControl(runtimeCapabilities) ? subscriptionRef.current : null,
    })
      .catch(() => {
        // This hint only helps the daemon prioritize future lazy windows.
      });
    const cached = auth.status === "authenticated"
      ? await loadSessionTurnsCache(auth.email, next.deviceId, next.sessionId).catch(() => null)
      : null;
    if (requestID !== loadRequestRef.current) return;
    if (cached?.turns.length) {
      replaceSessionTurns(next, cached.turns, cached.hydration);
      setTurnsStatus("");
    } else {
      replaceSessionTurns(next, [], null);
    }
    try {
      if (!cached?.turns.length) setTurnsStatus("loading");
      const session = initialSession ?? sessions.find((item) => item.session_id === next.sessionId && item.device_id === next.deviceId);
      const cachedTurns = cached?.turns ?? [];
      const hasCachedTurns = cachedTurns.length > 0;
      const cachedMaxSeq = lastConfirmedSeq(cachedTurns);
      let data = await getSessionTurns(next.sessionId, next.deviceId, hasCachedTurns
        ? sessionTurnsFetchOptionsForCachedOpen(cachedTurns)
        : { limit: SESSION_TURNS_WINDOW_LIMIT });
      if (requestID !== loadRequestRef.current) return;
      let hydrated = data.turns.map((turn) => ({ ...turn, device_id: next.deviceId }));
      let nextTurns = hasCachedTurns ? reconcileHydratedTurns(cachedTurns, hydrated, false) : hydrated;
      let nextHydration = hasCachedTurns && cached
        ? incrementalTurnsHydration(cached.hydration, data, nextTurns)
        : data;
      if (hasCachedTurns && shouldFetchHotTailAfterIncremental({
        cachedMaxSeq,
        response: data,
        session,
        limit: SESSION_TURNS_WINDOW_LIMIT,
      })) {
        data = await getSessionTurns(next.sessionId, next.deviceId, {
          limit: SESSION_TURNS_WINDOW_LIMIT,
        });
        if (requestID !== loadRequestRef.current) return;
        hydrated = data.turns.map((turn) => ({ ...turn, device_id: next.deviceId }));
        nextTurns = reconcileHydratedTurns(nextTurns, hydrated, false);
        nextHydration = incrementalTurnsHydration(nextHydration, data, nextTurns);
      }
      replaceSessionTurns(next, nextTurns, nextHydration);
      logSessionHydration("openSession loaded turns", {
        sessionId: next.sessionId,
        deviceId: next.deviceId,
        hydratedTurns: nextTurns.length,
        expectedTurns: session?.turn_count || session?.last_seq || 0,
        lastSeq: session?.last_seq ?? null,
        syncState: session ? sessionSyncState(session) : "unknown",
      });
      if (nextTurns.length > 0) {
        setTurnsStatus("");
        return;
      }
      if (!session || shouldSyncSessionOnOpen(session, nextTurns)) {
        logSessionHydration("openSession requesting sync", {
          sessionId: next.sessionId,
          deviceId: next.deviceId,
          reason: session ? "empty_window" : "missing_session_hint",
          hydratedTurns: nextTurns.length,
          expectedTurns: session?.turn_count || session?.last_seq || 0,
        });
        await syncSelectedSession(next, requestID, 0);
        return;
      }
      if (isLargeSessionForAutomaticBackfill(session)) {
        setTurnsStatus("");
        return;
      }
      setTurnsStatus("empty");
    } catch (error) {
      if (requestID !== loadRequestRef.current) return;
      // Fresh sessions (catalog says last_seq==0, turn_count==0)
      // legitimately 404 here — the SDK driver hasn't written
      // anything to jsonl yet. Don't trigger a sync round-trip that
      // will fail with the same "session not found" and surface it
      // as a footer error; render the empty "waiting" state and let
      // SSE deliver the first turn when it lands.
      const errMessage = error instanceof Error ? error.message : "";
      const sessionMeta = sessionHint ?? sessions.find(
        (item) => item.session_id === next.sessionId && item.device_id === next.deviceId,
      );
      if (isLargeSessionForAutomaticBackfill(sessionMeta)) {
        setTurnsStatus("");
        setTurnsHydrationState({
          session_id: next.sessionId,
          turns: [],
          synced_turn_count: sessionMeta?.synced_turn_count ?? 0,
          total_turn_count: sessionMeta?.turn_count ?? sessionMeta?.last_seq ?? 0,
          has_older_turns: Boolean(sessionMeta?.has_older_turns || (sessionMeta?.turn_count ?? sessionMeta?.last_seq ?? 0) > (sessionMeta?.synced_turn_count ?? 0)),
        });
        return;
      }
      const isFreshSession = !!sessionMeta
        && (sessionMeta.last_seq ?? 0) === 0
        && (sessionMeta.turn_count ?? 0) === 0;
      if (isFreshSession && isSessionNotFoundMessage(errMessage)) {
        setTurnsStatus("");
        setTurnsHydrationState({
          session_id: next.sessionId,
          turns: [],
          synced_turn_count: 0,
          total_turn_count: 0,
          has_older_turns: false,
        });
        return;
      }
      console.warn("[pockly:session-hydration] openSession failed; requesting sync", {
        sessionId: next.sessionId,
        deviceId: next.deviceId,
        error,
      });
      await syncSelectedSession(next, requestID, 0);
      return;
    }
  }

  function scheduleInjectRefresh(
    selection: ReaderSelection,
    baselineSeq: number,
    attempts = 6,
    intervalMs = 2000,
    onSettled?: () => void,
    onExhausted?: () => void,
  ) {
    if (injectRefreshRef.current != null) {
      window.clearInterval(injectRefreshRef.current);
      injectRefreshRef.current = null;
    }
    let remaining = attempts;
    let running = false;
    let settled = false;
    const stop = () => {
      if (injectRefreshRef.current != null) {
        window.clearInterval(injectRefreshRef.current);
        injectRefreshRef.current = null;
      }
    };
    const tick = async () => {
      // running/settled guard: the immediate call and the interval must not
      // overlap or double-spend an attempt.
      if (running || settled) return;
      running = true;
      try {
        remaining -= 1;
        try {
          const refreshed = await getSessionTurns(selection.sessionId, selection.deviceId, {
            limit: SESSION_TURNS_WINDOW_LIMIT,
            afterSeq: lastConfirmedSeq(turnsRef.current),
          });
          const hydrated = refreshed.turns.map((turn) => ({ ...turn, device_id: selection.deviceId }));
          const hydratedLastSeq = hydrated.at(-1)?.seq ?? 0;
          const hasAgentResponse = hydrated.some((turn) => isAgentResponseTurnAfter(turn, baselineSeq));
          if (hydratedLastSeq > baselineSeq) {
            mergeSessionTurnsIntoState(selection, hydrated, refreshed, isCompleteTurnsResponse(refreshed));
          }
          if (hasAgentResponse) {
            settled = true;
            stop();
            setInjectStatus("Background run finished. Synced latest session updates.");
            void refreshSessionsList();
            onSettled?.();
            return;
          }
        } catch {
          // Keep current rendering stable and retry while attempts remain.
        }
        if (remaining <= 0) {
          settled = true;
          stop();
          if (onExhausted) {
            onExhausted();
            return;
          }
          setInjectStatus(tx("errors.backgroundFinished"));
          void refreshSessionsList();
          onSettled?.();
        }
      } finally {
        running = false;
      }
    };
    // Run the first poll immediately. The reply has already streamed, so the
    // persisted copy is usually a beat away — re-enable the composer as soon
    // as it's confirmed rather than idling a full intervalMs first. Retries
    // then fall back to the interval cadence.
    void tick();
    injectRefreshRef.current = window.setInterval(() => void tick(), intervalMs);
  }

  function finishLiveAgentRun(message: string) {
    setActiveInjectID("");
    setInjectStatus(message);
  }

  // After an inject completes the daemon syncs the durable turns to the server
  // within a few seconds. The live event stream can DROP events on a flaky link
  // (a proxy killing the control WS), and codex emits SEVERAL messages per turn
  // (commentary → tool → final answer) — so a dropped final reply otherwise
  // stays invisible until a manual page reload. Re-hydrate the authoritative
  // server copy a few times to backfill whatever the live stream missed.
  // reconcileHydratedTurns(authoritative) folds the durable copies in and drops
  // stale live ghosts; it's idempotent, so redundant passes are harmless.
  async function backfillTurnsAfterInject(selection: ReaderSelection) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
      const sel = selectedRef.current;
      if (!sel || sel.sessionId !== selection.sessionId || sel.deviceId !== selection.deviceId) return;
      try {
        const refreshed = await getSessionTurns(selection.sessionId, selection.deviceId, {
          limit: SESSION_TURNS_WINDOW_LIMIT,
          afterSeq: lastConfirmedSeq(turnsRef.current),
        });
        const stillOn = selectedRef.current;
        if (!stillOn || stillOn.sessionId !== selection.sessionId || stillOn.deviceId !== selection.deviceId) return;
        const hydrated = refreshed.turns.map((turn) => ({ ...turn, device_id: selection.deviceId }));
        mergeSessionTurnsIntoState(selection, hydrated, refreshed, isCompleteTurnsResponse(refreshed));
      } catch {
        // Transient (sync still catching up / link blip) — keep retrying.
      }
    }
  }

  // discardDraft removes a placeholder draft conversation that never advanced
  // to a real daemon session — e.g. user cancelled before the agent started,
  // or the agent failed before publishing its session id. Safe to call even
  // when the draft has already been cleared.
  function discardDraft(draft: DraftConversation | null) {
    if (injectRefreshRef.current != null) {
      window.clearInterval(injectRefreshRef.current);
      injectRefreshRef.current = null;
    }
    pendingDraftRef.current = null;
    setDraftConversation(null);
    if (!draft) return;
    if (selected?.sessionId === draft.session_id && selected.deviceId === draft.device_id) {
      replaceRoute({ view: "workspaceSessions" });
    }
    setSelected((selection) => {
      if (selection?.sessionId === draft.session_id && selection.deviceId === draft.device_id) {
        setTurns([]);
        setTurnsHydrationState(null);
        setTurnsStatus("");
        return null;
      }
      return selection;
    });
  }

  function discardFailedPromotedSession(selection: ReaderSelection) {
    if (injectRefreshRef.current != null) {
      window.clearInterval(injectRefreshRef.current);
      injectRefreshRef.current = null;
    }
    pendingDraftRef.current = null;
    setDraftConversation(null);
    setSelected((current) => {
      if (current?.sessionId === selection.sessionId && current.deviceId === selection.deviceId) {
        setTurns([]);
        setTurnsHydrationState(null);
        setTurnsStatus("");
        replaceRoute({ view: "workspaceSessions" });
        return null;
      }
      return current;
    });
  }

  function promoteDraftConversation(draft: DraftConversation, match: SessionListItem) {
    setDraftConversation(null);
    pendingDraftRef.current = null;
    setSelected((selection) => selection?.sessionId === draft.session_id && selection.deviceId === draft.device_id
      ? { sessionId: match.session_id, deviceId: match.device_id }
      : selection);
    replaceRoute({ view: "workspaceSession", sessionId: match.session_id, deviceId: match.device_id });
    setTurnsHydrationState((hydration) => hydration ? { ...hydration, session_id: match.session_id } : hydration);
    setTurns((existing) => existing.map((turn) => turn.session_id === draft.session_id ? { ...turn, session_id: match.session_id } : turn));
  }

  function scheduleDraftResolution(draft: DraftConversation, attempts = 12, intervalMs = 2500) {
    if (injectRefreshRef.current != null) window.clearInterval(injectRefreshRef.current);
    let remaining = attempts;
    injectRefreshRef.current = window.setInterval(async () => {
      remaining -= 1;
      const listedSessions = await refreshSessionsList();
      const match = findCreatedSessionForDraft(listedSessions, draft);
      if (match) {
        if (injectRefreshRef.current != null) {
          window.clearInterval(injectRefreshRef.current);
          injectRefreshRef.current = null;
        }
        promoteDraftConversation(draft, match);
        setInjectStatus(tx("errors.newTaskStarted"));
        return;
      }
      if (remaining <= 0 && injectRefreshRef.current != null) {
        window.clearInterval(injectRefreshRef.current);
        injectRefreshRef.current = null;
      }
    }, intervalMs);
  }

  async function refreshSessionTurnsWithBackoff(next: ReaderSelection, requestID: number, sessionHint?: SessionListItem | null, mergeWithCurrent = false) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refreshed = await getSessionTurns(next.sessionId, next.deviceId, {
        limit: SESSION_TURNS_WINDOW_LIMIT,
        ...(mergeWithCurrent ? { beforeSeq: nextLazyBackfillBeforeSeq(turnsHydration, turns, sessionHint ?? sessions.find((item) => item.session_id === next.sessionId && item.device_id === next.deviceId) ?? null) } : {}),
      });
      if (requestID !== loadRequestRef.current) return true;
      const hydrated = refreshed.turns.map((turn) => ({ ...turn, device_id: next.deviceId }));
      const session = sessionHint ?? sessions.find((item) => item.session_id === next.sessionId && item.device_id === next.deviceId);
      if (hydrated.length > 0 || session?.turn_count === 0 || attempt === 2) {
        if (mergeWithCurrent) {
          mergeSessionTurnsIntoState(next, hydrated, refreshed, isCompleteTurnsResponse(refreshed));
        } else {
          replaceSessionTurns(next, hydrated, refreshed);
        }
        setTurnsStatus(hydrated.length === 0 ? "empty" : "");
        setSyncProgress(null);
        void refreshSessionsList();
        return true;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    return true;
  }

  async function syncSelectedSession(next: ReaderSelection, requestID: number, beforeSeq: number) {
    let failed = "";
    let receivedTransientTurns = false;
    const controller = new AbortController();
    syncAbortRef.current = controller;
    try {
      logSessionHydration("syncSelectedSession start", {
        sessionId: next.sessionId,
        deviceId: next.deviceId,
        requestID,
        beforeSeq,
      });
      const loadingEarlier = beforeSeq > 0;
      if (loadingEarlier) {
        setSyncingEarlier(true);
      } else {
        setTurnsStatus("syncing");
        setTurns([]);
      }
      setSyncProgress(null);
      await streamSessionSync({
        sessionId: next.sessionId,
        deviceId: next.deviceId,
        ...(beforeSeq > 0 ? { limit: MANUAL_LAZY_BACKFILL_TURN_LIMIT } : {}),
        beforeSeq,
        signal: controller.signal,
        realtime: shouldUseBrowserRealtimeControl(runtimeCapabilities) ? subscriptionRef.current : null,
        onEvent: (event) => {
          if (requestID !== loadRequestRef.current) return;
          if (Array.isArray(event.turns) && event.turns.length > 0) {
            const hydrated = event.turns.map((turn) => ({ ...turn, device_id: next.deviceId }));
            receivedTransientTurns = true;
            const hydration = mergeTurnHydration(turnsHydration, transientTurnsHydration(next.sessionId, hydrated, event));
            mergeSessionTurnsIntoState(next, hydrated, hydration, false);
          }
          logSessionHydration("syncSelectedSession event", {
            sessionId: next.sessionId,
            deviceId: next.deviceId,
            stage: event.stage,
            status: event.status,
            message: event.message,
            error: event.error,
          });
          setSyncProgress(event);
          if (event.stage === "failed" || event.status === "failed") {
            failed = syncErrorMessage(event.error || tx("errors.sessionSyncFailed"));
            if (loadingEarlier) {
              setInjectStatus(failed);
            } else {
              setTurnsStatus(failed);
            }
          }
        },
      });
      if (requestID !== loadRequestRef.current) return;
      if (failed) {
        void refreshSessionsList();
        return;
      }
      if (!shouldRefreshPersistentTurnsAfterSync(receivedTransientTurns)) {
        void refreshSessionsList();
        setSyncProgress(null);
        if (!loadingEarlier) {
          setTurnsStatus("");
        }
        return;
      }
      const listedSessions = await refreshSessionsList();
      await refreshSessionTurnsWithBackoff(
        next,
        requestID,
        listedSessions.find((item) => item.session_id === next.sessionId && item.device_id === next.deviceId) ?? null,
        loadingEarlier,
      );
      logSessionHydration("syncSelectedSession finished", {
        sessionId: next.sessionId,
        deviceId: next.deviceId,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (requestID !== loadRequestRef.current) return;
      console.warn("[pockly:session-hydration] syncSelectedSession failed", {
        sessionId: next.sessionId,
        deviceId: next.deviceId,
        error,
      });
      setSyncProgress(null);
      // Same fresh-session short-circuit as openSession (in case
      // someone reaches sync via the reload path without a hint).
      const rawErrMessage = error instanceof Error ? error.message : "";
      const freshMeta = sessions.find(
        (item) => item.session_id === next.sessionId && item.device_id === next.deviceId,
      );
      const isFreshSession = !!freshMeta
        && (freshMeta.last_seq ?? 0) === 0
        && (freshMeta.turn_count ?? 0) === 0;
      if (beforeSeq === 0 && isFreshSession && isSessionNotFoundMessage(rawErrMessage)) {
        setTurnsStatus("");
        void refreshSessionsList();
        return;
      }
      const message = error instanceof Error ? syncErrorMessage(error.message) : tx("errors.sessionSyncFailed");
      if (beforeSeq > 0) {
        setInjectStatus(message);
      } else {
        setTurnsStatus(message);
      }
      void refreshSessionsList();
    } finally {
      if (beforeSeq > 0) {
        setSyncingEarlier(false);
      }
      if (syncAbortRef.current === controller) {
        syncAbortRef.current = null;
      }
    }
  }

  async function loadEarlierTurns() {
    if (!selected || !selectedSession || loadingEarlierRef.current) return;
    if (!hasEarlierTurns(turnsHydration, turns, selectedSession)) return;
    const beforeSeq = nextLazyBackfillBeforeSeq(turnsHydration, turns, selectedSession);
    if (beforeSeq === 1) return;
    loadingEarlierRef.current = true;
    const requestID = loadRequestRef.current;
    try {
      if (turnsHydration?.next_loaded_before_seq && turnsHydration.next_loaded_before_seq > 1) {
        setSyncingEarlier(true);
        const earlier = await getSessionTurns(selected.sessionId, selected.deviceId, {
          limit: MANUAL_LAZY_BACKFILL_TURN_LIMIT,
          beforeSeq: turnsHydration.next_loaded_before_seq,
        });
        if (requestID !== loadRequestRef.current) return;
        const hydrated = earlier.turns.map((turn) => ({ ...turn, device_id: selected.deviceId }));
        mergeSessionTurnsIntoState(selected, hydrated, mergeTurnHydration(turnsHydration, earlier), isCompleteTurnsResponse(earlier));
        return;
      }
      await syncSelectedSession(selected, requestID, beforeSeq);
    } finally {
      setSyncingEarlier(false);
      loadingEarlierRef.current = false;
    }
  }

  async function refreshSessionsList() {
    try {
      const listedSessions = auth.status === "authenticated"
        ? (await refreshSessionCatalog(auth.email)).sessions ?? []
        : sessions;
      applyListedSessions(listedSessions);
      const draft = pendingDraftRef.current ?? draftConversation;
      if (draft) {
        if (hasSession(listedSessions, { sessionId: draft.session_id, deviceId: draft.device_id })) {
          setDraftConversation(null);
        } else {
          const match = findCreatedSessionForDraft(listedSessions, draft);
          if (match) promoteDraftConversation(draft, match);
        }
      }
      setSessionsStatus("");
      return listedSessions;
    } catch {
      // Keep the rendered session stable; the next explicit refresh will surface the error.
      return sessions;
    }
  }

  async function finishAuthenticatedFlow(target: Route = { view: "workspaceSessions" }) {
    const returnPath = sessionStorage.getItem("pockly.return_after_login");
    if (returnPath) {
      sessionStorage.removeItem("pockly.return_after_login");
      window.history.replaceState({}, "", returnPath);
      const next = parseRoute();
      setRoute(next);
      await refreshApp(next);
      return;
    }
    await refreshApp(target);
  }

  async function onPasswordLogin() {
    setSessionsStatus("");
    try {
      await loginWithPassword(email, password);
      if (route.view === "localSetup") {
        // Binding this computer requires a fresh password even if a session
        // already existed. Mark the re-auth and refresh in place — staying on
        // /local-setup so the claim effect fires, rather than redirecting to
        // the workspace the way a normal login does.
        setSetupReauthed(true);
        setPassword("");
        await refreshApp(route);
        return;
      }
      await finishAuthenticatedFlow();
    } catch (error) {
      setSessionsStatus(authErrorMessage(error));
    }
  }

  async function onRegister() {
    setSessionsStatus("");
    if (password !== confirmPassword) {
      setSessionsStatus(tx("auth.passwordsDoNotMatch"));
      return;
    }
    try {
      const result = await registerAccount({ email, name, password });
      if (result.status === "active") {
        await finishAuthenticatedFlow();
        return;
      }
      setVerificationEmail(result.email);
      setResendAfterSeconds(result.resend_after_seconds);
      setAuthMode("verify");
    } catch (error) {
      setSessionsStatus(authErrorMessage(error));
    }
  }

  async function onVerifyRegistration() {
    setSessionsStatus("");
    try {
      await verifyRegistration(verificationEmail || email, verificationCode);
      await finishAuthenticatedFlow();
    } catch (error) {
      setSessionsStatus(authErrorMessage(error));
    }
  }

  async function onResendVerificationCode() {
    setSessionsStatus("");
    try {
      const result = await resendRegistrationCode(verificationEmail || email);
      setResendAfterSeconds(result.resend_after_seconds);
      setSessionsStatus(tx("auth.verificationCodeSent"));
    } catch (error) {
      setSessionsStatus(authErrorMessage(error));
    }
  }

  async function onLogout() {
    // Snapshot the signed-out email before state flips so we can purge
    // their session-title cache from localStorage — leaving prompt-
    // derived labels behind after signout would be a privacy leak.
    const previousEmail = auth.status === "authenticated" ? auth.email : "";
    try {
      await logout();
    } catch {
      // Older local Nexus builds may not expose logout yet; still clear local UI state.
    }
    subscriptionRef.current?.close();
    subscriptionRef.current = null;
    injectAbortRef.current?.abort();
    syncAbortRef.current?.abort();
    liveSessionBridgesRef.current.forEach((bridge) => bridge.abort.abort());
    liveSessionBridgesRef.current.clear();
    cleanupVoiceRecorder();
    setAuth({ status: "anonymous" });
    setDevices([]);
    clearHosts();
    setSessions([]);
    setInjectStatus("");
    setPairStatus("");
    setSessionTitles({});
    if (previousEmail) {
      clearSessionTitlesInStorage(previousEmail);
      sessionCatalogSnapshotRef.current = null;
      sessionCatalogCacheLoadedForRef.current = "";
      void clearSessionCatalogCache(previousEmail);
      void clearSessionTurnsCache(previousEmail);
    }
    clearReaderState();
    replaceRoute({ view: "login" });
  }

  async function onClaimDaemonSetupGrant(grantID: string) {
    if (!grantID || claimedSetupGrant === grantID) return;
    setClaimedSetupGrant(grantID);
    setPairStatus(tx("connect.setupDetected"));
    try {
      const browserState = await ensureBrowserDeviceState();
      const claimed = await claimDaemonSetupGrant(grantID, {
        ...(browserState.deviceId ? { browser_device_id: browserState.deviceId } : {}),
        browser_device_pubkey: browserState.devicePublicKey,
        device_name: browserDeviceName(),
        user_agent: navigator.userAgent,
      });
      persistBrowserTokens({ browserDeviceId: claimed.browser_device_id });
      setPairStatus(tx("cli.connectedNotice"));
      pushRoute({ view: "workspaceSessions" });
      await refreshApp({ view: "workspaceSessions" });
    } catch (error) {
      setClaimedSetupGrant("");
      setPairStatus(error instanceof Error ? error.message : tx("errors.failedConnectComputer"));
    }
  }

  // runLocalSetup completes a daemon-initiated local install:
  //   1. Mint device tokens via /api/daemon/local-claim (Nexus binds daemon
  //      to this user and returns access + refresh tokens).
  //   2. POST { nonce, claim } to the daemon's loopback callback so the
  //      daemon process can save the tokens and start serving.
  //   3. Show the user a success state and offer a button into the workspace.
  //
  // We intentionally do NOT navigate the user away on success — the daemon
  // is now running locally and the user may want to confirm the install
  // worked before moving on.
  async function runLocalSetup(grant: string, nonce: string, cb: string) {
    setLocalSetupState({ phase: "claiming", message: tx("localSetup.claiming") });
    // Validate cb before consuming the Nexus setup grant. If the fragment was
    // tampered with, claiming first would bind the daemon in Nexus but leave
    // the local process without tokens.
    let cbURL: URL;
    try {
      cbURL = new URL(cb);
    } catch {
      setLocalSetupState({ phase: "error", message: tx("localSetup.badCallback"), retryable: false });
      return;
    }
    if (cbURL.protocol !== "http:" || cbURL.hostname !== "127.0.0.1" || cbURL.pathname !== "/callback" || !cbURL.port) {
      setLocalSetupState({ phase: "error", message: tx("localSetup.badCallback"), retryable: false });
      return;
	    }
	    let claimed: Awaited<ReturnType<typeof claimDaemonLocal>>;
	    try {
	      const claimWithBrowserState = async () => {
	        const browserState = await ensureBrowserDeviceState();
	        const response = await claimDaemonLocal({
	          daemon_setup: grant,
		          browser_nonce: nonce,
		          ...(browserState.deviceId ? { browser_device_id: browserState.deviceId } : {}),
		          browser_device_pubkey: browserState.devicePublicKey,
		          device_name: browserDeviceName(),
	          user_agent: navigator.userAgent,
	        });
	        return { browserState, response };
	      };
	      let result: Awaited<ReturnType<typeof claimWithBrowserState>>;
	      try {
	        result = await claimWithBrowserState();
	      } catch (error) {
	        if (!isStaleBrowserDeviceError(error)) throw error;
	        await clearBrowserDeviceState();
	        result = await claimWithBrowserState();
	      }
	      claimed = result.response;
	      persistBrowserTokens({ browserDeviceId: claimed.browser_device_id });
	    } catch (error) {
      setLocalSetupState({
        phase: "error",
        message: error instanceof Error ? error.message : tx("localSetup.claimError"),
        retryable: true,
      });
      return;
    }

    setLocalSetupState({ phase: "claiming", message: tx("localSetup.handingOff") });
    try {
      const resp = await fetch(cb, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nonce: claimed.browser_nonce || nonce,
          claim: {
            daemon_device_id: claimed.daemon_device_id,
            user_email: claimed.user.email,
            user_id: claimed.user.user_id,
            device_access_token: claimed.device_access_token,
            device_refresh_token: claimed.device_refresh_token,
            remote_access_enabled: claimed.remote_access_enabled,
            browser_device_id: claimed.browser_device_id,
            browser_device_name: browserDeviceName(),
          },
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`${resp.status}: ${body || resp.statusText}`);
      }
    } catch (error) {
      // The daemon binding still succeeded on the Nexus side — surface that
      // so the user knows what to do next.
      setLocalSetupState({
        phase: "error",
        message: error instanceof Error ? error.message : tx("localSetup.callbackError"),
        retryable: false,
      });
      return;
    }

    setLocalSetupState({
      phase: "done",
      daemonDeviceID: claimed.daemon_device_id,
      userEmail: claimed.user.email,
    });
  }

	  async function runMobileJoin(grant: string) {
	    setMobileJoinState({ phase: "claiming", message: tx("mobileJoin.joining") });
	    try {
	      const claimWithBrowserState = async () => {
	        const browserState = await ensureBrowserDeviceState();
	        const response = await claimMobileJoinQRGrant({
		          grant_token: grant,
		          ...(browserState.deviceId ? { browser_device_id: browserState.deviceId } : {}),
		          browser_device_pubkey: browserState.devicePublicKey,
		          device_name: browserDeviceName(),
	          user_agent: navigator.userAgent,
	        });
	        return { browserState, response };
	      };
	      let result: Awaited<ReturnType<typeof claimWithBrowserState>>;
	      try {
	        result = await claimWithBrowserState();
	      } catch (error) {
	        if (!isStaleBrowserDeviceError(error)) throw error;
	        await clearBrowserDeviceState();
	        result = await claimWithBrowserState();
	      }
	      const claimed = result.response;
	      persistBrowserTokens({
	        browserDeviceId: claimed.browser_device_id,
	        accessToken: claimed.device_access_token,
	      });
	      setAuth({ status: "authenticated", email: claimed.user.email, name: claimed.user.name });
      setMobileJoinState({ phase: "done", email: claimed.user.email, daemonsNotified: claimed.daemons_notified });
      setTimeout(() => {
        void navigate({ view: "workspaceSessions" });
      }, 900);
    } catch (error) {
      setMobileJoinState({
        phase: "error",
        message: error instanceof Error ? error.message : tx("mobileJoin.errorBody"),
      });
    }
  }

  async function onConnectHost(hostDeviceId: string) {
    setPairStatus(tx("workspace.connectComputer"));
    const browserState = await ensureBrowserDeviceState();
    const connected = await connectHost(hostDeviceId, {
	      ...(browserState.deviceId ? { browser_device_id: browserState.deviceId } : {}),
	      browser_device_pubkey: browserState.devicePublicKey,
	      device_name: browserDeviceName(),
      user_agent: navigator.userAgent,
    });
    persistBrowserTokens({
      browserDeviceId: connected.browser_device_id,
    });
setPairStatus(`${tx("common.connected")} ${connected.daemon_device_id}.`);
    pushRoute({ view: "workspaceSessions" });
    await refreshApp({ view: "workspaceSessions" });
  }

  async function loadCLIAuth(deviceCode: string) {
    setCliStatus("loading");
    try {
      const authRequest = await getDaemonDeviceAuthorization(deviceCode);
      setCliAuthorization(authRequest);
      setCliStatus(authRequest.status);
    } catch (error) {
      setCliAuthorization(null);
      setCliStatus(error instanceof Error ? error.message : tx("errors.authorizationNotFound"));
    }
  }

  async function onAuthorizeCLI() {
    if (!cliAuthorization) return;
    setCliStatus("authorizing");
    trackEvent("cli_authorize_started");
    try {
      const browserState = await ensureBrowserDeviceState();
      await authorizeDaemonDevice(cliAuthorization.device_code, {
	        ...(browserState.deviceId ? { browser_device_id: browserState.deviceId } : {}),
	        browser_device_pubkey: browserState.devicePublicKey,
	        device_name: browserDeviceName(),
        user_agent: navigator.userAgent,
      });
      // Nexus now holds the claim in awaiting_daemon_confirm until the
      // daemon process on the user's computer prompts and accepts. Poll for
      // the final state and surface clear feedback.
      setCliStatus("awaiting_daemon_confirm");
      trackEvent("cli_awaiting_daemon_confirm");
      const final = await pollDaemonAuthClaimStatus(cliAuthorization.device_code);
      if (final.status === "authorized" || final.status === "consumed") {
        const browserDeviceId = final.browser_device_id || browserState.deviceId;
        if (browserDeviceId) {
          persistBrowserTokens({ browserDeviceId });
        }
        setCliStatus("authorized");
        trackEvent("cli_authorize_completed");
      } else if (final.status === "denied_by_daemon") {
        setCliStatus(tx("errors.cliDeniedByDaemon") || "Pair denied on the desktop. The mobile claim was voided.");
        trackEvent("cli_authorize_denied_by_daemon");
      } else if (final.status === "expired") {
        setCliStatus(tx("errors.cliExpired") || "Pair request expired before the desktop confirmed.");
        trackEvent("cli_authorize_expired");
      } else {
        setCliStatus(final.status);
      }
      await loadCLIAuth(cliAuthorization.device_code);
    } catch (error) {
      const message = error instanceof Error ? error.message : tx("errors.authorizationFailed");
      trackEvent("cli_authorize_failed", { error: normalizeTelemetryError(message) });
      setCliStatus(message);
    }
  }

  // pollDaemonAuthClaimStatus waits up to ~5 minutes for the daemon-side
  // decision after mobile approves. Polls every 2 seconds.
  async function pollDaemonAuthClaimStatus(deviceCode: string) {
    const deadline = Date.now() + 5 * 60 * 1000;
    for (;;) {
      const claim = await getDaemonAuthClaimStatus(deviceCode);
      if (
        claim.status === "authorized" ||
        claim.status === "denied" ||
        claim.status === "denied_by_daemon" ||
        claim.status === "expired" ||
        claim.status === "consumed"
      ) {
        return claim;
      }
      if (Date.now() > deadline) {
        return { ...claim, status: "expired" as const };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  async function onDenyCLI() {
    if (!cliAuthorization) return;
    setCliStatus("denying");
    try {
      await denyDaemonDevice(cliAuthorization.device_code);
      setCliStatus("denied");
      await loadCLIAuth(cliAuthorization.device_code);
    } catch (error) {
      setCliStatus(error instanceof Error ? error.message : tx("errors.denyFailed"));
    }
  }

  async function onRenameDevice(deviceId: string, deviceName: string) {
    const result = await renameDevice(deviceId, deviceName);
    let listedDevices: Device[] = [];
    try {
      listedDevices = (await listDevices()).devices ?? [];
    } catch {
      listedDevices = [];
    }
    setDevices(listedDevices.length > 0 ? listedDevices : (current) => current.map((device) => device.device_id === deviceId ? result.device : device));
    try {
      const browserDeviceID = loadBrowserDeviceState()?.deviceId;
      updateHosts((await listOnlineHosts(browserDeviceID)).hosts ?? []);
    } catch {
      clearHosts();
    }
  }

  async function onRevoke(deviceId: string) {
    const removedDevice = devices.find((device) => device.device_id === deviceId);
    const currentBrowserID = loadBrowserDeviceState()?.deviceId ?? "";
    await revokeDevice(deviceId);

    if (deviceId === currentBrowserID) {
      const previousEmail = auth.status === "authenticated" ? auth.email : "";
      await clearBrowserDeviceState();
      if (previousEmail) {
        sessionCatalogSnapshotRef.current = null;
        sessionCatalogCacheLoadedForRef.current = "";
        void clearSessionCatalogCache(previousEmail);
        void clearSessionTurnsCache(previousEmail);
      }
      let listedDevices: Device[] = [];
      try {
        listedDevices = (await listDevices()).devices ?? [];
        setDevices(listedDevices);
      } catch {
        setDevices([]);
      }
      try {
        updateHosts((await listOnlineHosts()).hosts ?? []);
      } catch {
        clearHosts();
      }
      const nextDaemonID = preferredDaemonDeviceID(listedDevices, deviceId);
      setExplicitDeviceFilter("");
      setNewConversationDaemon(nextDaemonID);
      setDraftConversation(null);
      pendingDraftRef.current = null;
      setSessions([]);
      setSessionsStatus(tx("errors.deviceSetupFailed"));
      setPushStatus("not_enabled");
      setPushDetail("");
      clearReaderState(tx("errors.deviceSetupFailed"));
      pushRoute({ view: "workspaceSessions" });
      return;
    }

    let listedDevices: Device[] = [];
    try {
      listedDevices = (await listDevices()).devices ?? [];
      setDevices(listedDevices);
    } catch {
      setDevices([]);
    }
    try {
      const browserDeviceID = loadBrowserDeviceState()?.deviceId;
      updateHosts((await listOnlineHosts(browserDeviceID)).hosts ?? []);
    } catch {
      clearHosts();
    }
    try {
      const listedSessions = await refreshSessionsList();
      applyListedSessions(listedSessions);
    } catch (error) {
      setSessions([]);
      setSessionsStatus(error instanceof Error ? error.message : tx("errors.deviceSetupFailed"));
    }

    const nextDaemonID = preferredDaemonDeviceID(listedDevices, deviceId);
    if (removedDevice?.device_type === "daemon") {
      if (deviceFilter === deviceId || selected?.deviceId === deviceId || newConversationDaemon === deviceId) {
        setExplicitDeviceFilter("");
        setNewConversationDaemon(nextDaemonID);
        if (draftConversation?.device_id === deviceId) {
          setDraftConversation(null);
          pendingDraftRef.current = null;
        }
        clearReaderState(nextDaemonID ? "Device removed. Select a session to continue." : "");
        if (!nextDaemonID || route.view === "workspaceSession") {
          pushRoute({ view: "workspaceSessions" });
        }
      }
    }

  }

  async function onResetCurrentBrowserAccess() {
    const currentBrowserID = loadBrowserDeviceState()?.deviceId ?? "";
    if (currentBrowserID) {
      await revokeDevice(currentBrowserID).catch(() => undefined);
    }
    await clearBrowserDeviceState();
    if (auth.status === "authenticated") {
      sessionCatalogSnapshotRef.current = null;
      sessionCatalogCacheLoadedForRef.current = "";
      void clearSessionCatalogCache(auth.email);
      void clearSessionTurnsCache(auth.email);
    }
    setPushStatus("not_enabled");
    setPushDetail("");
    await refreshApp(route, true);
  }

  async function refreshPushStatus() {
    try {
      if (auth.status !== "authenticated") {
        setPushStatus("checking");
        return;
      }
      if (!supportsPush()) {
        setPushStatus("unsupported");
        setPushDetail("");
        return;
      }
      if (Notification.permission === "denied") {
        setPushStatus("blocked");
        setPushDetail(tx("errors.notificationBlockedDetail"));
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration("/sw.js");
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription) {
        setPushStatus("not_enabled");
        setPushDetail("");
        return;
      }
      if (!loadBrowserDeviceState()?.deviceId) {
        setPushStatus("not_enabled");
        setPushDetail("");
        return;
      }
      await registerRemotePushSubscription(subscription);
      setPushStatus("enabled");
      setPushDetail("");
    } catch (error) {
      void error;
      setPushStatus("not_enabled");
    }
  }

  async function onEnablePush() {
    setPushDetail("");
    if (!supportsPush()) {
      setPushStatus("unsupported");
      setPushDetail(tx("errors.notificationPwaRequired"));
      return;
    }
    if (!loadBrowserDeviceState()?.deviceId) {
      setPushStatus("not_enabled");
      setPushDetail(tx("errors.notificationConnectFirst"));
      return;
    }
    if (Notification.permission === "denied") {
      setPushStatus("blocked");
      setPushDetail(tx("errors.notificationPermissionBlocked"));
      return;
    }
    setPushStatus("checking");
    setPushDetail(tx("errors.notificationRegistering"));
    try {
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") {
        setPushStatus(permission === "denied" ? "blocked" : "not_enabled");
        setPushDetail(permission === "denied" ? tx("errors.notificationBlockedDetail") : tx("errors.notificationPermissionNotGranted"));
        return;
      }
      const subscription = await registerLocalPushSubscription();
      await registerRemotePushSubscription(subscription);
      setPushStatus("enabled");
      setPushDetail(tx("errors.notificationEnabledBrowser"));
    } catch (error) {
      setPushStatus("not_enabled");
      setPushDetail(error instanceof Error ? error.message : tx("errors.notificationEnableFailed"));
    }
  }

  async function registerLocalPushSubscription() {
    const registration = await navigator.serviceWorker.register("/sw.js");
    const existing = await registration.pushManager.getSubscription();
    if (existing) return existing;
    const { public_key: publicKey } = await getVAPIDPublicKey();
    return registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64URLToUint8Array(publicKey),
    });
  }

  async function registerRemotePushSubscription(subscription: PushSubscription) {
    const data = subscription.toJSON();
    if (!data.endpoint || !data.keys?.p256dh || !data.keys?.auth) {
      throw new Error(tx("errors.incompletePushSubscription"));
    }
    await registerPushSubscription({
      endpoint: data.endpoint,
      keys: {
        p256dh: data.keys.p256dh,
        auth: data.keys.auth,
      },
      user_agent: navigator.userAgent,
    });
  }

  function liveSessionBridgeKey(session: SessionListItem) {
    return `${session.device_id}::${session.session_id}`;
  }

  // Tear down a session's live bridge: kill any sleeping reconnect timer,
  // abort the in-flight SSE fetch, and drop the map entry. Used on
  // navigate-away / unmount so we don't leak one live stream + auto-reconnect
  // loop per visited session (an unbounded bridge map + a visibility-resume
  // reconnect storm proportional to sessions visited).
  function detachLiveSessionBridge(key: string) {
    const bridge = liveSessionBridgesRef.current.get(key);
    if (!bridge) return;
    if (bridge.reconnectTimer != null) window.clearTimeout(bridge.reconnectTimer);
    bridge.abort.abort();
    liveSessionBridgesRef.current.delete(key);
  }

  function attachLiveSessionBridge(session: SessionListItem, terminalSession: TerminalSession, options: { ignoreHistory?: boolean } = {}) {
    const key = liveSessionBridgeKey(session);
    // Cancel any pending reconnect timer from a previous instance — the
    // caller wants a fresh attach, so any sleeping retry from an older
    // disconnect is now obsolete.
    const prev = liveSessionBridgesRef.current.get(key);
    if (prev?.reconnectTimer != null) window.clearTimeout(prev.reconnectTimer);
    prev?.abort.abort();
    connectStream(session, terminalSession, options, 0);
  }

  // connectStream is the inner SSE attach loop used by both initial
  // attach and the auto-reconnect path. attempt counts the current
  // retry (0 = first attempt). On non-aborted failure we schedule a
  // re-attempt with exponential backoff (1s, 2s, 4s, ..., capped at
  // 30s) indefinitely — Nexus buffers history so even multi-minute
  // gaps recover without user action.
  //
  // Why explicit retry vs EventSource's built-in: we use fetch + ReadableStream
  // for the SSE consumer (see streamTerminalSession) so EventSource's
  // auto-reconnect isn't available. Plus we want to instrument each
  // failure with telemetry — EventSource just silently retries.
  function connectStream(
    session: SessionListItem,
    terminalSession: TerminalSession,
    options: { ignoreHistory?: boolean; preserveIgnoreHistoryCutoff?: boolean },
    attempt: number,
  ) {
    const key = liveSessionBridgeKey(session);
    const abort = new AbortController();
    const attemptToken = Date.now() + Math.random();
    const previousBridge = liveSessionBridgesRef.current.get(key);
    const ignoreEventsBefore = options.ignoreHistory
      ? (options.preserveIgnoreHistoryCutoff || attempt > 0
          ? previousBridge?.ignoreEventsBefore ?? Date.now()
          : Date.now())
      : undefined;
    const bridge: LiveSessionBridge = {
      terminalSession,
      abort,
      attempt,
      attemptToken,
      ...(ignoreEventsBefore ? { ignoreEventsBefore } : {}),
      forceReconnect: () => {
        const current = liveSessionBridgesRef.current.get(key);
        if (current?.attemptToken !== attemptToken) return;
        if (current.reconnectTimer != null) window.clearTimeout(current.reconnectTimer);
        abort.abort();
        // #33: re-resolve the live terminal_id rather than reusing the pinned one
        // (the daemon may have re-announced under a new id while we were away).
        void reconnectLiveBridge(session, { ...options, preserveIgnoreHistoryCutoff: true }, 0, attemptToken);
      },
    };
    // Preserve pendingPrompt across reconnects (was set by the inject
    // path and used for echo dedup) — losing it would cause the just-
    // injected text to appear twice once SSE catches up.
    if (attempt > 0) {
      const carry = previousBridge?.pendingPrompt;
      if (carry) bridge.pendingPrompt = carry;
    }
    liveSessionBridgesRef.current.set(key, bridge);

    if (attempt > 0) {
      setInjectStatus(`Reconnecting live stream (attempt ${attempt})…`);
    }

    void streamTerminalSession({
      terminalSessionId: terminalSession.terminal_session_id,
      daemonDeviceId: terminalSession.daemon_device_id || session.device_id,
      realtime: shouldUseBrowserRealtimeControl(runtimeCapabilities) ? subscriptionRef.current : null,
      signal: abort.signal,
      onEvent: (event) => handleLiveSessionEvent(session, event),
    }).then(() => {
      // Stream ended cleanly (server closed). Don't auto-retry —
      // session_exited and similar terminal states arrive as events.
      const current = liveSessionBridgesRef.current.get(key);
      if (current?.attemptToken === attemptToken) {
        liveSessionBridgesRef.current.delete(key);
      }
    }).catch((error) => {
      if (abort.signal.aborted) return; // intentional cancel
      // Telemetry once per disconnect — captures network errors,
      // mobile backgrounding, Nexus WS hiccups. Sampled by the
      // browser access token so we can correlate per-user.
      reportWebTelemetry({
        name: "web_sse_disconnected",
        sessionId: session.session_id,
        errorCode: error instanceof Error ? error.message.slice(0, 80) : "stream_failed",
      });
      const nextAttempt = attempt + 1;
      const delayMs = Math.min(1000 * Math.pow(2, attempt), SSE_RECONNECT_MAX_BACKOFF_MS);
      const persistent = nextAttempt > SSE_RECONNECT_PERSISTENT_AFTER;
      const secs = Math.round(delayMs / 1000);
      if (persistent) {
        setInjectStatus(`Still reconnecting live stream… (next try in ${secs}s)`);
      } else {
        setInjectStatus(error instanceof Error
          ? `Live stream interrupted (${error.message.slice(0, 40)}); retrying in ${secs}s…`
          : `Live stream interrupted; retrying in ${secs}s…`);
      }
      const timer = window.setTimeout(() => {
        // Race guard: only fire if THIS attempt's token still owns
        // the bridge slot (a fresh attachLiveSessionBridge would have
        // bumped attemptToken; ditto a user-driven detach).
        const current = liveSessionBridgesRef.current.get(key);
        if (current?.attemptToken !== attemptToken) {
          // The retry was abandoned (bridge cleaned up by session_exited,
          // replaced by a fresh attach, or evicted by page nav). Clear the
          // earlier "retrying in Xs…" status so the user does not see a
          // forever-stuck state.
          setInjectStatus("");
          return;
        }
        // #33: re-resolve the current live terminal_id before retrying so a
        // restarted daemon's new terminal_session_id is picked up instead of
        // hammering the dead pinned one.
        void reconnectLiveBridge(session, options, nextAttempt, attemptToken);
      }, delayMs);
      bridge.reconnectTimer = timer;
    });
  }

  // reconnectLiveBridge re-resolves the session's CURRENT live terminal_session
  // before re-streaming, instead of reusing the terminal_session_id pinned in the
  // bridge. The daemon can re-announce a session under a NEW terminal_session_id
  // (e.g. after a restart), and the auto-reconnect / forceReconnect paths used to
  // retry the dead pinned id forever — recovering only ~45s later once Nexus
  // emitted session_disconnected and the recovery effect re-attached (#33). `expect`
  // is the attemptToken of the bridge that scheduled this reconnect; if it no
  // longer owns the slot (a fresh attach or a detach happened), bail.
  async function reconnectLiveBridge(
    session: SessionListItem,
    options: { ignoreHistory?: boolean; preserveIgnoreHistoryCutoff?: boolean },
    attempt: number,
    expect: number,
  ) {
    const key = liveSessionBridgeKey(session);
    const owner = liveSessionBridgesRef.current.get(key);
    if (owner?.attemptToken !== expect) return;
    const pinned = owner.terminalSession;
    let fresh: TerminalSession | undefined;
    let resolved = false;
    try {
      const listed = await listTerminalSessions();
      resolved = true;
      fresh = (listed.terminal_sessions ?? [])
        .filter((c) =>
          c.session_id === session.session_id &&
          c.daemon_device_id === session.device_id &&
          (c.session_status === "live" || c.session_status === "starting"))
        .sort((a, b) => Date.parse(b.updated_at || b.created_at || "") - Date.parse(a.updated_at || a.created_at || ""))[0];
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        setAuth({ status: "anonymous" });
        setInjectStatus("");
        liveSessionBridgesRef.current.delete(key);
        return;
      }
      // Transient resolve failure — fall back to retrying the pinned terminal.
    }
    // Re-check ownership after the await (a switch/detach may have intervened).
    if (liveSessionBridgesRef.current.get(key)?.attemptToken !== expect) return;
    if (resolved && !fresh) {
      // The daemon reports NO live terminal for this session — the wrapper is
      // gone. Stop retrying the (now dead) pinned terminal_id; drop the bridge
      // and surface the dead hint. The disconnect-recovery / attach effect
      // re-attaches if the session comes back live.
      liveSessionBridgesRef.current.delete(key);
      setSessionLivenessHint("dead");
      setInjectStatus("");
      return;
    }
    connectStream(session, fresh ?? pinned, options, attempt);
  }

  async function attachExistingLiveSessionBridge(session: SessionListItem) {
    const key = liveSessionBridgeKey(session);
    const existing = liveSessionBridgesRef.current.get(key);
    if (existing && (existing.terminalSession.session_status === "live" || existing.terminalSession.session_status === "starting")) return;
    // Dedupe concurrent attaches for the same key: the switch attach effect and
    // the disconnect-recovery effect can both fire for the same session inside
    // the listTerminalSessions() await window, and each would build a bridge.
    if (attachInFlightRef.current.has(key)) return;
    attachInFlightRef.current.add(key);
    try {
      const listed = await listTerminalSessions();
      // We just awaited. If the user navigated away in the meantime, the
      // attach effect's cleanup has already detached this key — re-attaching
      // now would resurrect a bridge for a no-longer-displayed session with
      // nothing left to tear it down (the leak this fix exists to prevent).
      if (selectedRef.current?.sessionId !== session.session_id || selectedRef.current?.deviceId !== session.device_id) {
        return;
      }
      const reusable = (listed.terminal_sessions ?? [])
        .filter((candidate) =>
          candidate.session_id === session.session_id &&
          candidate.daemon_device_id === session.device_id &&
          (candidate.session_status === "live" || candidate.session_status === "starting"))
        .sort((a, b) => Date.parse(b.updated_at || b.created_at || "") - Date.parse(a.updated_at || a.created_at || ""))[0];
      if (reusable) {
        // Found a live wrapper for this session_id — attach.
        attachLiveSessionBridge(session, reusable, { ignoreHistory: true });
        setSessionLivenessHint("active");
      } else {
        // No matching live terminal_session for the session_id we're viewing.
        // The chat history loads from catalog sync, but the user cannot send
        // new prompts because the wrapper is gone (Claude exited, or daemon
        // has not been online recently). Surface a banner instead of leaving
        // a working-looking UI that silently cannot reply.
        setSessionLivenessHint("dead");
      }
    } catch (err) {
      // Bubble auth failures to top-level state instead of silently
      // degrading. A 401 here means there will be no SSE attach and no
      // useful UI hint unless auth state is reset.
      if (err instanceof AuthExpiredError) {
        setAuth({ status: "anonymous" });
        setInjectStatus("");
        return;
      }
      // Non-auth network errors stay opportunistic — normal session
      // reading still works without live attach.
      setSessionLivenessHint("unknown");
    } finally {
      attachInFlightRef.current.delete(key);
    }
  }

  function handleLiveSessionEvent(session: SessionListItem, event: TerminalEvent) {
    const key = liveSessionBridgeKey(session);
    const bridge = liveSessionBridgesRef.current.get(key);
    // Is this event's session the one currently on screen? Read live via
    // selectedRef (this handler outlives any single selection). Bridge
    // bookkeeping + teardown below run regardless; only RENDERING (turn
    // appends, run-complete footer) is gated so a background session can't
    // leak its stream into the displayed conversation.
    const isDisplayedSession =
      !!selectedRef.current &&
      selectedRef.current.sessionId === session.session_id &&
      selectedRef.current.deviceId === session.device_id;
    if (event.kind === "terminal_session") {
      liveSessionBridgesRef.current.set(key, {
        ...(bridge ?? {}),
        terminalSession: {
          terminal_session_id: event.terminal_session_id,
          daemon_device_id: session.device_id,
          session_id: session.session_id,
          agent: "claude-code",
          cwd: session.cwd,
          session_status: event.session_status ?? "live",
          turn_status: event.turn_status ?? "idle",
          ...(event.error ? { error: event.error } : {}),
          created_at: event.timestamp ?? new Date().toISOString(),
          updated_at: event.timestamp ?? new Date().toISOString(),
        },
        abort: bridge?.abort ?? new AbortController(),
      });
    }
    if (isIgnoredTerminalHistoryEvent(bridge, event)) return;
    if (event.kind === "user_input" && event.payload) {
      const text = event.payload.trim();
      const pendingPrompt = liveSessionBridgesRef.current.get(key)?.pendingPrompt?.trim();
      if (isDisplayedSession && text && text !== pendingPrompt) {
        setTurns((current) => appendStreamingTurn(current, {
          device_id: session.device_id,
          session_id: session.session_id,
          seq: nextOptimisticSeq(optimisticSeqRef),
          agent: session.agent,
          kind: "user_message",
          timestamp: event.timestamp ?? new Date().toISOString(),
          payload: { text },
        }));
      }
    }
    // Raw PTY bytes are a terminal render stream, not chat content.
    // Keep them out of the conversation and let message_added JSONL
    // events below provide the clean assistant turns.
    if (event.kind === "message_added" && event.payload) {
      // The wrapper jsonl watcher sends one structured record per Claude
      // turn (role + clean text + uuid) instead of raw PTY bytes. We only
      // render role="assistant" here because:
      //   - role="user" local-typing is already covered by the
      //     user_input handler above (char-by-char stdin capture from
      //     the wrapper, no ANSI noise).
      //   - role="user" web-inject is already covered by the
      //     optimisticTurn() bubble created in sendPromptForSession.
      //   - role="attachment" (tool_result, listings) renders via a
      //     separate catalog turn-sync path.
      // Adding role=user here would double-bubble for BOTH paths.
      //
      // Two payload shapes share this event.kind:
      //   1. Wrapper jsonl-watch — flat `{role, text, uuid, timestamp}`.
      //   2. SDK driver — raw stream-json record from
      //      `claude --print --output-format=stream-json`, shape
      //      `{type:"assistant", message:{role, content:[{type,text}]},
      //      uuid, session_id}`. The daemon pipes claude's stdout
      //      verbatim — no flattening — to keep Nexus
      //      bridgeSDKTerminalEventToTurn able to attribute the same
      //      bytes to session_turns without re-encoding.
      // Normalize both into the legacy flat shape so the existing
      // mergeTurns / setInjectStatus path stays untouched.
      let payload: {
        role?: string;
        text?: string;
        uuid?: string;
        segment?: number;
        timestamp?: string;
        tool?: string;
        id?: string;
        input?: unknown;
        result?: string;
        is_error?: boolean;
        has_result?: boolean;
      } = {};
      try {
        const raw = JSON.parse(event.payload) as Record<string, unknown>;
        if (typeof raw.role === "string") {
          // Wrapper shape — already flat.
          payload = raw as typeof payload;
        } else if (raw.type === "result") {
          // finishLiveAgentRun mutates GLOBAL inject state (activeInjectID +
          // injectStatus), so gate it on isDisplayedSession exactly like the
          // turn appends below — a background bridge's result marker must not
          // clear the on-screen session's in-flight inject footer.
          if (isDisplayedSession) finishLiveAgentRun("Live reply ready.");
          return;
        } else if (raw.type === "assistant" && typeof raw.message === "object" && raw.message !== null) {
          // SDK stream-json: extract role + concatenated text deltas
          // from message.content[]. uuid is at the top level (claude
          // stamps it on each record) so we can dedupe across retries.
          const msg = raw.message as { role?: string; content?: unknown };
          const role = typeof msg.role === "string" ? msg.role : undefined;
          const text = Array.isArray(msg.content)
            ? msg.content
                .map((part) => (typeof part === "object" && part !== null && (part as { type?: string }).type === "text"
                  ? ((part as { text?: string }).text ?? "")
                  : ""))
                .join("")
            : "";
          payload = {
            ...(role ? { role } : {}),
            ...(text ? { text } : {}),
            ...(typeof raw.uuid === "string" ? { uuid: raw.uuid } : {}),
          };
        }
      } catch {
        return;
      }
      if (payload.role === "tool_call" || payload.role === "tool_result") {
        const role = payload.role;
        const stableID = liveMessageStableSeqKey(payload, event.timestamp);
        let seq = messageUUIDSeqRef.current.get(stableID);
        if (seq === undefined) {
          seq = nextOptimisticSeq(optimisticSeqRef);
          messageUUIDSeqRef.current.set(stableID, seq);
        }
        if (isDisplayedSession) setTurns((current) => mergeTurns(current, [{
          device_id: session.device_id,
          session_id: session.session_id,
          seq,
          agent: session.agent,
          kind: role,
          timestamp: payload.timestamp ?? event.timestamp ?? new Date().toISOString(),
          payload: role === "tool_call"
            ? {
                tool: payload.tool || "Unknown",
                id: payload.id ?? "",
                input: payload.input,
              }
            : {
                id: payload.id ?? "",
                result: payload.result ?? payload.text ?? "",
                is_error: Boolean(payload.is_error),
                has_result: payload.has_result ?? true,
              },
        }]));
        return;
      }
      if (payload.role !== "assistant") return;
      const text = payload.text ?? "";
      const uuid = payload.uuid ?? "";
      if (!text.trim() || !uuid) return;
      // Stable per-UUID seq inside the optimistic range. mergeTurns
      // keys on (device, session, seq) — same UUID → same seq → replaces
      // the prior bubble; new UUID → fresh seq → new bubble. This
      // avoids the appendStreamingTurn assistant_text filter that would
      // clobber earlier assistant bubbles when multiple message_added
      // events land between catalog syncs.
      const stableID = liveMessageStableSeqKey(payload, event.timestamp);
      let seq = messageUUIDSeqRef.current.get(stableID);
      if (seq === undefined) {
        seq = nextOptimisticSeq(optimisticSeqRef);
        messageUUIDSeqRef.current.set(stableID, seq);
      }
      if (isDisplayedSession) setTurns((current) => mergeTurns(current, [{
        device_id: session.device_id,
        session_id: session.session_id,
        seq,
        agent: session.agent,
        kind: "assistant_text",
        timestamp: payload.timestamp ?? event.timestamp ?? new Date().toISOString(),
        payload: { text },
      }]));
      // The wrapper JSONL watcher emits message_added only after a full
      // assistant turn has been written. Once that bubble is visible,
      // the user-facing run is complete even if the PTY prompt_ready /
      // SDK result marker arrives a few seconds later.
      // Gated like the setTurns append above: only the on-screen session's
      // completion may clear the global inject footer.
      if (isDisplayedSession) finishLiveAgentRun("Live reply ready.");
    }
    if (event.kind === "permission_request" && event.payload) {
      // Claude is about to invoke a tool and the permission bridge routed
      // the native "may I?" question through Pockly so the ask is visible
      // and actionable on web.
      //
      // Flow:
      //   - decision === "pending" renders Approve/Deny buttons and stashes
      //     request_id + daemon_device_id for the decide API.
      //   - decision === "allow"/"deny" updates the existing request state.
      //
      // Use the same seqKey across pending → resolved so mergeTurns replaces
      // the in-place card instead of stacking two cards for one decision.
      let payload: {
        tool_name?: string;
        input?: unknown;
        decision?: string;
        reason?: string;
        ts?: string;
        request_id?: string;
      } = {};
      try { payload = JSON.parse(event.payload) as typeof payload; } catch { return; }
      const toolName = payload.tool_name || "?";
      const inputPreview = (() => {
        try {
          const s = JSON.stringify(payload.input);
          return s.length > 200 ? s.slice(0, 200) + "…" : s;
        } catch { return ""; }
      })();
      const decisionStr = payload.decision ?? "pending";
      // Stable seq per request_id or per stable local-confirmation signature.
      // Legacy resolved events without request_id keep the timestamp key so
      // unrelated old wrappers don't overwrite each other.
      const seqKey = payload.request_id
        ? `perm:req:${payload.request_id}`
        : decisionStr === "local_confirmation"
        ? `perm:local:${toolName}:${inputPreview}`
        : `perm:${toolName}:${payload.ts || ""}`;
      let seq = messageUUIDSeqRef.current.get(seqKey);
      if (seq === undefined) {
        seq = nextOptimisticSeq(optimisticSeqRef);
        messageUUIDSeqRef.current.set(seqKey, seq);
      }
      // Carry the structured fields the card needs to render
      // Approve/Deny + post the decision. Daemon device_id comes
      // from the bridge's session context (= the daemon hosting the
      // claude process that asked).
      // text_preview kept for backwards compat (getTurns + the
      // legacy AttachmentCard rendering path) — actual card uses the
      // structured fields below.
      const stateLabel = decisionStr === "pending"
        ? "⏳ awaiting decision"
        : decisionStr === "local_confirmation"
        ? "⏳ waiting on computer"
        : decisionStr === "deny"
        ? "✗ denied"
        : "✓ approved";
      const text = `🛡️ **${toolName}** ${stateLabel}\n\`${inputPreview}\``;
      if (isDisplayedSession) setTurns((current) => mergeTurns(current, [{
        device_id: session.device_id,
        session_id: session.session_id,
        seq,
        agent: session.agent,
        kind: "attachment",
        timestamp: payload.ts ?? event.timestamp ?? new Date().toISOString(),
        payload: {
          text,
          attachment_type: "permission_request",
          // Structured fields used by the interactive permission card.
          // Older readers ignore unknown keys and fall back to text rendering.
          permission_request_id: payload.request_id ?? "",
          permission_tool_name: toolName,
          permission_input_preview: inputPreview,
          permission_decision: decisionStr,
          permission_reason: payload.reason ?? "",
          permission_daemon_device_id: session.device_id,
        },
      }]));
    }
    if (event.kind === "prompt_ready") {
      const bridge = liveSessionBridgesRef.current.get(key);
      if (bridge) {
        liveSessionBridgesRef.current.set(key, {
          ...bridge,
          terminalSession: {
            ...bridge.terminalSession,
            session_status: event.session_status ?? bridge.terminalSession.session_status,
            turn_status: event.turn_status ?? bridge.terminalSession.turn_status,
            updated_at: event.timestamp ?? new Date().toISOString(),
          },
        });
      }
      // Bridge bookkeeping above runs regardless (per-session, keyed by `key`);
      // the global inject footer below must only update for the on-screen
      // session so a background prompt_ready can't clear the displayed
      // session's in-flight inject indicator.
      if (isDisplayedSession) finishLiveAgentRun("Live reply ready.");
    }
    if (event.kind === "agent_error") {
      const message = event.error || event.payload || "Agent turn failed.";
      const stableID = `agent_error:${event.terminal_session_id}:${event.seq ?? event.timestamp ?? message}`;
      let seq = messageUUIDSeqRef.current.get(stableID);
      if (seq === undefined) {
        seq = nextOptimisticSeq(optimisticSeqRef);
        messageUUIDSeqRef.current.set(stableID, seq);
      }
      if (isDisplayedSession) {
        setTurns((current) => mergeTurns(current, [{
          device_id: session.device_id,
          session_id: session.session_id,
          seq,
          agent: session.agent,
          kind: "assistant_text",
          timestamp: event.timestamp ?? new Date().toISOString(),
          payload: { text: message, is_error: true },
        }]));
        finishLiveAgentRun(message);
      }
    }
    if (event.kind === "session_exited" || event.kind === "error" || event.kind === "session_disconnected") {
      // Cancel any pending SSE-reconnect retry: the wrapper is gone
      // (session_exited), unreachable (session_disconnected), or errored, so
      // retrying would just hammer Nexus. The abort tells any in-flight stream
      // to bail.
      //
      // session_disconnected specifically is Nexus's "stop reconnecting"
      // signal that replaced the old hard reconnect-attempt cap (see the
      // no-attempt-cap note on liveSessionBridgeKey). Until it was handled here
      // that stop signal was a no-op, so a bridge whose host went unreachable
      // reconnected forever against a dead session. When the daemon comes back
      // the catalog re-announces the session as live and
      // attachExistingLiveSessionBridge re-establishes the stream — so tearing
      // down here is safe even though a disconnect (unlike an exit) can recover.
      const bridge = liveSessionBridgesRef.current.get(key);
      if (bridge?.reconnectTimer != null) window.clearTimeout(bridge.reconnectTimer);
      bridge?.abort.abort();
      liveSessionBridgesRef.current.delete(key);
      setActiveInjectID("");
      setInjectStatus(
        event.kind === "session_disconnected"
          ? event.error || "Live terminal disconnected — host unreachable."
          : event.error || "Live terminal exited.",
      );
    }
  }

  function createDraftConversation(cwdOverride?: string, agentOverride?: AgentKind, deviceOverride?: string) {
    const cwd = (cwdOverride ?? "").trim();
    // deviceOverride lets a per-project "new session" start on that project's
    // own computer rather than the rail's currently-selected daemon.
    const device = (deviceOverride ?? newConversationDaemon).trim();
    if (!device) {
      setInjectStatus(tx("task.noDaemonBody"));
      return null;
    }
    const agent = agentOverride ?? newConversationAgent;
    const now = new Date().toISOString();
    const draft: DraftConversation = {
      isDraft: true,
      session_id: `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      device_id: device,
      agent,
      cwd,
      snippet: tx("task.draftSnippet"),
      last_seq: 0,
      last_timestamp: now,
      sync_state: "catalog_only",
      turn_count: 0,
      synced_turn_count: 0,
      has_older_turns: false,
    };
    setDraftConversation(draft);
    setSelected({ sessionId: draft.session_id, deviceId: draft.device_id });
    setTurns([]);
    setTurnsHydrationState({ session_id: draft.session_id, turns: [], synced_turn_count: 0, total_turn_count: 0, has_older_turns: false });
    setTurnsStatus("");
    setSyncProgress(null);
    setComposerModel("");
    setComposerPermissionMode("default");
    setComposerEffort("none");
    setNewConversationDrawerOpen(false);
    pushRoute({ view: "workspaceSessions" });
    return draft;
  }

  async function sendPromptForSession(
    session: SessionListItem,
    text: string,
    files: File[] = [],
    restoreFiles: File[] = files,
  ) {
    if ((!text.trim() && files.length === 0) || activeInjectID) return;
    // Effort (reasoning depth) is a real agent setting now — the composer
    // pill applies it via /api/sessions/<sid>/agent-settings (PTY → /effort,
    // SDK → --effort on next spawn), exactly like model/permission. So the
    // send path no longer prepends a "think"/"ultrathink" keyword to the
    // prompt (and no longer needs an applyEffort opt-out for canned replies
    // like AskUserQuestion answers); whatever effort the pill last applied
    // is already in effect.
    //
    // Drafts still carry their own model/permission pill state on the
    // DraftConversation (used by the start-task path below) — pull from
    // the draft, not the global composer, which may have been overwritten
    // while the user briefly looked at a historical session.
    const draftPillSettings = isDraftConversation(session) ? (session as DraftConversation) : null;
    const selection = { sessionId: session.session_id, deviceId: session.device_id };
    const baselineSeq = lastConfirmedSeq(turns);
    const originalText = text;
    const originalFiles = [...restoreFiles];
    reportWebTelemetry({
      name: "web_inject_attempt",
      status: "ok",
      sessionId: session.session_id,
      errorCode: isDraftConversation(session) ? "draft" : "session",
    });
    if (injectRefreshRef.current != null) {
      window.clearInterval(injectRefreshRef.current);
      injectRefreshRef.current = null;
    }
    injectPhaseRef.current = { requestId: "", phase: "idle" };
    setActiveInjectID("pending");
    setComposerText("");
    setComposerAttachments([]);
    const sendingDraft = isDraftConversation(session);
    setInjectStatus(sendingDraft ? tx("task.creatingFromFirstMessage") : tx("errors.startingRemoteTask"));
    const optimistic = optimisticTurn(session, text, "user_message", nextOptimisticSeq(optimisticSeqRef));
    setTurns((current) => [...current, optimistic]);
    const ctrl = new AbortController();
    injectAbortRef.current = ctrl;
    let reachedDurableAgentEvent = false;
    const restoreFailedSend = () => {
      setComposerText(originalText);
      setComposerAttachments(originalFiles);
      setTurns((current) => current.filter((turn) => !sameTurnIdentity(turn, optimistic)));
    };
    try {
      if (sendingDraft) {
        pendingDraftRef.current = session;
        let promotedInline = false;
        let promotedSessionId = "";
        const startTaskInput: Parameters<typeof streamNewTask>[0] = {
          daemonDeviceId: session.device_id,
          agent: session.agent,
          cwd: session.cwd,
          text,
          signal: ctrl.signal,
          realtime: shouldUseBrowserRealtimeControl(runtimeCapabilities) ? subscriptionRef.current : null,
		          onEvent: (event) => {
	            if (event.type === "session_created" && event.session_id) {
	              promotedInline = true;
	              promotedSessionId = event.session_id;
	              reachedDurableAgentEvent = true;
	            }
	            if (event.type === "stream_event" || event.type === "inject_completed") {
	              reachedDurableAgentEvent = true;
	            }
	            handleInjectEvent(event, "draft-session");
	          },
        };
        // Drafts carry their own pill state; pull from the draft, not
        // the global composer (which may have been overwritten while
        // the user briefly looked at a historical session).
        const draftModel = draftPillSettings?.draft_model ?? "";
        const draftPermission = draftPillSettings?.draft_permission_mode ?? "default";
        const draftEffort = draftPillSettings?.draft_effort ?? "none";
        if (draftModel) startTaskInput.model = draftModel;
        if (draftPermission && draftPermission !== "default") {
          startTaskInput.permissionMode = draftPermission;
        }
        if (draftEffort && draftEffort !== "none") {
          startTaskInput.effort = draftEffort;
        }
        await streamNewTask(startTaskInput);
        if (injectPhaseRef.current.phase === "failed" || injectPhaseRef.current.phase === "cancelled") {
          restoreFailedSend();
          setActiveInjectID("");
          return;
        }
        if (promotedInline) {
          // Inline promote already swapped selected/URL to the real session id.
          // Refresh the catalog, then poll the synced turns window for the
          // first assistant/tool output. `/api/tasks` only confirms that the
          // daemon accepted and launched the agent; it is not proof that the
          // first reply has synced.
          void refreshSessionsList();
          scheduleInjectRefresh(
            { sessionId: promotedSessionId, deviceId: session.device_id },
            0,
            8,
            2000,
            () => setActiveInjectID(""),
            () => {
              setActiveInjectID("");
              setInjectStatus(tx("errors.firstMessageNoResponse"));
              discardFailedPromotedSession({ sessionId: promotedSessionId, deviceId: session.device_id });
              restoreFailedSend();
            },
          );
        } else {
          // Daemon should emit inject_failed when no session id ever arrives,
          // but keep the polling as defence-in-depth for older daemons.
          scheduleDraftResolution(session);
        }
      } else {
        // Polling fallback delivers only turns newer than what the reader
        // already shows. Optimistic placeholders live at seq >= 1e9 and are
        // not durable rows, so they must not advance the cursor.
        const lastRealSeq = turns.reduce(
          (max, turn) => (turn.session_id === session.session_id && turn.seq < 1_000_000_000 && turn.seq > max ? turn.seq : max),
          0,
        );
        await streamSessionInject({
          sessionId: session.session_id,
          deviceId: session.device_id,
          text,
          ...(files.length > 0 ? { files } : {}),
          afterSeq: lastRealSeq,
          ...injectPollOptionsForSession(session, realtimeLiveRef.current),
          realtime: files.length === 0 && shouldUseBrowserRealtimeControl(runtimeCapabilities) ? subscriptionRef.current : null,
		          signal: ctrl.signal,
	          onEvent: (event) => {
	            if (event.type === "stream_event" || event.type === "inject_completed") {
	              reachedDurableAgentEvent = true;
	            }
	            handleInjectEvent(event, "session");
	          },
	        });
        // A daemon-side inject_failed / inject_cancelled arrives in-band via
        // handleInjectEvent, which already set phase + the "Send failed" /
        // "Cancelled" status. The stream then closes normally, so without this
        // guard the unconditional "syncing… → finished" status below would
        // clobber the error and falsely tell the user the message landed. On
        // failure/cancel: keep that status and just clear the in-flight
        // indicator (the composer must not stay stuck "sending"). Success path
        // still shows syncing + polls for the reply.
        if (injectPhaseRef.current.phase === "failed" || injectPhaseRef.current.phase === "cancelled") {
          restoreFailedSend();
          setActiveInjectID("");
        } else if (!shouldScheduleInjectRefreshAfterStream(injectPhaseRef.current.phase)) {
          // inject_completed already triggered the authoritative turn backfill.
          // Starting scheduleInjectRefresh here would double-poll the same
          // session for normal successful turns.
          setActiveInjectID("");
        } else {
          setInjectStatus(tx("errors.backgroundCompletedSyncing"));
          scheduleInjectRefresh(selection, baselineSeq, 6, 2000, () => setActiveInjectID(""));
        }
      }
    } catch (error) {
      if (!ctrl.signal.aborted) {
        // session_drifted = wrapper has rebound to a different sid since
        // the page loaded. Instead of silently retargeting (or relying
        // on window.confirm which is ugly AND racy — a previous bug
        // dropped the user's text when the async resend got cancelled
        // by the new session's hydration), capture the user's typed
        // text and show SessionDriftDialog. On confirm we navigate to
        // actualSid AND refill the composer; the user must press Send
        // once more to actually inject. The contract becomes simple:
        // your text is in the input box, so your text is safe.
        if (error instanceof InjectControlError && error.details?.error === "session_drifted") {
          const actualSid = String(error.details.actual_sid ?? "");
          if (actualSid) {
            setDriftPrompt({ savedText: text, actualSid, deviceId: session.device_id });
            setInjectStatus(""); // suppress the raw error toast — the modal owns the UX
            setActiveInjectID("");
            restoreFailedSend();
            return;
          }
        }
        setInjectStatus(error instanceof Error ? error.message : tx("errors.injectFailed"));
        // Capture browser-to-daemon send failures that would otherwise
        // be visible only client-side. session_drifted is intentionally
        // not reported here because it is a handled race: the modal owns
        // the UX and the user retries against the corrected session.
        reportWebTelemetry({
          name: "web_inject_error",
          sessionId: session.session_id,
          errorCode: injectTelemetryErrorCode(error instanceof InjectControlError && error.details?.error
            ? String(error.details.error)
            : (error instanceof Error ? error.message : "inject_failed")),
        });
        if (sendingDraft) {
          discardDraft(session as DraftConversation);
        }
	        if (shouldRestoreFailedSendOnControlError(injectPhaseRef.current.phase, reachedDurableAgentEvent)) {
	          restoreFailedSend();
	        }
      }
      setActiveInjectID("");
    } finally {
      injectAbortRef.current = null;
      pendingDraftRef.current = null;
    }
  }

  async function onSendPrompt() {
    const text = composerText.trim();
    const files = composerAttachments;
    if ((!text && files.length === 0) || activeInjectID) return;
    const target = selectedSession ?? createDraftConversation();
    if (!target) return;
    // Attachments ride the existing-session inject path only; a fresh draft
    // (brand-new conversation) sends text alone.
    await sendPromptForSession(target, text, isDraftConversation(target) ? [] : files, files);
  }

  function onCreateNewConversation(cwdOverride?: string, agentOverride?: AgentKind) {
    const draft = createDraftConversation(cwdOverride, agentOverride);
    if (draft) setInjectStatus(tx("task.draftReady"));
  }

  async function onCancelInject() {
    const requestID = activeInjectID;
    if (requestID.startsWith("live:")) {
      const terminalSessionID = requestID.slice("live:".length);
      try {
        await stopTerminalSession(terminalSessionID);
      } catch (error) {
        setInjectStatus(error instanceof Error ? error.message : tx("errors.cancelFailed"));
      }
      for (const [key, bridge] of liveSessionBridgesRef.current.entries()) {
        if (bridge.terminalSession.terminal_session_id === terminalSessionID) {
          bridge.abort.abort();
          liveSessionBridgesRef.current.delete(key);
        }
      }
      setActiveInjectID("");
      setInjectStatus("Live terminal stop requested.");
      return;
    }
    if (requestID) {
      try {
        await cancelInject(requestID);
      } catch (error) {
        setInjectStatus(error instanceof Error ? error.message : tx("errors.cancelFailed"));
      }
    }
    injectAbortRef.current?.abort();
    setActiveInjectID("");
    setInjectStatus(tx("errors.cancelRequested"));
    // If the cancelled inject was still in the placeholder-draft phase
    // (no session_created event yet), remove the floating draft so the user
    // isn't stuck with an undismissable entry in the sessions list.
    if (selectedSession && isDraftConversation(selectedSession) && selectedSession.session_id.startsWith("draft_")) {
      discardDraft(selectedSession);
    }
  }

  async function onToggleVoiceInput() {
    if (voiceStatus === "recording") {
      stopVoiceRecording();
      return;
    }
    if (activeInjectID || voiceStatus !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setVoiceError(tx("errors.voiceUnavailable"));
      return;
    }
    try {
      setVoiceError("");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceStreamRef.current = stream;
      voiceChunksRef.current = [];
      // Tap the stream for an audio-reactive recording waveform. Purely
      // decorative — wrapped so a Web Audio failure never blocks recording.
      try {
        const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtor) {
          const audioCtx = new AudioCtor();
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 64;
          analyser.smoothingTimeConstant = 0.7;
          source.connect(analyser);
          voiceAudioCtxRef.current = audioCtx;
          setVoiceAnalyser(analyser);
        }
      } catch {
        // No waveform reactivity; recording + the CSS-animated fallback still work.
      }
      const mimeType = supportedVoiceMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) voiceChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setVoiceError(tx("errors.transcriptionRecorder"));
        setVoiceStatus("idle");
        cleanupVoiceRecorder();
      };
      recorder.onstop = () => {
        const chunks = voiceChunksRef.current;
        const type = recorder.mimeType || mimeType || "audio/webm";
        const durationMs = voiceStartedAtRef.current > 0 ? Date.now() - voiceStartedAtRef.current : undefined;
        cleanupVoiceRecorder();
        if (chunks.length === 0) {
          setVoiceError(tx("errors.transcriptionEmpty"));
          setVoiceStatus("idle");
          return;
        }
        const audio = new Blob(chunks, { type });
        void transcribeRecordedVoice(audio, durationMs);
      };
      recorder.start();
      voiceStartedAtRef.current = Date.now();
      voiceTimeoutRef.current = window.setTimeout(() => stopVoiceRecording(), 60_000);
      setVoiceStatus("recording");
    } catch (error) {
      cleanupVoiceRecorder();
      setVoiceStatus("idle");
      const message = error instanceof Error ? error.message : tx("settings.permissionDenied");
      setVoiceError(tx("errors.permissionDeniedWithMessage", { message }));
    }
  }

  async function transcribeRecordedVoice(audio: Blob, durationMs?: number) {
    setVoiceStatus("transcribing");
    setVoiceError("");
    try {
      const optimized = await optimizeVoiceBlob(audio, durationMs);
      const result = await transcribeVoice({
        audio: optimized.audio,
        filename: optimized.filename,
        durationMs: optimized.optimizedDurationMs,
        originalDurationMs: optimized.originalDurationMs,
        optimizedDurationMs: optimized.optimizedDurationMs,
        language: "zh",
        prompt: "Pockly voice prompt for Claude Code. Preserve technical terms, code identifiers, paths, and mixed Chinese English wording.",
      });
      setComposerText((current) => current ? `${current}${current.endsWith("\n") ? "" : "\n"}${result.text}` : result.text);
      setInjectStatus("");
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : tx("errors.transcriptionFailed"));
    } finally {
      setVoiceStatus("idle");
    }
  }

  function cleanupVoiceRecorder() {
    if (voiceTimeoutRef.current != null) {
      window.clearTimeout(voiceTimeoutRef.current);
      voiceTimeoutRef.current = null;
    }
    recorderRef.current = null;
    voiceChunksRef.current = [];
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    voiceStreamRef.current = null;
    voiceStartedAtRef.current = 0;
    voiceAudioCtxRef.current?.close().catch(() => {});
    voiceAudioCtxRef.current = null;
    setVoiceAnalyser(null);
  }

  function stopVoiceRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
  }

  function handleInjectEvent(event: InjectEvent, target: "session" | "draft-session") {
    const terminalEvent = event.type === "inject_completed" || event.type === "inject_failed" || event.type === "inject_cancelled";
    if (event.request_id && !terminalEvent) {
      setActiveInjectID(event.request_id);
      if (injectPhaseRef.current.requestId !== event.request_id) {
        injectPhaseRef.current = { requestId: event.request_id, phase: "started" };
      }
    }
    switch (event.type) {
      case "inject_started":
        injectPhaseRef.current = { requestId: event.request_id, phase: "started" };
        setInjectStatus(tx("errors.acceptedByComputer"));
        break;
      case "session_created":
        if (target === "draft-session" && event.session_id) {
          const draft = pendingDraftRef.current;
          if (draft) {
            const created: DraftConversation = {
              ...draft,
              session_id: event.session_id,
              snippet: tx("task.createdSnippet"),
              sync_state: "syncing",
            };
            pendingDraftRef.current = created;
            setDraftConversation(created);
            setSelected({ sessionId: created.session_id, deviceId: created.device_id });
            replaceRoute({ view: "workspaceSession", sessionId: created.session_id, deviceId: created.device_id });
            setTurnsHydrationState((current) => current ? { ...current, session_id: created.session_id } : current);
            setTurns((current) => current.map((turn) => turn.session_id === draft.session_id ? { ...turn, session_id: created.session_id } : turn));
          }
        }
        setInjectStatus(event.message ?? tx("errors.newTaskStarted"));
        break;
      case "stream_event": {
        injectPhaseRef.current = { requestId: event.request_id, phase: "streaming" };
        let visibleAssistantReply = false;
        if (event.turn) {
          const turn = event.turn;
          let hydratedTurn: SessionTurn | null = null;
          if (target === "draft-session") {
            const activeDraft = pendingDraftRef.current;
            if (activeDraft && turn.session_id === activeDraft.session_id) {
              hydratedTurn = { ...turn, device_id: activeDraft.device_id };
            }
          } else if (
            // Read the LIVE selection, not the `selectedSession` captured when
            // this inject's onEvent closure was created — otherwise switching
            // away mid-stream leaks the original session's turns into whatever
            // conversation is now on screen.
            selectedRef.current &&
            turn.session_id === selectedRef.current.sessionId &&
            (turn.device_id ?? selectedRef.current.deviceId) === selectedRef.current.deviceId
          ) {
            hydratedTurn = { ...turn, device_id: selectedRef.current.deviceId };
          }
          if (hydratedTurn) {
            setTurns((current) => appendStreamingTurn(current, hydratedTurn));
            visibleAssistantReply = hydratedTurn.kind === "assistant_text" && Boolean(hydratedTurn.payload?.text?.trim());
          }
        }
        if (visibleAssistantReply) {
          finishLiveAgentRun("Live reply ready.");
          break;
        }
        setInjectStatus(tx("errors.backgroundReplying"));
        break;
      }
      case "approval_required":
        if (
          injectPhaseRef.current.requestId === event.request_id &&
          (injectPhaseRef.current.phase === "streaming" ||
            injectPhaseRef.current.phase === "completed" ||
            injectPhaseRef.current.phase === "failed" ||
            injectPhaseRef.current.phase === "cancelled")
        ) {
          break;
        }
        setInjectStatus(event.message ?? tx("errors.waitingLocalApproval"));
        break;
      case "inject_completed":
        injectPhaseRef.current = { requestId: event.request_id, phase: "completed" };
        if (target === "draft-session") {
          setInjectStatus(tx("errors.backgroundCompletedSyncing"));
          break;
        }
        finishLiveAgentRun("Live reply ready.");
        // Self-heal: pull the authoritative turns from the server so a reply
        // the live stream dropped (e.g. codex's final answer over a flaky link)
        // appears without a manual page reload.
        if (selectedRef.current) void backfillTurnsAfterInject(selectedRef.current);
        break;
      case "inject_cancelled":
        injectPhaseRef.current = { requestId: event.request_id, phase: "cancelled" };
        setInjectStatus(tx("errors.cancelled"));
        if (target === "draft-session") {
          const draft = pendingDraftRef.current;
          // Only discard when session_created never arrived; otherwise the
          // real session exists on the daemon and will surface in the next
          // sessions list refresh.
          if (draft && draft.session_id.startsWith("draft_")) {
            discardDraft(draft);
          }
        }
        break;
      case "inject_failed":
        injectPhaseRef.current = { requestId: event.request_id, phase: "failed" };
        reportWebTelemetry({
          name: "web_inject_error",
          sessionId: event.session_id || selectedRef.current?.sessionId || "",
          errorCode: injectTelemetryErrorCode(event.error || "inject_failed"),
        });
        setInjectStatus(tx("errors.sendFailed", { suffix: event.error ? `: ${injectControlErrorMessage(event.error)}` : "." }));
        if (target === "draft-session") {
          const draft = pendingDraftRef.current;
          if (draft && draft.session_id.startsWith("draft_")) {
            discardDraft(draft);
          }
        }
        break;
    }
  }

  if (route.view === "duplexTest") {
    return <DuplexTestPage />;
  }

  if (route.view === "mobileJoin") {
    return (
      <MobileJoinPage
        state={mobileJoinState}
        onRetry={() => {
          if (route.view !== "mobileJoin") return;
          void runMobileJoin(route.grant);
        }}
        onOpenWorkspace={() => void navigate({ view: "workspaceSessions" })}
      />
    );
  }

  // Don't flash the login page while the initial getSession() is in flight
  // for users who already have a valid cookie. Render a neutral splash for
  // the loading window; LoginPage only renders once we've confirmed there
  // is no session.
  //
  // workspaceBootstrapped is now flipped before metadata loads; this gate is
  // only a safety fallback for the narrow auth render gap before refreshApp
  // can set the loading workspace state.
  if (auth.status === "loading") {
    return <SplashScreen />;
  }
  if (
    auth.status === "authenticated"
    && !workspaceBootstrapped
    && shouldGateAuthenticatedWorkspaceSplash(route)
  ) {
    return <SplashScreen />;
  }

  if (auth.status !== "authenticated") {
    return (
      <LoginPage
        auth={auth}
        mode={authMode}
        email={email}
        name={name}
        password={password}
        confirmPassword={confirmPassword}
        verificationCode={verificationCode}
        verificationEmail={verificationEmail}
        resendAfterSeconds={resendAfterSeconds}
        error={sessionsStatus}
        onMode={setAuthMode}
        onEmail={setEmail}
        onName={setName}
        onPassword={setPassword}
        onConfirmPassword={setConfirmPassword}
        onVerificationCode={setVerificationCode}
        onLogin={() => void onPasswordLogin()}
        onRegister={() => void onRegister()}
        onVerify={() => void onVerifyRegistration()}
        onResend={() => void onResendVerificationCode()}
      />
    );
  }

  if (route.view === "cliLogin") {
    return (
      <CLIAuthPage
        auth={auth}
        request={cliAuthorization}
        status={cliStatus}
        onAuthorize={() => void onAuthorizeCLI()}
        onDeny={() => void onDenyCLI()}
        onReload={() => void loadCLIAuth(route.deviceCode)}
        onNavigate={(next) => void navigate(next)}
      />
    );
  }

  if (route.view === "localSetup") {
    // Device binding must re-authenticate every time, even with an existing
    // session. When already signed in but not yet re-authed for THIS grant,
    // force the password form before the claim can run. (Unauthenticated users
    // hit the standard login gate above, and onPasswordLogin marks them
    // re-authed for the localSetup route so they aren't prompted twice.)
    if (auth.status === "authenticated" && !setupReauthed) {
      return (
        <LoginPage
          auth={auth}
          mode="login"
          email={email}
          name={name}
          password={password}
          confirmPassword={confirmPassword}
          verificationCode={verificationCode}
          verificationEmail={verificationEmail}
          resendAfterSeconds={resendAfterSeconds}
          error={sessionsStatus}
          notice={tx("localSetup.reauthNotice")}
          onMode={setAuthMode}
          onEmail={setEmail}
          onName={setName}
          onPassword={setPassword}
          onConfirmPassword={setConfirmPassword}
          onVerificationCode={setVerificationCode}
          onLogin={() => void onPasswordLogin()}
          onRegister={() => void onRegister()}
          onVerify={() => void onVerifyRegistration()}
          onResend={() => void onResendVerificationCode()}
        />
      );
    }
    return (
      <LocalSetupPage
        auth={auth}
        state={localSetupState}
        onRetry={() => {
          if (route.view !== "localSetup") return;
          setLocalSetupState({ phase: "idle" });
          void runLocalSetup(route.grant, route.nonce, route.cb);
        }}
        onOpenWorkspace={() => void navigate({ view: "workspaceSessions" })}
      />
    );
  }

  const outdatedDaemons = daemonUpdateTargets(daemonDevices, hosts, MIN_RECOMMENDED_DAEMON_VERSION);
  const daemonUpdateVersion = daemonUpdateRecommendation(outdatedDaemons) || MIN_RECOMMENDED_DAEMON_VERSION;

  return (
    <AppShell>
      {outdatedDaemons.length > 0 ? (
        <DaemonOutdatedBanner
          devices={outdatedDaemons}
          recommended={daemonUpdateVersion}
          onTriggerRefresh={() => void refreshSessionsList()}
        />
      ) : null}
      <Rail
        auth={auth}
        route={route}
        sessions={sessionsForSelectedDevice}
        sessionTitles={sessionTitles}
        devices={daemonDevices}
        hosts={hosts}
        currentDeviceId={deviceFilter}
        onDeviceFilter={setExplicitDeviceFilter}
        onNavigate={(next) => void navigate(next)}
        onNewSessionInProject={(cwd, deviceId, agent) => {
          createDraftConversation(cwd, agent, deviceId);
          setRailDrawerOpen(false);
        }}
        sessionPrefs={sessionPrefs}
        projectPrefs={projectPrefs}
        onSessionPrefChange={applySessionPref}
        onProjectPrefChange={applyProjectPref}
        onDeleteSession={(sessionId, deviceId, title) => setDeleteTarget({ sessionId, deviceId, title })}
        drawerOpen={railDrawerOpen}
        onDrawerOpenChange={setRailDrawerOpen}
        catalogHasMore={sessionCatalogHasMore}
        catalogLoadingMore={sessionCatalogLoadingMore}
        catalogPrefetchPx={SESSION_CATALOG_PREFETCH_PX}
        onLoadMoreCatalog={() => void loadMoreSessionCatalogPage()}
      />
      <Workspace view={route.view}>
        {route.view === "workspaceConnect" ? (
          <PairPage
            auth={auth}
            setupGrant={route.setupGrant ?? ""}
            hosts={hosts}
            pairStatus={pairStatus}
            onConnectHost={(hostDeviceID) => void onConnectHost(hostDeviceID)}
            onRefreshHosts={() => void refreshApp({ view: "workspaceConnect" }, true)}
            onOpenCLIAuth={(deviceCode) => void navigate({ view: "cliLogin", deviceCode })}
            onOpenWorkspace={() => void navigate({ view: "workspaceSessions" })}
          />
        ) : route.view === "workspaceSettings" ? (
          <SettingsPage
            auth={auth}
            devices={devices}
            selectedSession={selectedSession}
            selectedDeviceId={deviceFilter}
            pushStatus={pushStatus}
            pushDetail={pushDetail}
            onEnablePush={() => void onEnablePush()}
            onOpenDevices={() => void navigate({ view: "workspaceDevices" })}
            onResetBrowserAccess={onResetCurrentBrowserAccess}
            onBack={() => void navigate({ view: "workspaceSessions" })}
            onLogout={() => void onLogout()}
          />
        ) : route.view === "workspaceDevices" ? (
          <DevicesPage
            devices={devices}
            onBack={() => void navigate({ view: "workspaceSettings" })}
            onAddDevice={() => void navigate({ view: "workspaceConnect" })}
            onRevoke={onRevoke}
            onRename={onRenameDevice}
          />
        ) : route.view === "workspaceLive" ? (
          <LiveTerminalPage
            devices={daemonDevices}
            hosts={hosts}
            sessions={sessionsForSelectedDevice}
            realtime={shouldUseBrowserRealtimeControl(runtimeCapabilities) ? subscriptionRef.current : null}
            onBack={() => void navigate({ view: "workspaceSessions" })}
          />
        ) : route.view === "routeError" ? (
          <RouteErrorPage title={route.title} body={route.body} onBack={() => void navigate({ view: "workspaceSessions" })} />
        ) : (
          <SessionsPage
            sessions={sessionsWithDraft}
            sessionGroups={sessionGroups}
            selectedSession={selectedSession}

            conversationRoute={route.view === "workspaceSession"}
            turns={turns}
            turnsHydration={turnsHydration}
            turnsStatus={turnsStatus}
            syncingEarlier={syncingEarlier}
            syncProgress={syncProgress}
            sessionsStatus={sessionsStatus}
            sessionLivenessHint={sessionLivenessHint}
            routeSelection={route.view === "workspaceSession" ? { sessionId: route.sessionId, deviceId: route.deviceId } : null}
            query={query}
            deviceFilter={deviceFilter}
            daemonDevices={daemonDevices}
            hosts={hosts}
            sessionTitles={sessionTitles}
            onNavigate={(next) => void navigate(next)}
            onOpenNewTask={() => setNewConversationDrawerOpen(true)}
            onOpenMenu={() => setRailDrawerOpen(true)}
            onLoadEarlier={() => void loadEarlierTurns()}
            onRefresh={() => void refreshApp(route, true)}
            composerText={composerText}
            attachments={composerAttachments}
            onAddFiles={addComposerFiles}
            onRemoveAttachment={removeComposerAttachment}
            injectStatus={injectStatus}
            injectBusy={Boolean(activeInjectID)}
            voiceStatus={voiceStatus}
            voiceAnalyser={voiceAnalyser}
            voiceError={voiceError}
            realtime={shouldUseBrowserRealtimeControl(runtimeCapabilities) ? subscriptionRef.current : null}
            onComposerText={setComposerText}
            composerEffort={effectiveComposerEffort}
            onComposerEffort={handleComposerEffortChange}
            composerModel={effectiveComposerModel}
            onComposerModel={handleComposerModelChange}
            composerPermissionMode={effectiveComposerPermissionMode}
            onComposerPermissionMode={handleComposerPermissionModeChange}
            onSendPrompt={() => void onSendPrompt()}
            onCancelInject={() => void onCancelInject()}
            onToggleVoiceInput={() => void onToggleVoiceInput()}
          />
        )}
      </Workspace>
      {newConversationDrawerOpen ? (
        <NewConversationDrawer
          devices={daemonDevices}
          daemonDevice={newConversationDaemon}
          agent={newConversationAgent}
          status={injectStatus}
          busy={Boolean(activeInjectID)}
          initialCwd={selectedSession?.cwd ?? ""}
          onDaemon={setNewConversationDaemon}
          onAgent={setNewConversationAgent}
          onSubmit={(cwd, agent) => onCreateNewConversation(cwd, agent)}
          onCancel={() => void onCancelInject()}
          onClose={() => setNewConversationDrawerOpen(false)}
        />
      ) : null}
      {deleteTarget ? (
        <ConfirmDeleteSessionDialog
          title={deleteTarget.title}
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => void confirmDeleteSession()}
          onCancel={() => {
            setDeleteTarget(null);
            setDeleteError("");
          }}
        />
      ) : null}
      {driftPrompt ? (
        <SessionDriftDialog
          actualSid={driftPrompt.actualSid}
          savedTextPreview={driftPrompt.savedText}
          onCancel={() => {
            // User declined the redirect. We've already cleared the
            // composer (sendPromptForSession does setComposerText("")
            // before the inject fires), so restore the text so they
            // don't lose it. Cancel just closes the modal; the user is
            // still on the old (read_only_sync) session.
            setComposerText(driftPrompt.savedText);
            setDriftPrompt(null);
          }}
          onConfirm={() => {
            // Navigate to the live sid AND prefill the composer with
            // the saved text. We deliberately do NOT auto-inject — the
            // user pressing Send again is the safety net that
            // guarantees their text is never silently dropped by automatic
            // resend after a drift correction.
            const target = driftPrompt;
            setDriftPrompt(null);
            setComposerText(target.savedText);
            setSelected({ sessionId: target.actualSid, deviceId: target.deviceId });
            pushRoute({ view: "workspaceSession", sessionId: target.actualSid, deviceId: target.deviceId });
          }}
        />
      ) : null}
    </AppShell>
  );
}

// SplashScreen covers the gap between page-load and the first getSession()
// resolution so users with a valid cookie don't see LoginPage briefly
// flash before the workspace renders.
function SplashScreen() {
  return (
    <div
      className="app-splash"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <RefreshCw className="app-splash-spinner" size={22} strokeWidth={1.8} aria-hidden="true" />
    </div>
  );
}

function LoginPage({
  auth,
  mode,
  email,
  name,
  password,
  confirmPassword,
  verificationCode,
  verificationEmail,
  resendAfterSeconds,
  error,
  onMode,
  onEmail,
  onName,
  onPassword,
  onConfirmPassword,
  onVerificationCode,
  onLogin,
  onRegister,
  onVerify,
  onResend,
  notice,
}: {
  auth: AuthState;
  mode: "login" | "register" | "verify";
  email: string;
  name: string;
  password: string;
  confirmPassword: string;
  verificationCode: string;
  verificationEmail: string;
  resendAfterSeconds: number;
  error: string;
  onMode: (value: "login" | "register" | "verify") => void;
  onEmail: (value: string) => void;
  onName: (value: string) => void;
  onPassword: (value: string) => void;
  onConfirmPassword: (value: string) => void;
  onVerificationCode: (value: string) => void;
  onLogin: () => void;
  onRegister: () => void;
  onVerify: () => void;
  onResend: () => void;
  notice?: string;
}) {
  const busy = auth.status === "loading";
  return (
    <main className="login-page">
      <section className="login-card">
        <div className="brand brand-with-action">
          <span className="brand-mark" aria-hidden="true"><img src="/pockly-icon.svg" alt="" /></span>
          <div>
            <strong>Pockly</strong>
            <span>{tx("auth.brandSubtitle")}</span>
          </div>
          <ThemeToggle />
        </div>
        {notice ? <Notice>{notice}</Notice> : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (mode === "login") onLogin();
            else if (mode === "register") onRegister();
            else onVerify();
          }}
        >
          {mode === "verify" ? (
            <>
              <span className="label">{tx("auth.verifyEmail")}</span>
              <Notice>
                <Trans i18nKey="auth.verifyNotice" values={{ email: verificationEmail || email }} components={{ strong: <strong /> }} />
              </Notice>
              <label>
                <span>{tx("auth.verificationCode")}</span>
                <Input
                  value={verificationCode}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  onChange={(event) => onVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              </label>
              <Button type="submit" disabled={busy || verificationCode.length !== 6}>{tx("auth.verifyAndContinue")}</Button>
              <Button type="button" variant="ghost" onClick={onResend} disabled={busy || resendAfterSeconds > 0}>
                {tx("auth.resendCode")}{resendAfterSeconds ? ` (${resendAfterSeconds}s)` : ""}
              </Button>
            </>
          ) : (
            <>
              <span className="label">{mode === "login" ? tx("auth.account") : tx("auth.createAccount")}</span>
              <label>
                <span>{tx("auth.email")}</span>
                <Input type="email" autoComplete="email" value={email} onChange={(event) => onEmail(event.target.value)} />
              </label>
              {mode === "register" ? (
                <label>
                  <span>{tx("auth.name")}</span>
                  <Input autoComplete="name" value={name} onChange={(event) => onName(event.target.value)} />
                </label>
              ) : null}
              <label>
                <span>{tx("auth.password")}</span>
                <Input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => onPassword(event.target.value)} />
              </label>
              {mode === "register" ? (
                <>
                  <label>
                    <span>{tx("auth.confirmPassword")}</span>
                    <Input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => onConfirmPassword(event.target.value)} />
                  </label>
                  <p className="form-hint">{tx("auth.passwordHint")}</p>
                </>
              ) : null}
              <Button type="submit" disabled={busy}>{mode === "login" ? tx("public.actions.signIn") : tx("auth.sendVerificationCode")}</Button>
              <p className="auth-pivot">
                {mode === "login" ? tx("auth.newToPockly") : tx("auth.alreadyHaveAccount")}{" "}
                <button type="button" className="auth-link-button ui-button-ghost" onClick={() => onMode(mode === "login" ? "register" : "login")}>
                  {mode === "login" ? tx("auth.createAccount") : tx("public.actions.signIn")}
                </button>
              </p>
            </>
          )}
          {error ? <Notice className="notice-error">{error}</Notice> : null}
        </form>
      </section>
    </main>
  );
}

function CLIAuthPage({
  auth,
  request,
  status,
  onAuthorize,
  onDeny,
  onReload,
  onNavigate,
}: {
  auth: Extract<AuthState, { status: "authenticated" }>;
  request: DaemonDeviceAuthorization | null;
  status: string;
  onAuthorize: () => void;
  onDeny: () => void;
  onReload: () => void;
  onNavigate: (route: Route) => void;
}) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [request?.device_code]);
  const expiresAt = request?.expires_at ? Date.parse(request.expires_at) : Number.NaN;
  const expiredByTime = now > 0 && Number.isFinite(expiresAt) && expiresAt <= now;
  const pending = request?.status === "pending" && !expiredByTime;
  const busy = status === "loading" || status === "authorizing" || status === "denying" || status === "awaiting_daemon_confirm";
  const awaitingDaemon = status === "awaiting_daemon_confirm";
  const connected = request?.status === "authorized" || request?.status === "consumed" || status === "authorized";
  const unavailable = request?.status === "denied" || request?.status === "expired" || expiredByTime;
  const actionError = request && !connected && !unavailable && !busy && !["", "pending", "loading"].includes(status) ? status : "";
  return (
    <main className="login-page cli-auth-page">
      <section className="login-card cli-auth-card">
        <div className="brand brand-with-action">
          <span className="brand-mark" aria-hidden="true"><img src="/pockly-icon.svg" alt="" /></span>
          <div>
            <strong>Pockly</strong>
            <span>{tx("cli.brandSubtitle")}</span>
          </div>
          <ThemeToggle />
        </div>
        {request ? (
          <>
            <div className="cli-auth-head">
              <span className="label">{tx("cli.signedInAs", { email: auth.email })}</span>
              <h1>{tx("cli.connectTitle")}</h1>
              <p>{tx("cli.connectBody")}</p>
            </div>
            {connected ? (
              <Notice>{tx("cli.connectedNotice")}</Notice>
            ) : null}
            {awaitingDaemon ? (
              <Notice>
                {tx("cli.awaitingDaemonConfirm") ||
                  "Approved on this phone. Now confirm the pair on your computer — open the terminal where you ran pockly-daemon setup."}
              </Notice>
            ) : null}
            {unavailable ? (
              <Notice className="notice-error"><Trans i18nKey="cli.unavailableNotice" components={{ code: <code /> }} /></Notice>
            ) : null}
            <div className="cli-auth-cta" aria-label={tx("cli.actionsAria")}>
              {connected ? (
                <>
                  <Button onClick={() => onNavigate({ view: "workspaceSessions" })}>{tx("cli.openSessions")}</Button>
                  <Button variant="ghost" onClick={() => onNavigate({ view: "workspaceDevices" })}>{tx("cli.devices")}</Button>
                </>
              ) : unavailable ? (
                <>
                  <Button onClick={onReload}>{tx("cli.checkAgain")}</Button>
                  <Button variant="ghost" onClick={() => onNavigate({ view: "workspaceDevices" })}>{tx("cli.devices")}</Button>
                </>
              ) : (
                <>
                  <Button disabled={!pending || busy} onClick={onAuthorize}>{tx("cli.connectComputer")}</Button>
                  <Button variant="ghost" disabled={!pending || busy} onClick={onDeny}>{tx("cli.deny")}</Button>
                </>
              )}
            </div>
            {actionError ? (
              <Notice className="notice-error">
                <Trans i18nKey="cli.connectFailed" values={{ error: actionError }} components={{ code: <code /> }} />
              </Notice>
            ) : null}
            <dl className="detail-list cli-device-list">
              <div><dt>{tx("cli.device")}</dt><dd>{request.daemon.device_name}</dd></div>
              <div><dt>{tx("cli.hostname")}</dt><dd>{request.daemon.hostname || "--"}</dd></div>
              <div><dt>{tx("cli.os")}</dt><dd>{request.daemon.os || "--"}</dd></div>
              <div><dt>{tx("cli.version")}</dt><dd>{request.daemon.app_version || "--"}</dd></div>
              <div><dt>{tx("cli.code")}</dt><dd>{request.user_code}</dd></div>
              <div><dt>{tx("cli.expires")}</dt><dd>{clockTime(request.expires_at)}</dd></div>
            </dl>
            <Notice>
              {tx("cli.requestedAccess", { capabilities: request.requested_capabilities.join(", ") })}
            </Notice>
            <div className="action-row">
              <Button variant="ghost" onClick={() => onNavigate({ view: "workspaceDevices" })}>{tx("cli.devices")}</Button>
              <Button variant="ghost" onClick={() => onNavigate({ view: "workspaceSessions" })}>{tx("cli.sessions")}</Button>
            </div>
          </>
        ) : (
          <>
            <div className="cli-auth-head">
              <span className="label">{tx("cli.brandSubtitle")}</span>
              <h1>{tx("cli.requestUnavailable")}</h1>
              <p>{status || tx("cli.requestNotFound")}</p>
            </div>
            <Notice className="notice-error"><Trans i18nKey="cli.rerunSetup" components={{ code: <code /> }} /></Notice>
            <Button variant="ghost" onClick={onReload}>{tx("common.retry")}</Button>
          </>
        )}
      </section>
    </main>
  );
}

// LocalSetupPage is the landing the daemon's `setup` command opens in the
// user's browser. Once the user is signed in, the parent App effect drives
// the actual handshake; this page just renders the visible progress and
// recovery affordances.
function LocalSetupPage({
  auth,
  state,
  onRetry,
  onOpenWorkspace,
}: {
  auth: AuthState;
  state: LocalSetupState;
  onRetry: () => void;
  onOpenWorkspace: () => void;
}) {
  const signedIn = auth.status === "authenticated";
  const showSignIn = !signedIn && auth.status !== "loading";
  return (
    <main className="login-page cli-auth-page">
      <section className="login-card cli-auth-card">
        <div className="brand brand-with-action">
          <span className="brand-mark" aria-hidden="true"><img src="/pockly-icon.svg" alt="" /></span>
          <div>
            <strong>Pockly</strong>
            <span>{tx("localSetup.brandSubtitle")}</span>
          </div>
          <ThemeToggle />
        </div>
        {signedIn ? <span className="label">{tx("cli.signedInAs", { email: auth.email })}</span> : null}
        {showSignIn ? (
          <div className="cli-auth-head">
            <h1>{tx("localSetup.signInTitle")}</h1>
            <p>{tx("localSetup.signInBody")}</p>
          </div>
        ) : (
          <div className="flow-status">
            {state.phase === "done" ? (
              <div className="disc ok"><Check size={28} strokeWidth={2.6} aria-hidden="true" /></div>
            ) : state.phase === "error" ? (
              <div className="disc danger"><X size={28} strokeWidth={2.4} aria-hidden="true" /></div>
            ) : (
              <div className="disc"><span className="spinner" /></div>
            )}
            {state.phase === "done" ? (
              <>
                <h3>{tx("localSetup.doneTitle")}</h3>
                <p className="flow-meta">{tx("localSetup.doneNotice", { device: state.daemonDeviceID })}</p>
                <MobileJoinQRCodeCard className="local-setup-phone-card" />
                <Button variant="ghost" onClick={onOpenWorkspace}>{tx("localSetup.openPCWorkspace")}</Button>
              </>
            ) : state.phase === "error" ? (
              <>
                <h3>{tx("localSetup.errorTitle")}</h3>
                <p>{state.message}</p>
                <div className="cli-auth-cta">
                  {state.retryable ? <Button onClick={onRetry}>{tx("common.retry")}</Button> : null}
                  <Button variant="ghost" onClick={onOpenWorkspace}>{tx("localSetup.openSessions")}</Button>
                </div>
              </>
            ) : (
              <>
                <h3>{tx("localSetup.workingTitle")}</h3>
                <p>{state.phase === "claiming" ? state.message : tx("localSetup.claiming")}</p>
              </>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function MobileJoinPage({
  state,
  onRetry,
  onOpenWorkspace,
}: {
  state: MobileJoinState;
  onRetry: () => void;
  onOpenWorkspace: () => void;
}) {
  const done = state.phase === "done";
  const error = state.phase === "error";
  return (
    <main className="login-page cli-auth-page">
      <section className="login-card cli-auth-card">
        <div className="brand brand-with-action">
          <span className="brand-mark" aria-hidden="true"><img src="/pockly-icon.svg" alt="" /></span>
          <div>
            <strong>Pockly</strong>
            <span>{tx("mobileJoin.brandSubtitle")}</span>
          </div>
          <ThemeToggle />
        </div>
        <div className="cli-auth-head">
          <span className="label">{tx("mobileJoin.label")}</span>
          <h1>{done ? tx("mobileJoin.doneTitle") : error ? tx("mobileJoin.errorTitle") : tx("mobileJoin.title")}</h1>
          <p>{done ? tx("mobileJoin.doneBody", { email: state.email }) : error ? state.message : state.message}</p>
        </div>
        {done ? (
          <div className="cli-auth-cta">
            <Button onClick={onOpenWorkspace}>{tx("mobileJoin.openWorkspace")}</Button>
          </div>
        ) : null}
        {error ? (
          <div className="cli-auth-cta">
            <Button onClick={onRetry}>{tx("common.retry")}</Button>
            <Button variant="ghost" onClick={onOpenWorkspace}>{tx("mobileJoin.openWorkspace")}</Button>
          </div>
        ) : state.phase === "claiming" ? (
          <Notice>{state.message}</Notice>
        ) : null}
      </section>
    </main>
  );
}

function MobileJoinQRModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="device-action-layer mobile-join-layer" role="presentation">
      <button type="button" className="device-action-backdrop" aria-label={tx("common.close")} onClick={onClose} />
      <section className="device-action-sheet mobile-join-sheet" role="dialog" aria-modal="true" aria-label={tx("mobileJoin.openQR")}>
        <MobileJoinQRCodeCard />
      </section>
    </div>
  );
}

function MobileJoinQRCodeCard({ className = "" }: { className?: string }) {
  const [qrPayload, setQRPayload] = useState("");
  const [qrDataURL, setQRDataURL] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [status, setStatus] = useState(tx("mobileJoin.creatingQR"));
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setStatus(tx("mobileJoin.creatingQR"));
        const grant = await createMobileJoinQRGrant();
        const dataURL = await QRCode.toDataURL(grant.qr_payload, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 280,
          color: {
            dark: "#111827",
            light: "#ffffff",
          },
        });
        if (cancelled) return;
        setQRPayload(grant.qr_payload);
        setQRDataURL(dataURL);
        setExpiresAt(grant.expires_at);
        setStatus(tx("mobileJoin.scanHint"));
      } catch (error) {
        if (cancelled) return;
        setStatus(error instanceof Error ? error.message : tx("mobileJoin.qrError"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={className ? `mobile-join-card ${className}` : "mobile-join-card"}>
      <header>
        <span className="device-action-icon" aria-hidden="true"><Smartphone size={20} /></span>
        <div>
          <strong>{tx("mobileJoin.qrTitle")}</strong>
          <span>{tx("mobileJoin.qrBody")}</span>
        </div>
      </header>
      <div className="mobile-join-qr-box">
        {qrDataURL ? <img src={qrDataURL} alt={tx("mobileJoin.qrAlt")} /> : <span>{status}</span>}
      </div>
      <p className="device-action-status">{status}</p>
      {expiresAt ? <p className="muted-copy">{tx("mobileJoin.expiresAt", { time: clockTime(expiresAt) })}</p> : null}
      {qrPayload ? (
        <Button
          variant="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(qrPayload);
            setCopyStatus(tx("mobileJoin.copied"));
          }}
        >
          <Copy size={16} aria-hidden="true" /> {copyStatus || tx("mobileJoin.copyLink")}
        </Button>
      ) : null}
    </div>
  );
}

// Rail nav pagination: each project starts collapsed-open showing
// RAIL_PROJECT_INITIAL conversations, revealing RAIL_PROJECT_STEP more per
// "show more"; the loose conversation list paginates the same way.
const RAIL_PROJECT_INITIAL = 2;
const RAIL_PROJECT_STEP = 3;
const RAIL_LOOSE_INITIAL = 8;
const RAIL_LOOSE_STEP = 12;

// presenceLabel renders a short status word for the device-picker trigger (the
// coloured dot carries the same signal; the design pairs it with short text —
// not the long hostname, which would collide with a long device name).
function presenceLabel(status: ReturnType<typeof devicePresenceStatus>): string {
  switch (status) {
    case "online":
      return tx("workspace.presenceOnline");
    case "connecting":
      return tx("workspace.presenceConnecting");
    case "degraded":
      return tx("workspace.presenceDegraded");
    default:
      return tx("workspace.presenceOffline");
  }
}

// RailDevicePicker — top of the rail; selects which connected computer the
// session list is scoped to (replaces the old rail search). Mirrors
// WorkspaceDeviceDropdown's data logic with the redesign's .device-picker chrome.
function RailDevicePicker({
  devices,
  hosts,
  currentDeviceId,
  onDeviceFilter,
  onConnect,
}: {
  devices: Device[];
  hosts: HostSummary[];
  currentDeviceId: string;
  onDeviceFilter: (value: string) => void;
  onConnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const selectedHost = hosts.find((host) => host.device_id === currentDeviceId);
  const selectedDevice = devices.find((device) => device.device_id === currentDeviceId);
  const selectedName = selectedHost?.device_name || selectedDevice?.device_name || tx("workspace.noDevice");
  const selectedPresence = devicePresenceStatus(selectedDevice ?? null, selectedHost ?? null);
  const hasSelected = Boolean(selectedHost || selectedDevice);
  const selectedMeta = hasSelected ? presenceLabel(selectedPresence) : tx("workspace.connectComputerMetaLower");
  useEffect(() => {
    if (!open) {
      return;
    }
    const onOutsidePress = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", onOutsidePress, true);
    document.addEventListener("touchstart", onOutsidePress, true);
    return () => {
      document.removeEventListener("mousedown", onOutsidePress, true);
      document.removeEventListener("touchstart", onOutsidePress, true);
    };
  }, [open]);
  return (
    <div ref={ref} className={open ? "device-picker is-open" : "device-picker"}>
      <button
        type="button"
        className="device-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={hasSelected ? clientDotClassName(selectedPresence) : "client-dot is-none"} aria-hidden="true" />
        <span className="device-picker-name">{selectedName}</span>
        <span className="device-picker-meta">{selectedMeta}</span>
        <ChevronDown className="device-picker-caret" size={15} aria-hidden="true" />
      </button>
      {open ? (
        <div className="device-picker-menu" role="listbox">
          {devices.map((device) => {
            const host = hosts.find((item) => item.device_id === device.device_id);
            const presence = devicePresenceStatus(device, host ?? null);
            const active = currentDeviceId === device.device_id;
            return (
              <button
                type="button"
                role="option"
                aria-selected={active}
                key={device.device_id}
                className={active ? "device-picker-option is-active" : "device-picker-option"}
                onClick={() => {
                  setOpen(false);
                  onDeviceFilter(device.device_id);
                }}
              >
                <span className={clientDotClassName(presence)} aria-hidden="true" />
                <span className="device-picker-opt-main">
                  <span className="device-picker-opt-name">{device.device_name || host?.device_name || device.device_id}</span>
                  <span className="device-picker-opt-meta">{host?.hostname || device.hostname || device.os || device.device_id}</span>
                </span>
                {active ? <Check size={15} aria-hidden="true" /> : null}
              </button>
            );
          })}
          <button
            type="button"
            className="device-picker-connect"
            onClick={() => {
              setOpen(false);
              onConnect();
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {tx("workspace.connectComputer")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// RailItemMenu is the compact ⋯ dropdown on sidebar project/session rows.
// Items run on click; the menu closes on selection, outside press, or Escape.
function RailItemMenu({ ariaLabel, items }: {
  ariaLabel: string;
  items: { key: string; label: string; danger?: boolean; onSelect: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onOutside = (event: MouseEvent | TouchEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("touchstart", onOutside, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("touchstart", onOutside, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="rail-menu" ref={ref}>
      <button
        type="button"
        className="drawer-project-action ui-button-ghost"
        title={ariaLabel}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="rail-menu-pop" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={item.danger ? "rail-menu-item is-danger" : "rail-menu-item"}
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Rail({
  auth,
  route,
  sessions,
  sessionTitles,
  devices,
  hosts,
  currentDeviceId,
  onDeviceFilter,
  onNavigate,
  onNewSessionInProject,
  sessionPrefs,
  projectPrefs,
  onSessionPrefChange,
  onProjectPrefChange,
  onDeleteSession,
  drawerOpen,
  onDrawerOpenChange,
  catalogHasMore,
  catalogLoadingMore,
  catalogPrefetchPx,
  onLoadMoreCatalog,
}: {
  auth: Extract<AuthState, { status: "authenticated" }>;
  route: Route;
  sessions: SessionListItem[];
  sessionTitles: Record<string, string>;
  devices: Device[];
  hosts: HostSummary[];
  currentDeviceId: string;
  onDeviceFilter: (value: string) => void;
  onNavigate: (route: Route) => void;
  onNewSessionInProject: (cwd: string, deviceId: string, agent: AgentKind) => void;
  sessionPrefs: Record<string, SessionPref>;
  projectPrefs: Record<string, ProjectPref>;
  onSessionPrefChange: (deviceId: string, sessionId: string, patch: { pinned?: boolean; archived?: boolean; customTitle?: string }) => void;
  onProjectPrefChange: (deviceId: string, cwd: string, patch: { pinned?: boolean; archived?: boolean; removed?: boolean; customLabel?: string }) => void;
  onDeleteSession: (sessionId: string, deviceId: string, title: string) => void;
  drawerOpen: boolean;
  onDrawerOpenChange: (open: boolean) => void;
  catalogHasMore: boolean;
  catalogLoadingMore: boolean;
  catalogPrefetchPx: number;
  onLoadMoreCatalog: () => void;
}) {
  // Drawer-open state is lifted to App so the workspace header's hamburger
  // (which lives in SessionsPage, a sibling) can open this rail's drawer.
  const setDrawerOpen = onDrawerOpenChange;
  const drawerRef = useRef<HTMLDivElement | null>(null);
  // The rail filters by the computer picker; `sessions` already arrives scoped
  // to the selected computer.
  const projectPrefFor = (deviceId: string, cwd: string) => projectPrefs[`${deviceId}:${cwd}`];
  const sessionPrefFor = (session: SessionListItem) => sessionPrefs[`${session.device_id}:${session.session_id}`];
  // Prefs-aware ordering: pinned projects first (then recency), removed and
  // archived projects hidden; within a project pinned sessions first and
  // archived sessions hidden. Same for the loose conversations list.
  const drawerProjects = useMemo(() => {
    return buildDrawerProjects(sessions)
      .filter((project) => {
        const pref = projectPrefFor(project.deviceId, project.cwd);
        return !pref?.removed && !pref?.archived;
      })
      .sort((a, b) => {
        const ap = projectPrefFor(a.deviceId, a.cwd)?.pinned ? 1 : 0;
        const bp = projectPrefFor(b.deviceId, b.cwd)?.pinned ? 1 : 0;
        return bp - ap;
      });
     
  }, [sessions, projectPrefs]);
  const drawerLooseSessions = useMemo(() => {
    return buildDrawerLooseSessions(sessions)
      .filter((session) => !sessionPrefFor(session)?.archived)
      .sort((a, b) => (sessionPrefFor(b)?.pinned ? 1 : 0) - (sessionPrefFor(a)?.pinned ? 1 : 0));
     
  }, [sessions, sessionPrefs]);
  // Collapsible nav + "show more" state.
  const activeSessionId = route.view === "workspaceSession" ? route.sessionId : "";
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [shownPerProject, setShownPerProject] = useState<Record<string, number>>({});
  const [looseShown, setLooseShown] = useState(RAIL_LOOSE_INITIAL);
  const go = (next: Route) => {
    setDrawerOpen(false);
    onNavigate(next);
  };
  // Shared session row (used by both the in-project list and the loose
  // conversations list): the session button + a ⋯ menu (pin / rename /
  // archive). The row is a div so the menu isn't an invalid nested button.
  const renderSessionRow = (session: SessionListItem) => {
    const pref = sessionPrefFor(session);
    const isActive = route.view === "workspaceSession" && route.sessionId === session.session_id && route.deviceId === session.device_id;
    return (
      <div key={`${session.device_id}:${session.session_id}`} className="drawer-session-mini-row">
        <button
          type="button"
          className={isActive ? "drawer-session-mini ui-button-ghost is-active" : "drawer-session-mini ui-button-ghost"}
          onClick={() => go({ view: "workspaceSession", sessionId: session.session_id, deviceId: session.device_id })}
        >
          <AgentLogo agent={session.agent} />
          <span className="drawer-session-title">{sessionDisplayName(session, sessionTitles[session.session_id])}</span>
          {pref?.pinned ? <Pin className="drawer-pin-mark" size={11} aria-hidden="true" /> : null}
          <time>{shortTime(session.last_timestamp)}</time>
        </button>
        <RailItemMenu
          ariaLabel={tx("railMenu.sessionMenuAria")}
          items={[
            {
              key: "pin",
              label: pref?.pinned ? tx("railMenu.unpin") : tx("railMenu.pin"),
              onSelect: () => onSessionPrefChange(session.device_id, session.session_id, { pinned: !pref?.pinned }),
            },
            {
              key: "rename",
              label: tx("railMenu.renameSession"),
              onSelect: () => {
                const next = window.prompt(tx("railMenu.renamePromptSession"), pref?.custom_title || sessionDisplayName(session, sessionTitles[session.session_id]));
                if (next === null) return;
                onSessionPrefChange(session.device_id, session.session_id, { customTitle: next.trim() });
              },
            },
            {
              key: "archive",
              label: tx("railMenu.archiveSession"),
              onSelect: () => onSessionPrefChange(session.device_id, session.session_id, { archived: true }),
            },
            {
              key: "delete",
              label: tx("railMenu.deleteSession"),
              danger: true,
              onSelect: () => onDeleteSession(session.session_id, session.device_id, sessionDisplayName(session, sessionTitles[session.session_id])),
            },
          ]}
        />
      </div>
    );
  };
  const renderMiniSessionList = (list: SessionListItem[]) => {
    const buckets = bucketSessionsByRecency(list);
    // Only show date headers when the list actually spans more than one time
    // bucket — a lone "Today" header above an all-recent list is just noise.
    const showHeaders = buckets.length > 1;
    return (
    <div className="drawer-session-mini-list">
      {buckets.map((bucket) => (
        <Fragment key={bucket.key}>
          {showHeaders ? <div className="drawer-date-header">{recencyBucketLabel(bucket.key)}</div> : null}
          {bucket.sessions.map(renderSessionRow)}
        </Fragment>
      ))}
    </div>
    );
  };
  useEffect(() => {
    if (!drawerOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);
  useEffect(() => {
    if (!drawerOpen) {
      return;
    }
    const onOutsidePress = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (target instanceof Node && drawerRef.current?.contains(target)) {
        return;
      }
      setDrawerOpen(false);
    };
    document.addEventListener("mousedown", onOutsidePress, true);
    document.addEventListener("touchstart", onOutsidePress, true);
    return () => {
      document.removeEventListener("mousedown", onOutsidePress, true);
      document.removeEventListener("touchstart", onOutsidePress, true);
    };
  }, [drawerOpen]);

  return (
    <aside className={drawerOpen ? "rail is-drawer-open" : "rail"}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><img src="/pockly-icon.svg" alt="" /></span>
        <div>
          <strong>Pockly</strong>
          <span>{tx("workspace.brandSubtitle")}</span>
        </div>
      </div>
      {drawerOpen ? <button type="button" className="rail-backdrop" aria-label={tx("workspace.dismissMenu")} onClick={() => setDrawerOpen(false)} /> : null}
      <div ref={drawerRef} className="rail-drawer" aria-label={tx("workspace.menuAria")}>
        <button
          type="button"
          className={route.view === "workspaceSettings" ? "account-panel account-button ui-button-ghost is-active" : "account-panel account-button ui-button-ghost"}
          onClick={() => go({ view: "workspaceSettings" })}
        >
          <span className="account-avatar" aria-hidden="true">{accountInitial(auth.name || auth.email)}</span>
          <span className="account-copy">
            <span className="label">{tx("workspace.signedIn")}</span>
            <strong>{auth.name}</strong>
            <span>{auth.email}</span>
          </span>
        </button>
        <div
          className="drawer-scroll"
          onScroll={(event) => {
            if (shouldLoadMoreSessionCatalogFromScroll({
              scrollTop: event.currentTarget.scrollTop,
              scrollHeight: event.currentTarget.scrollHeight,
              clientHeight: event.currentTarget.clientHeight,
              hasMore: catalogHasMore,
              loading: catalogLoadingMore,
              prefetchPx: catalogPrefetchPx,
            })) {
              onLoadMoreCatalog();
            }
          }}
        >
          <RailDevicePicker
            devices={devices}
            hosts={hosts}
            currentDeviceId={currentDeviceId}
            onDeviceFilter={onDeviceFilter}
            onConnect={() => go({ view: "workspaceConnect" })}
          />

          <section className="drawer-section" aria-label={tx("workspace.projects")}>
            <h2>{tx("workspace.projects")}</h2>
            {drawerProjects.length > 0 ? (
              <div className="drawer-project-list">
                {drawerProjects.map((project, index) => {
                  const projectPref = projectPrefFor(project.deviceId, project.cwd);
                  const defaultOpen = index === 0 || project.sessions.some((session) => session.session_id === activeSessionId);
                  const isOpen = openProjects[project.key] ?? defaultOpen;
                  const ordered = [...project.sessions]
                    .filter((session) => !sessionPrefFor(session)?.archived)
                    .sort((a, b) => Date.parse(b.last_timestamp || "") - Date.parse(a.last_timestamp || ""))
                    .sort((a, b) => (sessionPrefFor(b)?.pinned ? 1 : 0) - (sessionPrefFor(a)?.pinned ? 1 : 0));
                  const shown = shownPerProject[project.key] ?? RAIL_PROJECT_INITIAL;
                  const visible = ordered.slice(0, shown);
                  const remaining = ordered.length - visible.length;
                  return (
                    <article key={project.key} className={isOpen ? "drawer-project is-open" : "drawer-project"}>
                      <div className="drawer-project-head-row">
                        <button
                          type="button"
                          className="drawer-project-head ui-button-ghost"
                          aria-expanded={isOpen}
                          onClick={() => setOpenProjects((state) => ({ ...state, [project.key]: !(state[project.key] ?? defaultOpen) }))}
                        >
                          <span className="drawer-project-caret" style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }} aria-hidden="true">
                            <ChevronRight size={14} />
                          </span>
                          <Folder className="drawer-project-folder" size={16} aria-hidden="true" />
                          <span className="drawer-project-label">{projectPref?.custom_label?.trim() || project.label}</span>
                          {projectPref?.pinned ? <Pin className="drawer-pin-mark" size={12} aria-hidden="true" /> : null}
                          <span className="drawer-project-count">{project.sessions.length}</span>
                        </button>
                        <RailItemMenu
                          ariaLabel={tx("railMenu.projectMenuAria")}
                          items={[
                            {
                              key: "pin",
                              label: projectPref?.pinned ? tx("railMenu.unpin") : tx("railMenu.pin"),
                              onSelect: () => onProjectPrefChange(project.deviceId, project.cwd, { pinned: !projectPref?.pinned }),
                            },
                            {
                              key: "rename",
                              label: tx("railMenu.renameProject"),
                              onSelect: () => {
                                const next = window.prompt(tx("railMenu.renamePromptProject"), projectPref?.custom_label || project.label);
                                if (next === null) return;
                                onProjectPrefChange(project.deviceId, project.cwd, { customLabel: next.trim() });
                              },
                            },
                            {
                              key: "archive",
                              label: tx("railMenu.archiveProject"),
                              onSelect: () => onProjectPrefChange(project.deviceId, project.cwd, { archived: true }),
                            },
                            {
                              key: "remove",
                              label: tx("railMenu.removeProject"),
                              danger: true,
                              onSelect: () => onProjectPrefChange(project.deviceId, project.cwd, { removed: true }),
                            },
                          ]}
                        />
                        <button
                          type="button"
                          className="drawer-project-action ui-button-ghost"
                          title={tx("workspace.newSessionInProject")}
                          aria-label={tx("workspace.newSessionInProject")}
                          onClick={() => {
                            const seed = ordered[0];
                            if (seed) onNewSessionInProject(seed.cwd || "", seed.device_id, seed.agent as AgentKind);
                          }}
                        >
                          <SquarePen size={14} aria-hidden="true" />
                        </button>
                      </div>
                      {isOpen ? (
                        <div className="drawer-session-mini-list">
                          {visible.map(renderSessionRow)}
                          {remaining > 0 ? (
                            <button
                              type="button"
                              className="drawer-show-more"
                              onClick={() => setShownPerProject((state) => ({ ...state, [project.key]: shown + RAIL_PROJECT_STEP }))}
                            >
                              {tx("workspace.showMore")}
                              <span className="drawer-show-more-count">{remaining} {tx("workspace.itemsLeft")}</span>
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="drawer-empty">{tx("workspace.noProjectSessions")}</p>
            )}
          </section>

          <section className="drawer-section" aria-label={tx("workspace.conversations")}>
            <h2>{tx("workspace.conversations")}</h2>
            {drawerLooseSessions.length > 0 ? (
              <>
                {renderMiniSessionList(drawerLooseSessions.slice(0, looseShown))}
                {drawerLooseSessions.length > looseShown ? (
                  <button
                    type="button"
                    className="drawer-show-more"
                    onClick={() => setLooseShown((value) => value + RAIL_LOOSE_STEP)}
                  >
                    {tx("workspace.showMore")}
                    <span className="drawer-show-more-count">{drawerLooseSessions.length - looseShown} {tx("workspace.itemsLeft")}</span>
                  </button>
                ) : null}
              </>
            ) : (
              <p className="drawer-empty">{tx("workspace.noLooseConversations")}</p>
            )}
          </section>
          {catalogHasMore ? (
            <button
              type="button"
              className="drawer-show-more"
              disabled={catalogLoadingMore}
              onClick={onLoadMoreCatalog}
            >
              {catalogLoadingMore ? tx("common.loading") : tx("workspace.loadOlderSessions")}
            </button>
          ) : null}
        </div>

        <div className="drawer-footer nav-stack">
          <Button
            variant="ghost"
            aria-current={route.view === "workspaceSettings" ? "page" : undefined}
            className={route.view === "workspaceSettings" ? "is-active" : ""}
            onClick={() => go({ view: "workspaceSettings" })}
          >
            <span><Settings size={17} aria-hidden="true" /> {tx("workspace.settings")}</span>
          </Button>
        </div>
      </div>
    </aside>
  );
}

function SessionsPage({
  sessions,
  sessionGroups,
  selectedSession,
  conversationRoute,
  turns,
  turnsHydration,
  turnsStatus,
  syncingEarlier,
  syncProgress,
  sessionsStatus,
  sessionLivenessHint,
  routeSelection,
  query,
  deviceFilter,
  daemonDevices,
  hosts,
  sessionTitles,
  onNavigate,
  onOpenNewTask,
  onOpenMenu,
  onLoadEarlier,
  onRefresh,
  composerText,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  injectStatus,
  injectBusy,
  voiceStatus,
  voiceAnalyser = null,
  voiceError,
  onComposerText,
  composerEffort,
  onComposerEffort,
  composerModel,
  onComposerModel,
  composerPermissionMode,
  onComposerPermissionMode,
  onSendPrompt,
  onCancelInject,
  onToggleVoiceInput,
  realtime,
}: {
  sessions: SessionListItem[];
  sessionGroups: SessionGroup[];
  selectedSession: SessionListItem | null;
  conversationRoute: boolean;
  turns: SessionTurn[];
  turnsHydration: SessionTurnsResponse | null;
  turnsStatus: string;
  syncingEarlier: boolean;
  syncProgress: SyncSessionEvent | null;
  sessionsStatus: string;
  sessionLivenessHint: "active" | "dead" | "unknown";
  routeSelection: ReaderSelection | null;
  query: string;
  deviceFilter: string;
  daemonDevices: Device[];
  hosts: HostSummary[];
  sessionTitles: Record<string, string>;
  onNavigate: (route: Route) => void;
  onOpenNewTask: () => void;
  onOpenMenu: () => void;
  onLoadEarlier: () => void;
  onRefresh: () => void;
  composerText: string;
  attachments: File[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
  injectStatus: string;
  injectBusy: boolean;
  voiceStatus: VoiceStatus;
  voiceAnalyser?: AnalyserNode | null;
  voiceError: string;
  onComposerText: (value: string) => void;
  composerEffort: string;
  onComposerEffort: (effort: string) => void;
  composerModel: string;
  onComposerModel: (model: string) => void;
  composerPermissionMode: string;
  onComposerPermissionMode: (permissionMode: string) => void;
  onSendPrompt: () => void;
  onCancelInject: () => void;
  onToggleVoiceInput: () => void;
  realtime?: SessionSubscription | null;
}) {
  const visibleTurns = selectedSession ? visibleConversationTurns(turns) : [];
  const hasOlderTurns = hasEarlierTurns(turnsHydration, visibleTurns, selectedSession);
  // Composer mirrors the no-device home: starts in rest (single-row) and
  // expands to the focused 2-row layout only after the user taps in.
  const [composerFocused, setComposerFocused] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [mobileQRModalOpen, setMobileQRModalOpen] = useState(false);
  const readerScrollRef = useRef<HTMLDivElement | null>(null);
  const previousScrollHeightRef = useRef(0);
  const initialScrolledSessionIdRef = useRef<string | null>(null);
  const pullStartYRef = useRef<number | null>(null);
  const composerHasDraft = composerText.trim().length > 0;
  const showMobileJoinAction = !isMobileBrowser();
  const handleOpenMobileJoin = useCallback(() => setMobileQRModalOpen(true), []);
  const selectedSessionIsFreshDraft = !!selectedSession
    && isDraftConversation(selectedSession)
    && (selectedSession.last_seq ?? 0) === 0
    && (selectedSession.turn_count ?? 0) === 0;

  useEffect(() => {
    const node = readerScrollRef.current;
    if (!node || previousScrollHeightRef.current <= 0) return;
    const previous = previousScrollHeightRef.current;
    previousScrollHeightRef.current = 0;
    node.scrollTop += node.scrollHeight - previous;
  }, [visibleTurns.length]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      updateScrollToBottomVisibility(readerScrollRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visibleTurns.length, selectedSession?.session_id, turnsStatus]);

  // First-open scroll-to-bottom: when a session is opened, jump the
  // reader to its latest message once turns have hydrated. Reader
  // identity throughout this app is the (session_id, device_id)
  // pair — same session_id on a different daemon is a different
  // conversation — so we dedupe on the composite selection key. That
  // way streaming new turns or load-earlier prepends in the same
  // session don't re-trigger, but switching to a same-id session on
  // another device correctly re-runs the auto-scroll.
  //
  // Markdown, images, and lazy-loaded KaTeX math keep growing the document
  // several frames after the initial paint — a single
  // rAF snap lands halfway up because scrollHeight is still climbing.
  // We re-snap every frame until either scrollHeight has been stable
  // for ~100ms, a 1.5s hard cap is hit, or the user grabs the scroll
  // (wheel/touch) themselves.
  useEffect(() => {
    const sessionId = selectedSession?.session_id;
    const deviceId = selectedSession?.device_id;
    if (!sessionId) {
      initialScrolledSessionIdRef.current = null;
      return;
    }
    const selectionKey = `${deviceId ?? ""}:${sessionId}`;
    if (initialScrolledSessionIdRef.current === selectionKey) return;
    if (turnsStatus === "loading" || turnsStatus === "syncing") return;
    if (visibleTurns.length === 0) return;
    const node = readerScrollRef.current;
    if (!node) return;

    let cancelled = false;
    let lastHeight = -1;
    let stableFrames = 0;
    let frameCount = 0;
    let frameId: number | null = null;

    const finalize = () => {
      cancelled = true;
      initialScrolledSessionIdRef.current = selectionKey;
      setShowScrollToBottom(false);
    };
    const onUserGesture = () => {
      if (cancelled) return;
      finalize();
    };

    const snap = () => {
      if (cancelled) return;
      const h = node.scrollHeight;
      node.scrollTop = h;
      if (h === lastHeight) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        lastHeight = h;
      }
      if (stableFrames >= 6 || frameCount >= 90) {
        finalize();
        return;
      }
      frameCount += 1;
      frameId = window.requestAnimationFrame(snap);
    };

    node.addEventListener("wheel", onUserGesture, { passive: true });
    node.addEventListener("touchstart", onUserGesture, { passive: true });
    frameId = window.requestAnimationFrame(snap);

    return () => {
      cancelled = true;
      node.removeEventListener("wheel", onUserGesture);
      node.removeEventListener("touchstart", onUserGesture);
      if (frameId != null) window.cancelAnimationFrame(frameId);
    };
  }, [selectedSession?.session_id, selectedSession?.device_id, turnsStatus, visibleTurns.length]);

  function requestEarlierContext(node: HTMLDivElement) {
    if (!hasOlderTurns || turnsStatus === "syncing" || syncingEarlier) return;
    previousScrollHeightRef.current = node.scrollHeight;
    onLoadEarlier();
  }

  function updateScrollToBottomVisibility(node: HTMLDivElement | null) {
    if (!node || !selectedSession) {
      setShowScrollToBottom(false);
      return;
    }
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const shouldShow = distanceFromBottom > 140;
    setShowScrollToBottom((current) => (current === shouldShow ? current : shouldShow));
  }

  function scrollConversationToBottom() {
    const node = readerScrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    setShowScrollToBottom(false);
  }

  const emptyState = workspaceHomeEmptyState({
    sessions,
    filteredGroups: sessionGroups,
    daemonCount: daemonDevices.length,
    hosts,
    sessionsStatus,
    query,
  });
  const showConversationView = Boolean(selectedSession || conversationRoute);
  const showNoDeviceHome = Boolean(emptyState && emptyState.action === "connect" && daemonDevices.length === 0 && !showConversationView);
  const showCatalogWarmingHome = Boolean(
    emptyState &&
    emptyState.kind === "catalog_warming" &&
    daemonDevices.length > 0 &&
    sessions.length === 0 &&
    !showConversationView,
  );
  const showBootstrapLoadingHome = Boolean(
    emptyState &&
    emptyState.kind === "bootstrap_loading" &&
    !showConversationView,
  );
  const showStatusHome = Boolean(
    emptyState &&
    emptyState.kind === "session_status" &&
    !showConversationView,
  );
  const selectedSessionControllable = selectedSession ? canControlSession(selectedSession) : true;
  const bootstrapLoading = emptyState?.kind === "bootstrap_loading";
  const composerDisabled = injectBusy || showNoDeviceHome || showStatusHome || bootstrapLoading || !selectedSessionControllable;
  const composerHasAttachments = attachments.length > 0;
  const composerSendDisabled = composerDisabled || (!composerHasDraft && !composerHasAttachments);
  const composerVoiceDisabled = composerDisabled || voiceStatus === "transcribing";
  // Attachments ride the existing-session inject path: enabled only for a real,
  // controllable, non-draft session (a fresh draft creates the session on send).
  const composerAttachmentsEnabled = !composerDisabled && !!selectedSession && !selectedSessionIsFreshDraft;
  // Workspace-header status dot reflects the selected computer's presence
  // (the device selector itself moved to the rail in the redesign).
  const headerDevice = daemonDevices.find((device) => device.device_id === deviceFilter);
  const headerHost = hosts.find((host) => host.device_id === deviceFilter);
  const headerDotClass = headerDevice || headerHost
    ? clientDotClassName(devicePresenceStatus(headerDevice ?? null, headerHost ?? null))
    : "client-dot is-none";

  return (
    <>
      {/* The .ws-header is only the LIST/empty-view header. In a conversation
          the AgentConversationHeader below is the single header (session title
          + meta + token usage), so we don't stack a second bar on top. */}
      {!showConversationView ? (
        <header className="ws-header">
        <button
          type="button"
          className="ws-icon-btn ws-menu-btn"
          aria-label={tx("workspace.openMenu")}
          onClick={onOpenMenu}
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        <div className="ws-center-title">
          <span className={headerDotClass} aria-hidden="true" />
          <span className="ws-center-title-text">{selectedSession ? projectDisplayName(selectedSession) : tx("workspace.conversations")}</span>
        </div>
        <div className="ws-header-actions">
          {showMobileJoinAction ? (
            <button
              type="button"
              className="ws-icon-btn"
              aria-label={tx("mobileJoin.openQR")}
              title={tx("mobileJoin.openQR")}
              onClick={() => setMobileQRModalOpen(true)}
            >
              <Smartphone size={20} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="ws-icon-btn"
            aria-label={tx("workspace.newConversation")}
            title={tx("workspace.newConversation")}
            onClick={onOpenNewTask}
          >
            <SquarePen size={20} aria-hidden="true" />
          </button>
        </div>
        </header>
      ) : null}
      {mobileQRModalOpen ? <MobileJoinQRModal onClose={() => setMobileQRModalOpen(false)} /> : null}
      {showNoDeviceHome || showCatalogWarmingHome || showBootstrapLoadingHome || showStatusHome ? (
        <PocklyNoDeviceHome
          mode={showBootstrapLoadingHome ? "workspace_loading" : showCatalogWarmingHome ? "catalog_warming" : emptyState?.kind === "session_status" ? "session_status" : "no_device"}
          composerText={composerText}
          injectStatus={injectStatus}
          injectBusy={injectBusy}
          voiceStatus={voiceStatus}
          voiceError={voiceError}
          onConnect={() => onNavigate({ view: "workspaceConnect" })}
          {...(showMobileJoinAction ? { onOpenMobileJoin: handleOpenMobileJoin } : {})}
          onRefresh={onRefresh}
          onComposerText={onComposerText}
          onSendPrompt={onSendPrompt}
          onCancelInject={onCancelInject}
          onToggleVoiceInput={onToggleVoiceInput}
        />
      ) : (
      <div className={showConversationView ? "content-grid sessions-grid workspace-home-grid has-selection" : "content-grid sessions-grid workspace-home-grid"}>
        <section className="reader">
          {showConversationView ? (
            <AgentConversationHeader
              session={selectedSession}
              routeSelection={routeSelection}
              turns={visibleTurns}
              totalTurns={turns}
              hydration={turnsHydration}
              turnsStatus={turnsStatus}
              syncProgress={syncProgress}
              injectBusy={injectBusy}
              derivedTitle={(selectedSession ? sessionTitles[selectedSession.session_id] : "") || ""}
              onOpenMenu={onOpenMenu}
              onOpenNewTask={onOpenNewTask}
              onOpenMobileJoin={() => setMobileQRModalOpen(true)}
              showMobileJoinAction={showMobileJoinAction}
            />
          ) : null}
          <div
            ref={readerScrollRef}
            className={showConversationView ? "turn-scroll" : "turn-scroll is-workspace-idle"}
            onScroll={(event) => {
              updateScrollToBottomVisibility(event.currentTarget);
              if (visibleTurns.length > 0 && event.currentTarget.scrollTop < 96) {
                requestEarlierContext(event.currentTarget);
              }
            }}
            onTouchStart={(event) => {
              if (visibleTurns.length === 0) {
                pullStartYRef.current = null;
                return;
              }
              pullStartYRef.current = event.currentTarget.scrollTop <= 2 ? event.touches[0]?.clientY ?? null : null;
            }}
            onTouchMove={(event) => {
              const startY = pullStartYRef.current;
              if (startY == null || event.currentTarget.scrollTop > 2) return;
              const currentY = event.touches[0]?.clientY ?? startY;
              if (currentY - startY < 48) return;
              event.preventDefault();
              pullStartYRef.current = null;
              requestEarlierContext(event.currentTarget);
            }}
            onTouchEnd={() => {
              pullStartYRef.current = null;
            }}
            onTouchCancel={() => {
              pullStartYRef.current = null;
            }}
          >
            {!selectedSession ? (
              <WsEmpty
                icon={<SquarePen size={24} aria-hidden="true" />}
                head={emptyState?.title ?? tx("workspace.idleTitle")}
                sub={emptyState?.body ?? tx("workspace.idleBody")}
                footer={
                  <div className="ws-empty-actions">
                    <button type="button" className="empty-action is-primary" onClick={onOpenMenu}>
                      {tx("workspace.idleChoose")}
                    </button>
                    <button type="button" className="empty-action is-secondary" onClick={onOpenNewTask}>
                      {tx("workspace.idleStartNew")}
                    </button>
                  </div>
                }
              />
            ) : turnsStatus === "loading" ? (
              <ReaderPlaceholder />
            ) : turnsStatus === "syncing" && visibleTurns.length === 0 ? (
              <SyncProgressState event={syncProgress} />
            ) : turnsStatus && visibleTurns.length === 0 ? (
              <ReaderEdgeState
                session={selectedSession}
                daemonDevices={daemonDevices}
                hosts={hosts}
                turnsStatus={turnsStatus}
                dead={sessionLivenessHint === "dead"}
                onBack={() => onNavigate({ view: "workspaceSessions" })}
                onRefresh={onRefresh}
              />
            ) : (
              <>
                {hasOlderTurns ? (
                  <Button
                    variant="secondary"
                    className="load-earlier-button"
                    disabled={syncingEarlier || turnsStatus === "syncing"}
                    onClick={() => {
                      if (readerScrollRef.current) requestEarlierContext(readerScrollRef.current);
                    }}
                  >
                    <ChevronUp size={14} aria-hidden="true" />
                    {syncingEarlier ? tx("common.syncing") : tx("workspace.loadEarlierContext")}
                  </Button>
                ) : null}
                {syncingEarlier ? <SyncProgressState event={syncProgress} /> : null}
                <div className="ws-mg-list">
                  {groupTurnsForRender(visibleTurns).map((group) => (
                    <MessageGroupArticle key={group.key} group={group} />
                  ))}
                </div>
                <RunningIndicator running={injectBusy} />
              </>
            )}
          </div>
          <footer className="agent-composer pockly-empty-composer-zone">
            {showConversationView ? (
              <PermissionRequestsPanel
                turns={turns}
                realtime={realtime ?? null}
              />
            ) : null}
            {selectedSession && canControlSession(selectedSession) ? (
              <ClaudeCodePillsRow
                sessionId={selectedSession.session_id}
                deviceId={selectedSession.device_id}
                agent={selectedSession.agent}
                turns={turns}
                disabled={composerDisabled}
                draftMode={selectedSessionIsFreshDraft}
                draftCwd={selectedSession.cwd || ""}
                draftModel={composerModel}
                draftEffort={composerEffort}
                draftPermissionMode={composerPermissionMode}
                onModelChange={onComposerModel}
                onEffortChange={onComposerEffort}
                onPermissionModeChange={onComposerPermissionMode}
              />
            ) : null}
            <WorkspaceComposerDock
              value={composerText}
              focused={composerFocused}
              hasAction={composerHasDraft || composerHasAttachments || injectBusy}
              busy={injectBusy}
              disabled={composerDisabled}
              sendDisabled={composerSendDisabled}
              placeholder={selectedSession ? tx("workspace.promptContinue") : tx("workspace.promptComposer")}
              voiceStatus={voiceStatus}
              voiceAnalyser={voiceAnalyser}
              voiceDisabled={composerVoiceDisabled}
              attachments={attachments}
              attachmentsEnabled={composerAttachmentsEnabled}
              onAddFiles={onAddFiles}
              onRemoveAttachment={onRemoveAttachment}
              onFocus={() => setComposerFocused(true)}
              onBlur={() => setComposerFocused(false)}
              onChange={onComposerText}
              onSend={onSendPrompt}
              onStop={onCancelInject}
              onVoice={onToggleVoiceInput}
            />
            {voiceError || injectStatus ? (
              <p className="pockly-empty-footnote">{voiceError || injectStatus}</p>
            ) : null}
          </footer>
          {showConversationView && showScrollToBottom ? (
            <button
              type="button"
              className="scroll-to-bottom-button"
              aria-label={tx("workspace.scrollToBottom")}
              onClick={scrollConversationToBottom}
            >
              <ChevronDown size={18} aria-hidden="true" />
            </button>
          ) : null}
        </section>
      </div>
      )}
    </>
  );
}

type PocklyNoDeviceHomeProps = {
  mode: "no_device" | "catalog_warming" | "workspace_loading" | "session_status";
  composerText: string;
  injectStatus: string;
  injectBusy: boolean;
  voiceStatus: VoiceStatus;
  voiceError: string;
  onConnect: () => void;
  // Optional: when present and the viewer isn't already on a phone, render
  // a secondary "Open on phone" CTA so first-time users discover the
  // mobile-join flow without having to first complete a desktop pairing.
  onOpenMobileJoin?: () => void;
  onRefresh?: () => void;
  onComposerText: (value: string) => void;
  onSendPrompt: () => void;
  onCancelInject: () => void;
  onToggleVoiceInput: () => void;
};

function PocklyNoDeviceHome({
  mode,
  composerText,
  injectStatus,
  injectBusy,
  voiceStatus,
  voiceError,
  onConnect,
  onOpenMobileJoin,
  onRefresh,
  onComposerText,
  onSendPrompt,
  onCancelInject,
  onToggleVoiceInput,
}: PocklyNoDeviceHomeProps) {
  const [focused, setFocused] = useState(false);
  // Non-onboarding center states render as a simple .ws-empty (no composer),
  // matching the design's m-center-waiting / m-ws-unavailable. The no-device
  // onboarding below keeps its composer so a first prompt can be queued.
  if (mode === "catalog_warming") {
    return (
      <WsEmpty
        icon={<span className="spinner" />}
        head={tx("workspace.catalogWarmingTitle")}
        sub={tx("workspace.catalogWarmingBody")}
        helper={<><span className="spinner" />{tx("workspace.catalogWarmingHelper")}</>}
      />
    );
  }
  if (mode === "workspace_loading") {
    return (
      <WsEmpty
        icon={<span className="spinner" />}
        head={tx("workspace.loadingWorkspaceTitle")}
        sub={tx("workspace.loadingWorkspaceBody")}
        helper={<><span className="spinner" />{tx("common.loading")}</>}
      />
    );
  }
  if (mode === "session_status") {
    return (
      <WsEmpty
        icon={<Lock size={22} aria-hidden="true" />}
        tone="danger"
        head={tx("workspace.workspaceUnavailableTitle")}
        sub={tx("workspace.workspaceUnavailableBody")}
        footer={
          <button type="button" className="pockly-empty-inline-link" onClick={onRefresh}>
            {tx("cli.checkAgain")}
          </button>
        }
      />
    );
  }
  const hasDraft = composerText.trim().length > 0;
  const composerDisabled = mode === "no_device" || injectBusy;
  const placeholder = composerDisabled ? tx("workspace.unavailablePromptPlaceholder") : tx("workspace.promptComposer");
  return (
    <div className="pockly-empty-home">
      <section className="pockly-empty-welcome" aria-label={tx("workspace.emptyIntroAria")}>
        <span className="pockly-empty-icon-bubble" aria-hidden="true">
          <Laptop size={26} strokeWidth={1.8} />
        </span>
        <div className="pockly-empty-head">{tx("workspace.noDeviceTitle")}</div>
        <div className="pockly-empty-sub">{tx("workspace.noDeviceBody")}</div>
        <div className="pockly-empty-actions">
          <button type="button" className="pockly-empty-inline-link" onClick={onConnect}>{tx("workspace.connectComputerArrow")}</button>
          {onOpenMobileJoin ? (
            <button type="button" className="pockly-empty-inline-link" onClick={onOpenMobileJoin}>{tx("workspace.openOnPhoneArrow")}</button>
          ) : null}
        </div>
      </section>
      <section className="pockly-empty-composer-zone" aria-label={tx("workspace.emptyPromptAria")}>
        <WorkspaceComposerDock
          value={composerText}
          focused={focused}
          hasAction={hasDraft || injectBusy}
          busy={injectBusy}
          disabled={composerDisabled}
          sendDisabled={composerDisabled || !hasDraft}
          placeholder={placeholder}
          voiceStatus={voiceStatus}
          voiceDisabled={composerDisabled || voiceStatus === "transcribing"}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={onComposerText}
          onSend={onSendPrompt}
          onStop={onCancelInject}
          onVoice={onToggleVoiceInput}
        />
        <p className="pockly-empty-footnote">{voiceError || injectStatus || tx("workspace.emptyFootnote")}</p>
      </section>
    </div>
  );
}

function VoiceWaveform({ analyser }: { analyser: AnalyserNode | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!analyser) return;
    const container = containerRef.current;
    if (!container) return;
    const bars = Array.from(container.children) as HTMLElement[];
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const draw = () => {
      analyser.getByteFrequencyData(data);
      const step = Math.max(1, Math.floor(data.length / bars.length));
      for (let i = 0; i < bars.length; i += 1) {
        let sum = 0;
        for (let j = 0; j < step; j += 1) sum += data[i * step + j] ?? 0;
        const level = sum / step / 255;
        bars[i].style.height = `${Math.max(12, Math.min(100, 12 + level * 150))}%`;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [analyser]);
  return (
    <div className={`voice-waveform${analyser ? "" : " is-idle-anim"}`} ref={containerRef} aria-hidden="true">
      {Array.from({ length: 28 }).map((_, index) => (
        <span key={index} className="voice-waveform-bar" style={analyser ? undefined : { animationDelay: `${(index % 7) * 0.08}s` }} />
      ))}
    </div>
  );
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// One attachment chip. Images get a live thumbnail (object URL revoked on
// unmount); everything else shows a file glyph + name + size.
function ComposerAttachmentChip({ file, onRemove }: { file: File; onRemove?: (() => void) | undefined }) {
  const isImage = file.type.startsWith("image/");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return undefined;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, isImage]);
  return (
    <span className="composer-attachment-chip">
      {isImage && url ? (
        <img className="composer-attachment-thumb" src={url} alt="" />
      ) : (
        <span className="composer-attachment-glyph" aria-hidden="true"><FileText size={14} /></span>
      )}
      <span className="composer-attachment-meta">
        <span className="composer-attachment-name" title={file.name}>{file.name}</span>
        <span className="composer-attachment-size">{formatAttachmentSize(file.size)}</span>
      </span>
      {onRemove ? (
        <button
          type="button"
          className="composer-attachment-remove"
          aria-label={tx("workspace.removeAttachment")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRemove}
        >
          <X size={12} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

function ComposerAttachmentChips({ files, onRemove }: { files: File[]; onRemove?: ((index: number) => void) | undefined }) {
  if (files.length === 0) return null;
  return (
    <div className="composer-attachments" aria-label={tx("workspace.attachmentsAria")}>
      {files.map((file, index) => (
        <ComposerAttachmentChip
          key={`${file.name}-${file.size}-${index}`}
          file={file}
          onRemove={onRemove ? () => onRemove(index) : undefined}
        />
      ))}
    </div>
  );
}

function WorkspaceComposerDock({
  value,
  focused,
  hasAction,
  busy,
  disabled,
  sendDisabled,
  placeholder,
  voiceStatus,
  voiceAnalyser = null,
  voiceDisabled,
  attachments = [],
  attachmentsEnabled = false,
  onAddFiles,
  onRemoveAttachment,
  onFocus,
  onBlur,
  onChange,
  onSend,
  onStop,
  onVoice,
}: {
  value: string;
  focused: boolean;
  hasAction: boolean;
  busy: boolean;
  disabled: boolean;
  sendDisabled: boolean;
  placeholder: string;
  voiceStatus: VoiceStatus;
  voiceAnalyser?: AnalyserNode | null;
  voiceDisabled: boolean;
  attachments?: File[];
  attachmentsEnabled?: boolean;
  onAddFiles?: (files: File[]) => void;
  onRemoveAttachment?: (index: number) => void;
  onFocus: () => void;
  onBlur: () => void;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onVoice: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const openFilePicker = () => fileInputRef.current?.click();
  const onFilesPicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files ? Array.from(event.target.files) : [];
    if (picked.length > 0) onAddFiles?.(picked);
    // Reset so picking the same file again re-fires onChange.
    event.target.value = "";
  };
  const attachButton = (extra?: React.HTMLAttributes<HTMLButtonElement>) => (
    <button
      type="button"
      className="pockly-empty-composer-icon is-attach ui-button-ghost"
      aria-label={tx("workspace.addAttachment")}
      disabled={!attachmentsEnabled}
      onClick={openFilePicker}
      {...extra}
    >
      <PlusCircle size={15} aria-hidden="true" />
    </button>
  );
  // Voice input: TAPPING the mic arms "voice mode" — the composer collapses to
  // a single row and the textarea area becomes a waveform "hold to talk" bar.
  // You press-and-hold THAT bar to record, release to transcribe. heldRef
  // tracks an *intentional* hold so the race guard only stops auto-started
  // recordings the user already let go of.
  const [voiceMode, setVoiceMode] = useState(false);
  const heldRef = useRef(false);
  const beginVoiceHold = useCallback(() => {
    if (voiceDisabled) return;
    heldRef.current = true;
    // Haptic tick the moment the hold starts. Works on Android Chrome; iOS
    // Safari has no Web Vibration API, so this safely no-ops there.
    try { navigator.vibrate?.(20); } catch { /* unsupported */ }
    if (voiceStatus === "idle") onVoice();
  }, [voiceDisabled, voiceStatus, onVoice]);
  const endVoiceHold = useCallback(() => {
    if (!heldRef.current) return;
    heldRef.current = false;
    if (voiceStatus === "recording") onVoice(); // stop → transcribe
    setVoiceMode(false); // release leaves voice mode so the transcript shows
  }, [voiceStatus, onVoice]);
  // Fast tap on the bar: pointer released before getUserMedia resolved. When
  // recording finally starts with no active hold, stop it immediately.
  useEffect(() => {
    if (voiceStatus === "recording" && !heldRef.current) onVoice();
  }, [voiceStatus, onVoice]);
  // Leave voice mode if the composer becomes unusable (session changed, etc).
  useEffect(() => {
    if (voiceDisabled && voiceMode) setVoiceMode(false);
  }, [voiceDisabled, voiceMode]);
  const voicePressProps = {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* unsupported */ }
      beginVoiceHold();
    },
    onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => {
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* unsupported */ }
      endVoiceHold();
    },
    onPointerCancel: () => endVoiceHold(),
    // Keyboard fallback: Enter/Space toggles record (press once, again to stop).
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
        event.preventDefault();
        if (voiceStatus === "recording") { heldRef.current = false; onVoice(); }
        else { heldRef.current = true; onVoice(); }
      }
    },
  };
  // Mic icon button: tap to enter voice mode (or exit it / cancel a recording).
  const onMicTap = () => {
    if (voiceDisabled) return;
    if (voiceMode) {
      if (voiceStatus === "recording") { heldRef.current = false; onVoice(); }
      setVoiceMode(false);
    } else {
      setVoiceMode(true);
    }
  };
  const voiceHint = voiceStatus === "recording" ? tx("workspace.releaseToSend") : tx("workspace.holdToTalk");
  const micButton = (extra?: React.HTMLAttributes<HTMLButtonElement>) => (
    <button
      type="button"
      className="pockly-empty-composer-icon is-voice ui-button-ghost"
      aria-label={tx("workspace.voiceInput")}
      disabled={voiceDisabled}
      onClick={onMicTap}
      {...extra}
    >
      <Mic size={14} aria-hidden="true" />
    </button>
  );
  const actionButton = busy ? (
    <button type="button" className="pockly-empty-send-button ui-button-ghost" aria-label={tx("common.stop")} onMouseDown={(event) => event.preventDefault()} onClick={onStop}>
      <Square size={13} aria-hidden="true" />
    </button>
  ) : (
    <button type="button" className="pockly-empty-send-button ui-button-ghost" aria-label={tx("common.send")} disabled={sendDisabled} onMouseDown={(event) => event.preventDefault()} onClick={onSend}>
      <SendHorizontal size={14} aria-hidden="true" />
    </button>
  );
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    if (!focused) {
      node.style.height = "34px";
      return;
    }
    node.style.height = "auto";
    node.style.height = `${Math.min(Math.max(node.scrollHeight, 24), 132)}px`;
  }, [focused, value]);

  // Voice mode: single-row composer where the input area is a press-and-hold
  // "按住说话" waveform bar (idle CSS wave + centred hint; audio-reactive while
  // recording). The mic icon flips to a keyboard glyph to return to typing.
  if (voiceMode) {
    return (
      <div className="pockly-empty-prompt-dock is-voice-mode">
        <div className="pockly-empty-input-row">
          <button
            type="button"
            className="pockly-empty-composer-icon is-voice ui-button-ghost"
            aria-label={tx("workspace.exitVoice")}
            onClick={onMicTap}
          >
            <Keyboard size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`pockly-voice-bar${voiceStatus === "recording" ? " is-recording" : ""}`}
            aria-label={voiceHint}
            disabled={voiceDisabled}
            {...voicePressProps}
          >
            {voiceStatus === "recording" ? <VoiceWaveform analyser={voiceAnalyser} /> : null}
            <span className="pockly-voice-hint">
              {voiceStatus === "recording" ? null : <Mic size={13} aria-hidden="true" />}
              <span>{voiceHint}</span>
            </span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`${hasAction ? "pockly-empty-prompt-dock has-draft" : "pockly-empty-prompt-dock"} ${focused ? "is-focused" : ""}`}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={onFilesPicked}
      />
      <ComposerAttachmentChips files={attachments} onRemove={onRemoveAttachment} />
      <div className="pockly-empty-input-row">
        {!focused ? micButton() : null}
        <Textarea
          ref={textareaRef}
          disabled={disabled}
          value={value}
          placeholder={placeholder}
          aria-label={tx("workspace.promptComposer")}
          rows={1}
          onBlur={onBlur}
          onChange={(event) => onChange(event.target.value)}
          onFocus={onFocus}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter inserts a newline. Guard isComposing so
            // pressing Enter to pick an IME (e.g. pinyin) candidate never sends.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        {!focused ? (
          <span className="pockly-empty-action-cluster">
            {attachButton()}
            {actionButton}
          </span>
        ) : null}
      </div>
      {focused ? (
        <div className="pockly-empty-action-row">
          {micButton({ onMouseDown: (event) => event.preventDefault() })}
          <span className="pockly-empty-action-spacer" aria-hidden="true" />
          <span className="pockly-empty-action-cluster">
            {attachButton({ onMouseDown: (event) => event.preventDefault() })}
            {actionButton}
          </span>
        </div>
      ) : null}
    </div>
  );
}
// ClaudeCodePillsRow renders the three composer-pills the user sees
// above the prompt textarea when they're inside a claude-code session:
//
//   [ Model: sonnet ▾ ]  [ Effort: none ▾ ]  [ Permission: default ▾ ]
//
// The pills are read-write: clicking one opens a tiny popover, picking
// a value POSTs to /api/sessions/<sid>/agent-settings which Nexus
// forwards to the daemon. Model picks inject `/model <name>` into the
// live PTY; permission picks send Shift+Tab cycles. Effort now applies
// for real the same way: a pick POSTs agent-settings, the daemon sends
// /effort <level> to the live PTY (or forwards --effort on the next SDK
// spawn). onEffortChange just mirrors the choice into App.tsx pill state.
//
// Only mounted when the selected session's agent === "claude-code" so
// Codex / future agents don't render an unsupported control surface.
const AGENT_SETTINGS_RETRY_BASE_MS = 4000;
const AGENT_SETTINGS_RETRY_MAX_MS = 60000;
const AGENT_SETTINGS_MAX_AUTO_RETRIES = 5;
const SESSION_DIFF_RETRYABLE_ERROR_COOLDOWN_MS = 60000;

function isRetryableDaemonReadError(error: unknown): boolean {
  if (error instanceof AuthExpiredError) return false;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (error instanceof ApiError) {
    return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
  }
  const message = error instanceof Error ? error.message : String(error || "");
  return /failed to fetch|load failed|network|timeout|temporar|offline/i.test(message);
}

function daemonReadRetryDelayMs(attempt: number): number {
  const cappedAttempt = Math.max(0, Math.min(10, attempt));
  return Math.min(AGENT_SETTINGS_RETRY_MAX_MS, AGENT_SETTINGS_RETRY_BASE_MS * 2 ** cappedAttempt);
}

export function ClaudeCodePillsRow({
  sessionId,
  deviceId,
  agent,
  disabled,
  draftMode = false,
  draftCwd = "",
  draftModel = "",
  draftEffort = "none",
  draftPermissionMode = "default",
  onModelChange,
  onEffortChange,
  onPermissionModeChange,
  turns = [],
}: {
  sessionId: string;
  deviceId: string;
  agent: string;
  disabled: boolean;
  // turns powers the "Diffs · N" pill + diff drawer (files the agent changed).
  turns?: SessionTurn[];
  draftMode?: boolean;
  // draftCwd is the working directory the user picked for the new
  // conversation (empty for "directly chat / no project"). Forwarded
  // to the new /api/agent-defaults endpoint so the model pill picks
  // up project-config aliases from compatible providers instead of being
  // stuck on the hardcoded sonnet/opus/haiku alias list.
  draftCwd?: string;
  draftModel?: string;
  draftEffort?: string;
  draftPermissionMode?: string;
  onModelChange?: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onPermissionModeChange?: (permissionMode: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<AgentSettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Bumped to re-run the agent-settings fetch after a transient failure (e.g.
  // the daemon was momentarily offline / reconnecting / just reinstalled) so a
  // stale "daemon offline" error self-heals once it's back, instead of sticking
  // under the run-config pills forever.
  const [retryTick, setRetryTick] = useState(0);
  const agentSettingsRetryAttemptRef = useRef(0);
  const configWasOpenRef = useRef(false);
  const [busyField, setBusyField] = useState<"" | "model" | "effort" | "permission_mode">("");
  // The model/effort/permission settings live in one combined "Run config"
  // pill whose popover is a 3-column panel; this tracks its open state.
  const [configOpen, setConfigOpen] = useState(false);
  // Session diffs: show a cheap local hint from tool calls, then fetch the
  // daemon's live `git diff` only when the user opens the drawer. The live diff
  // endpoint depends on the daemon/control path, so prefetching it on every
  // session open creates avoidable background failures and request spend.
  const toolDiffs = useMemo(() => sessionDiffs(turns ?? []), [turns]);
  const [sheetDiffs, setSheetDiffs] = useState<SessionFileDiff[]>([]);
  const [diffsOpen, setDiffsOpen] = useState(false);
  const liveDiffLoadedKeyRef = useRef("");
  const diffFailureCooldownRef = useRef<{ key: string; retryAfterMs: number } | null>(null);
  useEffect(() => {
    if (draftMode || !sessionId || !deviceId) {
      setSheetDiffs([]);
      liveDiffLoadedKeyRef.current = "";
      return;
    }
    const diffKey = `${deviceId}:${sessionId}`;
    setSheetDiffs(toolDiffs);
    liveDiffLoadedKeyRef.current = "";
    diffFailureCooldownRef.current = diffFailureCooldownRef.current?.key === diffKey
      ? diffFailureCooldownRef.current
      : null;
  }, [sessionId, deviceId, draftMode, toolDiffs]);
  useEffect(() => {
    if (draftMode || !sessionId || !deviceId || !diffsOpen) {
      return;
    }
    const diffKey = `${deviceId}:${sessionId}`;
    if (liveDiffLoadedKeyRef.current === diffKey) {
      return;
    }
    const cooldown = diffFailureCooldownRef.current;
    if (cooldown && cooldown.key !== diffKey) {
      diffFailureCooldownRef.current = null;
    } else if (cooldown && Date.now() < cooldown.retryAfterMs) {
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      void getSessionDiff({ sessionId, deviceId, signal: ctrl.signal })
        .then((res) => {
          if (cancelled) return;
          liveDiffLoadedKeyRef.current = diffKey;
          if (diffFailureCooldownRef.current?.key === diffKey) {
            diffFailureCooldownRef.current = null;
          }
          const liveDiffs = res.status === "ok" ? parseUnifiedDiff(res.diff || "") : [];
          setSheetDiffs(liveDiffs.length > 0 ? liveDiffs : toolDiffs);
        })
        .catch((err: unknown) => {
          if (cancelled || ctrl.signal.aborted) return;
          // Keep the last known diff on a transient error (daemon momentarily
          // offline) — don't flicker the pill to empty or hammer a 503ing
          // daemon-backed endpoint on every render/turn update.
          diffFailureCooldownRef.current = {
            key: diffKey,
            retryAfterMs: isRetryableDaemonReadError(err)
              ? Date.now() + SESSION_DIFF_RETRYABLE_ERROR_COOLDOWN_MS
              : Number.POSITIVE_INFINITY,
          };
        });
    }, 500);
    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [sessionId, deviceId, draftMode, diffsOpen, toolDiffs]);

  // Draft and real sessions intentionally use separate effects. The draft
  // path depends on draftModel/draftPermissionMode/draftEffort, but the real
  // session path writes those parent composer values after GET succeeds. If a
  // single effect depends on both sets, opening a real session can self-trigger
  // a fetch loop that makes the pills flicker.
  useEffect(() => {
    if (!sessionId || !deviceId) return;
    if (!draftMode) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError("");
    // Seed with the bundled aliases so the pill is usable while
    // /api/agent-defaults is in flight (and as a fallback when the
    // daemon is an older build that doesn't expose the endpoint).
    // The fetch's success path replaces this with the cwd-aware list,
    // including project-config models from compatible providers.
    const fallbackModels = agent === "codex" ? [] : ["sonnet", "opus", "haiku"];
    const fallbackPermissionModes = agent === "codex" ? ["default", "acceptEdits", "auto", "bypassPermissions"] : ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];
    const fallbackEfforts = agent === "codex" ? ["none", "minimal", "low", "medium", "high", "xhigh"] : ["none", "low", "medium", "high", "xhigh", "max"];
    setSnapshot({
      current: {
        model: draftModel,
        resolved_model: resolveModelOptionTarget(draftModel, undefined),
        effort: draftEffort || "none",
        permission_mode: draftPermissionMode || "default",
      },
      available_models: fallbackModels,
      available_model_options: fallbackModelOptions(fallbackModels),
      available_permission_modes: fallbackPermissionModes,
      available_efforts: fallbackEfforts,
    });
    onEffortChange(draftEffort || "none");
    getAgentDefaults({ daemonDeviceId: deviceId, cwd: draftCwd, agent, signal: ctrl.signal })
      .then((defaults) => {
        setSnapshot({
          current: {
            // Show the user's explicit draft pick when set; otherwise
            // the daemon's effective default model (project/user
            // .claude.json) so the pill reads a concrete name instead
            // of a bare "default" before the conversation exists.
            model: draftModel || defaults.default_model || "",
            resolved_model: resolveModelOptionTarget(draftModel || defaults.default_model || "", defaults.available_model_options) || defaults.resolved_model || "",
            effort: draftEffort || "none",
            permission_mode: draftPermissionMode || "default",
          },
          available_models: defaults.available_models.length > 0 ? defaults.available_models : fallbackModels,
          available_model_options: normalizeModelOptions(defaults.available_model_options, defaults.available_models.length > 0 ? defaults.available_models : fallbackModels),
          available_permission_modes: defaults.available_permission_modes.length > 0 ? defaults.available_permission_modes : fallbackPermissionModes,
          available_efforts: defaults.available_efforts.length > 0 ? defaults.available_efforts : fallbackEfforts,
        });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        // Non-fatal: we already seeded the bundled aliases. Surface
        // the error in a way that doesn't block the user from
        // sending the first message.
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [
    sessionId,
    deviceId,
    draftMode,
    draftCwd,
    draftModel,
    draftEffort,
    draftPermissionMode,
    agent,
    onEffortChange,
  ]);

  // Fetch on mount / real-session switch. AbortController gates a stale
  // response from clobbering a newer session's snapshot.
  // Reset the composer-mirrored state + clear the pills ONLY when the
  // session/device identity changes — NOT on a background retry (retryTick).
  // Clearing snapshot + resetting model/effort on every retry made a transient
  // agent-settings blip (daemon momentarily unreachable through a flaky proxy)
  // nuke the already-loaded pills and flash "daemon offline" under them every
  // few seconds. Keeping the last-good snapshot across retries lets a
  // background failure self-heal silently.
  useEffect(() => {
    if (!sessionId || !deviceId || draftMode) return;
    setSnapshot(null);
    setError("");
    agentSettingsRetryAttemptRef.current = 0;
    // Reset effort/model/permission so sendPromptForSession never inherits a
    // stale choice from a prior session; draft-session start_task consumes
    // these before a real agent-settings row exists.
    onModelChange?.("");
    onPermissionModeChange?.("default");
    onEffortChange("none");
  }, [sessionId, deviceId, draftMode, onModelChange, onEffortChange, onPermissionModeChange]);

  useEffect(() => {
    const justOpened = configOpen && !configWasOpenRef.current;
    configWasOpenRef.current = configOpen;
    if (!justOpened || draftMode || !sessionId || !deviceId || loading || !error) return;
    agentSettingsRetryAttemptRef.current = 0;
    setRetryTick((t) => t + 1);
  }, [configOpen, draftMode, sessionId, deviceId, loading, error]);

  useEffect(() => {
    if (draftMode || !sessionId || !deviceId || !error) return;
    const handleVisible = () => {
      if (document.visibilityState !== "visible") return;
      agentSettingsRetryAttemptRef.current = 0;
      setRetryTick((t) => t + 1);
    };
    document.addEventListener("visibilitychange", handleVisible);
    return () => document.removeEventListener("visibilitychange", handleVisible);
  }, [draftMode, sessionId, deviceId, error]);

  useEffect(() => {
    if (!sessionId || !deviceId || draftMode) return;
    const ctrl = new AbortController();
    let retryTimer = 0;
    setLoading(true);
    getAgentSettings({ sessionId, deviceId, signal: ctrl.signal })
      .then((data) => {
        setSnapshot(data);
        setError("");
        agentSettingsRetryAttemptRef.current = 0;
        // Sync local model/effort/permission up to App.tsx so the send path
        // uses the remembered choice without waiting for the user to re-pick.
        onModelChange?.(data.current.model ?? "");
        onPermissionModeChange?.(data.current.permission_mode ?? "default");
        onEffortChange(data.current.effort ?? "none");
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        // Record the error and retry so a transient failure self-heals. The
        // error is RENDERED only when no snapshot is loaded yet (cold failure)
        // — see the composer-pills-error gate — so a background-refresh blip
        // after the pills loaded never flashes the alarm.
        setError(err instanceof Error ? err.message : String(err));
        if (isRetryableDaemonReadError(err) && agentSettingsRetryAttemptRef.current < AGENT_SETTINGS_MAX_AUTO_RETRIES && document.visibilityState !== "hidden") {
          const delayMs = daemonReadRetryDelayMs(agentSettingsRetryAttemptRef.current);
          agentSettingsRetryAttemptRef.current += 1;
          retryTimer = window.setTimeout(() => setRetryTick((t) => t + 1), delayMs);
        }
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => {
      ctrl.abort();
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [
    sessionId,
    deviceId,
    draftMode,
    retryTick,
    onModelChange,
    onEffortChange,
    onPermissionModeChange,
  ]);

  async function applyChange(field: "model" | "effort" | "permission_mode", value: string) {
    // Leave the Run config panel open after a selection so the user can set
    // model, effort and permission in one pass; an outside click dismisses it.
    if (!snapshot) return;
    if (draftMode) {
      const next: AgentSettingsSnapshot = {
        ...snapshot,
        current: {
          ...snapshot.current,
          ...(field === "model" ? { model: value, resolved_model: resolveModelOptionTarget(value, snapshot.available_model_options) } : {}),
          ...(field === "effort" ? { effort: value } : {}),
          ...(field === "permission_mode" ? { permission_mode: value } : {}),
        },
      };
      setSnapshot(next);
      if (field === "model") onModelChange?.(value);
      if (field === "effort") onEffortChange(value || "none");
      if (field === "permission_mode") onPermissionModeChange?.(value || "default");
      return;
    }
    setBusyField(field);
    setError("");
    try {
      const args: Parameters<typeof setAgentSettings>[0] = { sessionId, deviceId };
      if (field === "model") args.model = value;
      if (field === "permission_mode") args.permissionMode = value;
      if (field === "effort") args.effort = value;
      const next = await setAgentSettings(args);
      setSnapshot(next);
      if (field === "model") onModelChange?.(next.current.model ?? "");
      if (field === "effort") onEffortChange(next.current.effort ?? "none");
      if (field === "permission_mode") onPermissionModeChange?.(next.current.permission_mode ?? "default");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyField("");
    }
  }

  const current = snapshot?.current ?? {};
  const modelOptions = normalizeModelOptions(snapshot?.available_model_options, snapshot?.available_models ?? []);
  const modelLabel = modelPillLabel(current.model, current.resolved_model, modelOptions) || tx("pills.modelDefault");
  const effortLabel = effortLabelFor(current.effort);
  const permissionLabel = permissionLabelFor(current.permission_mode);
  const pillsDisabled = disabled || !snapshot;

  return (
    <div className="composer-pills-row" role="toolbar" aria-label={tx("pills.toolbarAria")}>
      <RunConfigPill
        modelLabel={modelLabel}
        effortLabel={effortLabel}
        permissionLabel={permissionLabel}
        loading={loading}
        disabled={pillsDisabled}
        busyField={busyField}
        open={configOpen}
        onOpenChange={setConfigOpen}
        modelOptions={modelOptions.map((m) => ({
          value: m.value,
          label: modelOptionLabel(m),
          active: m.value === current.model,
        }))}
        effortOptions={(snapshot?.available_efforts ?? ["none", "low", "medium", "high", "xhigh", "max"]).map((e) => ({
          value: e,
          label: effortLabelFor(e),
          active: e === (current.effort ?? "none"),
        }))}
        permissionOptions={(snapshot?.available_permission_modes ?? []).map((p) => ({
          value: p,
          label: permissionLabelFor(p),
          active: p === (current.permission_mode ?? "default"),
        }))}
        onSelect={(field, v) => applyChange(field, v)}
      />
      {sheetDiffs.length > 0 ? (
        <button
          type="button"
          className="composer-diff-pill"
          aria-label={tx("diffSheet.pillAria")}
          aria-expanded={diffsOpen}
          title={tx("diffSheet.pillAria")}
          onClick={() => setDiffsOpen(true)}
        >
          <span className="k">{tx("diffSheet.pill")}</span>
          <span className="composer-diff-badge">{sheetDiffs.length}</span>
        </button>
      ) : null}
      {/* Only surface the error on a COLD failure (no pills loaded yet). Once a
          snapshot has loaded, a transient background-refresh failure is kept
          silent (the retry self-heals) so "daemon offline" never flashes under
          the pills on a flaky connection. */}
      {error && !snapshot ? <div className="composer-pills-error" role="status">{error}</div> : null}
      {sheetDiffs.length > 0 ? (
        <SessionDiffSheet diffs={sheetDiffs} open={diffsOpen} onClose={() => setDiffsOpen(false)} />
      ) : null}
    </div>
  );
}

type ConfigOption = { value: string; label: string; active: boolean };

// RunConfigPill collapses model / effort / permission into ONE "Run config"
// pill — saving composer width for the Diffs pill. Clicking opens a 3-column
// panel (one column per setting); selecting an option applies it in place
// WITHOUT closing, so all three can be changed in one pass. Uses <details>
// for keyboard a11y; open state is controlled so outside clicks dismiss it.
function RunConfigPill({
  modelLabel,
  effortLabel,
  permissionLabel,
  modelOptions,
  effortOptions,
  permissionOptions,
  loading,
  disabled,
  busyField,
  open,
  onOpenChange,
  onSelect,
}: {
  modelLabel: string;
  effortLabel: string;
  permissionLabel: string;
  modelOptions: ConfigOption[];
  effortOptions: ConfigOption[];
  permissionOptions: ConfigOption[];
  loading: boolean;
  disabled: boolean;
  busyField: "" | "model" | "effort" | "permission_mode";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (field: "model" | "effort" | "permission_mode", value: string) => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<"left" | "right" | "fixed">("left");
  useEffect(() => {
    if (!open) return;
    const onOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (target instanceof Node && detailsRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("touchstart", onOutside, true);
    return () => {
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("touchstart", onOutside, true);
    };
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!open) {
      setMenuPlacement("left");
      return;
    }
    const updatePlacement = () => {
      const trigger = detailsRef.current?.querySelector(".composer-pill-trigger");
      const menu = menuRef.current;
      if (!(trigger instanceof HTMLElement) || !menu) return;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      if (viewportWidth <= 560) {
        setMenuPlacement("fixed");
        return;
      }
      const triggerRect = trigger.getBoundingClientRect();
      const menuWidth = menu.getBoundingClientRect().width || 420;
      setMenuPlacement(triggerRect.left + menuWidth > viewportWidth - 16 ? "right" : "left");
    };
    const frame = window.requestAnimationFrame(updatePlacement);
    window.addEventListener("resize", updatePlacement);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePlacement);
    };
  }, [open]);
  const columns: { key: "model" | "effort" | "permission_mode"; title: string; options: ConfigOption[] }[] = [
    { key: "model", title: tx("pills.modelLabel"), options: modelOptions },
    { key: "effort", title: tx("pills.effortLabel"), options: effortOptions },
    { key: "permission_mode", title: tx("pills.permissionLabel"), options: permissionOptions },
  ];
  return (
    <details
      ref={detailsRef}
      className={`composer-pill composer-pill-config${disabled ? " is-disabled" : ""}${loading ? " is-loading" : ""}`}
      open={open}
      onToggle={(event) => {
        if (disabled) {
          event.currentTarget.open = false;
          return;
        }
        onOpenChange(event.currentTarget.open);
      }}
    >
      <summary className="composer-pill-trigger">
        <span className="composer-pill-label">{tx("pills.runConfig")}</span>
        <span className="composer-pill-value">
          {modelLabel}<i aria-hidden="true" />{effortLabel}<i aria-hidden="true" />{permissionLabel}
        </span>
        <ChevronDown size={12} aria-hidden="true" />
      </summary>
      <div ref={menuRef} className={`composer-pill-menu composer-config-panel is-${menuPlacement}`} role="menu">
        {columns.map((col) => (
          <div className="composer-config-col" key={col.key}>
            <div className="composer-config-col-head">{col.title}</div>
            {col.options.length === 0 ? (
              <div className="composer-pill-empty">{tx("pills.noOptions")}</div>
            ) : (
              col.options.map((opt) => (
                <button
                  type="button"
                  key={opt.value}
                  role="menuitemradio"
                  aria-checked={opt.active}
                  className={opt.active ? "composer-pill-option is-active" : "composer-pill-option"}
                  disabled={busyField !== ""}
                  onClick={() => onSelect(col.key, opt.value)}
                >
                  <span>{opt.label}</span>
                  {opt.active ? <Check size={12} aria-hidden="true" /> : null}
                </button>
              ))
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function fallbackModelOptions(models: string[]): AgentModelOption[] {
  return models.map((model) => ({ value: model, label: model }));
}

export function normalizeModelOptions(options: AgentModelOption[] | undefined, fallbackModels: string[]): AgentModelOption[] {
  const seen = new Set<string>();
  const out: AgentModelOption[] = [];
  const add = (option: AgentModelOption) => {
    const value = option.value?.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    const normalized: AgentModelOption = {
      value,
      label: option.label?.trim() || value,
    };
    const resolved = option.resolved_model?.trim();
    if (resolved) normalized.resolved_model = resolved;
    const source = option.source?.trim();
    if (source) normalized.source = source;
    out.push(normalized);
  };
  (options ?? []).forEach(add);
  fallbackModelOptions(fallbackModels).forEach(add);
  return out;
}

function resolveModelOptionTarget(model: string | undefined, options: AgentModelOption[] | undefined): string {
  const value = model?.trim();
  if (!value) return "";
  const match = (options ?? []).find((option) => option.value === value || option.resolved_model === value);
  return match?.resolved_model?.trim() || value;
}

export function modelOptionLabel(option: AgentModelOption): string {
  const label = option.label?.trim() || option.value;
  const resolved = option.resolved_model?.trim();
  if (resolved && resolved !== option.value) {
    return `${label} -> ${resolved}`;
  }
  return label;
}

export function modelPillLabel(model: string | undefined, resolvedModel: string | undefined, options: AgentModelOption[]): string {
  const value = model?.trim();
  if (!value) return "";
  const option = options.find((candidate) => candidate.value === value);
  const resolved = resolvedModel?.trim() || option?.resolved_model?.trim();
  if (option && option.value === value) {
    const withResolved: AgentModelOption = { ...option };
    const nextResolved = resolved || option.resolved_model;
    if (nextResolved) {
      withResolved.resolved_model = nextResolved;
    }
    return modelOptionLabel(withResolved);
  }
  if (resolved && resolved !== value) {
    return `${value} -> ${resolved}`;
  }
  return value;
}

function effortLabelFor(effort: string | undefined) {
  switch (effort) {
    case "low":
      return tx("pills.effortLow");
    case "minimal":
      return tx("pills.effortMinimal");
    case "medium":
      return tx("pills.effortMedium");
    case "high":
      return tx("pills.effortHigh");
    case "xhigh":
      return tx("pills.effortXhigh");
    case "max":
      return tx("pills.effortMax");
    default:
      return tx("pills.effortNone");
  }
}

function permissionLabelFor(mode: string | undefined) {
  switch (mode) {
    // Codex approval presets (disjoint from Claude's vocabulary, so the token
    // itself selects the label — no agent flag needed).
    case "request-approval":
      return tx("pills.permCodexRequest");
    case "approve-for-me":
      return tx("pills.permCodexAuto");
    case "full-access":
      return tx("pills.permCodexFull");
    // Claude Code permission modes.
    case "acceptEdits":
      return tx("pills.permissionAcceptEdits");
    case "plan":
      return tx("pills.permissionPlan");
    case "auto":
    case "dontAsk":
      return tx("pills.permissionAuto");
    case "bypassPermissions":
      return tx("pills.permissionBypass");
    default:
      return tx("pills.permissionDefault");
  }
}

function RouteErrorPage({ title, body, onBack }: { title: string; body: string; onBack: () => void }) {
  // A bare .ws-empty direct child of .workspace; the workspace fills + centers
  // it (see the .workspace:has(> .ws-empty) rules) so no toolbar/card chrome.
  return (
    <WsEmpty
      icon={<AlertCircle size={24} aria-hidden="true" />}
      head={title}
      sub={body}
      footer={
        <button type="button" className="pockly-empty-inline-link" onClick={onBack}>
          {tx("workspace.backToWorkspace")} →
        </button>
      }
    />
  );
}

type DirBreadcrumb = { label: string; path: string };

function splitPathForBreadcrumb(path: string): DirBreadcrumb[] {
  if (!path) return [];
  const isWindows = /^[A-Za-z]:[\\/]/.test(path);
  if (isWindows) {
    const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
    const segments: DirBreadcrumb[] = [];
    if (parts.length === 0) return segments;
    segments.push({ label: parts[0], path: parts[0] + "\\" });
    for (let i = 1; i < parts.length; i += 1) {
      segments.push({ label: parts[i], path: parts.slice(0, i + 1).join("\\") });
    }
    return segments;
  }
  const parts = path.split("/").filter((p) => p.length > 0);
  const segments: DirBreadcrumb[] = [{ label: "/", path: "/" }];
  for (let i = 0; i < parts.length; i += 1) {
    segments.push({ label: parts[i], path: "/" + parts.slice(0, i + 1).join("/") });
  }
  return segments;
}

function joinDirPath(base: string, name: string): string {
  if (!base) return name;
  if (/^[A-Za-z]:[\\/]/.test(base)) {
    return base.replace(/[\\/]$/, "") + "\\" + name;
  }
  return base === "/" ? "/" + name : base.replace(/\/$/, "") + "/" + name;
}

// Remembers the last absolute directory a conversation was created in,
// so the new-conversation picker defaults there instead of $HOME on the
// next open. localStorage access is wrapped because it throws in some
// privacy modes / sandboxed iframes.
const LAST_NEW_CONV_DIR_KEY = "pockly.lastNewConvDir";
function readLastNewConvDir(): string {
  try {
    return window.localStorage.getItem(LAST_NEW_CONV_DIR_KEY) ?? "";
  } catch {
    return "";
  }
}
function writeLastNewConvDir(path: string) {
  try {
    if (path) window.localStorage.setItem(LAST_NEW_CONV_DIR_KEY, path);
  } catch {
    /* ignore */
  }
}

// newConvDirCandidates is the ordered, de-duplicated list of directories the
// new-conversation picker tries to open: the current conversation's workspace
// first, then the last dir a conversation was created in. Empty entries are
// dropped (the caller falls back to the daemon default afterwards).
export function newConvDirCandidates(initialCwd: string, remembered: string): string[] {
  return [...new Set([initialCwd, remembered].filter((d) => Boolean(d)))];
}

function NewConversationDrawer({
  devices,
  daemonDevice,
  agent,
  status,
  busy,
  initialCwd = "",
  onDaemon,
  onAgent,
  onSubmit,
  onCancel,
  onClose,
}: {
  devices: Device[];
  daemonDevice: string;
  agent: AgentKind;
  status: string;
  busy: boolean;
  // initialCwd seeds the directory picker — the cwd of the conversation the
  // user was viewing when they hit "new conversation", so a new session
  // defaults to the same workspace. Falls back to the remembered last dir.
  initialCwd?: string;
  onDaemon: (value: string) => void;
  onAgent: (value: AgentKind) => void;
  onSubmit: (cwd: string, agent: AgentKind) => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"with_cwd" | "no_cwd">("with_cwd");
  const [listing, setListing] = useState<ListDirResult | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const activeDaemon = daemonDevice || devices[0]?.device_id || "";

  useEffect(() => {
    if (!daemonDevice && devices[0]?.device_id) {
      onDaemon(devices[0].device_id);
    }
  }, [daemonDevice, devices, onDaemon]);

  // Returns true when the listing loaded, false on error/abort so the
  // initial-load effect can fall back from a stale remembered dir.
  const loadDir = useCallback(async (path: string): Promise<boolean> => {
    if (!activeDaemon) return false;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setListLoading(true);
    setListError("");
    setListing(null);
    try {
      const res = await listDaemonDirectory({ daemonDeviceId: activeDaemon, path, signal: ctrl.signal });
      if (ctrl.signal.aborted) return false;
      if (res.error) {
        setListError(res.error);
        setListing(null);
        return false;
      }
      setListing(res);
      return true;
    } catch (e) {
      if (!ctrl.signal.aborted) setListError(e instanceof Error ? e.message : "failed to load directory");
      return false;
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setListLoading(false);
      }
    }
  }, [activeDaemon]);

  // Initial load + reload when the daemon or mode changes. Default to the
  // current conversation's workspace (initialCwd) so "新对话" from inside a
  // project starts in that same project; then the last directory the user
  // created a conversation in (remembered in localStorage); then the daemon's
  // default ("" = $HOME). Each candidate that fails to load (deleted dir,
  // different machine) falls through to the next.
  useEffect(() => {
    if (mode !== "with_cwd" || !activeDaemon) return;
    let cancelled = false;
    void (async () => {
      const candidates = newConvDirCandidates(initialCwd, readLastNewConvDir());
      for (const dir of candidates) {
        const ok = await loadDir(dir);
        if (cancelled) return;
        if (ok) return;
      }
      await loadDir("");
    })();
    return () => {
      cancelled = true;
    };
  }, [activeDaemon, mode, loadDir, initialCwd]);

  // ESC to close.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      abortRef.current?.abort();
      document.body.style.overflow = previous;
    };
  }, []);

  const breadcrumb = listing?.path ? splitPathForBreadcrumb(listing.path) : [];
  const canSubmit =
    !busy &&
    !!activeDaemon &&
    (mode === "no_cwd" || !!listing?.path);
  const hasDaemon = Boolean(activeDaemon);

  return (
    <div className="new-task-layer" role="presentation">
      <button
        type="button"
        className="new-task-backdrop"
        aria-label={tx("common.cancel")}
        onClick={onClose}
      />
      <section
        className="new-task-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={tx("task.heading")}
      >
        <header className="new-task-header">
          <div className="new-task-header-copy">
            <span className="label">{tx("task.label")}</span>
            <h2>{tx("task.heading")}</h2>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label={tx("common.cancel")}>
            ✕
          </Button>
        </header>

        <div className="new-task-body">
          <div className="new-task-row">
            <label>
              <span>{tx("task.remoteDaemon")}</span>
              <Select value={activeDaemon} onChange={(event) => onDaemon(event.target.value)}>
                {devices.length === 0 ? <option value="">{tx("task.noConnectedDaemon")}</option> : null}
                {devices.map((device) => (
                  <option key={device.device_id} value={device.device_id}>{device.device_name || device.device_id}</option>
                ))}
              </Select>
            </label>
          </div>
          <div className="new-task-row">
            <label>
              <span>{tx("task.agent")}</span>
              <Select value={agent} onChange={(event) => onAgent(event.target.value as AgentKind)}>
                <option value="claude-code">Claude Code</option>
                <option value="codex">Codex</option>
              </Select>
            </label>
          </div>

          {hasDaemon ? (
            <div className="new-task-mode" role="radiogroup">
              <button
                type="button"
                role="radio"
                aria-checked={mode === "with_cwd"}
                className={`ui-button-ghost new-task-mode-card${mode === "with_cwd" ? " is-active" : ""}`}
                onClick={() => setMode("with_cwd")}
              >
                <strong>{tx("task.modeWithCwd")}</strong>
                <span>{tx("task.modeWithCwdHint")}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === "no_cwd"}
                className={`ui-button-ghost new-task-mode-card${mode === "no_cwd" ? " is-active" : ""}`}
                onClick={() => setMode("no_cwd")}
              >
                <strong>{tx("task.modeNoCwd")}</strong>
                <span>{tx("task.modeNoCwdHint")}</span>
              </button>
            </div>
          ) : (
            <div className="new-conversation-empty">
              <strong>{tx("task.noDaemonTitle")}</strong>
              <span>{tx("task.noDaemonBody")}</span>
            </div>
          )}

          {hasDaemon && mode === "with_cwd" ? (
            <div className="dir-picker">
              <div className="dir-breadcrumb" aria-label={tx("task.currentPath")}>
                {breadcrumb.length === 0 ? (
                  <span className="muted-copy">{tx("common.loading")}</span>
                ) : (
                  breadcrumb.map((segment, i) => {
                    // The POSIX root segment carries label "/" — it
                    // already reads as a separator, so we tag it
                    // .is-root and CSS suppresses the leading "/"
                    // the next sibling would otherwise prepend.
                    // Otherwise we'd render "/  /home  /tester" with
                    // visually doubled separators.
                    const isRoot = segment.label === "/" && i === 0;
                    const classes = ["dir-breadcrumb-btn"];
                    if (isRoot) classes.push("is-root");
                    if (i === breadcrumb.length - 1) classes.push("is-current");
                    return (
                      <button
                        key={`${segment.path}:${i}`}
                        type="button"
                        onClick={() => void loadDir(segment.path)}
                        className={classes.join(" ")}
                      >
                        {segment.label}
                      </button>
                    );
                  })
                )}
              </div>
              <ul className="dir-list">
                {listing?.parent ? (
                  <li>
                    <button
                      type="button"
                      className="dir-list-btn"
                      onClick={() => listing.parent && void loadDir(listing.parent)}
                    >
                      <Folder size={15} aria-hidden="true" />
                      <span>..</span>
                    </button>
                  </li>
                ) : null}
                {(listing?.entries ?? []).map((entry) => (
                  <li key={entry.name}>
                    {entry.is_dir ? (
                      <button
                        type="button"
                        className="dir-list-btn"
                        onClick={() => listing?.path && void loadDir(joinDirPath(listing.path, entry.name))}
                      >
                        <Folder size={15} aria-hidden="true" />
                        <span>{entry.name}</span>
                        {entry.is_git ? <small>git</small> : null}
                      </button>
                    ) : (
                      <span className="dir-file">
                        <span>{entry.name}</span>
                      </span>
                    )}
                  </li>
                ))}
                {listing && (listing.entries?.length ?? 0) === 0 && !listLoading ? (
                  <li className="dir-empty">{tx("task.emptyDirectory")}</li>
                ) : null}
              </ul>
              {listLoading ? <div className="dir-loading">{tx("common.loading")}</div> : null}
              {listing?.truncated ? <Notice>{tx("task.truncatedHint")}</Notice> : null}
              {listError ? <Notice>{listError}</Notice> : null}
            </div>
          ) : null}

          {status ? <Notice>{status}</Notice> : null}
        </div>

        <footer className="new-task-footer">
          {busy ? (
            <Button variant="destructive" onClick={onCancel}>
              {tx("common.stop")}
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              {tx("common.cancel")}
            </Button>
          )}
          <Button
            disabled={!canSubmit}
            onClick={() => {
              const cwd = mode === "with_cwd" ? (listing?.path ?? "") : "";
              // Remember an explicit project dir so the next "新对话"
              // defaults here instead of $HOME. "直接聊天" (no cwd) does
              // not overwrite the memory.
              if (cwd) writeLastNewConvDir(cwd);
              onSubmit(cwd, agent);
            }}
          >
            {tx("task.createConversation")}
          </Button>
        </footer>
      </section>
    </div>
  );
}

function LiveTerminalPage({
  devices,
  hosts,
  sessions,
  realtime,
  onBack,
}: {
  devices: Device[];
  hosts: HostSummary[];
  sessions: SessionListItem[];
  realtime: SessionSubscription | null;
  onBack: () => void;
}) {
  const cwdOptions = uniqueValues(sessions.map((session) => session.cwd).filter(Boolean));
  const continuationContext = useMemo(
    () => ({
      devicesById: new Map(devices.map((device) => [device.device_id, device])),
      hostsById: new Map(hosts.map((host) => [host.device_id, host])),
    }),
    [devices, hosts],
  );
  const projectOptions = groupSessions(sessions, continuationContext).slice(0, 8);
  const [daemonDeviceId, setDaemonDeviceId] = useState(devices[0]?.device_id ?? "");
  const [cwd, setCwd] = useState(cwdOptions[0] ?? "");
  const [selectedSessionId, setSelectedSessionId] = useState(projectOptions[0]?.sessionId ?? "");
  const [input, setInput] = useState("");
  const [terminalSession, setTerminalSession] = useState<TerminalSession | null>(null);
  const [events, setEvents] = useState<TerminalEvent[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const resumeAttemptedRef = useRef(false);

  useEffect(() => {
    if (!daemonDeviceId && devices[0]?.device_id) setDaemonDeviceId(devices[0].device_id);
  }, [daemonDeviceId, devices]);

  useEffect(() => {
    if (!cwd && cwdOptions[0]) setCwd(cwdOptions[0]);
  }, [cwd, cwdOptions]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  useEffect(() => () => streamAbortRef.current?.abort(), []);

  useEffect(() => {
    if (resumeAttemptedRef.current || terminalSession) return;
    resumeAttemptedRef.current = true;
    let cancelled = false;
    listTerminalSessions().then((result) => {
      if (cancelled) return;
      const resumable = (result.terminal_sessions ?? [])
        .filter((session) => session.session_status === "live" || session.session_status === "starting")
        .sort((a, b) => Date.parse(b.updated_at || b.created_at || "") - Date.parse(a.updated_at || a.created_at || ""))[0];
      if (!resumable) return;
      setDaemonDeviceId(resumable.daemon_device_id);
      setCwd(resumable.cwd);
      setSelectedSessionId(resumable.session_id ?? "");
      attachTerminalStream(resumable, "Reconnected to the latest live Claude terminal.", true);
    }).catch((error) => {
      if (!cancelled) setStatus(error instanceof Error ? error.message : "Failed to restore live terminal.");
    });
    return () => {
      cancelled = true;
    };
  }, [terminalSession]);

  function applyTerminalEvent(event: TerminalEvent) {
    setEvents((current) => [...current, event]);
    if (event.session_status || event.turn_status) {
      setTerminalSession((current) => current ? {
        ...current,
        session_status: event.session_status ?? current.session_status,
        turn_status: event.turn_status ?? current.turn_status,
        updated_at: event.timestamp ?? current.updated_at,
      } : current);
    }
    if (event.kind === "session_ready") setStatus("Claude is ready.");
    if (event.kind === "prompt_ready") setStatus("Prompt ready. You can send the next message.");
    if (event.kind === "session_exited") setStatus("Terminal exited.");
    if (event.kind === "agent_error") setStatus(event.error || event.payload || "Agent turn failed.");
    if (event.kind === "error" || (event.kind === "terminal_session" && event.session_status === "error")) setStatus(event.error || "Terminal error.");
  }

  function attachTerminalStream(session: TerminalSession, nextStatus: string, resetEvents: boolean) {
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    setTerminalSession(session);
    if (resetEvents) setEvents([]);
    setStatus(nextStatus);
    void streamTerminalSession({
      terminalSessionId: session.terminal_session_id,
      daemonDeviceId: session.daemon_device_id,
      realtime,
      signal: controller.signal,
      onEvent: applyTerminalEvent,
    }).catch((error) => {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : "Terminal stream failed.");
    }).finally(() => {
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
    });
  }

  async function startLiveTerminal() {
    if (!daemonDeviceId || !cwd.trim() || busy) return;
    setBusy(true);
    setStatus("Starting Claude terminal...");
    setEvents([]);
    setTerminalSession(null);
    try {
      const created = await createTerminalSession({
        daemonDeviceId,
        sessionId: selectedSessionId || undefined,
        agent: "claude-code",
        cwd: cwd.trim(),
        realtime,
      });
      attachTerminalStream(created.terminal_session, "Terminal connected. Waiting for Claude prompt...", true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to start terminal.");
    } finally {
      setBusy(false);
    }
  }

  async function sendInput() {
    const text = input.trim();
    if (!terminalSession || !text) return;
    setInput("");
    setStatus("Sent. Waiting for Claude output...");
    try {
      await sendTerminalInput(terminalSession.terminal_session_id, text, realtime, terminalSession.daemon_device_id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to send input.");
    }
  }

  async function openInTerminal() {
    if (!terminalSession || openingTerminal) return;
    setOpeningTerminal(true);
    setStatus("Opening Terminal.app...");
    try {
      await openTerminalSession(terminalSession.terminal_session_id, realtime, terminalSession.daemon_device_id);
      setStatus("Terminal.app is attaching to this live session.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to open Terminal.app.");
    } finally {
      setOpeningTerminal(false);
    }
  }

  async function stopLiveTerminal() {
    if (!terminalSession) return;
    try {
      await stopTerminalSession(terminalSession.terminal_session_id, realtime, terminalSession.daemon_device_id);
      setStatus("Stop requested. Waiting for terminal exit...");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to stop terminal.");
    }
  }

  const output = renderTerminalOutput(events);
  const selectedDevice = devices.find((device) => device.device_id === daemonDeviceId);
  const selectedHost = hosts.find((host) => host.device_id === daemonDeviceId);
  const isLive = terminalSession?.session_status === "live" || terminalSession?.session_status === "starting";

  return (
    <>
      <Toolbar
        eyebrow="Attached terminal"
        title="Live Claude terminal"
        actions={(
          <>
            <Button variant="ghost" onClick={onBack}>
              <ChevronLeft size={17} aria-hidden="true" />
              <span>Sessions</span>
            </Button>
            {isLive ? (
              <Button variant="secondary" disabled={openingTerminal} onClick={() => void openInTerminal()}>
                <Terminal size={16} aria-hidden="true" />
                <span>{openingTerminal ? "Opening..." : "Open in Terminal"}</span>
              </Button>
            ) : null}
            {isLive ? <Button variant="destructive" onClick={() => void stopLiveTerminal()}>Stop</Button> : null}
          </>
        )}
      />
      <div className="route-page live-terminal-page">
        <section className="route-card live-terminal-control">
          <div className="task-intro">
            <span className="task-intro-icon"><Terminal size={20} aria-hidden="true" /></span>
            <div>
              <span className="label">Milestone C prototype</span>
              <h2>Start Claude in a daemon-owned PTY</h2>
              <p>This mode sends input directly into Claude Code and streams PTY output back to this page.</p>
            </div>
          </div>
          <label>
            <span>Remote daemon</span>
            <Select value={daemonDeviceId} onChange={(event) => setDaemonDeviceId(event.target.value)} disabled={isLive}>
              {devices.length === 0 ? <option value="">No connected daemon</option> : null}
              {devices.map((device) => (
                <option key={device.device_id} value={device.device_id}>
                  {device.device_name || device.device_id}
                </option>
              ))}
            </Select>
          </label>
          {selectedDevice || selectedHost ? (
            <p className="muted-copy">
              Host: {selectedHost?.hostname || selectedDevice?.hostname || selectedDevice?.os || daemonDeviceId}
            </p>
          ) : null}
          {projectOptions.length > 0 ? (
            <div className="project-picker-strip" aria-label="Recent projects">
              {projectOptions.map((project) => (
                <button
                  type="button"
                  key={project.key}
                  className={selectedSessionId === project.sessionId && cwd === project.cwd && daemonDeviceId === project.deviceId ? "ui-button-ghost is-active" : "ui-button-ghost"}
                  disabled={isLive}
                  onClick={() => {
                    setDaemonDeviceId(project.deviceId);
                    setCwd(project.cwd);
                    setSelectedSessionId(project.sessionId ?? "");
                  }}
                >
                  <Folder size={15} aria-hidden="true" />
                  <span>{project.label}</span>
                  <small>{shortDeviceName(project.deviceId)}</small>
                </button>
              ))}
            </div>
          ) : null}
          <label>
            <span>Working directory</span>
            <Input list="live-cwd-options" value={cwd} disabled={isLive} onChange={(event) => {
              setCwd(event.target.value);
              setSelectedSessionId("");
            }} placeholder="/Users/you/project" />
          </label>
          <datalist id="live-cwd-options">
            {cwdOptions.map((item) => <option key={item} value={item} />)}
          </datalist>
          <Button disabled={busy || isLive || !daemonDeviceId || !cwd.trim()} onClick={() => void startLiveTerminal()}>
            Start live Claude
          </Button>
          {status ? <Notice>{status}</Notice> : null}
          {terminalSession ? (
            <dl className="detail-list live-terminal-meta">
              <div><dt>Terminal ID</dt><dd>{terminalSession.terminal_session_id}</dd></div>
              <div><dt>Session</dt><dd>{terminalSession.session_status}</dd></div>
              <div><dt>Turn</dt><dd>{terminalSession.turn_status}</dd></div>
            </dl>
          ) : null}
        </section>

        <section className="route-card live-terminal-stream">
          <div className="live-terminal-head">
            <span className="label">Claude output</span>
            <Badge>{events.length} events</Badge>
          </div>
          <pre ref={outputRef} className="live-terminal-output">{output || "Start a live terminal to see Claude output here."}</pre>
          <div className="live-terminal-composer">
            <Textarea
              value={input}
              rows={3}
              disabled={!terminalSession || terminalSession.session_status === "exited" || terminalSession.session_status === "error"}
              placeholder="Type a prompt for Claude..."
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void sendInput();
              }}
            />
            <Button disabled={!terminalSession || !input.trim()} onClick={() => void sendInput()}>
              <SendHorizontal size={16} aria-hidden="true" />
              Send
            </Button>
          </div>
          <p className="muted-copy">Use Cmd/Ctrl + Enter to send. This prototype streams PTY text, not a full terminal emulator yet.</p>
        </section>
      </div>
    </>
  );
}

function DuplexTestPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [hosts, setHosts] = useState<HostSummary[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [status, setStatus] = useState("Preparing duplex test page...");

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        setStatus("Signing in to local dev Nexus...");
        const devEmail = "dev@example.local";
        const devPassword = "correct horse battery staple";
        try {
          await registerAccount({ email: devEmail, name: "Dev User", password: devPassword });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "email_already_registered") throw error;
          await loginWithPassword(devEmail, devPassword);
        }
        if (cancelled) return;
        const browserState = await ensureBrowserDeviceState();
        const initialHosts = await listOnlineHosts(browserState.deviceId);
        const firstHost = initialHosts.hosts[0];
        if (firstHost && !firstHost.connected) {
          setStatus("Binding this browser to the local daemon...");
          const browserID = browserState.deviceId;
          const connected = await connectHost(firstHost.device_id, {
	            ...(browserID ? { browser_device_id: browserID } : {}),
	            browser_device_pubkey: browserState.devicePublicKey,
	            device_name: browserDeviceName(),
            user_agent: navigator.userAgent,
          });
          persistBrowserTokens({ browserDeviceId: connected.browser_device_id });
        }
        if (cancelled) return;
        setStatus("Loading local daemon and agent sessions...");
        const [deviceResult, hostResult, sessionResult] = await Promise.all([
          listDevices(),
          listOnlineHosts(loadBrowserDeviceState()?.deviceId),
          listSessions().catch(() => ({ sessions: [] as SessionListItem[] })),
        ]);
        if (cancelled) return;
        const daemonDevices = visibleComputerDevices(deviceResult.devices);
        const claudeSessions = sessionResult.sessions.filter((session) => session.agent === "claude-code");
        setDevices(daemonDevices);
        setHosts(hostResult.hosts);
        setSessions(claudeSessions);
        setStatus(daemonDevices.length ? "Ready. Click Start live Claude to test duplex sync." : "No connected daemon found. Start pockly-daemon and refresh this page.");
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "Failed to prepare duplex test page.");
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="duplex-test-shell">
      <MinimalLiveTerminalTest
        devices={devices}
        hosts={hosts}
        sessions={sessions.length ? sessions : fallbackDuplexSessions(devices)}
        bootStatus={status}
      />
    </main>
  );
}

function MinimalLiveTerminalTest({
  devices,
  hosts,
  sessions,
  bootStatus,
}: {
  devices: Device[];
  hosts: HostSummary[];
  sessions: SessionListItem[];
  bootStatus: string;
}) {
  const cwdOptions = uniqueValues(sessions.map((session) => session.cwd).filter(Boolean));
  const [daemonDeviceId, setDaemonDeviceId] = useState(devices[0]?.device_id ?? "");
  const [cwd, setCwd] = useState(cwdOptions[0] ?? "");
  const [input, setInput] = useState("");
  const [terminalSession, setTerminalSession] = useState<TerminalSession | null>(null);
  const [events, setEvents] = useState<TerminalEvent[]>([]);
  const [structuredBlocks, setStructuredBlocks] = useState<DaemonBlock[]>([]);
  const [structuredSessionId, setStructuredSessionId] = useState("");
  const [hiddenStructuredCount, setHiddenStructuredCount] = useState(0);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const structuredStreamAbortRef = useRef<AbortController | null>(null);
  const structuredSessionIdRef = useRef("");
  const outputRef = useRef<HTMLDivElement | null>(null);
  const devTerminalRef = useRef(false);

  useEffect(() => {
    if (!daemonDeviceId && devices[0]?.device_id) setDaemonDeviceId(devices[0].device_id);
  }, [daemonDeviceId, devices]);

  useEffect(() => {
    if (!cwd && cwdOptions[0]) setCwd(cwdOptions[0]);
  }, [cwd, cwdOptions]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: "smooth" });
  }, [events.length, structuredBlocks.length]);

  useEffect(() => () => {
    streamAbortRef.current?.abort();
    structuredStreamAbortRef.current?.abort();
  }, []);

  const attachStructuredBlocksStream = useCallback((sessionId: string) => {
    if (!sessionId || structuredSessionIdRef.current === sessionId) return;
    structuredStreamAbortRef.current?.abort();
    const controller = new AbortController();
    structuredStreamAbortRef.current = controller;
    structuredSessionIdRef.current = sessionId;
    setStructuredSessionId(sessionId);
    void getDaemonSessionBlocks(sessionId)
      .then((blocks) => {
        if (controller.signal.aborted) return;
        setStructuredBlocks(blocks.blocks ?? []);
        setHiddenStructuredCount(countHiddenStructuredBlocks(blocks.blocks ?? []));
      })
      .catch(() => {
        // The SSE stream below is the source of truth; this fetch is only fast initial paint.
      });
    void streamDaemonSessionBlocks({
      sessionId,
      signal: controller.signal,
      onEvent: (blocks) => {
        setStructuredSessionId(blocks.session_id);
        structuredSessionIdRef.current = blocks.session_id;
        setStructuredBlocks(blocks.blocks ?? []);
        setHiddenStructuredCount(countHiddenStructuredBlocks(blocks.blocks ?? []));
      },
    }).catch((error) => {
      if (!controller.signal.aborted) {
        structuredSessionIdRef.current = "";
        setStatus(error instanceof Error ? error.message : "Structured agent stream failed.");
      }
    }).finally(() => {
      if (structuredStreamAbortRef.current === controller) structuredStreamAbortRef.current = null;
    });
  }, []);

  useEffect(() => {
    if (!terminalSession || !cwd.trim()) return;
    let cancelled = false;
    async function discoverStructuredTranscript() {
      try {
        const projects = await listDaemonProjects();
        const latest = latestClaudeSessionForCwd(projects, cwd);
        if (!latest) return;
        if (cancelled) return;
        attachStructuredBlocksStream(latest.session_id);
      } catch {
        // The PTY stream remains the live fallback if JSONL indexing lags.
      }
    }
    void discoverStructuredTranscript();
    const timer = window.setInterval(() => void discoverStructuredTranscript(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [terminalSession, cwd, attachStructuredBlocksStream]);

  function attachTerminalStream(session: TerminalSession, nextStatus: string) {
    streamAbortRef.current?.abort();
    structuredStreamAbortRef.current?.abort();
    devTerminalRef.current = false;
    const controller = new AbortController();
    streamAbortRef.current = controller;
    setTerminalSession(session);
    setEvents([]);
    setStructuredBlocks([]);
    setStructuredSessionId("");
    structuredSessionIdRef.current = "";
    setHiddenStructuredCount(0);
    setStatus(nextStatus);
    void streamTerminalSession({
      terminalSessionId: session.terminal_session_id,
      daemonDeviceId: session.daemon_device_id,
      realtime: null,
      signal: controller.signal,
      onEvent: (event) => {
        setEvents((current) => [...current, event]);
        if (event.session_status || event.turn_status) {
          setTerminalSession((current) => current ? {
            ...current,
            session_status: event.session_status ?? current.session_status,
            turn_status: event.turn_status ?? current.turn_status,
            updated_at: event.timestamp ?? current.updated_at,
          } : current);
        }
        if (event.kind === "session_ready") setStatus("Claude ready");
        if (event.kind === "prompt_ready") setStatus("Ready for next message");
        if (event.kind === "session_exited") setStatus("Stopped");
        if (event.kind === "agent_error") setStatus(event.error || event.payload || "Agent turn failed");
        if (event.kind === "error") setStatus(event.error || "Terminal error");
      },
    }).catch((error) => {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : "Stream failed");
    }).finally(() => {
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
    });
  }

  function attachDevTerminalStream(session: TerminalSession, nextStatus: string) {
    streamAbortRef.current?.abort();
    structuredStreamAbortRef.current?.abort();
    devTerminalRef.current = true;
    const controller = new AbortController();
    streamAbortRef.current = controller;
    setTerminalSession(session);
    setEvents([]);
    setStructuredBlocks([]);
    setStructuredSessionId("");
    structuredSessionIdRef.current = "";
    setHiddenStructuredCount(0);
    setStatus(nextStatus);
    void streamDevTerminalSession({
      terminalSessionId: session.terminal_session_id,
      signal: controller.signal,
      onEvent: (event) => {
        setEvents((current) => [...current, event]);
        if (event.session_status || event.turn_status) {
          setTerminalSession((current) => current ? {
            ...current,
            session_status: event.session_status ?? current.session_status,
            turn_status: event.turn_status ?? current.turn_status,
            updated_at: event.timestamp ?? current.updated_at,
          } : current);
        }
        if (event.kind === "session_ready") setStatus("Transparent Claude ready");
        if (event.kind === "prompt_ready") setStatus("Ready for next message");
        if (event.kind === "session_exited") setStatus("Stopped");
        if (event.kind === "agent_error") setStatus(event.error || event.payload || "Agent turn failed");
        if (event.kind === "error") setStatus(event.error || "Terminal error");
      },
    }).catch((error) => {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : "Dev stream failed");
    }).finally(() => {
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
    });
  }

  async function startLiveTerminal() {
    if (!daemonDeviceId || !cwd.trim() || busy) return;
    setBusy(true);
    setStatus("Starting...");
    setEvents([]);
    setStructuredBlocks([]);
    setStructuredSessionId("");
    structuredSessionIdRef.current = "";
    setHiddenStructuredCount(0);
    setTerminalSession(null);
    try {
      const created = await createTerminalSession({
        daemonDeviceId,
        sessionId: sessions[0]?.session_id,
        agent: "claude-code",
        cwd: cwd.trim(),
        realtime: null,
      });
      attachTerminalStream(created.terminal_session, "Connected. Waiting for Claude...");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to start");
    } finally {
      setBusy(false);
    }
  }

  async function attachLatestTransparentTerminal() {
    setBusy(true);
    setStatus("Looking for transparent claude...");
    try {
      const result = await listDevTerminalSessions();
      const latest = [...(result.terminal_sessions ?? [])]
        .filter((session) => session.session_status === "live" || session.session_status === "starting")
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      if (!latest) throw new Error("No transparent claude session found. Open Terminal and run claude first.");
      attachDevTerminalStream({
        terminal_session_id: latest.id,
        daemon_device_id: "local-daemon",
        agent: "claude-code",
        cwd: cwd.trim(),
        session_status: latest.session_status,
        turn_status: latest.turn_status,
        created_at: latest.created_at,
        updated_at: latest.created_at,
      }, "Attached to transparent Claude.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to attach transparent claude");
    } finally {
      setBusy(false);
    }
  }

  async function sendInput() {
    const text = input.trim();
    if (!terminalSession || !text) return;
    setInput("");
    setStatus("Sent");
    try {
      if (devTerminalRef.current) {
        await sendDevTerminalInput(terminalSession.terminal_session_id, text);
      } else {
        await sendTerminalInput(terminalSession.terminal_session_id, text, null, terminalSession.daemon_device_id);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Send failed");
    }
  }

  async function stopLiveTerminal() {
    if (!terminalSession) return;
    try {
      await stopTerminalSession(terminalSession.terminal_session_id, null, terminalSession.daemon_device_id);
      setStatus("Stopping...");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Stop failed");
    }
  }

  const structuredChatMessages = renderStructuredDuplexMessages(structuredBlocks);
  const chatMessages = structuredChatMessages.length ? structuredChatMessages : renderDuplexChatMessages(events);
  const selectedDevice = devices.find((device) => device.device_id === daemonDeviceId);
  const selectedHost = hosts.find((host) => host.device_id === daemonDeviceId);
  const daemonLabel = selectedHost?.hostname || selectedDevice?.device_name || selectedDevice?.hostname || terminalSession?.daemon_device_id || daemonDeviceId || "No daemon";
  const canSend = Boolean(terminalSession && terminalSession.session_status !== "exited" && terminalSession.session_status !== "error");
  const isLive = terminalSession?.session_status === "live" || terminalSession?.session_status === "starting";

  return (
    <section className="minimal-duplex">
      <header className="minimal-duplex-header">
        <div>
          <h1>Claude Session Bridge</h1>
          <p>{status || bootStatus || "Ready"}</p>
          <small>{daemonLabel}</small>
        </div>
        <div className="minimal-duplex-actions">
          <Button variant="secondary" onClick={() => void startLiveTerminal()} disabled={busy || isLive || !daemonDeviceId || !cwd.trim()}>
            {busy ? "Starting..." : "Start"}
          </Button>
          <Button onClick={() => void attachLatestTransparentTerminal()} disabled={busy || isLive}>
            Attach claude
          </Button>
          <Button variant="secondary" onClick={() => window.location.reload()}>Reload</Button>
          {terminalSession ? <Button variant="destructive" onClick={() => void stopLiveTerminal()}>Stop</Button> : null}
        </div>
      </header>
      <label className="minimal-duplex-cwd">
        <span>cwd</span>
        <Input value={cwd} disabled={isLive} onChange={(event) => setCwd(event.target.value)} placeholder="/Users/dev/project" />
      </label>
      <TerminalMirror events={events} active={Boolean(terminalSession)} />
      <div ref={outputRef} className="minimal-duplex-chat">
        {structuredSessionId ? (
          <div className="duplex-transcript-source">
            <span>Structured agent session</span>
            <code>{structuredSessionId.slice(0, 8)}</code>
            {hiddenStructuredCount > 0 ? <small>已隐藏 {hiddenStructuredCount} 条工具/思考/附件记录</small> : null}
          </div>
        ) : null}
        {chatMessages.length ? chatMessages.map((message) => (
          <article key={message.id} className={`duplex-message duplex-message-${message.role}`}>
            <div className="duplex-message-meta">
              <span>{message.role === "user" ? "USER" : message.role === "assistant" ? "ASSISTANT" : "SYSTEM"}</span>
              {message.time ? <small>{message.time}</small> : null}
            </div>
            <div className="duplex-bubble">{message.text}</div>
          </article>
        )) : (
          <div className="duplex-empty">
            <strong>{terminalSession ? "已绑定 Claude 会话" : "等待绑定 Claude 会话"}</strong>
            <p>
              {terminalSession
                ? "现在可以在下面输入消息测试双向同步，Claude 的有效回复会显示成 ASSISTANT 气泡。"
                : <>在 Terminal 里运行 <code>claude</code>，然后点右上角 <b>Attach claude</b>。绑定后，这里会像普通问答会话一样显示 USER / ASSISTANT。</>}
            </p>
          </div>
        )}
      </div>
      <div className="minimal-duplex-composer">
        <Textarea
          value={input}
          rows={3}
          disabled={!canSend}
          placeholder={canSend ? "输入消息，Enter 发送，Shift+Enter 换行..." : "先绑定 Claude 会话..."}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void sendInput();
            }
          }}
        />
        <Button disabled={!canSend || !input.trim()} onClick={() => void sendInput()}>
          Send
        </Button>
      </div>
    </section>
  );
}

type DuplexChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  time: string;
};

function TerminalMirror({ events, active }: { events: TerminalEvent[]; active: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTermInstance | null>(null);
  const fitAddonRef = useRef<XTermFitAddon | null>(null);
  const writtenEventCountRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let cleanupResize: (() => void) | undefined;
    async function bootTerminal() {
      if (!containerRef.current || terminalRef.current) return;
      const [{ Terminal: BrowserTerminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled || !containerRef.current) return;
      const terminal = new BrowserTerminal({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: true,
        disableStdin: true,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 1.24,
        rows: 16,
        scrollback: 4000,
        theme: {
          background: "#050505",
          foreground: "#f7f7f2",
          cursor: "#f7f7f2",
          selectionBackground: "#3c3c3c",
          black: "#050505",
          red: "#ff6b6b",
          green: "#9be564",
          yellow: "#ffd166",
          blue: "#7db7ff",
          magenta: "#d6a3ff",
          cyan: "#6ee7f9",
          white: "#f7f7f2",
          brightBlack: "#7a7a74",
          brightRed: "#ff8f8f",
          brightGreen: "#b7f58a",
          brightYellow: "#ffe08a",
          brightBlue: "#9dccff",
          brightMagenta: "#e3bdff",
          brightCyan: "#9ff3ff",
          brightWhite: "#ffffff",
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      fitAddon.fit();
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      cleanupResize = observeTerminalResize(containerRef.current, () => fitAddon.fit());
      if (!active) {
        terminal.writeln("Attach Claude to mirror the raw PTY stream here.");
      }
    }
    void bootTerminal();
    return () => {
      cancelled = true;
      cleanupResize?.();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      writtenEventCountRef.current = 0;
    };
  }, [active]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (events.length < writtenEventCountRef.current) {
      terminal.reset();
      writtenEventCountRef.current = 0;
    }
    for (const event of events.slice(writtenEventCountRef.current)) {
      if (event.kind === "text_delta" && event.payload) {
        terminal.write(event.payload);
      } else if (event.kind === "user_input" && event.payload) {
        terminal.write(`\r\n> ${event.payload}\r\n`);
      } else if (event.kind === "agent_error") {
        terminal.write(`\r\n[agent error] ${event.error ?? event.payload ?? "agent turn failed"}\r\n`);
      } else if (event.kind === "error") {
        terminal.write(`\r\n[pockly error] ${event.error ?? event.payload ?? "terminal error"}\r\n`);
      } else if (event.kind === "session_exited") {
        terminal.write("\r\n[pockly] terminal exited\r\n");
      }
    }
    writtenEventCountRef.current = events.length;
  }, [events]);

  return (
    <section className="duplex-terminal-card" aria-label="Raw terminal mirror">
      <div className="duplex-terminal-head">
        <span>Terminal mirror</span>
        <small>xterm.js renders raw PTY ANSI</small>
      </div>
      <div ref={containerRef} className="duplex-xterm" />
    </section>
  );
}

function observeTerminalResize(element: HTMLElement, onResize: () => void) {
  if (typeof ResizeObserver === "undefined") {
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }
  const observer = new ResizeObserver(() => onResize());
  observer.observe(element);
  return () => observer.disconnect();
}

function renderStructuredDuplexMessages(blocks: DaemonBlock[]): DuplexChatMessage[] {
  const messages: DuplexChatMessage[] = [];
  for (const [index, block] of blocks.entries()) {
    const text = (block.text ?? "").trim();
    if (!text) continue;
    const time = block.timestamp ? shortTime(block.timestamp) : "";
    if (block.kind === "user_message") {
      messages.push({ id: `${block.uuid || index}-user`, role: "user", text, time });
      continue;
    }
    if (block.kind === "assistant_text") {
      const previous = messages[messages.length - 1];
      if (previous?.role === "assistant") {
        previous.text = [previous.text, text].filter(Boolean).join("\n\n");
        if (!previous.time && time) previous.time = time;
      } else {
        messages.push({ id: `${block.uuid || index}-assistant`, role: "assistant", text, time });
      }
    }
  }
  return messages;
}

function countHiddenStructuredBlocks(blocks: DaemonBlock[]) {
  return blocks.filter((block) => block.kind !== "user_message" && block.kind !== "assistant_text" && block.kind !== "meta").length;
}

function latestClaudeSessionForCwd(projects: Array<{ agent: string; cwd: string; sessions: Array<{ session_id: string; timestamp?: string }> }>, cwd: string) {
  const normalizedCwd = normalizeCwdHint(cwd);
  const candidates = projects
    .filter((project) => project.agent === "claude-code")
    .filter((project) => {
      const projectCwd = normalizeCwdHint(project.cwd);
      return projectCwd === normalizedCwd || projectCwd.endsWith(`/${normalizedCwd}`) || normalizedCwd.endsWith(`/${projectCwd}`);
    })
    .flatMap((project) => project.sessions.map((session) => ({ ...session, cwd: project.cwd })))
    .sort((a, b) => Date.parse(b.timestamp || "") - Date.parse(a.timestamp || ""));
  return candidates[0];
}

function normalizeCwdHint(value: string) {
  return value.trim().replace(/\/+$/g, "");
}

export function renderDuplexChatMessages(events: TerminalEvent[]): DuplexChatMessage[] {
  const messages: DuplexChatMessage[] = [];
  for (const [index, event] of events.entries()) {
    const time = event.timestamp ? shortTime(event.timestamp) : "";
    if (event.kind === "user_input") {
      const text = cleanTerminalLine(event.payload ?? "").trim();
      if (text) messages.push({ id: `${index}-user`, role: "user", text, time });
      continue;
    }
    if (event.kind === "message_added" && event.payload) {
      const parsed = parseStructuredTerminalMessage(event.payload);
      if (!parsed || parsed.role !== "assistant" || !parsed.text.trim()) continue;
      messages.push({ id: `${index}-assistant`, role: "assistant", text: parsed.text, time });
      continue;
    }
    if (event.kind === "text_delta") {
      // Avoid showing ANSI/TUI control streams in chat. The terminal
      // mirror may still use text_delta, ideally through xterm.js.
      continue;
    }
    if (event.kind === "agent_error") {
      messages.push({
        id: `${index}-agent-error`,
        role: "system",
        text: event.error ?? event.payload ?? "Agent turn failed",
        time,
      });
      continue;
    }
    if (event.kind === "error") {
      messages.push({
        id: `${index}-error`,
        role: "system",
        text: event.error ?? event.payload ?? "Terminal error",
        time,
      });
      continue;
    }
    if (event.kind === "session_exited") {
      messages.push({ id: `${index}-session-exited`, role: "system", text: "Agent session stopped.", time });
    }
    if (event.kind === "session_disconnected") {
      messages.push({
        id: `${index}-session-disconnected`,
        role: "system",
        text: event.error ? `Host disconnected: ${event.error}.` : "Host disconnected.",
        time,
      });
    }
  }
  return messages;
}

function parseStructuredTerminalMessage(payload: string): { role?: string; text: string } | null {
  try {
    const parsed = JSON.parse(payload) as { role?: unknown; text?: unknown };
    const message = { text: typeof parsed.text === "string" ? parsed.text : "" } as { role?: string; text: string };
    if (typeof parsed.role === "string") message.role = parsed.role;
    return message;
  } catch {
    return null;
  }
}

function fallbackDuplexSessions(devices: Device[]): SessionListItem[] {
  const daemon = devices[0];
  if (!daemon) return [];
  return [{
    device_id: daemon.device_id,
    session_id: "pockly-duplex-test",
    agent: "claude-code",
    cwd: "/Users/dev/projects/pockly-duplex-test",
    snippet: "Pockly duplex test",
    last_timestamp: new Date().toISOString(),
    last_seq: 0,
    turn_count: 0,
    sync_state: "ready",
  }];
}

function renderTerminalOutput(events: TerminalEvent[]) {
  return events.map((event) => {
    const time = event.timestamp ? shortTime(event.timestamp) : "";
    if (event.kind === "text_delta") return compactTerminalPayload(event.payload ?? "");
    if (event.kind === "user_input") return `\n\n> ${event.payload ?? ""}\n`;
    if (event.kind === "agent_error") return `\n[${time}] agent error: ${event.error ?? event.payload ?? "agent turn failed"}\n`;
    if (event.kind === "error") return `\n[${time}] error: ${event.error ?? event.payload ?? "terminal error"}\n`;
    if (event.kind === "terminal_session") return "";
    if (event.kind === "session_exited") return `\n[${time}] Terminal exited\n`;
    if (event.kind === "session_disconnected") return `\n[${time}] Host disconnected${event.error ? `: ${event.error}` : ""}\n`;
    return "";
  }).join("").replace(/\n{4,}/g, "\n\n\n").trimStart();
}

const terminalAnimationOnlyRE = /^[\s\d·.()[\]{}<>|/\\_\-+*=~:;,'"`!?↓↑←→●○◐◑◒◓◔◕◖◗✢✳✻✶✽✼✲✱✺✹✸✷✵✴✦✧*★☆]+$/;
const terminalStatusNoiseRE = /^(?:❯.*|esc to interrupt|esc ?to ?interrupt|\? ?for ?shortcuts.*|← ?for ?agents.*|⎿?\s*tip:.*|.*\/effort.*|.*tokens.*thought\s*for.*|.*tokens.*thoughtfor.*|\d+\s*tokens?\.?|[·\s\d]*(?:tokens?·)?thinking\)?|[·✢✳✻✶✽✼✲✱✺✹✸✷✵✴✦✧*★☆]\s*(?:[a-z]+-)?[a-z]+(?:\s+[a-z]+)*(?:\s+for\s+\d+s)?…?\.?|(?:baked|brewed|churned|evaporating|churning|roosting|saut[eé]ed|worked|transfiguring).*)$/i;
const terminalChromeRE = /ClaudeCodev|Tipsforgettingstarted|What'snew|APIUsageBilling|release-notes|Welcomeback/i;
const terminalOSCControlRE = new RegExp(String.raw`\u001b\][^\u0007]*(?:\u0007|\u001b\\)`, "g");
const terminalCSIControlRE = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");
const terminalC0ControlRE = new RegExp(String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]`, "g");

function compactTerminalPayload(payload: string) {
  const normalized = payload
    .replace(terminalOSCControlRE, "")
    .replace(terminalCSIControlRE, "")
    .replace(terminalC0ControlRE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\uFFFD/g, "");
  const assistantReplies = [...normalized.matchAll(/⏺\s*([^❯\n]+)/g)]
    .map((match) => cleanTerminalLine(match[1] ?? ""))
    .filter(Boolean);
  if (assistantReplies.length > 0) return assistantReplies.join("\n");
  if (terminalChromeRE.test(normalized)) return "";
  const lines: string[] = [];
  let blankCount = 0;
  for (const rawLine of normalized.split("\n")) {
    const line = cleanTerminalLine(rawLine);
    const trimmed = line.trim();
    if (!trimmed) {
      blankCount++;
      if (blankCount <= 1) lines.push("");
      continue;
    }
    blankCount = 0;
    if (trimmed.startsWith("> ")) continue;
    if (terminalAnimationOnlyRE.test(trimmed) || terminalStatusNoiseRE.test(trimmed.replace(/\s+/g, " "))) continue;
    lines.push(line.length > 1400 ? `${line.slice(0, 1400)} ...` : line);
  }
  return lines.join("\n");
}

function cleanTerminalLine(value: string) {
  return value
    .replace(/[╭╮╰╯│─━┃▐▌▛▜▝▘█]+/g, " ")
    .replace(/\(?\d+s?·thinking\)?/gi, " ")
    .replace(/↓?\s*\d+\s*tokens?·thinking\)?/gi, " ")
    .replace(/\d*ought for\s*\d+s\)?/gi, " ")
    .replace(/^\d+\s*tokens?\.?$/i, "")
    .replace(/[·✢✳✻✶✽✼✲✱✺✹✸✷✵✴✦✧*★☆]\s*(?:(?:[a-z]+-)?[a-z]+(?:\s+[a-z]+)*(?:\s+for\s+\d+s)?|baked|brewed|crunched|churned|roosting|evaporating|churning|saut[eé]ed|worked|transfiguring).*/i, "")
    .replace(/^⎿?\s*tip:.*/i, "")
    .replace(/\s+/g, " ")
    .replace(/[ \t]+$/g, "")
    .trimStart();
}

function isIgnoredTerminalHistoryEvent(bridge: LiveSessionBridge | undefined, event: TerminalEvent) {
  if (!bridge?.ignoreEventsBefore || !event.timestamp) return false;
  const eventTime = Date.parse(event.timestamp);
  return Number.isFinite(eventTime) && eventTime < bridge.ignoreEventsBefore;
}

function PairPage({
  hosts,
  onRefreshHosts,
  onOpenWorkspace,
}: {
  auth: AuthState;
  setupGrant: string;
  hosts: HostSummary[];
  pairStatus: string;
  onConnectHost: (hostDeviceID: string) => void;
  onRefreshHosts: () => void;
  onOpenCLIAuth: (deviceCode: string) => void;
  onOpenWorkspace: () => void;
}) {
  const [tab, setTab] = useState<"unix" | "windows">("unix");
  const connected = hosts.length > 0;
  // Local setup binds the daemon to the account on the computer (the installer
  // opens a browser to sign in — no phone pairing, no codes). Poll until it
  // shows up in `hosts`, then surface the open-workspace action.
  useEffect(() => {
    if (connected) return;
    const id = window.setInterval(() => onRefreshHosts(), 4000);
    return () => window.clearInterval(id);
  }, [connected, onRefreshHosts]);
  const install =
    tab === "unix"
      ? { label: "macOS / Linux", prompt: "$", command: configuredInstallUnixCommand() }
      : { label: "Windows PowerShell", prompt: "PS", command: configuredInstallWindowsCommand() };
  return (
    <div className="route-page connect-setup-page">
      <section className="connect-setup-card" aria-label={tx("connect.pageAria")}>
        <span className="connect-eyebrow">{tx("workspace.connectComputerMeta")}</span>
        <h1 className="connect-setup-title">{tx("connect.setupTitle")}</h1>
        <p className="connect-setup-intro">{tx("connect.setupIntro")}</p>
        <div className="connect-os-tabs" role="tablist" aria-label={tx("connect.installCommandsAria")}>
          <button type="button" role="tab" aria-selected={tab === "unix"} className={tab === "unix" ? "connect-os-tab is-active" : "connect-os-tab"} onClick={() => setTab("unix")}>macOS / Linux</button>
          <button type="button" role="tab" aria-selected={tab === "windows"} className={tab === "windows" ? "connect-os-tab is-active" : "connect-os-tab"} onClick={() => setTab("windows")}>Windows PowerShell</button>
        </div>
        <ol className="connect-steps">
          <li className="connect-step">
            <span className="connect-step-num">01</span>
            <div className="connect-step-main">
              <strong>{tx("connect.stepInstallTitle")}</strong>
              <InstallCommandCard label={install.label} prompt={install.prompt} command={install.command} />
            </div>
          </li>
          <li className="connect-step">
            <span className="connect-step-num">02</span>
            <div className="connect-step-main">
              <strong>{tx("connect.stepRunTitle")}</strong>
              <InstallCommandCard prompt="$" command="pockly-daemon setup" />
              <span className="connect-step-helper">{tx("connect.stepRunHelper")}</span>
            </div>
          </li>
          <li className="connect-step">
            <span className="connect-step-num">03</span>
            <div className="connect-step-main">
              <strong>{tx("connect.stepAutoTitle")}</strong>
              <span className="connect-step-helper">{tx("connect.stepAutoHelper")}</span>
            </div>
          </li>
        </ol>
        {connected ? (
          <div className="connect-connected">
            <CheckCircle2 size={18} aria-hidden="true" />
            <span>{tx("connect.statusConnectedTitle")}</span>
            <Button onClick={onOpenWorkspace}>{tx("connect.backToWorkspace")}</Button>
          </div>
        ) : (
          <span className="connect-waiting"><span className="spinner" />{tx("connect.waitingToConnect")}</span>
        )}
      </section>
    </div>
  );
}

function InstallCommandCard({
  label,
  prompt,
  command,
}: {
  label?: string;
  prompt: string;
  command: string;
}) {
  const [copied, setCopied] = useState(false);
  async function onCopy(target?: HTMLButtonElement) {
    if (target) {
      target.dataset.copied = "true";
      window.setTimeout(() => {
        delete target.dataset.copied;
      }, 1600);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
    try {
      await copyTextToClipboard(command);
    } catch {
      // Keep the immediate UI feedback; the command remains visible for manual selection.
    }
  }

  return (
    <div className="install-command-card">
      {label ? <span className="label">{label}</span> : null}
      <div className="terminal-command">
        <span>{prompt}</span>
        <code>{command}</code>
        <button
          type="button"
          className="install-command-copy"
          aria-label={label ? tx("connect.copyInstallCommand", { label }) : tx("common.copy")}
          onClick={(event) => void onCopy(event.currentTarget)}
        >
          {copied ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

function DevicesPage({
  devices,
  onBack,
  onAddDevice,
  onRevoke,
  onRename,
}: {
  devices: Device[];
  onBack: () => void;
  onAddDevice: () => void;
  onRevoke: (deviceID: string) => Promise<void>;
  onRename: (deviceID: string, deviceName: string) => Promise<void>;
}) {
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const daemonDevices = visibleComputerDevices(devices);

  function openDevice(device: Device) {
    setSelectedDevice(device);
    setRenameValue(device.device_name);
    setActionStatus("");
    setBusy(false);
    setConfirmRemove(false);
  }

  async function submitRename() {
    if (!selectedDevice) return;
    setBusy(true);
    setActionStatus("");
    try {
      await onRename(selectedDevice.device_id, renameValue);
      setSelectedDevice({ ...selectedDevice, device_name: renameValue.trim() });
      setActionStatus("Device name updated.");
    } catch (error) {
      setActionStatus(deviceActionError(error, "Rename failed."));
    } finally {
      setBusy(false);
    }
  }

  async function submitRemove() {
    if (!selectedDevice) return;
    setBusy(true);
    setActionStatus("");
    try {
      await onRevoke(selectedDevice.device_id);
      setSelectedDevice(null);
    } catch (error) {
      setActionStatus(deviceActionError(error, "Remove failed."));
      setBusy(false);
    }
  }

  return (
<div className="settings-mobile-page device-management-page">
      <header className="settings-nav">
        <button type="button" aria-label={tx("devices.backToSettings")} className="settings-back-button ui-button-ghost" onClick={onBack}>
          <ChevronLeft size={23} aria-hidden="true" />
        </button>
        <h1>{tx("settings.deviceManagement")}</h1>
        <button type="button" aria-label={tx("devices.addDevice")} className="settings-nav-action ui-button-ghost" onClick={onAddDevice}>
          <PlusCircle size={20} aria-hidden="true" />
        </button>
      </header>

      <div className="settings-scroll">
        <button type="button" className="settings-list-card add-device-card ui-button-ghost" onClick={onAddDevice}>
          <span className="add-device-icon" aria-hidden="true"><PlusCircle size={20} /></span>
          <span>
            <strong>{tx("devices.addNewDevice")}</strong>
            <small>{tx("devices.addNewDeviceBody")}</small>
          </span>
        </button>

        {daemonDevices.length > 0 ? (
          <DeviceManagementSection
            title={tx("devices.computers")}
            devices={daemonDevices}
            onOpen={openDevice}
          />
        ) : null}
      </div>

      {selectedDevice ? (
        <DeviceActionSheet
          device={selectedDevice}
          renameValue={renameValue}
          busy={busy}
          status={actionStatus}
          confirmRemove={confirmRemove}
          onRenameValue={setRenameValue}
          onClose={() => setSelectedDevice(null)}
          onRename={() => void submitRename()}
          onRequestRemove={() => setConfirmRemove(true)}
          onCancelRemove={() => setConfirmRemove(false)}
          onConfirmRemove={() => void submitRemove()}
        />
      ) : null}
    </div>
  );
}

function SettingsPage({
  auth,
  devices,
  selectedSession,
  selectedDeviceId,
  pushStatus,
  pushDetail,
  onEnablePush,
  onOpenDevices,
  onResetBrowserAccess,
  onBack,
  onLogout,
}: {
  auth: Extract<AuthState, { status: "authenticated" }>;
  devices: Device[];
  selectedSession: SessionListItem | null;
  selectedDeviceId: string;
  pushStatus: PushStatus;
  pushDetail: string;
  onEnablePush: () => void;
  onOpenDevices: () => void;
  onResetBrowserAccess: () => Promise<void>;
  onBack: () => void;
  onLogout: () => void;
}) {
  const [micStatus, setMicStatus] = useState("");
  const [micStatusKind, setMicStatusKind] = useState<MicStatusKind>("idle");
  const { mode, setMode } = useTheme();
  const currentBrowserID = loadBrowserDeviceState()?.deviceId ?? "";
  const daemonCount = visibleComputerDevices(devices).length;
  const release = window.POCKLY_CONFIG?.releaseSha || "dev";
  const environment = window.POCKLY_CONFIG?.environment || "local";
  const voiceValue = voiceSettingValue(micStatusKind);
  const currentLanguage = isSupportedLanguage(appI18n.language) ? appI18n.language : "en";
  const nextLanguage: SupportedLanguage = currentLanguage === "zh-CN" ? "en" : "zh-CN";
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [notifView, setNotifView] = useState(false);
  const [resetAccessOpen, setResetAccessOpen] = useState(false);
  const [resetAccessBusy, setResetAccessBusy] = useState(false);
  const [resetAccessStatus, setResetAccessStatus] = useState("");
  // Live snapshot of reader preferences; setReaderPreferences notifies
  // subscribers so timeline renderers update without a remount.
  const readerPrefs = useReaderPreferences();

  async function checkMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicStatusKind("blocked");
      setMicStatus(tx("settings.micUnsupported"));
      return;
    }
    setMicStatusKind("checking");
    setMicStatus(tx("settings.micRequesting"));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setMicStatusKind("ready");
      setMicStatus(tx("settings.micReady"));
    } catch (error) {
      const message = error instanceof Error ? error.message : tx("settings.permissionDenied");
      setMicStatusKind("blocked");
      setMicStatus(tx("settings.micUnavailable", { message }));
    }
  }

  async function switchLanguage() {
    await appI18n.changeLanguage(nextLanguage);
    setDocumentLanguage(nextLanguage);
  }

  if (notifView) {
    return (
      <NotificationsSettingsView
        pushStatus={pushStatus}
        pushDetail={pushDetail}
        onEnablePush={onEnablePush}
        onBack={() => setNotifView(false)}
      />
    );
  }

  return (
    <div className="settings-mobile-page">
      <header className="settings-nav">
        <button type="button" aria-label={tx("settings.back")} className="settings-back-button ui-button-ghost" onClick={onBack}>
          <ChevronLeft size={23} aria-hidden="true" />
        </button>
        <h1>{tx("settings.title")}</h1>
      </header>

      <div className="settings-scroll">
        <SettingsSection>
          <SettingsRow icon={<UserRound size={18} aria-hidden="true" />} label={tx("settings.profile")} value={auth.name || auth.email} detail={auth.email} />
          <SettingsRow
            icon={<KeyRound size={18} aria-hidden="true" />}
            label={tx("settings.browserAccess")}
            value={currentBrowserID ? tx("settings.browserAccessActive") : tx("settings.browserAccessNone")}
            onClick={() => {
              setResetAccessStatus("");
              setResetAccessOpen(true);
            }}
          />
          <SettingsRow icon={<MessageSquare size={18} aria-hidden="true" />} label={tx("settings.feedback")} onClick={() => setFeedbackOpen(true)} />
        </SettingsSection>

        {/* Reader preferences are persisted to localStorage and update open
            sessions without a remount via readerPrefsListeners. */}
        <SettingsSection title={tx("settings.reader")}>
          <SettingsToggleRow
            icon={<ChevronDown size={18} aria-hidden="true" />}
            label={tx("settings.readerAutoExpandTools")}
            detail={tx("settings.readerAutoExpandToolsDetail")}
            checked={readerPrefs.autoExpandTools}
            onChange={(next) => setReaderPreferences({ autoExpandTools: next })}
          />
          <SettingsToggleRow
            icon={<MessageSquare size={18} aria-hidden="true" />}
            label={tx("settings.readerShowThinking")}
            detail={tx("settings.readerShowThinkingDetail")}
            checked={readerPrefs.showThinking}
            onChange={(next) => setReaderPreferences({ showThinking: next })}
          />
          <SettingsToggleRow
            icon={<Terminal size={18} aria-hidden="true" />}
            label={tx("settings.readerShowRawParameters")}
            detail={tx("settings.readerShowRawParametersDetail")}
            checked={readerPrefs.showRawParameters}
            onChange={(next) => setReaderPreferences({ showRawParameters: next })}
          />
        </SettingsSection>

<SettingsSection title={tx("settings.general")}>
          <SettingsRow icon={<Volume2 size={18} aria-hidden="true" />} label={tx("settings.voice")} value={voiceValue} detail={micStatus} onClick={() => void checkMicrophone()} />
          <SettingsRow icon={<Palette size={18} aria-hidden="true" />} label={tx("settings.theme")} value={settingThemeLabel(mode)} onClick={() => setMode(nextThemeMode(mode))} />
          <SettingsRow icon={<span className="settings-row-glyph">文</span>} label={tx("settings.language")} value={currentLanguage === "zh-CN" ? tx("language.chineseSimplified") : tx("language.english")} onClick={() => void switchLanguage()} />
          <SettingsRow icon={<Laptop size={18} aria-hidden="true" />} label={tx("settings.deviceManagement")} value={tx("settings.deviceManagementValue", { count: daemonCount })} onClick={onOpenDevices} />
          <SettingsRow icon={<Bell size={18} aria-hidden="true" />} label={tx("settings.notifications")} value={settingPushLabel(pushStatus)} detail={pushDetail} onClick={() => setNotifView(true)} />
        </SettingsSection>

        <SettingsSection title={tx("settings.about")}>
          <SettingsRow icon={<Info size={18} aria-hidden="true" />} label={tx("settings.aboutPockly")} value={environment} />
          <SettingsRow icon={<RefreshCw size={18} aria-hidden="true" />} label={tx("settings.checkForUpdates")} value={shortRelease(release)} onClick={() => window.location.reload()} />
        </SettingsSection>

        <button type="button" className="settings-signout-button ui-button-ghost" onClick={onLogout}>
          <LogOut size={18} aria-hidden="true" />
          <span>{tx("settings.signOut")}</span>
        </button>

        <footer className="settings-footnote">
          <span>{tx("settings.model")}</span>
          <span>{tx("settings.release", { release: shortRelease(release) })}</span>
          <span>{tx("settings.environment", { environment })}</span>
        </footer>
      </div>
      <FeedbackDialog
        auth={auth}
        environment={environment}
        open={feedbackOpen}
        release={release}
        selectedDeviceId={selectedDeviceId}
        selectedSession={selectedSession}
        onOpenChange={setFeedbackOpen}
      />
      <ResetBrowserAccessDialog
        open={resetAccessOpen}
        busy={resetAccessBusy}
        status={resetAccessStatus}
        onOpenChange={(open) => {
          if (resetAccessBusy) return;
          setResetAccessOpen(open);
          if (!open) setResetAccessStatus("");
        }}
        onConfirm={async () => {
          setResetAccessBusy(true);
          setResetAccessStatus("");
          try {
            await onResetBrowserAccess();
            setResetAccessOpen(false);
          } catch (error) {
            setResetAccessStatus(error instanceof Error ? error.message : tx("settings.resetBrowserAccessFailed"));
          } finally {
            setResetAccessBusy(false);
          }
        }}
      />
    </div>
  );
}

// SessionDriftDialog shows when Nexus drift-aware inject handling
// rejects a Send because the wrapper has rebound to a different sid
// since the page loaded. Two outcomes:
//   - Confirm: navigate to actualSid AND refill the composer with
//     savedTextPreview. We deliberately don't auto-inject — the user
//     pressing Send again is the safety net that makes "your text is
//     in the box = your text is safe" the contract.
//   - Cancel: stay on the (now read-only) old session; the caller
//     restores composer text so cancellation also doesn't lose work.
// ConfirmDeleteSessionDialog gates the PERMANENT session delete: the daemon
// removes the local transcript file (claude jsonl / codex rollout), then the
// server drops its copy. There is no undo, so the modal spells that out and
// the destructive button is visually distinct.
function ConfirmDeleteSessionDialog({
  title,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="ws-modal">
        <DialogTitle asChild><h3>{tx("railMenu.deleteTitle")}</h3></DialogTitle>
        <DialogDescription asChild><p>{tx("railMenu.deleteBody", { title })}</p></DialogDescription>
        <p className="ws-modal-note">{tx("railMenu.deleteNote")}</p>
        {error ? <p className="ws-modal-error" role="alert">{error}</p> : null}
        <div className="ws-modal-actions">
          <button type="button" className="ws-modal-btn is-cancel" disabled={busy} onClick={onCancel}>{tx("common.cancel")}</button>
          <button type="button" className="ws-modal-btn is-danger" disabled={busy} onClick={onConfirm}>
            {busy ? tx("railMenu.deleting") : tx("railMenu.deleteConfirm")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SessionDriftDialog({
  actualSid,
  savedTextPreview,
  onConfirm,
  onCancel,
}: {
  actualSid: string;
  savedTextPreview: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const shortSid = actualSid.length > 12 ? `${actualSid.slice(0, 8)}…${actualSid.slice(-4)}` : actualSid;
  // Wrapping the textarea preview in <pre> keeps multiline prompts
  // legible without re-implementing line breaks. We slice at 400 chars
  // so the modal never grows past the viewport for very long prompts.
  const truncatedPreview = savedTextPreview.length > 400 ? `${savedTextPreview.slice(0, 400)}…` : savedTextPreview;
  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="ws-modal">
        <DialogTitle asChild><h3>{tx("drift.title")}</h3></DialogTitle>
        <DialogDescription asChild><p>{tx("drift.body", { sid: shortSid })}</p></DialogDescription>
        <p className="ws-modal-note">{tx("drift.savedPromptLabel")}</p>
        <pre className="ws-modal-preview">{truncatedPreview}</pre>
        <div className="ws-modal-actions">
          <button type="button" className="ws-modal-btn is-cancel" onClick={onCancel}>{tx("drift.cancel")}</button>
          <button type="button" className="ws-modal-btn is-primary" onClick={onConfirm}>{tx("drift.switch")}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FeedbackDialog({
  auth,
  environment,
  open,
  release,
  selectedSession,
  selectedDeviceId,
  onOpenChange,
}: {
  auth: Extract<AuthState, { status: "authenticated" }>;
  environment: string;
  open: boolean;
  release: string;
  selectedSession: SessionListItem | null;
  selectedDeviceId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [message, setMessage] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) return;
    setMessage("");
    setAttachment(null);
    setSubmitting(false);
    setStatus("");
    setError("");
  }, [open]);

  async function onSubmit() {
    const trimmed = message.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError("");
    setStatus("");
    try {
      await submitFeedback({
        message: trimmed,
        attachment,
        pagePath: window.location.pathname,
        appVersion: shortRelease(release),
        relayEnvironment: environment,
        browserName: browserDeviceName(),
        browserPlatform: navigator.platform || "",
        browserUserAgent: navigator.userAgent,
        ...(attachment ? { attachmentName: attachment.name } : {}),
        ...(selectedSession?.session_id ? { selectedSessionId: selectedSession.session_id } : {}),
        ...(selectedDeviceId || selectedSession?.device_id ? { selectedDeviceId: selectedDeviceId || selectedSession?.device_id || "" } : {}),
      });
      setStatus(tx("feedback.success"));
      setMessage("");
      setAttachment(null);
    } catch (submitError) {
      setError(feedbackErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ws-modal feedback-dialog">
        <DialogTitle asChild><h3>{tx("feedback.title")}</h3></DialogTitle>
        <DialogDescription asChild><p>{tx("feedback.description", { email: auth.email })}</p></DialogDescription>
        <label className="feedback-field">
          <span>{tx("feedback.problemLabel")}</span>
          <Textarea
            rows={6}
            maxLength={4000}
            value={message}
            placeholder={tx("feedback.problemPlaceholder")}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <label className="feedback-field">
          <span>{tx("feedback.attachmentLabel")}</span>
          <Input
            type="file"
            accept="image/*,.txt,.log,.md,.json"
            onChange={(event) => setAttachment(event.target.files?.[0] ?? null)}
          />
          <small>{attachment ? attachment.name : tx("feedback.attachmentHint")}</small>
        </label>
        <div className="feedback-meta-card">
          <strong>{tx("feedback.metaTitle")}</strong>
          <small>{tx("feedback.metaBody", { email: auth.email, environment, release: shortRelease(release) })}</small>
        </div>
        {error ? <p className="ws-modal-error">{error}</p> : null}
        {status ? <Notice>{status}</Notice> : null}
        <div className="ws-modal-actions">
          <button type="button" className="ws-modal-btn is-cancel" onClick={() => onOpenChange(false)}>{tx("common.cancel")}</button>
          <button type="button" className="ws-modal-btn is-primary" disabled={submitting || message.trim().length === 0} onClick={() => void onSubmit()}>
            {submitting ? tx("feedback.submitting") : tx("feedback.submit")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResetBrowserAccessDialog({
  open,
  busy,
  status,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  status: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ws-modal">
        <DialogTitle asChild><h3>{tx("settings.resetBrowserAccess")}</h3></DialogTitle>
        <DialogDescription asChild><p>{tx("settings.resetBrowserAccessBody")}</p></DialogDescription>
        {status ? <p className="ws-modal-error">{status}</p> : null}
        <div className="ws-modal-actions">
          <button type="button" className="ws-modal-btn is-cancel" disabled={busy} onClick={() => onOpenChange(false)}>{tx("common.cancel")}</button>
          <button type="button" className="ws-modal-btn is-danger" disabled={busy} onClick={onConfirm}>
            {busy ? tx("common.loading") : tx("settings.resetBrowserAccess")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Notifications sub-page with the push toggle, a status card reflecting the
// current push permission state, and a legend documenting the other permission
// states. Reached from the Settings -> Notifications row.
function NotificationsSettingsView({
  pushStatus,
  pushDetail,
  onEnablePush,
  onBack,
}: {
  pushStatus: PushStatus;
  pushDetail: string;
  onEnablePush: () => void;
  onBack: () => void;
}) {
  const info =
    pushStatus === "enabled"
      ? { variant: "is-ok", icon: <Check size={18} aria-hidden="true" />, titleKey: "settings.notifStateEnabledTitle", bodyKey: "settings.notifStateEnabledBody" }
      : pushStatus === "blocked"
        ? { variant: "is-danger", icon: <Lock size={18} aria-hidden="true" />, titleKey: "settings.notifStateBlockedTitle", bodyKey: "settings.notifStateBlockedBody" }
        : pushStatus === "unsupported"
          ? { variant: "is-muted", icon: <Bell size={18} aria-hidden="true" />, titleKey: "settings.notifStateUnsupportedTitle", bodyKey: "settings.notifStateUnsupportedBody" }
          : pushStatus === "checking"
            ? { variant: "", icon: <Bell size={18} aria-hidden="true" />, titleKey: "settings.notifStateCheckingTitle", bodyKey: "" }
            : { variant: "is-warn", icon: <Bell size={18} aria-hidden="true" />, titleKey: "settings.notifStateNotEnabledTitle", bodyKey: "settings.notifStateNotEnabledBody" };
  // Only surface a status card for states the toggle can't fix on its own
  // (blocked / unsupported). Enabled + not-enabled rely on the toggle alone;
  // no enabled card, no "other states" legend.
  const showProblem = pushStatus === "blocked" || pushStatus === "unsupported";
  return (
    <div className="settings-mobile-page">
      <header className="settings-nav">
        <button type="button" aria-label={tx("settings.back")} className="settings-back-button ui-button-ghost" onClick={onBack}>
          <ChevronLeft size={23} aria-hidden="true" />
        </button>
        <h1>{tx("settings.notifications")}</h1>
      </header>
      <div className="settings-scroll">
        <SettingsSection>
          <SettingsToggleRow
            icon={<Bell size={18} aria-hidden="true" />}
            label={tx("settings.notifPushLabel")}
            detail={tx("settings.notifPushDesc")}
            checked={pushStatus === "enabled"}
            onChange={() => onEnablePush()}
          />
        </SettingsSection>
        {showProblem ? (
          <div className={`notif-status ${info.variant}`}>
            <span className="ico">{info.icon}</span>
            <span className="txt">
              <strong>{tx(info.titleKey)}</strong>
              <span>{pushDetail || tx(info.bodyKey)}</span>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SettingsSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      {title ? <h2>{title}</h2> : null}
      <div className="settings-list-card">{children}</div>
    </section>
  );
}

function SettingsRow({
  icon,
  label,
  value,
  detail,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value?: string;
  detail?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="settings-row-icon" aria-hidden="true">{icon}</span>
      <span className="settings-row-main">
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
      {value ? <span className="settings-row-value">{value}</span> : null}
      <ChevronRight className="settings-row-chevron" size={19} aria-hidden="true" />
    </>
  );

  if (onClick) {
    return (
      <button type="button" className="settings-row ui-button-ghost" onClick={onClick}>
        {content}
      </button>
    );
  }

  return <div className="settings-row settings-row-static">{content}</div>;
}

// Toggle row for boolean preferences. Renders as a labeled row with a native
// checkbox aligned right using the existing settings-row chrome for visual
// consistency. Click anywhere on the row flips the state; checkbox handles
// keyboard accessibility.
function SettingsToggleRow({
  icon,
  label,
  detail,
  checked,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="settings-row settings-row-toggle">
      <span className="settings-row-icon" aria-hidden="true">{icon}</span>
      <span className="settings-row-main">
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
      {/* Input precedes switch so :focus-visible + .settings-toggle-switch
          works without :has(). Input is visually hidden via CSS. */}
      <input
        type="checkbox"
        className="settings-toggle-input"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className={`settings-toggle-switch${checked ? " is-on" : ""}`} aria-hidden="true">
        <span className="settings-toggle-knob" />
      </span>
    </label>
  );
}

function settingThemeLabel(mode: ThemeMode) {
  if (mode === "system") return tx("common.system");
  if (mode === "light") return tx("common.light");
  return tx("common.dark");
}

function nextThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === "system") return "light";
  if (mode === "light") return "dark";
  return "system";
}

function voiceSettingValue(status: MicStatusKind) {
  if (status === "ready") return tx("status.voice.ready");
  if (status === "checking") return tx("status.voice.checking");
  if (status === "blocked") return tx("status.voice.blocked");
  return tx("status.voice.check");
}

function shortRelease(release: string) {
  if (!release || release === "dev") return "dev";
  return release.length > 7 ? release.slice(0, 7) : release;
}

function settingPushLabel(status: PushStatus) {
  if (status === "enabled") return tx("status.push.enabled");
  if (status === "blocked") return tx("status.push.blocked");
  if (status === "checking") return tx("status.push.checking");
  return tx("status.push.notEnabled");
}

function deviceSummary(device: Device) {
  const parts = [
    device.status,
    device.device_type === "daemon" ? device.hostname || device.os : device.user_agent,
    device.app_version,
    shortTime(device.last_seen_at || device.first_paired_at || ""),
  ].filter(Boolean);
  return parts.join(" · ");
}

function deviceActionError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  switch (message) {
    case "invalid_device_name":
      return "Use a device name between 1 and 64 characters.";
    case "device_not_found":
      return "Device not found.";
    case "device_revoked":
      return "This device has already been removed.";
    default:
      return message || fallback;
  }
}

function DeviceManagementSection({
  title,
  devices,
  onOpen,
}: {
  title: string;
  devices: Device[];
  onOpen: (device: Device) => void;
}) {
  return (
    <SettingsSection title={title}>
      <>
        {devices.map((device) => (
          <DeviceManagementRow
            key={device.device_id}
            device={device}
            onOpen={() => onOpen(device)}
          />
        ))}
      </>
    </SettingsSection>
  );
}

function DeviceManagementRow({
  device,
  onOpen,
}: {
  device: Device;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="settings-row device-management-row ui-button-ghost" onClick={onOpen}>
      <span className="settings-row-icon" aria-hidden="true">
        <Laptop size={18} />
      </span>
      <span className="settings-row-main">
        <strong>{device.device_name}</strong>
        <small>{deviceSummary(device)}</small>
      </span>
      <span className={`device-status-pill device-${device.status}`}>{device.status}</span>
      <ChevronRight className="settings-row-chevron" size={19} aria-hidden="true" />
    </button>
  );
}

function DeviceActionSheet({
  device,
  renameValue,
  busy,
  status,
  confirmRemove,
  onRenameValue,
  onClose,
  onRename,
  onRequestRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  device: Device;
  renameValue: string;
  busy: boolean;
  status: string;
  confirmRemove: boolean;
  onRenameValue: (value: string) => void;
  onClose: () => void;
  onRename: () => void;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}) {
  const isRenameDisabled = busy || renameValue.trim() === "" || renameValue.trim() === device.device_name || [...renameValue.trim()].length > 64;
  return (
    <div className="device-action-layer" role="presentation">
      <button type="button" className="device-action-backdrop" aria-label={tx("devices.closeActions")} onClick={onClose} />
      <section className="device-action-sheet" role="dialog" aria-modal="true" aria-label={tx("devices.manageDevice", { name: device.device_name })}>
        <header>
          <span className="device-action-icon" aria-hidden="true">
            <Laptop size={20} />
          </span>
          <div>
            <strong>{device.device_name}</strong>
            <span>{deviceSummary(device)}</span>
          </div>
        </header>

        <label className="device-rename-field">
          <span>{tx("devices.deviceName")}</span>
          <Input
            value={renameValue}
            maxLength={64}
            disabled={busy}
            onChange={(event) => onRenameValue(event.target.value)}
          />
        </label>
        <Button disabled={isRenameDisabled} onClick={onRename}>
          <SquarePen size={16} aria-hidden="true" /> {tx("devices.renameDevice")}
        </Button>

        {confirmRemove ? (
          <div className="device-remove-confirm">
            <strong>{tx("devices.removeQuestion")}</strong>
            <span>{tx("devices.removeDeviceBody")}</span>
            <div className="device-action-row">
              <Button variant="ghost" disabled={busy} onClick={onCancelRemove}>{tx("common.cancel")}</Button>
              <Button variant="destructive" disabled={busy} onClick={onConfirmRemove}>
                {busy ? tx("devices.removing") : tx("devices.remove")}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="destructive" disabled={busy} onClick={onRequestRemove}>
            <Trash2 size={16} aria-hidden="true" /> {tx("devices.removeDevice")}
          </Button>
        )}

        {status ? <p className="device-action-status">{status}</p> : null}
      </section>
    </div>

  );
}

function Toolbar({ eyebrow, title, actions, deviceSelector }: { eyebrow?: string; title: string; actions?: ReactNode; deviceSelector?: ReactNode }) {
  return (
    <header className="toolbar">
      {deviceSelector ?? (
        <div>
          {eyebrow ? <span className="label">{eyebrow}</span> : null}
          <h1>{title}</h1>
        </div>
      )}
      <div className="toolbar-actions">{actions}</div>
    </header>
  );
}


// Reader-side user preferences. Three boolean toggles affect how the
// conversation timeline renders. Persisted to localStorage on write; surface
// lives in the workspace Settings page. Module-level singleton + listener set
// lets deep-tree renderers subscribe via a hook without prop-drilling.
//
// Defaults are conservative, so an existing user sees no change until they opt
// in to the new toggles.
//
//   autoExpandTools     — open every tool <details> by default. Off
//                         by default because the collapsed-summary
//                         pattern is what gives the long timeline its
//                         readability. Power users who want raw output
//                         visible inline can flip it.
//   showThinking        — show extended-thinking blocks (kind=
//                         "thinking") as persistent items in the
//                         transcript. Off by default to match the
//                         Codex / Claude desktop UX: thinking is an
//                         in-progress state surfaced live via the
//                         RunningIndicator, and once the assistant
//                         response arrives the prior thoughts roll
//                         out of view rather than piling up in the
//                         message list. Power users debugging an
//                         agent's reasoning can flip this on.
//   showRawParameters   — show the JSON dump of payload.input in the
//                         rows-and-raw fallback body. On by default
//                         On by default. Off keeps the structured rows + result
//                         output, drops only
//                         the input-dump <pre>.
export type ReaderPreferences = {
  autoExpandTools: boolean;
  showThinking: boolean;
  showRawParameters: boolean;
};

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  autoExpandTools: false,
  showThinking: false,
  showRawParameters: true,
};

const READER_PREFS_STORAGE_KEY = "pockly:prefs:reader:v1";

// Tolerant parser — partial blobs (missing keys) fall back to defaults
// key by key. Non-boolean values are treated as missing. Anything not
// a plain object short-circuits to the full default.
export function parseReaderPreferences(raw: unknown): ReaderPreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_READER_PREFERENCES;
  }
  const obj = raw as Record<string, unknown>;
  return {
    autoExpandTools: typeof obj.autoExpandTools === "boolean"
      ? obj.autoExpandTools
      : DEFAULT_READER_PREFERENCES.autoExpandTools,
    showThinking: typeof obj.showThinking === "boolean"
      ? obj.showThinking
      : DEFAULT_READER_PREFERENCES.showThinking,
    showRawParameters: typeof obj.showRawParameters === "boolean"
      ? obj.showRawParameters
      : DEFAULT_READER_PREFERENCES.showRawParameters,
  };
}

function loadReaderPreferences(): ReaderPreferences {
  if (typeof window === "undefined") return DEFAULT_READER_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(READER_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_READER_PREFERENCES;
    return parseReaderPreferences(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_READER_PREFERENCES;
  }
}

function persistReaderPreferences(prefs: ReaderPreferences) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(READER_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage may be full or disabled (private browsing). Prefs
    // are best-effort; silently drop the write.
  }
}

let currentReaderPrefs: ReaderPreferences = loadReaderPreferences();
const readerPrefsListeners = new Set<(p: ReaderPreferences) => void>();

export function getReaderPreferences(): ReaderPreferences {
  return currentReaderPrefs;
}

export function setReaderPreferences(patch: Partial<ReaderPreferences>) {
  const merged: ReaderPreferences = { ...currentReaderPrefs, ...patch };
  // Skip the work if nothing actually changed — avoids redundant
  // re-renders on the listener side.
  if (
    merged.autoExpandTools === currentReaderPrefs.autoExpandTools &&
    merged.showThinking === currentReaderPrefs.showThinking &&
    merged.showRawParameters === currentReaderPrefs.showRawParameters
  ) {
    return;
  }
  currentReaderPrefs = merged;
  persistReaderPreferences(merged);
  readerPrefsListeners.forEach((fn) => {
    try { fn(merged); } catch { /* listener errors don't block others */ }
  });
}

function useReaderPreferences(): ReaderPreferences {
  const [prefs, setPrefs] = useState<ReaderPreferences>(currentReaderPrefs);
  useEffect(() => {
    readerPrefsListeners.add(setPrefs);
    return () => { readerPrefsListeners.delete(setPrefs); };
  }, []);
  return prefs;
}

// Documented context windows per agent. Used as the denominator for the
// token-usage pie when the daemon doesn't surface an explicit max. Numbers are
// conservative defaults: if the user's actual model has more headroom, the pie
// stays green longer, which is safer than under-reporting.
//
//   claude-code → 200k  (Sonnet 4.x / Opus 4.x both report 200k)
//   codex       → 272k  (gpt-5-codex baseline per public docs)
//
// Unknown agents fall back to 200k so the pie still renders something
// rather than dividing by zero or hiding entirely.
const CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  "claude-code": 200_000,
  codex: 272_000,
};
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

export function contextWindowForAgent(agent: string | undefined | null): number {
  if (!agent) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  return CONTEXT_WINDOW_TOKENS[agent] ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export type SessionUsage = { used: number; total: number };

// Find the most-recent token usage record carried by any turn. The daemon
// attaches usage to the last block extracted from each assistant message,
// so the latest non-zero record reflects current prompt size. Returns
// null when no turn carries usage (legacy daemon or pure-user session).
//
// The agent argument selects the context-window denominator per
// CONTEXT_WINDOW_TOKENS. Callers from a session header already know the
// session's agent string and pass it through. Omitting the argument falls back
// to the Claude 200k default.
export function latestSessionUsage(
  turns: SessionTurn[],
  agent?: string | null,
): SessionUsage | null {
  const total = contextWindowForAgent(agent);
  for (let i = turns.length - 1; i >= 0; i--) {
    const p = turns[i].payload;
    if (!p) continue;
    const used = (p.input_tokens ?? 0)
      + (p.cache_creation_input_tokens ?? 0)
      + (p.cache_read_input_tokens ?? 0);
    if (used > 0) return { used, total };
  }
  return null;
}

// Bucket a 0..100 percentage into the visual escalation tier. Pure function so
// tests can assert thresholds without touching the DOM.
export type TokenUsageTier = "ok" | "warn" | "danger";
export function tokenUsageTier(pct: number): TokenUsageTier {
  if (pct >= 80) return "danger";
  if (pct >= 50) return "warn";
  return "ok";
}

// Circular progress chart for context-window usage. Renders nothing when
// usage is unknown (so legacy sessions don't show a stale 0%). Color
// shifts at 50% / 80% so the pill becomes visually louder as we approach the
// window limit. The localized tooltip and tier class stay on the wrapper so the
// percent text gets the matching color too.
// Exported for the renderer fixture (src/renderer-fixture.tsx) so
// e2e specs assert against the real pie — SVG arc, role/aria, tier class,
// localized tooltip — not a stripped-down copy. A fixture-side reimplementation
// would let SVG / a11y / i18n regressions slip past the spec.
export function TokenUsagePie({ usage }: { usage: SessionUsage }) {
  const rawPct = (usage.used / usage.total) * 100;
  const pct = Math.min(100, Math.max(0, rawPct));
  const tier = tokenUsageTier(pct);
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;
  const color = tier === "ok" ? "#2ea043" : tier === "warn" ? "#d4a93a" : "#d4424a";
  const tooltip = tx("workspace.tokenUsageTooltip", {
    used: usage.used.toLocaleString(),
    total: usage.total.toLocaleString(),
    pct: pct.toFixed(1),
  });
  return (
    <span
      className={`token-usage-pie token-usage-pie-${tier}`}
      role="img"
      aria-label={tooltip}
      title={tooltip}
    >
      <svg width="20" height="20" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r={radius} fill="none" stroke="var(--border)" strokeWidth="2.5" />
        <circle
          cx="11"
          cy="11"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 11 11)"
        />
      </svg>
      <span className="token-usage-pct">{Math.round(pct)}%</span>
    </span>
  );
}

// Session-level pending-permission summary. Scans all known turns for
// permission_request attachments still in "pending" state so the UI can surface
// a banner above the timeline. Pure function so tests assert shape without
// mounting React.
//
// We treat a permission_request as pending if it carries a request_id
// structured shape and either has no decision field or the
// field is the literal string "pending" — matches the inverse check
// the card itself does.
export type PendingPermissionSummary = {
  count: number;
  toolNames: string[]; // deduped, in first-encountered order
  latestRequestId: string; // anchor for "jump to latest"
};

export function summarizePendingPermissions(turns: SessionTurn[]): PendingPermissionSummary {
  let count = 0;
  let latestRequestId = "";
  let latestSeq = Number.NEGATIVE_INFINITY;
  const seenTools = new Set<string>();
  const orderedTools: string[] = [];
  for (const t of turns) {
    const p = t.payload;
    if (!p) continue;
    if (p.attachment_type !== "permission_request") continue;
    const requestId = p.permission_request_id;
    if (!requestId) continue;
    const decision = p.permission_decision ?? "pending";
    if (decision !== "pending") continue;
    count++;
    const name = p.permission_tool_name || "?";
    if (!seenTools.has(name)) {
      seenTools.add(name);
      orderedTools.push(name);
    }
    if (t.seq > latestSeq) {
      latestSeq = t.seq;
      latestRequestId = requestId;
    }
  }
  return { count, toolNames: orderedTools, latestRequestId };
}

export function pendingPermissionPayloads(turns: SessionTurn[]): ToolPayload[] {
  const seen = new Set<string>();
  const pending: ToolPayload[] = [];
  for (const t of turns) {
    const p = t.payload;
    if (!p || p.attachment_type !== "permission_request") continue;
    const requestId = p.permission_request_id;
    const decision = p.permission_decision ?? "pending";
    if (decision !== "pending" && decision !== "local_confirmation") continue;
    const key = requestId || `local:${p.permission_tool_name ?? "?"}:${p.permission_input_preview ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(p);
  }
  return pending;
}

// Permission requests are transient agent controls, not conversation content.
// Render them close to the composer and suppress immediately after a local
// decision so an approval never leaves behind an "Allowed..." history card.
export function PermissionRequestsPanel({ turns, realtime }: { turns: SessionTurn[]; realtime?: SessionSubscription | null }) {
  const [locallyResolved, setLocallyResolved] = useState<Set<string>>(() => new Set());
  const pending = useMemo(() => pendingPermissionPayloads(turns), [turns]);

  useEffect(() => {
    setLocallyResolved((current) => {
      if (current.size === 0) return current;
      const stillPending = new Set(pending.map((p) => p.permission_request_id).filter(Boolean) as string[]);
      let changed = false;
      const next = new Set<string>();
      for (const requestId of current) {
        if (stillPending.has(requestId)) {
          next.add(requestId);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [pending]);

  const visible = pending.filter((p) => {
    const requestId = p.permission_request_id ?? "";
    return (p.permission_decision === "local_confirmation" || requestId) && !locallyResolved.has(requestId);
  });
  if (visible.length === 0) return null;

  return (
    <div className="permission-panel" aria-live="polite">
      {visible.map((payload) => (
        <PermissionRequestCard
          key={payload.permission_request_id}
          payload={payload}
          realtime={realtime ?? null}
          onResolved={(requestId) => {
            setLocallyResolved((current) => {
              if (current.has(requestId)) return current;
              const next = new Set(current);
              next.add(requestId);
              return next;
            });
          }}
        />
      ))}
    </div>
  );
}

function AgentConversationHeader({
  session,
  routeSelection,
  turns,
  totalTurns,
  hydration,
  turnsStatus,
  syncProgress,
  injectBusy,
  derivedTitle,
  onOpenMenu,
  onOpenNewTask,
  onOpenMobileJoin,
  showMobileJoinAction,
}: {
  session: SessionListItem | null;
  routeSelection: ReaderSelection | null;
  turns: SessionTurn[];
  totalTurns: SessionTurn[];
  hydration: SessionTurnsResponse | null;
  turnsStatus: string;
  syncProgress: SyncSessionEvent | null;
  injectBusy: boolean;
  derivedTitle: string;
  onOpenMenu: () => void;
  onOpenNewTask: () => void;
  onOpenMobileJoin: () => void;
  showMobileJoinAction: boolean;
}) {
  // Mobile-only menu affordance: opens the rail drawer (the rail holds the
  // device picker + project/session nav, so it doubles as "back to the
  // list"). Hidden on desktop via the .agent-conversation-back CSS, where the
  // rail is always visible. The class name is a legacy positional hook
  // (absolute, left); only the icon + action changed from a back arrow.
  const menuButton = (
    <button
      type="button"
      className="agent-conversation-back"
      aria-label={tx("workspace.openMenu")}
      onClick={onOpenMenu}
    >
      {/* Match the list header hamburger (.ws-menu-btn renders Menu at 20). */}
      <Menu size={20} aria-hidden="true" />
    </button>
  );

  if (!session) {
    const title = routeSelection?.sessionId ? shortConversationID(routeSelection.sessionId) : tx("workspace.loadingConversation");
    return (
      <header className="agent-conversation-header">
        {menuButton}
        <div className="agent-conversation-main">
          <h2>{title}</h2>
          <div className="agent-conversation-meta" aria-label={tx("workspace.conversationSource")}>
            <span>{turnsStatus || tx("workspace.loadingConversation")}</span>
          </div>
        </div>
      </header>
    );
  }
  const title = sessionDisplayName(session, derivedTitle);
  const project = projectDisplayName(session);
  const loaded = hydration?.synced_turn_count ?? session.synced_turn_count ?? turns.length;
  const total = hydration?.total_turn_count ?? session.turn_count ?? session.last_seq ?? totalTurns.length;
  const statusLabel = injectBusy
    ? tx("workspace.streamingTapToStop")
    : turnsStatus === "syncing" && syncProgress?.stage
      ? syncStageLabel(syncProgress.stage)
      : sessionSyncLabel(session);
  const isLive = injectBusy || turnsStatus === "syncing";
  const usage = latestSessionUsage(totalTurns, session.agent);
  return (
    <header className={`agent-conversation-header${isLive ? " is-live" : ""}`}>
      {menuButton}
      <div className="agent-conversation-main">
        <h2>{title}</h2>
        <div className="agent-conversation-meta" aria-label={tx("workspace.conversationSource")}>
          {isLive ? <span className="agent-conversation-live">{tx("workspace.live")}</span> : null}
          <span>{agentLabel(session.agent).toLowerCase()}</span>
          <span>{project}</span>
          <span>{session.last_timestamp ? shortTime(session.last_timestamp) : shortDeviceName(session.device_id)}</span>
        </div>
      </div>
      <div className="agent-conversation-actions">
        {usage ? <TokenUsagePie usage={usage} /> : null}
        {injectBusy ? (
          <span className="agent-conversation-status is-streaming">{statusLabel}</span>
        ) : turnsStatus === "syncing" && syncProgress?.stage ? (
          <span className="agent-conversation-status is-syncing">{statusLabel}</span>
        ) : total > 0 && loaded >= total ? (
          <span className="agent-conversation-status is-synced" title={tx("workspace.loadedTurns", { loaded, total })}>
            <span className="status-dot" aria-hidden="true" />
            {tx("workspace.fullySynced")}
          </span>
        ) : total > 0 ? (
          <span className="agent-conversation-status">{tx("workspace.loadedTurns", { loaded, total })}</span>
        ) : (
          <span className="agent-conversation-status">{statusLabel}</span>
        )}
        {showMobileJoinAction ? (
          <button
            type="button"
            className="ws-icon-btn"
            aria-label={tx("mobileJoin.openQR")}
            title={tx("mobileJoin.openQR")}
            onClick={onOpenMobileJoin}
          >
            <Smartphone size={18} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="ws-icon-btn"
          aria-label={tx("workspace.newConversation")}
          title={tx("workspace.newConversation")}
          onClick={onOpenNewTask}
        >
          <SquarePen size={18} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

function ReaderPlaceholder() {
  return (
    <div className="reader-placeholder">
      <span />
      <span />
      <span />
    </div>
  );
}

function SyncProgressState({ event }: { event: SyncSessionEvent | null }) {
  const label = event ? syncStageLabel(event.stage) : tx("status.sync.preparing");
  const total = event?.total ?? 0;
  const processed = event?.processed ?? 0;
  const pct = total > 0 ? Math.max(4, Math.min(100, Math.round((processed / total) * 100))) : 18;
  return (
    <div className="sync-progress-state">
      <span className="label">{tx("status.sync.lazy")}</span>
      <strong>{label}</strong>
      <p>{event?.message || tx("status.sync.askingComputer")}</p>
      <div className="sync-progress-bar" aria-label={tx("workspace.session") + " " + tx("common.syncing")}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {total > 0 ? <small>{processed}/{total}</small> : <small>{tx("status.sync.waitingProgress")}</small>}
    </div>
  );
}

// Cycle through verb forms so the indicator doesn't feel frozen during
// a long inject. Each verb gets ~3 cycles before rotating.
const RUNNING_VERBS = ["Thinking", "Working", "Reasoning", "Searching", "Composing"];

// Animated "agent is busy" row that pins to the end of the turn list
// while an inject is in flight. Owns its own start timestamp + 1Hz tick
// so the SessionsPage tree doesn't have to thread elapsed time as a
// prop. When `running` flips false the start time resets so the next
// inject begins from 0.
function RunningIndicator({ running }: { running: boolean }) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (running) {
      setStartedAt((current) => current ?? Date.now());
      setNow(Date.now());
    } else {
      setStartedAt(null);
    }
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  if (!running || startedAt == null) return null;

  const elapsedSec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const verb = RUNNING_VERBS[Math.floor(elapsedSec / 9) % RUNNING_VERBS.length];
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  const elapsedLabel = mins > 0 ? `${mins}m ${secs.toString().padStart(2, "0")}s` : `${secs}s`;

  return (
    <div className="running-indicator" role="status" aria-live="polite">
      <span className="running-indicator-dot" aria-hidden="true" />
      <span className="running-indicator-label">{verb}…</span>
      <span className="running-indicator-elapsed">{elapsedLabel}</span>
    </div>
  );
}

// Exported for the renderer fixture. The fixture loops over a synthetic turn list and
// renders each through this article wrapper, exactly the same way
// the workspace does in SessionsPage.
export function TurnArticle({ turn }: { turn: SessionTurn }) {
  const prefs = useReaderPreferences();
  // showThinking=false hides the entire thinking article, both the body and the
  // kind-mark/time aside, so the transcript reads as assistant/user only. The
  // pref is at the article level so the aside doesn't leave an empty timestamp
  // band.
  if (turn.kind === "thinking" && !prefs.showThinking) return null;
  const role = kindLabel(turn.kind);
  return (
    <article className={`turn turn-${turn.kind}`}>
      <aside>
        <span className={`kind-mark kind-${turn.kind}`}>{role}</span>
        <time>{shortTime(turn.timestamp)}</time>
      </aside>
      <div className="turn-body">
        <TurnRenderer turn={turn} />
      </div>
    </article>
  );
}

function TurnRenderer({ turn }: { turn: SessionTurn }) {
  const payload = turn.payload ?? {};
  if (turn.kind === "assistant_text") {
    const scrubbed = stripInternalContent(payload.text ?? "");
    if (!scrubbed.trim()) return null;
    if (isCompactSummaryText(scrubbed)) return <CompactSummaryCard text={scrubbed} />;
    return <MarkdownBlock markdown={scrubbed} />;
  }
  if (turn.kind === "user_message") {
    const parsed = parseUserMessage(payload.text ?? "");
    if (parsed.kind === "slash") {
      return (
        <div className="slash-command-chip">
          <span className="slash-command-prefix" aria-hidden="true">/</span>
          <strong>{parsed.command}</strong>
          {parsed.args ? <span className="slash-command-args">{parsed.args}</span> : null}
          {parsed.output ? (
            <details>
              <summary>{tx("workspace.commandOutput")}</summary>
              <pre>{parsed.output}</pre>
            </details>
          ) : null}
        </div>
      );
    }
    if (parsed.kind === "system") {
      return <div className="system-line">{parsed.text}</div>;
    }
    if (parsed.kind === "compact") {
      return <CompactSummaryCard text={parsed.text} />;
    }
    if (!parsed.text.trim()) return null;
    return <div className="ws-mg-text is-user-bubble user-bubble">{parsed.text}</div>;
  }
  if (turn.kind === "thinking") {
    const text = stripInternalContent(payload.text ?? "");
    return (
      <details className="thinking-block">
        <summary>{tx("workspace.thinking")}</summary>
        <div className="thinking-body"><MarkdownBlock markdown={text} /></div>
      </details>
    );
  }
  if (turn.kind === "attachment") {
    return <AttachmentCard payload={payload} />;
  }
  if (turn.kind === "image") {
    return <ImageTurnCard payload={payload} />;
  }
  if (turn.kind === "meta") {
    return (
      <div className="tool-card meta-card">
        <ToolCardHeader icon="meta" name="Meta Record" state={payload.meta_type ?? "record"} />
        <details className="tool-raw">
          <summary>Details</summary>
          <pre>{payload.text ?? ""}</pre>
        </details>
      </div>
    );
  }
  if (turn.kind === "tool_call") {
    return <ToolCallCard payload={payload} />;
  }
  if (turn.kind === "tool_result") {
    return <ToolResultCard payload={payload} />;
  }
  if (turn.kind === "tool_group") {
    return <ToolGroupCard payload={payload} />;
  }
  if (payload.text) return <pre>{payload.text}</pre>;
  return <pre>{JSON.stringify(payload, null, 2)}</pre>;
}

// ============================================================
// MessageGroup pipeline.
//
// `groupTurnsForRender` walks visible turns and clusters consecutive
// same-author turns into one MessageGroup, with role+time shown once
// on top instead of one <aside> per turn. Inside a group,
// `segmentGroupBody` further folds consecutive narrative tool_call
// turns into a ToolNarrativeGroup ("Ran 2 commands, Read a file"),
// while special tools (AskUserQuestion / ExitPlanMode / permission
// request attachments) break narrative and render standalone.
//
// SessionsPage uses this grouped pipeline directly for the conversation view.
// ============================================================

export type RenderAuthor = "user" | "assistant";

export function turnAuthor(
  turn: SessionTurn,
  recordAuthor?: Map<string, RenderAuthor>,
): RenderAuthor {
  const kind = turn.kind;
  if (kind === "user_message") return "user";
  if (kind === "assistant_text" || kind === "thinking" ||
      kind === "tool_call" || kind === "tool_result" || kind === "tool_group") {
    return "assistant";
  }
  // attachment / image / meta — honor an explicit payload.role hint when
  // present; otherwise inherit the author of the jsonl record this block
  // belongs to. A user message is [image, text]: the image block carries no
  // role of its own, so without this it defaults to assistant-side and renders
  // split from (and above) the user's own text. It shares the record uuid with
  // the user_message block, so recordAuthor resolves it back to the user side.
  const payload = turn.payload as Record<string, unknown> | undefined;
  const role = payload?.role;
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  const uuid = typeof payload?.uuid === "string" ? payload.uuid : "";
  if (uuid && recordAuthor?.has(uuid)) return recordAuthor.get(uuid) as RenderAuthor;
  return "assistant";
}

export interface RenderGroup {
  author: RenderAuthor;
  role: string;
  when: string;
  turns: SessionTurn[];
  key: string;
}

export function groupTurnsForRender(turns: SessionTurn[]): RenderGroup[] {
  // Resolve a uuid → author hint from the unambiguous blocks first, so the
  // ambiguous ones (image / attachment) can inherit the side of their jsonl
  // record. A user_message pins its record to the user; any assistant block
  // pins it to the assistant. This is what lets a user's attached image render
  // on the user side alongside the text it was sent with.
  const recordAuthor = new Map<string, RenderAuthor>();
  for (const t of turns) {
    const uuid = typeof t.payload?.uuid === "string" ? t.payload.uuid : "";
    if (!uuid) continue;
    if (t.kind === "user_message") {
      recordAuthor.set(uuid, "user");
    } else if (
      t.kind === "assistant_text" || t.kind === "thinking" ||
      t.kind === "tool_call" || t.kind === "tool_result"
    ) {
      if (!recordAuthor.has(uuid)) recordAuthor.set(uuid, "assistant");
    }
  }
  const groups: RenderGroup[] = [];
  for (const t of turns) {
    const author = turnAuthor(t, recordAuthor);
    const last = groups[groups.length - 1];
    if (last && last.author === author) {
      last.turns.push(t);
      last.when = shortTime(t.timestamp);
    } else {
      groups.push({
        author,
        role: kindLabel(author === "user" ? "user_message" : "assistant_text"),
        when: shortTime(t.timestamp),
        turns: [t],
        key: `${t.device_id ?? ""}:${t.session_id}:${t.seq}`,
      });
    }
  }
  return groups;
}

// Tools that DO NOT fold into a narrative line (they render as
// standalone cards that break a run of "Ran X, Read Y").
const SPECIAL_TOOL_NAMES = new Set([
  "ExitPlanMode",
  "AskUserQuestion",
]);

export function isNarrativeTool(name: string | undefined): boolean {
  if (!name) return false;
  return !SPECIAL_TOOL_NAMES.has(name);
}

export interface NarrativeTool {
  name: string;
  running?: boolean;
  turn: SessionTurn;
}

function narrativeToolFailed(tool: NarrativeTool): boolean {
  const payload = tool.turn.payload ?? {};
  const paired = payload._paired_result;
  return Boolean(payload.is_error || (paired && typeof paired === "object" && (paired as ToolPayload).is_error));
}

export type GroupSegment =
  | { kind: "narrative"; tools: NarrativeTool[]; key: string }
  | { kind: "turn"; turn: SessionTurn; key: string };

export function segmentGroupBody(turns: SessionTurn[]): GroupSegment[] {
  const segments: GroupSegment[] = [];
  let bucket: NarrativeTool[] = [];
  const flushBucket = () => {
    if (bucket.length) {
      const first = bucket[0].turn;
      segments.push({
        kind: "narrative",
        tools: bucket,
        key: `narr:${first.device_id ?? ""}:${first.session_id}:${first.seq}`,
      });
      bucket = [];
    }
  };
  for (const t of turns) {
    if (t.kind === "tool_call") {
      const name = String(t.payload?.tool ?? "");
      if (isNarrativeTool(name)) {
        bucket.push({
          name,
          running: !t.payload?.has_result && !t.payload?._paired_result,
          turn: t,
        });
        continue;
      }
    }
    flushBucket();
    segments.push({
      kind: "turn",
      turn: t,
      key: `turn:${t.device_id ?? ""}:${t.session_id}:${t.seq}`,
    });
  }
  flushBucket();
  return segments;
}

// Verb tables — keep singular/plural unit pairs for each first-party
// tool. Falls back to "used X" for unknown tools. MCP tools are parsed
// into `<service>__<verb>_<noun>` and fall through to a verb-prefix
// table; service-only fallback is "called <service>".
const NARRATIVE_VERB_MAP: Record<string, { past: string; progressive: string; unit: string | [string, string] }> = {
  Bash:      { past: "Ran",       progressive: "Running",     unit: ["command", "commands"] },
  Read:      { past: "Read",      progressive: "Reading",     unit: ["file", "files"] },
  Edit:      { past: "Edited",    progressive: "Editing",     unit: ["file", "files"] },
  MultiEdit: { past: "Edited",    progressive: "Editing",     unit: ["file", "files"] },
  Write:     { past: "Created",   progressive: "Creating",    unit: ["file", "files"] },
  Grep:      { past: "Searched",  progressive: "Searching",   unit: "the codebase" },
  Glob:      { past: "Searched",  progressive: "Searching",   unit: ["files", "files"] },
  TodoWrite: { past: "Updated",   progressive: "Updating",    unit: "the task list" },
  Task:      { past: "Delegated", progressive: "Delegating",  unit: "to a subagent" },
  WebFetch:  { past: "Fetched",   progressive: "Fetching",    unit: ["webpage", "webpages"] },
  WebSearch: { past: "Searched",  progressive: "Searching",   unit: "the web" },
};

const MCP_VERB_MAP: Record<string, [string, string]> = {
  create: ["Created", "Creating"],
  add:    ["Added",   "Adding"],
  list:   ["Listed",  "Listing"],
  get:    ["Fetched", "Fetching"],
  fetch:  ["Fetched", "Fetching"],
  read:   ["Read",    "Reading"],
  search: ["Searched","Searching"],
  query:  ["Queried", "Querying"],
  update: ["Updated", "Updating"],
  delete: ["Deleted", "Deleting"],
  remove: ["Removed", "Removing"],
  send:   ["Sent",    "Sending"],
  run:    ["Ran",     "Running"],
  write:  ["Wrote",   "Writing"],
  edit:   ["Edited",  "Editing"],
};

function parseMcpName(name: string): { service: string; serviceName: string; verbForms: [string, string] | null; noun: string } | null {
  const m = name && name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (!m) return null;
  const service = m[1];
  const verbId = m[2];
  const parts = verbId.split(/[_-]|(?=[A-Z])/).filter(Boolean);
  const firstWord = (parts[0] || "").toLowerCase();
  const verbForms = MCP_VERB_MAP[firstWord] || null;
  const noun = parts.slice(1).map((w) => w.toLowerCase()).join(" ");
  const serviceName = service.charAt(0).toUpperCase() + service.slice(1);
  return { service, serviceName, verbForms, noun };
}

export function narrativePhrase(tools: NarrativeTool[]): string {
  // Group consecutive same-name tools into one segment with a count.
  const segs: { name: string; count: number; running: boolean; failed: number }[] = [];
  for (const t of tools) {
    const failed = narrativeToolFailed(t) ? 1 : 0;
    const last = segs[segs.length - 1];
    if (last && last.name === t.name) {
      last.count += 1;
      if (t.running) last.running = true;
      last.failed += failed;
    } else {
      segs.push({ name: t.name, count: 1, running: !!t.running, failed });
    }
  }
  const parts = segs.map((seg) => {
    const v = NARRATIVE_VERB_MAP[seg.name];
    if (v) {
      if (!seg.running && seg.failed === seg.count && Array.isArray(v.unit)) {
        const [, plural] = v.unit;
        const noun = seg.count === 1 ? v.unit[0] : plural;
        return `${seg.count === 1 ? "a" : seg.count} ${noun} failed`;
      }
      if (!seg.running && seg.failed > 0 && Array.isArray(v.unit)) {
        const [, plural] = v.unit;
        return `${seg.failed} of ${seg.count} ${plural} failed`;
      }
      const verb = (seg.running ? v.progressive : v.past).toLowerCase();
      if (typeof v.unit === "string") return `${verb} ${v.unit}`;
      const [singular, plural] = v.unit;
      const noun = seg.count === 1 ? singular : plural;
      if (seg.count === 1 && singular === plural) return `${verb} ${noun}`;
      const qty = seg.count === 1 ? "a" : String(seg.count);
      return `${verb} ${qty} ${noun}`;
    }
    const mcp = parseMcpName(seg.name);
    if (mcp) {
      if (mcp.verbForms && mcp.noun) {
        const verb = (seg.running ? mcp.verbForms[1] : mcp.verbForms[0]).toLowerCase();
        const noun = mcp.noun.replace(/s$/, "");
        const pluralNoun = noun + (noun.endsWith("s") ? "" : "s");
        const qty = seg.count === 1 ? "a" : String(seg.count);
        return seg.count === 1
          ? `${verb} ${qty} ${mcp.serviceName} ${noun}`
          : `${verb} ${qty} ${mcp.serviceName} ${pluralNoun}`;
      }
      const callVerb = seg.running ? "calling" : "called";
      return seg.count === 1
        ? `${callVerb} ${mcp.serviceName}`
        : `${callVerb} ${mcp.serviceName} ${seg.count} times`;
    }
    const usedVerb = seg.running ? "using" : "used";
    return seg.count === 1 ? `${usedVerb} ${seg.name}` : `${usedVerb} ${seg.name} ${seg.count} times`;
  });
  const phrase = parts.join(", ");
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

function NarrativeChevron() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6"/>
    </svg>
  );
}

export function ToolNarrativeGroup({ tools }: { tools: NarrativeTool[] }) {
  const prefs = useReaderPreferences();
  const [open, setOpen] = useState(!!prefs.autoExpandTools);
  // Settings page contract: when the user toggles autoExpandTools, every
  // narrative pill in the open session should snap to the new value to stay
  // consistent with <details open={prefs.autoExpandTools}> on individual cards.
  useEffect(() => {
    setOpen(!!prefs.autoExpandTools);
  }, [prefs.autoExpandTools]);
  if (!tools.length) return null;
  const anyRunning = tools.some((t) => t.running);
  const phrase = narrativePhrase(tools);
  return (
    <div className={`ws-narr ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="ws-narr-row"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="ws-narr-text">{phrase}</span>
        <span className="ws-narr-chev"><NarrativeChevron /></span>
        {anyRunning ? <span className="ws-narr-pulse" aria-hidden="true" /> : null}
      </button>
      <div className="ws-narr-body-wrap" aria-hidden={!open}>
        <div className="ws-narr-body">
          {tools.map((t) => (
            <TurnRenderer key={`${t.turn.session_id}:${t.turn.seq}`} turn={t.turn} />
          ))}
        </div>
      </div>
    </div>
  );
}

// MessageGroupArticle — renders one cluster of consecutive same-author
// turns under a single role+time meta row, with narrative tool runs
// folded into ToolNarrativeGroup and special tools standing alone.
export function MessageGroupArticle({ group }: { group: RenderGroup }) {
  const prefs = useReaderPreferences();
  // Filter thinking turns at the group level when showThinking=false
  // so the meta row doesn't appear with an empty body.
  const turns = group.turns.filter((t) => !(t.kind === "thinking" && !prefs.showThinking));
  if (turns.length === 0) return null;
  const isUser = group.author === "user";
  const segments = segmentGroupBody(turns);
  // Re-derive the displayed time from the filtered tail so the visible
  // text and the dateTime attribute always agree, and so a hidden
  // trailing thinking turn never leaks its timestamp into the header.
  const headerTurn = turns[turns.length - 1];
  return (
    <div className={`ws-mg ${isUser ? "is-user" : "is-asst"}`}>
      <div className="ws-mg-meta">
        <span className="role">{group.role}</span>
        <time dateTime={headerTurn.timestamp}>{shortTime(headerTurn.timestamp)}</time>
      </div>
      <div className="ws-mg-body">
        {segments.map((seg) => {
          if (seg.kind === "narrative") {
            return <ToolNarrativeGroup key={seg.key} tools={seg.tools} />;
          }
          return <TurnRenderer key={seg.key} turn={seg.turn} />;
        })}
      </div>
    </div>
  );
}

export type ToolPayload = NonNullable<SessionTurn["payload"]>;
export type ToolInput = Record<string, unknown>;

export type ParsedUserMessage =
  | { kind: "slash"; command: string; args?: string; output?: string }
  | { kind: "system"; text: string }
  | { kind: "compact"; text: string }
  | { kind: "plain"; text: string };

function isModelSwitchCommandEnvelope(text: string): boolean {
  const command = text.match(/<command-name>([\s\S]*?)<\/command-name>/i)?.[1]?.trim().replace(/^\//, "").toLowerCase();
  return command === "model";
}

function isModelSwitchStdout(text: string): boolean {
  const stdout = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/i)?.[1]?.trim();
  return !!stdout && /^Set model to\b/i.test(stdout);
}

// Detect the "previous conversation compacted" header Claude Code emits
// when resuming after a /compact or auto-compaction. The pattern is
// stable across versions but might drift; keep the matchers narrow to
// avoid false positives on regular prose that happens to mention
// "summary".
export function isCompactSummaryText(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 400).trim();
  return (
    /^This session is being continued from a previous conversation/i.test(head) ||
    /^Previous Conversation Compacted/i.test(head) ||
    /^This conversation has been (summarized|compacted)/i.test(head)
  );
}

// Internal envelopes Claude Code injects into otherwise-normal message
// bodies. We strip these block-by-block (tag + content) before display
// so users don't see raw "<system-reminder>The tasks tool…" or stray
// antml_thinking artifacts leaking through. Tags are matched
// case-insensitively and across newlines.
const INTERNAL_BLOCK_TAGS = [
  "system-reminder",
  "antml:thinking",
  "antml:function_calls",
  "antml:function_call_results",
  "antml_thinking",
  "antml_function_calls",
  "antml_function_results",
  // Claude Code prepends this caveat to the user record it writes when a
  // local/slash command runs ("Caveat: The messages below were generated
  // by the user while running local commands. DO NOT respond…"). It's an
  // instruction to the model, never prose the human typed — strip it so it
  // doesn't leak into chat bubbles or the derived session title.
  "local-command-caveat",
  "local-command-stderr",
  // Background-task completion events the Claude Code harness injects into the
  // conversation as a USER-role message (that's how async task results reach the
  // agent). It is internal plumbing, never prose the human typed — strip it so
  // it doesn't render as a "you" chat bubble (or seed a session title).
  "task-notification",
];

// Standalone marker lines that show up in raw payloads but carry no
// information for the reader. Trimmed line must match one of these
// regexes to be removed.
const INTERNAL_LINE_PATTERNS: RegExp[] = [
  /^\[Request interrupted by user[^\]]*\]$/i,
  /^\[Request interrupted[^\]]*\]$/i,
  /^\[Continuing from where we left off\.?\]$/i,
];

// Strip Claude Code's internal envelopes (system-reminder, antml_*,
// interruption markers) from a free-text body. Pure function; idempotent.
export function stripInternalContent(raw: string): string {
  if (!raw) return raw ?? "";
  let text = raw;
  for (const tag of INTERNAL_BLOCK_TAGS) {
    const escaped = tag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const re = new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}>`, "gi");
    text = text.replace(re, "");
    const selfClosing = new RegExp(`<${escaped}\\b[^>]*\\/>`, "gi");
    text = text.replace(selfClosing, "");
  }
  text = text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !INTERNAL_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
    })
    .join("\n");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

// Claude Code wraps slash commands and daemon-injected status as XML
// envelopes inside an otherwise-normal user_message turn. Without parsing
// the user sees raw `<command-message>pockly</command-message>` or a
// "Local daemon: ..." status string sitting in a chat bubble. Split them
// out so the chat-bubble path only renders genuine prose.
export function parseUserMessage(raw: string): ParsedUserMessage {
  const text = raw ?? "";
  if (!text) return { kind: "plain", text: "" };
  if (isModelSwitchCommandEnvelope(text) || isModelSwitchStdout(text)) return { kind: "plain", text: "" };

  const cmdNameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/i);
  if (cmdNameMatch) {
    const command = cmdNameMatch[1].trim().replace(/^\//, "");
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/i)?.[1]?.trim();
    const output = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/i)?.[1]?.trim();
    if (command) {
      const result: ParsedUserMessage = { kind: "slash", command };
      if (args) result.args = args;
      if (output) result.output = output;
      return result;
    }
  }

  if (text.includes("<local-command-stdout>") || /^Local daemon:/im.test(text) || text.startsWith("<command-stdout>")) {
    const stripped = text.replace(/<[^>]+>/g, "").trim();
    if (stripped) return { kind: "system", text: stripped };
  }

  const scrubbed = stripInternalContent(text);
  if (!scrubbed) return { kind: "plain", text: "" };
  if (isCompactSummaryText(scrubbed)) return { kind: "compact", text: scrubbed };
  return { kind: "plain", text: scrubbed };
}

export type AttachmentSummary = {
  icon: string;
  label: string;
  state: string;
  preview?: string;
};

// Classify an attachment turn's payload into a compact one-line card.
// The raw types (deferred_tools_delta, agent_listing_delta, skill_listing,
// command_permissions) come straight from Claude Code's internal session
// context and are not meaningful to a human reader on their own.
export function attachmentSummary(attachmentType: string | undefined, rawText: string | undefined): AttachmentSummary {
  const type = (attachmentType ?? "file").toLowerCase();
  const text = rawText ?? "";
  let parsed: Record<string, unknown> | null = null;
  if (text.trimStart().startsWith("{")) {
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* leave null */ }
  }
  const addedCount = Array.isArray(parsed?.addedLines) ? (parsed!.addedLines as unknown[]).length : 0;
  const allowedTools = Array.isArray(parsed?.allowedTools) ? (parsed!.allowedTools as unknown[]) : [];

  if (type === "skill_listing") {
    const lines = text.split("\n").filter((l) => /^-\s/.test(l)).length;
    return { icon: "skill", label: tx("workspace.attachmentTypes.skills"), state: lines > 0 ? String(lines) : "listing" };
  }
  if (type === "agent_listing_delta") {
    return { icon: "agent", label: tx("workspace.attachmentTypes.agents"), state: addedCount > 0 ? `+${addedCount}` : "updated" };
  }
  if (type === "deferred_tools_delta") {
    return { icon: "tool", label: tx("workspace.attachmentTypes.tools"), state: addedCount > 0 ? `+${addedCount}` : "updated" };
  }
  if (type === "command_permissions") {
    const firstTool = typeof allowedTools[0] === "string" ? (allowedTools[0] as string).split("(")[0].trim() : "";
    const summary: AttachmentSummary = {
      icon: "shield",
      label: tx("workspace.attachmentTypes.permissions"),
      state: allowedTools.length > 0 ? String(allowedTools.length) : "set",
    };
    if (firstTool) summary.preview = firstTool;
    return summary;
  }
  return { icon: "paperclip", label: tx("workspace.attachmentTypes.generic"), state: attachmentType ?? "file" };
}

function AttachmentCard({ payload }: { payload: ToolPayload }) {
  const summary = attachmentSummary(payload.attachment_type, payload.text);
  return (
    <div className="tool-card tool-card-compact attachment-card">
      <ToolCardHeader icon={summary.icon} name={summary.label} state={summary.state} tone="idle" />
      {summary.preview ? (
        <div className="tool-card-body">
          <div className="tool-card-row"><span>{summary.preview}</span></div>
        </div>
      ) : null}
      {payload.text ? (
        <details className="tool-raw">
          <summary>{tx("workspace.attachmentTypes.viewRaw")}</summary>
          <pre>{payload.text}</pre>
        </details>
      ) : null}
    </div>
  );
}

// PermissionRequestCard renders the interactive native-permission bridge.
// States:
//   - "pending": Approve / Deny buttons, click POSTs decision.
//   - "allow"/"deny" (resolved by user, by timeout, or by another
//     browser tab): static label, no buttons. Re-render still happens
//     because the MCP server emits a follow-up event with the
//     resolved decision (so a stale tab catches up).
//
// Optimistic submitting state: once user clicks, buttons disable +
// show a spinner caption. On success, we leave the visual state
// alone — the follow-up SSE event will flip the card to its
// resolved appearance. On failure, we re-enable the buttons + show
// an inline error.
// Parse the permission_input_preview blob to pull the human-readable
// description + command, mirroring Claude.ai's card layout. We accept
// either a JSON object ({"command": "...", "description": "..."}) or
// a bare command string. Unknown shapes fall back to showing the raw
// blob as the command.
function parsePermissionPreview(raw: string): { command: string; description: string } {
  const text = (raw ?? "").trim();
  if (!text) return { command: "", description: "" };
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const command = typeof parsed.command === "string" ? parsed.command
        : typeof parsed.cmd === "string" ? parsed.cmd
        : "";
      const description = typeof parsed.description === "string" ? parsed.description
        : typeof parsed.desc === "string" ? parsed.desc
        : "";
      if (command || description) return { command, description };
    } catch { /* fall through */ }
  }
  return { command: text, description: "" };
}

function PermissionRequestCard({
  payload,
  realtime,
  onResolved,
}: {
  payload: ToolPayload;
  realtime?: SessionSubscription | null;
  onResolved?: (requestId: string) => void;
}) {
  const requestId = payload.permission_request_id ?? "";
  const daemonDeviceId = payload.permission_daemon_device_id ?? "";
  const toolName = payload.permission_tool_name ?? "?";
  const inputPreview = payload.permission_input_preview ?? "";
  const decision = payload.permission_decision ?? "pending";
  const reason = payload.permission_reason ?? "";

  const [submitting, setSubmitting] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string>("");

  const { command, description } = parsePermissionPreview(inputPreview);

  const onDecide = async (choice: "allow" | "deny") => {
    if (submitting || !requestId || !daemonDeviceId) return;
    setSubmitting(choice);
    setError("");
    try {
      const ack = await decidePermissionRequest(requestId, daemonDeviceId, choice, realtime ?? null);
      if (ack.status === "accepted") {
        if (requestId) onResolved?.(requestId);
      } else if (ack.status === "not_found") {
        // "not_found" means the request was no longer pending when the
        // decision arrived — it expired before it reached the agent, so
        // the tool was NOT run and the agent saw a blocked call. This was
        // previously swallowed as success, which is exactly why a click
        // that didn't land looked like it worked. Surface it so the user
        // can resend instead of silently losing the approval.
        setError(tx("errors.permissionDecisionDidNotLand"));
        setSubmitting(null);
      } else {
        setError(ack.error || `decide rejected: ${ack.status}`);
        setSubmitting(null);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(null);
    }
  };

  const isPending = decision === "pending";
  const isAllow = decision === "allow";
  const isDeny = decision === "deny";
  const isLocalConfirmation = decision === "local_confirmation";

  // Native agent approval prompts are sentence-style. If the agent did not
  // provide a description, fall back to the tool name so the card stays clear.
  const subject = description || toolName;
  const titleText = isLocalConfirmation
    ? tx("errors.waitingLocalConfirmationTitle")
    : isPending
    ? tx("task.permissionAllowTitle", { subject })
    : isAllow
    ? tx("task.permissionAllowedTitle", { subject })
    : isDeny
    ? tx("task.permissionDeniedTitle", { subject })
    : subject;
  const dotClass = isPending || isLocalConfirmation
    ? "is-pending"
    : isAllow
    ? "is-allow"
    : isDeny
    ? "is-deny"
    : "";

  return (
    <div
      className="permission-card"
      data-permission-request-id={requestId || undefined}
    >
      <div className="permission-card-head">
        <span className={`permission-card-dot ${dotClass}`} aria-hidden="true" />
        <strong className="permission-card-title">{titleText}</strong>
      </div>
      {description && command ? (
        <div className="permission-card-desc">{description}</div>
      ) : null}
      {command ? (
        <code className="permission-card-cmd">{command}</code>
      ) : null}
      {reason && !isPending ? (
        <div className="permission-card-reason">{reason}</div>
      ) : null}
      {isLocalConfirmation ? (
        <div className="permission-card-reason">{tx("errors.waitingLocalConfirmationBody")}</div>
      ) : null}
      {isPending ? (
        <div className="permission-card-actions">
          <button
            type="button"
            className="permission-card-btn permission-card-btn-deny"
            disabled={!!submitting || !requestId || !daemonDeviceId}
            onClick={() => onDecide("deny")}
          >Deny</button>
          <button
            type="button"
            className="permission-card-btn permission-card-btn-allow"
            disabled={!!submitting || !requestId || !daemonDeviceId}
            onClick={() => onDecide("allow")}
          >{submitting === "allow" ? "Allowing…" : "Allow"}</button>
        </div>
      ) : null}
      {error ? (
        <div className="permission-card-error">{error}</div>
      ) : null}
    </div>
  );
}

function ToolCallCard({ payload }: { payload: ToolPayload }) {
  const input = asRecord(payload.input);
  const result = payload.result ?? "";
  const toolName = payload.tool ?? tx("workspace.tool");
  // Per-tool spec lookup produces pure-data ToolDisplay metadata. ToolCallCard
  // maps body kinds to body components below. Specs live in
  // src/content/tools/specs/; registry.ts orders them.
  const spec = resolveToolSpec(toolName);
  const display = spec.display(input, payload, result);
  const paired = Boolean(payload._paired_result);
  const hasResult = Boolean(payload.has_result || result);
  // Spec's stateLabel wins when it has an opinion (e.g. "+12 -3" for
  // diffs); otherwise fall back to running/done/error so cards still
  // communicate completion state for tools whose spec doesn't bother
  // computing one.
  const state = display.stateLabel
    ? display.stateLabel
    : payload.is_error
      ? tx("workspace.error")
      : paired || hasResult
        ? tx("workspace.done")
        : tx("workspace.running");
  const tone: "ok" | "error" | "idle" = payload.is_error ? "error" : paired || hasResult ? "ok" : "idle";
  const errorClass = payload.is_error ? "tool-card tool-card-oneliner ws-tc is-error" : "tool-card tool-card-oneliner ws-tc";
  const diffPairs = display.body === "diff" ? extractEditPairs(toolName, input) : [];
  const questions = display.body === "question" ? extractQuestions(input) : [];
  const todos = display.body === "todo" ? extractTodos(input) : [];
  // A Read result IS a file body — syntax-highlight it (with a line-number
  // gutter) when we recognise the language; otherwise fall back to plain text.
  const readCanonical = toolName.replace(/^mcp__[^_]+__/, "");
  const readLang =
    readCanonical === "Read" || readCanonical === "NotebookRead"
      ? langForPath(stringField(input, ["file_path", "path", "filename", "file", "notebook_path"]))
      : "";
  const sidechainItems = payload._sidechain_items ?? [];
  const hasSidechain = sidechainItems.length > 0;
  // Reader preferences. autoExpandTools opens the <details> by default;
  // showRawParameters gates the input JSON dump in the rows-and-raw fallback.
  // Tool output is not gated because it is the useful content of a finished
  // tool call.
  const prefs = useReaderPreferences();

  return (
    <details className={errorClass} open={prefs.autoExpandTools || undefined}>
      <ToolOnelinerSummary
        icon={display.icon}
        name={display.name}
        narrativeLabel={display.narrativeLabel}
        keyArg={display.headerArg}
        state={state}
        tone={tone}
      />
      <div className="tool-card-oneliner-body ws-tc-body has-spec">
        {/* Specs that provide a narrativeLabel opt into the
            Claude-style clean view: skip the per-spec rows AND the
            raw input JSON dump in the rows-and-raw fallback, since
            the row + body label already convey what the call did.
            Command bodies skip rows separately for the same reason. */}
        {display.rows.length > 0 && display.body !== "command" && !display.narrativeLabel
          ? <ToolRows rows={display.rows} />
          : null}
        {display.body === "diff" && diffPairs.length > 0 ? (
          <ToolDiffView pairs={diffPairs} />
        ) : display.body === "question" && questions.length > 0 ? (
          <ToolQuestionCard questions={questions} result={result} />
        ) : display.body === "todo" && todos.length > 0 ? (
          <ToolTodoView todos={todos} />
        ) : display.body === "command" ? (
          <ToolCommandBody
            name={display.name}
            command={stringField(input, ["command", "cmd"])}
            result={hasResult ? result : ""}
          />
        ) : display.body === "plan" ? (
          <ToolPlanBody plan={stringField(input, ["plan"])} resolved={paired || hasResult} />
        ) : (
          <>
            {prefs.showRawParameters && payload.input && !display.narrativeLabel ? (
              <pre className="tool-raw-block">{JSON.stringify(payload.input, null, 2)}</pre>
            ) : null}
            {hasResult ? (
              readLang ? <CodeView code={result} lang={readLang} /> : <pre className="tool-raw-block">{result}</pre>
            ) : null}
          </>
        )}
        {hasSidechain ? <SidechainGroup items={sidechainItems} /> : null}
      </div>
    </details>
  );
}

// Terminal-styled body for command tools. The command sits in a mono block with
// a `$` prompt prefix and a copy button. Result output renders below in the same
// terminal style so the user sees command + stdout as one shell session.
function ToolCommandBody({ name, command, result }: { name?: string; command: string; result: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard write rejected (e.g. iframe sandbox / permissions
      // denied) — silently fail; the user can still select+copy the
      // text below.
    }
  };
  return (
    <div className="tool-command">
      {name ? <div className="tool-command-name">{name}</div> : null}
      <div className="tool-command-line">
        <span className="tool-command-prompt" aria-hidden="true">$</span>
        <code className="tool-command-text">{command || "(empty command)"}</code>
        {command ? (
          <button
            type="button"
            className="tool-command-copy"
            onClick={onCopy}
            aria-label={tx("workspace.copy")}
          >
            {copied ? tx("workspace.copied") : tx("workspace.copy")}
          </button>
        ) : null}
      </div>
      {result ? <pre className="tool-command-output">{result}</pre> : null}
    </div>
  );
}

// Plan body for the ExitPlanMode spec. Renders the plan markdown in an
// accent-bordered panel and, while unresolved, a footer noting the call is
// awaiting the user's approval. Plan content uses the same MarkdownBlock
// pipeline as assistant_text so tables, task lists, and fenced code blocks
// render like a regular reply.
//
// Approval-button wiring is out of scope here. The user replies in the composer
// with "approve" / "no, revise"; native permission prompts use their own
// approval bridge.
function ToolPlanBody({ plan, resolved }: { plan: string; resolved?: boolean }) {
  return (
    <div className="tool-plan">
      <div className="tool-plan-body">
        <MarkdownBlock markdown={plan} />
      </div>
      {/* Once the user has approved/denied, the card is historical —
          drop the pulsing footer so the past plan doesn't keep
          telling the user to act. */}
      {!resolved ? (
        <div className="tool-plan-footer">
          <span className="tool-plan-footer-dot" aria-hidden="true" />
          {tx("workspace.planAwaitingApproval")}
        </div>
      ) : null}
    </div>
  );
}

// Collapsed subagent run nested under a Task tool_call card. Shows a
// summary row ("subagent · 6 steps") and expands into the original
// sidechain blocks. Reuses TurnRenderer so each subagent step gets the
// same rich rendering as a top-level turn (diff viewer, todos, tools,
// thinking, etc.) — just visually indented.
function SidechainGroup({ items }: { items: SessionTurn[] }) {
  const toolCalls = items.filter((t) => t.kind === "tool_call").length;
  const texts = items.filter((t) => t.kind === "assistant_text").length;
  return (
    <details className="sidechain-group">
      <summary className="sidechain-summary">
        <span className="sidechain-icon" aria-hidden="true">⤷</span>
        <strong>subagent</strong>
        <span className="sidechain-summary-counts">
          {toolCalls > 0 ? `${toolCalls} tool${toolCalls === 1 ? "" : "s"}` : null}
          {toolCalls > 0 && texts > 0 ? " · " : null}
          {texts > 0 ? `${texts} reply${texts === 1 ? "" : "s"}` : null}
          {toolCalls === 0 && texts === 0 ? `${items.length} steps` : null}
        </span>
      </summary>
      <div className="sidechain-body">
        {items.map((item) => (
          <TurnArticle key={`side:${item.session_id}:${item.seq}`} turn={item} />
        ))}
      </div>
    </details>
  );
}

// Standalone tool_result (orphan — the matching tool_call wasn't found in
// the timeline, e.g. older history with a missing call). Same one-liner
// treatment so it doesn't visually outshine the paired cards.
function ToolResultCard({ payload }: { payload: ToolPayload }) {
  const result = payload.result ?? payload.text ?? "";
  const rows = resultRows(result);
  const errorClass = payload.is_error ? "tool-card tool-card-oneliner ws-tc is-error" : "tool-card tool-card-oneliner ws-tc";
  const preview = firstUsefulLine(result);
  // Orphan tool_result cards also obey autoExpandTools. showRawParameters does
  // not apply here because result output is the substance of the card, not the
  // input parameters.
  const prefs = useReaderPreferences();
  return (
    <details className={errorClass} open={prefs.autoExpandTools || undefined}>
      <ToolOnelinerSummary
        icon={payload.is_error ? "error" : "result"}
        name={tx("workspace.toolResult")}
        keyArg={preview ? truncateMiddle(preview, 56) : ""}
        state={payload.is_error ? "error" : "done"}
        tone={payload.is_error ? "error" : "ok"}
      />
      <div className="tool-card-oneliner-body ws-tc-body has-spec">
        {rows.length > 0 ? <ToolRows rows={rows} /> : null}
        {result ? <pre className="tool-raw-block">{result}</pre> : null}
      </div>
    </details>
  );
}

function ToolOnelinerSummary({ icon, name, narrativeLabel, keyArg, state, tone }: { icon: string; name: string; narrativeLabel?: string | undefined; keyArg: string; state: string; tone: "ok" | "error" | "idle" }) {
  // Map the existing 3-tone model (ok/error/idle) onto the design's
  // 3-color CSS classes (ok=green, danger=red, default-muted).
  // "idle" stays uncolored — that's running/no-status.
  const stateClass = tone === "ok" ? "ok" : tone === "error" ? "danger" : "";
  return (
    <summary className="tool-card-oneliner-summary ws-tc-row">
      <span className="tool-card-icon ws-tc-icon" aria-hidden="true"><ToolGlyph name={icon} /></span>
      <strong className="ws-tc-name">{name}</strong>
      {narrativeLabel ? <strong className="ws-tc-narrative-name">{narrativeLabel}</strong> : null}
      <span className="tool-card-oneliner-arg ws-tc-summary">{keyArg}</span>
      <span className={`tool-card-state ws-tc-state is-${tone} ${stateClass}`}>
        {tone !== "idle" ? <i /> : null}
        {state}
      </span>
      <span className="ws-tc-chev" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6"/>
        </svg>
      </span>
    </summary>
  );
}

// Renders the cluster carrier produced by groupConsecutiveTools. Collapsed
// it shows "<Tool> × N · <count> consecutive calls"; expanded it lists
// each original tool_call as its own one-liner card so the user can still
// drill in to any individual call.
function ToolGroupCard({ payload }: { payload: ToolPayload }) {
  const items = payload._group_items ?? [];
  const tool = payload.tool ?? tx("workspace.tool");
  const count = items.length;
  const errorCount = items.filter((t) => t.payload?.is_error).length;
  const tone: "ok" | "error" | "idle" = errorCount > 0 ? "error" : "ok";
  // Spec lookup for icon + display name. The group itself doesn't have
  // meaningful per-item input, so we pass empty input/payload. The spec's name
  // and icon come from the tool-name match alone, which is all the group header
  // needs.
  const spec = resolveToolSpec(tool);
  const display = spec.display({}, { tool } as ToolPayload, "");
  return (
    <details className="tool-card tool-card-oneliner tool-card-group ws-tc">
      <summary className="tool-card-oneliner-summary ws-tc-row">
        <span className="tool-card-icon ws-tc-icon" aria-hidden="true"><ToolGlyph name={display.icon} /></span>
        <strong className="ws-tc-name">{display.name}</strong>
        <span className="tool-card-oneliner-arg ws-tc-summary">{tx("workspace.toolGroupSummary", { count })}</span>
        <span className={`tool-card-state ws-tc-state is-${tone} ${tone === "ok" ? "ok" : "danger"}`}>
          <i />
          {`× ${count}`}
        </span>
        <span className="ws-tc-chev" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l6 6-6 6"/>
          </svg>
        </span>
      </summary>
      <div className="tool-card-group-list ws-tc-body">
        {items.map((item) => (
          <ToolCallCard key={`${item.seq}:${item.payload?.id ?? ""}`} payload={item.payload ?? {}} />
        ))}
      </div>
    </details>
  );
}

// Per-tool specs in src/content/tools/specs/ own their own header-arg logic;
// the default spec keeps a similar heuristic for unknown tools.

function ToolCardHeader({ icon, name, state, tone = "ok" }: { icon: string; name: string; state: string; tone?: "ok" | "error" | "idle" }) {
  return (
    <div className="tool-card-head">
      <span className="tool-card-icon" aria-hidden="true"><ToolGlyph name={icon} /></span>
      <strong>{name}</strong>
      <span className={`tool-card-state is-${tone}`}>{state}</span>
    </div>
  );
}

function ToolRows({ rows }: { rows: Array<{ key: string; value: string }> }) {
  return (
    <div className="tool-card-body">
      {rows.slice(0, 3).map((row) => (
        <div className="tool-card-row" key={`${row.key}:${row.value}`}>
          <span>{row.key}</span>
          <b>{row.value}</b>
        </div>
      ))}
    </div>
  );
}

function ToolGlyph({ name }: { name: string }) {
  if (name === "search") {
    return <svg viewBox="0 0 18 18"><circle cx="8" cy="8" r="4.5" /><path d="m11.5 11.5 3 3" /></svg>;
  }
  if (name === "edit") {
    return <svg viewBox="0 0 18 18"><path d="M4 13.5h3.2L14 6.7 11.3 4 4.5 10.8 4 13.5Z" /><path d="M10.4 4.9 13.1 7.6" /></svg>;
  }
  if (name === "terminal") {
    return <svg viewBox="0 0 18 18"><path d="M3.5 5.5h11v7h-11z" /><path d="m5.5 7.5 2 1.5-2 1.5" /><path d="M9 10.5h3" /></svg>;
  }
  if (name === "paperclip") {
    return <svg viewBox="0 0 18 18"><path d="m6.2 9.4 4-4a2.3 2.3 0 0 1 3.3 3.3l-5.2 5.2a3.2 3.2 0 0 1-4.6-4.6l5.5-5.5" /></svg>;
  }
  if (name === "error") {
    return <svg viewBox="0 0 18 18"><path d="M9 3.5 15 14H3L9 3.5Z" /><path d="M9 7v3" /><path d="M9 12.5h.01" /></svg>;
  }
  if (name === "meta") {
    return <svg viewBox="0 0 18 18"><path d="M5 4.5h8" /><path d="M5 9h8" /><path d="M5 13.5h5" /></svg>;
  }
  if (name === "skill") {
    return <svg viewBox="0 0 18 18"><path d="M4 3.5h8a1.5 1.5 0 0 1 1.5 1.5v9l-2.5-1.5L9 14l-2-1.5-2.5 1.5V5A1.5 1.5 0 0 1 4 3.5Z" /></svg>;
  }
  if (name === "agent") {
    return <svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="4.5" /><path d="M9 4.5V3" /><circle cx="7" cy="9" r="0.6" fill="currentColor" /><circle cx="11" cy="9" r="0.6" fill="currentColor" /></svg>;
  }
  if (name === "tool") {
    return <svg viewBox="0 0 18 18"><path d="m4 14 5-5" /><path d="M11 4a2.5 2.5 0 1 0 3 3l-1.5 1.5L11 6 12.5 4.5Z" /></svg>;
  }
  if (name === "shield") {
    return <svg viewBox="0 0 18 18"><path d="M9 3.5 4 5.5v4c0 3 2.5 4.5 5 5 2.5-.5 5-2 5-5v-4L9 3.5Z" /></svg>;
  }
  // File glyph for Read spec: a document with a folded corner.
  if (name === "file") {
    return <svg viewBox="0 0 18 18"><path d="M5 3.5h6l3 3v8h-9V3.5Z" /><path d="M11 3.5v3h3" /></svg>;
  }
  // List glyph for TodoWrite spec: three rows with bullets.
  if (name === "list") {
    return <svg viewBox="0 0 18 18"><circle cx="4" cy="5" r="0.8" fill="currentColor" /><path d="M6.5 5h7" /><circle cx="4" cy="9" r="0.8" fill="currentColor" /><path d="M6.5 9h7" /><circle cx="4" cy="13" r="0.8" fill="currentColor" /><path d="M6.5 13h5" /></svg>;
  }
  // Plan glyph for ExitPlanMode spec: clipboard with a folded top and check.
  if (name === "plan") {
    return <svg viewBox="0 0 18 18"><path d="M4 4.5h10v10H4z" /><path d="M6.5 3.5h5v2h-5z" /><path d="m7 9.5 1.5 1.5L12 7.5" /></svg>;
  }
  return <svg viewBox="0 0 18 18"><path d="M4 4.5h10v9H4z" /><path d="M6 7h6" /><path d="M6 10h4" /></svg>;
}

export function asRecord(value: unknown): ToolInput {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as ToolInput;
  return {};
}

// ToolSpec.display() owns display names, state labels, and rows. Per-tool specs
// live in src/content/tools/specs/; defaultSpec keeps similar heuristics for
// unknown tools so fallback rendering stays useful.

function resultRows(result: string) {
  const lines = countNonEmptyLines(result);
  const first = firstUsefulLine(result);
  const rows: Array<{ key: string; value: string }> = [];
  if (lines > 0) rows.push({ key: "lines", value: String(lines) });
  if (first) rows.push({ key: "preview", value: truncateMiddle(first, 76) });
  return rows;
}

export function stringField(input: ToolInput, keys: string[]) {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function numberField(input: ToolInput, keys: string[]) {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return 0;
}

export function countLikelyHits(result: string) {
  if (!result.trim()) return 0;
  return result.split("\n").filter((line) => line.trim() && !line.toLowerCase().includes("no matches")).length;
}

export function countNonEmptyLines(value: string) {
  return value.split("\n").filter((line) => line.trim()).length;
}

export function firstUsefulLine(value: string) {
  return value.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

export function editDelta(input: ToolInput, result: string) {
  const plusMinus = result.match(/([+]\d+)\s*[−-]\s*(\d+)/);
  if (plusMinus) return `${plusMinus[1]} −${plusMinus[2]}`;
  const oldText = stringField(input, ["old_string", "oldText", "old"]);
  const newText = stringField(input, ["new_string", "newText", "new"]);
  if (!oldText && !newText) return "";
  const added = Math.max(0, countNonEmptyLines(newText) - countNonEmptyLines(oldText));
  const removed = Math.max(0, countNonEmptyLines(oldText) - countNonEmptyLines(newText));
  if (added || removed) return `+${added} −${removed}`;
  return "edited";
}

// File-edit tools whose payload carries enough structure to render a real
// line diff inside the tool card body. Matched on canonical name so
// unrelated tools that happen to contain "edit"/"write" in their name
// (e.g. `MCP__notion__edit_page`) fall through to the generic renderer.
export function isDiffTool(toolName: string): boolean {
  const lower = (toolName || "").toLowerCase();
  return (
    lower === "edit" ||
    lower === "write" ||
    lower === "multiedit" ||
    lower === "applypatch" ||
    lower === "str_replace_editor" ||
    lower === "str_replace_based_edit_tool"
  );
}

export type EditPair = { file: string; old: string; new: string };

// Pull a list of {old, new} content pairs out of an edit-tool input.
// Returns one pair for Edit/ApplyPatch, the full edits[] for MultiEdit,
// and a synthetic [{old:"", new:content}] for Write so a fresh file
// still shows up as an all-add diff.
export function extractEditPairs(toolName: string, input: ToolInput): EditPair[] {
  const lower = (toolName || "").toLowerCase();
  const file = stringField(input, ["file_path", "path", "filename", "file"]);
  if (lower === "multiedit") {
    const raw = Array.isArray(input.edits) ? (input.edits as unknown[]) : [];
    const pairs = raw
      .map((entry) => {
        const rec = asRecord(entry);
        return {
          file,
          old: typeof rec.old_string === "string" ? rec.old_string : "",
          new: typeof rec.new_string === "string" ? rec.new_string : "",
        };
      })
      .filter((p) => p.old || p.new);
    return pairs;
  }
  if (lower === "write") {
    const content = typeof input.content === "string"
      ? (input.content as string)
      : stringField(input, ["text", "data"]);
    return content ? [{ file, old: "", new: content }] : [];
  }
  const oldText = typeof input.old_string === "string" ? (input.old_string as string) : stringField(input, ["oldText", "old"]);
  const newText = typeof input.new_string === "string" ? (input.new_string as string) : stringField(input, ["newText", "new"]);
  if (!oldText && !newText) return [];
  return [{ file, old: oldText, new: newText }];
}

export type DiffOp = {
  // "meta" is a git hunk header (@@ … @@), only produced by parseUnifiedDiff.
  kind: "add" | "remove" | "context" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
};

// Standard Hunt–McIlroy LCS line diff. O(m·n) time and space; we cap at
// 2000 lines per side so a pathological 50k-line Write doesn't lock up
// the renderer — beyond the cap the tail is shown as a single
// "+N more lines" marker.
export function lineDiff(oldText: string, newText: string): DiffOp[] {
  const cap = 2000;
  const oldLinesAll = oldText.split("\n");
  const newLinesAll = newText.split("\n");
  const oldLines = oldLinesAll.slice(0, cap);
  const newLines = newLinesAll.slice(0, cap);
  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ kind: "context", text: oldLines[i - 1], oldLine: i, newLine: j });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ kind: "remove", text: oldLines[i - 1], oldLine: i });
      i--;
    } else {
      ops.push({ kind: "add", text: newLines[j - 1], newLine: j });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ kind: "remove", text: oldLines[i - 1], oldLine: i });
    i--;
  }
  while (j > 0) {
    ops.push({ kind: "add", text: newLines[j - 1], newLine: j });
    j--;
  }
  ops.reverse();

  const truncOld = Math.max(0, oldLinesAll.length - cap);
  const truncNew = Math.max(0, newLinesAll.length - cap);
  if (truncOld > 0) ops.push({ kind: "remove", text: `… ${truncOld} more lines` });
  if (truncNew > 0) ops.push({ kind: "add", text: `… ${truncNew} more lines` });
  return ops;
}

// Render an inline image content part. Prefers base64 data (wrapped as a
// data URL) when present so the browser doesn't have to fetch an external
// asset; falls back to image_url for source.type=="url" emissions.
//
// Capped to a 300x300 thumbnail; click opens an in-page lightbox at native
// resolution so the user stays in context, especially on mobile.
function ImageTurnCard({ payload }: { payload: ToolPayload }) {
  const mime = payload.image_media_type ?? "image/png";
  const src = payload.image_data
    ? `data:${mime};base64,${payload.image_data}`
    : payload.image_url ?? "";
  const [zoomed, setZoomed] = useState(false);
  if (!src) return null;
  return (
    <>
      <button
        type="button"
        className="image-turn-card"
        onClick={() => setZoomed(true)}
        aria-label={tx("workspace.imageOpenFull")}
      >
        <img src={src} alt="" loading="lazy" />
      </button>
      {zoomed ? <ImageLightbox src={src} onClose={() => setZoomed(false)} /> : null}
    </>
  );
}

// Full-screen image overlay. Self-implemented to keep bundle size flat and CSP
// narrow; it only renders the same data: / https: URL the thumbnail already
// used.
//
// Closes on:
//   - backdrop click
//   - ESC key (window keydown listener)
//   - the explicit close button (top-right, large hit target)
//
// The inner <img> stops click propagation so clicking the image
// itself doesn't dismiss — that pattern lets users pinch-zoom on
// mobile without the overlay closing under their fingers.
function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Lock scroll on the document while the lightbox is open so
    // backdrop drag-scrolls don't leak through.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);
  return (
    <div
      className="image-lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={tx("workspace.imageLightboxLabel")}
      onClick={onClose}
    >
      <button
        type="button"
        className="image-lightbox-close"
        onClick={onClose}
        aria-label={tx("workspace.close")}
      >
        ×
      </button>
      <img
        className="image-lightbox-image"
        src={src}
        alt=""
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

// Render Claude Code's "previous conversation compacted" preamble as a
// collapsed card so it doesn't visually dominate the message list. The
// summary body is still markdown — it's a real summary, often with code
// blocks and bullet lists.
function CompactSummaryCard({ text }: { text: string }) {
  return (
    <details className="compact-summary-card">
      <summary>
        <span className="compact-summary-icon" aria-hidden="true">⤴</span>
        <strong>Previous conversation compacted</strong>
        <span className="compact-summary-hint">click to expand</span>
      </summary>
      <div className="compact-summary-body">
        <MarkdownBlock markdown={text} />
      </div>
    </details>
  );
}

export type QuestionOption = { label: string; description?: string };
export type QuestionEntry = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
};

// Parse AskUserQuestion's input.questions[] into a normalized shape so
// the renderer can lay out each question + option grid without juggling
// type-narrowing inline. Optional fields are omitted (not set to
// undefined) so the result type validates under exactOptionalPropertyTypes.
export function extractQuestions(input: ToolInput): QuestionEntry[] {
  const raw = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
  const out: QuestionEntry[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    const question = typeof rec.question === "string" ? rec.question : "";
    if (!question) continue;
    const opts = Array.isArray(rec.options) ? (rec.options as unknown[]) : [];
    const options: QuestionOption[] = [];
    for (const o of opts) {
      const r = asRecord(o);
      const label = typeof r.label === "string" ? r.label : "";
      if (!label) continue;
      const opt: QuestionOption = { label };
      if (typeof r.description === "string") opt.description = r.description;
      options.push(opt);
    }
    const item: QuestionEntry = { question, multiSelect: rec.multiSelect === true, options };
    if (typeof rec.header === "string") item.header = rec.header;
    out.push(item);
  }
  return out;
}

// Best-effort: when a tool_result is present for AskUserQuestion, extract
// which option labels the user picked so we can highlight them. Result is
// usually JSON-encoded {"answers": {"<question>": "<label>"}} but we
// gracefully fall back to substring matching when the format drifts.
export function selectedAnswerLabels(result: string): Set<string> {
  const set = new Set<string>();
  if (!result) return set;
  const tryAdd = (value: unknown) => {
    if (typeof value === "string" && value.trim()) set.add(value.trim());
    else if (Array.isArray(value)) value.forEach(tryAdd);
  };
  try {
    const parsed = JSON.parse(result) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (obj.answers && typeof obj.answers === "object") {
        for (const v of Object.values(obj.answers as Record<string, unknown>)) tryAdd(v);
      } else {
        for (const v of Object.values(obj)) tryAdd(v);
      }
    }
  } catch {
    // Fall through; caller will do substring matching against the raw text.
  }
  return set;
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "unknown";
export type TodoEntry = { content: string; status: TodoStatus; activeForm?: string };

export function isTodoTool(toolName: string): boolean {
  const lower = (toolName || "").toLowerCase();
  return lower === "todowrite" || lower === "todoread";
}

function normalizeTodoStatus(value: unknown): TodoStatus {
  if (value === "pending" || value === "in_progress" || value === "completed") return value;
  return "unknown";
}

export function extractTodos(input: ToolInput): TodoEntry[] {
  const raw = Array.isArray(input.todos) ? (input.todos as unknown[]) : [];
  const out: TodoEntry[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    const content = typeof rec.content === "string" ? rec.content : "";
    if (!content) continue;
    const item: TodoEntry = { content, status: normalizeTodoStatus(rec.status) };
    if (typeof rec.activeForm === "string") item.activeForm = rec.activeForm;
    out.push(item);
  }
  return out;
}

function ToolTodoView({ todos }: { todos: TodoEntry[] }) {
  return (
    <ul className="tool-todo-list">
      {todos.map((todo, idx) => (
        <li className={`tool-todo tool-todo-${todo.status}`} key={`${todo.content}:${idx}`}>
          <span className="tool-todo-marker" aria-hidden="true">
            {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◐" : "○"}
          </span>
          <span className="tool-todo-text">
            {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

// Window-level event channel for AskUserQuestion answers. The question card
// lives deep inside the turn renderer tree where the active session id isn't in
// scope; the conversation view subscribes to this event and inject-sends the
// text against whatever session is selected.
//
// Payload contract: { text: string } — the literal user message to
// inject, already formatted (single-select sends one label, multi-
// select joins picked labels with ", ").
export const ANSWER_QUESTION_EVENT = "pockly:answer-question";
export type AnswerQuestionDetail = { text: string };

function dispatchAnswerQuestion(text: string) {
  if (!text.trim()) return;
  window.dispatchEvent(
    new CustomEvent<AnswerQuestionDetail>(ANSWER_QUESTION_EVENT, { detail: { text } }),
  );
}

function ToolQuestionCard({ questions, result }: { questions: QuestionEntry[]; result: string }) {
  const picked = selectedAnswerLabels(result);
  // Resolved = the tool already has a result, so picker is passive.
  // Pending = no result yet; render option buttons + (for multi-
  // select) a Send button that submits the staged picks.
  const resolved = Boolean(result);
  return (
    <div className="tool-question-list">
      {questions.map((q, qi) => (
        <QuestionRow
          key={`${q.question}:${qi}`}
          question={q}
          resolved={resolved}
          pickedLabels={picked}
          rawResult={result}
        />
      ))}
    </div>
  );
}

function QuestionRow({
  question,
  resolved,
  pickedLabels,
  rawResult,
}: {
  question: QuestionEntry;
  resolved: boolean;
  pickedLabels: Set<string>;
  rawResult: string;
}) {
  // Local staged selection for multi-select pending questions.
  // Single-select sends immediately on click — no need to stage.
  const [staged, setStaged] = useState<Set<string>>(new Set());
  const [sent, setSent] = useState(false);
  const isMulti = question.multiSelect === true;

  const onPick = (label: string) => {
    if (resolved || sent) return;
    if (isMulti) {
      setStaged((prev) => {
        const next = new Set(prev);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        return next;
      });
    } else {
      // Single-select: dispatch immediately. Mark sent to switch the
      // row to a "submitted" visual so the user sees feedback even
      // before the inject roundtrip writes a tool_result back.
      dispatchAnswerQuestion(label);
      setSent(true);
    }
  };

  const onSendMulti = () => {
    if (resolved || sent || staged.size === 0) return;
    // Stable label order — preserve the question's option order
    // rather than insertion order so the submitted text reads
    // consistently regardless of click sequence.
    const labels = question.options
      .map((o) => o.label)
      .filter((label) => staged.has(label));
    dispatchAnswerQuestion(labels.join(", "));
    setSent(true);
  };

  return (
    <div className="tool-question">
      {question.header ? <span className="tool-question-header">{question.header}</span> : null}
      <div className="tool-question-prompt">{question.question}</div>
      <div className="tool-question-options">
        {question.options.map((opt, oi) => {
          const isResolvedPick =
            resolved && (pickedLabels.has(opt.label) || rawResult.includes(opt.label));
          const isStaged = !resolved && !sent && staged.has(opt.label);
          const isPicked = isResolvedPick || isStaged;
          const interactive = !resolved && !sent;
          const className = [
            "tool-question-option",
            isPicked ? "is-picked" : "",
            interactive ? "is-interactive" : "",
          ]
            .filter(Boolean)
            .join(" ");
          // Render as a button when interactive (clickable) so the
          // keyboard / screen-reader story works; render as div
          // afterwards so resolved questions stay non-tabbable.
          if (interactive) {
            return (
              <button
                type="button"
                className={className}
                key={`${opt.label}:${oi}`}
                onClick={() => onPick(opt.label)}
                aria-pressed={isMulti ? isStaged : undefined}
              >
                <span className="tool-question-option-label">{opt.label}</span>
                {opt.description ? (
                  <span className="tool-question-option-desc">{opt.description}</span>
                ) : null}
              </button>
            );
          }
          return (
            <div className={className} key={`${opt.label}:${oi}`}>
              <span className="tool-question-option-label">{opt.label}</span>
              {opt.description ? (
                <span className="tool-question-option-desc">{opt.description}</span>
              ) : null}
            </div>
          );
        })}
      </div>
      {isMulti && !resolved && !sent ? (
        <div className="tool-question-multi-actions">
          <span className="tool-question-multiselect">{tx("workspace.questionMultiselectHint")}</span>
          <button
            type="button"
            className="tool-question-send"
            onClick={onSendMulti}
            disabled={staged.size === 0}
          >
            {tx("workspace.questionSend", { count: staged.size })}
          </button>
        </div>
      ) : isMulti ? (
        <span className="tool-question-multiselect">{tx("workspace.questionMultiselectHint")}</span>
      ) : null}
      {sent && !resolved ? (
        <div className="tool-question-sent" aria-live="polite">{tx("workspace.questionSent")}</div>
      ) : null}
    </div>
  );
}

function ToolDiffView({ pairs }: { pairs: EditPair[] }) {
  // Lazy-load the highlighter once if any pair is a recognised language, then
  // colour each diff line. Per-line highlighting can't see cross-line context
  // (block comments / multi-line strings) — acceptable for compact edit diffs.
  // Hooks run before the early return to respect the rules of hooks.
  const [hljs, setHljs] = useState<Hljs | null>(null);
  const wantsHighlight = useMemo(() => pairs.some((p) => langForPath(p.file)), [pairs]);
  useEffect(() => {
    if (!wantsHighlight) return;
    let cancelled = false;
    void loadCodeHighlighter()
      .then((h) => {
        if (!cancelled) setHljs(h);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wantsHighlight]);
  if (pairs.length === 0) return null;
  const highlightLine = (text: string, lang: string): string | null => {
    if (!hljs || !lang || !hljs.getLanguage(lang)) return null;
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  };
  return (
    <div className="tool-diff-list">
      {pairs.map((pair, idx) => {
        const ops = lineDiff(pair.old, pair.new);
        const lang = langForPath(pair.file);
        let added = 0;
        let removed = 0;
        for (const op of ops) {
          if (op.kind === "add") added++;
          else if (op.kind === "remove") removed++;
        }
        return (
          <div className="tool-diff" key={`${pair.file}:${idx}`}>
            <div className="tool-diff-head">
              {pair.file ? <span className="tool-diff-file">{compactPath(pair.file)}</span> : <span />}
              <span className="tool-diff-stat">
                <span className="tool-diff-stat-add">+{added}</span>
                <span className="tool-diff-stat-rem">−{removed}</span>
              </span>
            </div>
            <div className="tool-diff-body">
              {ops.map((op, i) => {
                const hl = highlightLine(op.text, lang);
                return (
                <div key={i} className={`tool-diff-line tool-diff-line-${op.kind}`}>
                  <span className="tool-diff-gutter" aria-hidden="true">
                    {op.kind === "add" ? "+" : op.kind === "remove" ? "−" : " "}
                  </span>
                  {hl != null ? (
                    <span className="tool-diff-text" dangerouslySetInnerHTML={{ __html: hl || " " }} />
                  ) : (
                    <span className="tool-diff-text">{op.text || " "}</span>
                  )}
                </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// UnifiedDiffLines renders a parsed git-diff file (hunk lines straight from
// `git diff`) with per-line syntax highlighting, reusing the tool-diff-line
// styles. Meta lines (@@ hunk headers) render dimmed without a +/− gutter.
function UnifiedDiffLines({ file, lines }: { file: string; lines: DiffOp[] }) {
  const [hljs, setHljs] = useState<Hljs | null>(null);
  const lang = langForPath(file);
  useEffect(() => {
    if (!lang) return;
    let cancelled = false;
    void loadCodeHighlighter()
      .then((h) => {
        if (!cancelled) setHljs(h);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lang]);
  const highlightLine = (text: string): string | null => {
    if (!hljs || !lang || !hljs.getLanguage(lang)) return null;
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  };
  return (
    <div className="tool-diff">
      <div className="tool-diff-body">
        {lines.map((op, i) => {
          if (op.kind === "meta") {
            return (
              <div key={i} className="tool-diff-line tool-diff-line-meta">
                <span className="tool-diff-text">{op.text || " "}</span>
              </div>
            );
          }
          const hl = highlightLine(op.text);
          return (
            <div key={i} className={`tool-diff-line tool-diff-line-${op.kind}`}>
              <span className="tool-diff-gutter" aria-hidden="true">
                {op.kind === "add" ? "+" : op.kind === "remove" ? "−" : " "}
              </span>
              {hl != null ? (
                <span className="tool-diff-text" dangerouslySetInnerHTML={{ __html: hl || " " }} />
              ) : (
                <span className="tool-diff-text">{op.text || " "}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Session diffs (the "Diffs · N" pill + bottom sheet) ──
// Aggregates every file the agent changed this session from its Edit / Write /
// MultiEdit tool calls (reusing extractEditPairs + lineDiff): one entry per
// file with its total added/removed line counts and the underlying edit pairs
// (so the detail view can render the real diff via ToolDiffView).
const DIFF_TOOL_NAMES = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export interface SessionFileDiff {
  file: string;
  added: number;
  removed: number;
  // Legacy per-edit aggregation (sessionDiffs) renders from old/new pairs.
  pairs: EditPair[];
  // The real git diff (parseUnifiedDiff) renders from hunk lines instead; when
  // present the drawer prefers these over pairs.
  lines?: DiffOp[];
}

// parseUnifiedDiff turns a `git diff` (the daemon's real working-tree diff)
// into the per-file shape the Diffs drawer renders. Reflects uncommitted
// changes only — a commit clears it, since the daemon recomputes `git diff`
// against HEAD each time.
export function parseUnifiedDiff(text: string): SessionFileDiff[] {
  const files: SessionFileDiff[] = [];
  let cur: SessionFileDiff | null = null;
  let oldPath = "";
  const stripAB = (p: string) => p.replace(/^[ab]\//, "");
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/ b\/(.*)$/);
      cur = { file: m ? m[1] : "", added: 0, removed: 0, pairs: [], lines: [] };
      oldPath = "";
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("--- ")) {
      const p = raw.slice(4).trim();
      oldPath = p === "/dev/null" ? "" : stripAB(p);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      cur.file = p === "/dev/null" ? (oldPath || cur.file) : (stripAB(p) || cur.file);
      continue;
    }
    if (raw.startsWith("@@")) {
      cur.lines!.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      cur.lines!.push({ kind: "add", text: raw.slice(1) });
      cur.added++;
    } else if (raw.startsWith("-")) {
      cur.lines!.push({ kind: "remove", text: raw.slice(1) });
      cur.removed++;
    } else if (raw.startsWith(" ")) {
      cur.lines!.push({ kind: "context", text: raw.slice(1) });
    }
    // index/mode/rename headers and "\ No newline…" are ignored.
  }
  // Keep only files that actually have changes (a bare rename with no hunk
  // still counts — it has a file but 0 lines; drop those for the drawer).
  return files.filter((f) => f.file && (f.lines?.length ?? 0) > 0);
}

export function sessionDiffs(turns: SessionTurn[]): SessionFileDiff[] {
  const byFile = new Map<string, SessionFileDiff>();
  const order: string[] = [];
  for (const t of turns) {
    if (t.kind !== "tool_call") continue;
    const tool = String(t.payload?.tool ?? "").replace(/^mcp__[^_]+__/, "");
    if (!DIFF_TOOL_NAMES.has(tool)) continue;
    for (const pair of extractEditPairs(tool, (t.payload?.input ?? {}) as ToolInput)) {
      if (!pair.file) continue;
      let added = 0;
      let removed = 0;
      for (const op of lineDiff(pair.old, pair.new)) {
        if (op.kind === "add") added++;
        else if (op.kind === "remove") removed++;
      }
      let entry = byFile.get(pair.file);
      if (!entry) {
        entry = { file: pair.file, added: 0, removed: 0, pairs: [] };
        byFile.set(pair.file, entry);
        order.push(pair.file);
      }
      entry.added += added;
      entry.removed += removed;
      entry.pairs.push(pair);
    }
  }
  return order.map((f) => byFile.get(f) as SessionFileDiff);
}

// SessionDiffSheet is the diff drawer: a bottom sheet listing every changed
// file (name + added/removed + a stacked ratio bar), where tapping a file
// drills into its full diff (rendered by the shared, syntax-highlighted
// ToolDiffView).
export function SessionDiffSheet({ diffs, open, onClose }: { diffs: SessionFileDiff[]; open: boolean; onClose: () => void }) {
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => {
    if (!open) setSel(null);
  }, [open]);
  // Esc closes (detail → list → sheet).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (sel != null) setSel(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, sel, onClose]);

  const totalAdded = diffs.reduce((n, f) => n + f.added, 0);
  const totalRemoved = diffs.reduce((n, f) => n + f.removed, 0);
  const active = sel != null ? diffs[sel] ?? null : null;

  // Portal to <body>: the sheet renders deep inside the composer subtree (a CSS
  // grid cell with its own stacking context / transformed ancestor), so a
  // position:fixed scrim there wouldn't actually cover the conversation header.
  // Mounting at the document root makes it a true top-level overlay that dims
  // everything behind it.
  return createPortal(
    <div className={`diffsheet-layer ${open ? "is-open" : ""}`} aria-hidden={!open}>
      <button type="button" className="diffsheet-scrim" aria-label={tx("diffSheet.close")} tabIndex={open ? 0 : -1} onClick={onClose} />
      <section className="diffsheet" role="dialog" aria-label={tx("diffSheet.title")} aria-modal="true">
        <span className="diffsheet-grip" aria-hidden="true" />

        {active ? (
          <header className="diffsheet-head is-detail">
            <button type="button" className="diffsheet-back" aria-label={tx("diffSheet.backToList")} onClick={() => setSel(null)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
            </button>
            <span className="diffsheet-title">
              <strong className="diffsheet-detail-file">{active.file}</strong>
              <small><i className="add">+{active.added}</i> <i className="del">−{active.removed}</i></small>
            </span>
            <button type="button" className="diffsheet-x" aria-label={tx("diffSheet.close")} onClick={onClose}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </header>
        ) : (
          <header className="diffsheet-head">
            <span className="diffsheet-title">
              <strong>{tx("diffSheet.title")}</strong>
              <small>{diffs.length} {tx("diffSheet.files")} · <i className="add">+{totalAdded}</i> <i className="del">−{totalRemoved}</i></small>
            </span>
            <button type="button" className="diffsheet-x" aria-label={tx("diffSheet.close")} onClick={onClose}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </header>
        )}

        {active ? (
          <div className="diffsheet-detail">
            {active.lines && active.lines.length > 0 ? (
              <UnifiedDiffLines file={active.file} lines={active.lines} />
            ) : (
              <ToolDiffView pairs={active.pairs ?? []} />
            )}
          </div>
        ) : (
          <div className="diffsheet-list">
            {diffs.map((item, i) => {
              const total = item.added + item.removed;
              const addPct = total ? Math.round((item.added / total) * 100) : 0;
              // Absolute paths are long; show a compacted tail so the filename
              // always stays visible (dir muted, name emphasised).
              const shown = compactPath(item.file);
              const slash = shown.lastIndexOf("/");
              const dir = slash >= 0 ? shown.slice(0, slash + 1) : "";
              const name = slash >= 0 ? shown.slice(slash + 1) : shown;
              return (
                <button type="button" className="diffsheet-row" key={`${item.file}:${i}`} onClick={() => setSel(i)}>
                  <i className="diffsheet-glyph" aria-hidden="true">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3v5h5" /><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /></svg>
                  </i>
                  <span className="diffsheet-name"><span className="dir">{dir}</span>{name}</span>
                  <span className="diffsheet-stat">
                    <i className="add">+{item.added}</i><i className="del">−{item.removed}</i>
                    <i className="diffsheet-bar" aria-hidden="true"><b style={{ width: addPct + "%" }} /></i>
                  </span>
                  <svg className="diffsheet-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                </button>
              );
            })}
          </div>
        )}

        {/* Footer is only the "Next file" shortcut for multi-file diffs; on the
            last/only file there's nothing to advance to and the top-left back
            arrow already returns to the list, so we drop the footer to avoid a
            redundant second "back" button. */}
        {active && sel != null && sel < diffs.length - 1 ? (
          <div className="diffsheet-foot">
            <button type="button" className="diffsheet-open" onClick={() => setSel(sel + 1)}>
              {tx("diffSheet.nextFile")}
              <span className="diffsheet-open-sub">{baseName(diffs[sel + 1].file)}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
            </button>
          </div>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

export function compactPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `${parts.at(-3)}/${parts.at(-2)}/${parts.at(-1)}`;
}

export function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  const keep = Math.max(4, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

export function titleCaseTool(tool: string) {
  return tool
    .replace(/^mcp__[^_]+__/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// Tool specs own their display icon. The default spec covers unknown
// tools, and dedicated specs override for distinctive glyphs.

function MarkdownBlock({ markdown }: { markdown: string }) {
	  const ref = useRef<HTMLDivElement | null>(null);

	  useEffect(() => {
	    if (!ref.current) return;
	    let cancelled = false;
	    void renderMarkdown(markdown).then(({ html, highlightElement, renderMath }) => {
	      if (cancelled || !ref.current) return;
	      ref.current.innerHTML = html;
	      const codeNodes = Array.from(ref.current.querySelectorAll("pre code"));
	      for (const node of codeNodes) {
	        highlightElement(node as HTMLElement);
	        decorateCodeBlock(node);
	      }
	      // Render math sentinels if the lazy-loaded KaTeX module came back.
	      // renderMath is null when no math was detected or the dynamic import
	      // failed; both cases leave the empty span/div hidden by CSS.
	      if (renderMath) {
	        const mathNodes = ref.current.querySelectorAll("[data-tex]");
	        mathNodes.forEach((node) => renderMath(node));
	      }
	    });
	    return () => {
	      cancelled = true;
	    };
	  }, [markdown]);

	  return <div ref={ref} className="markdown-block" />;
}

// ── Syntax highlighting for code surfaces (Read results, Edit diffs) ──
//
// highlight.js/lib/core is a singleton module shared with renderMarkdown, so
// languages registered here are visible there too (and registration is
// idempotent). Lazy + cached: the first code render pulls the grammars; nothing
// hits the initial bundle. highlight.js HTML-escapes the source, so its output
// is safe to inject.
type Hljs = Awaited<typeof import("highlight.js/lib/core")>["default"];
let codeHighlighterPromise: Promise<Hljs> | null = null;
function loadCodeHighlighter(): Promise<Hljs> {
  if (!codeHighlighterPromise) {
    codeHighlighterPromise = (async () => {
      const [core, bash, c, cpp, csharp, css, diff, go, java, javascript, json, kotlin, markdownLang, php, python, ruby, rust, sql, swift, typescript, xml, yaml] = await Promise.all([
        import("highlight.js/lib/core"),
        import("highlight.js/lib/languages/bash"),
        import("highlight.js/lib/languages/c"),
        import("highlight.js/lib/languages/cpp"),
        import("highlight.js/lib/languages/csharp"),
        import("highlight.js/lib/languages/css"),
        import("highlight.js/lib/languages/diff"),
        import("highlight.js/lib/languages/go"),
        import("highlight.js/lib/languages/java"),
        import("highlight.js/lib/languages/javascript"),
        import("highlight.js/lib/languages/json"),
        import("highlight.js/lib/languages/kotlin"),
        import("highlight.js/lib/languages/markdown"),
        import("highlight.js/lib/languages/php"),
        import("highlight.js/lib/languages/python"),
        import("highlight.js/lib/languages/ruby"),
        import("highlight.js/lib/languages/rust"),
        import("highlight.js/lib/languages/sql"),
        import("highlight.js/lib/languages/swift"),
        import("highlight.js/lib/languages/typescript"),
        import("highlight.js/lib/languages/xml"),
        import("highlight.js/lib/languages/yaml"),
      ]);
      const hljs = core.default;
      const reg = (mod: { default: unknown }, ...names: string[]) => {
        for (const n of names) hljs.registerLanguage(n, mod.default as never);
      };
      reg(bash, "bash", "sh", "shell", "zsh");
      reg(c, "c", "h");
      reg(cpp, "cpp", "cc", "cxx", "hpp", "hh");
      reg(csharp, "csharp", "cs");
      reg(css, "css", "scss", "less");
      reg(diff, "diff");
      reg(go, "go");
      reg(java, "java");
      reg(javascript, "javascript", "js", "jsx");
      reg(json, "json");
      reg(kotlin, "kotlin", "kt");
      reg(markdownLang, "markdown", "md");
      reg(php, "php");
      reg(python, "python", "py");
      reg(ruby, "ruby", "rb");
      reg(rust, "rust", "rs");
      reg(sql, "sql");
      reg(swift, "swift");
      reg(typescript, "typescript", "ts", "tsx");
      reg(xml, "xml", "html", "htm", "svg", "vue");
      reg(yaml, "yaml", "yml");
      return hljs;
    })();
  }
  return codeHighlighterPromise;
}

// EXT_TO_LANG maps a file extension to a registered highlight.js language.
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  go: "go", py: "python", rb: "ruby", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", php: "php", swift: "swift", sql: "sql",
  css: "css", scss: "css", less: "css",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  json: "json", jsonc: "json", json5: "json",
  yml: "yaml", yaml: "yaml",
  sh: "bash", bash: "bash", zsh: "bash",
  md: "markdown", markdown: "markdown",
};

// langForPath returns the highlight.js language for a file path, or "" when we
// have no grammar for it (caller renders plain text).
export function langForPath(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec((path ?? "").trim());
  return m ? (EXT_TO_LANG[m[1].toLowerCase()] ?? "") : "";
}

// highlightCode returns highlight.js HTML for code in lang, or null when the
// language is unknown or highlighting fails (caller falls back to plain text).
async function highlightCode(code: string, lang: string): Promise<string | null> {
  if (!lang) return null;
  try {
    const hljs = await loadCodeHighlighter();
    if (!hljs.getLanguage(lang)) return null;
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

// parseCodeLines splits a code body into displayable lines, stripping Claude's
// Read line-number prefixes ("  123\t<line>") when present so we can render a
// proper gutter. Falls back to sequential numbering for un-prefixed content.
export function parseCodeLines(raw: string): { num: number | null; text: string }[] {
  const rawLines = raw.replace(/\n$/, "").split("\n");
  let numbered = 0;
  const parsed = rawLines.map((line) => {
    const m = /^\s*(\d+)\t(.*)$/.exec(line);
    if (m) {
      numbered++;
      return { num: Number(m[1]), text: m[2] };
    }
    return { num: null as number | null, text: line };
  });
  if (numbered >= Math.max(1, Math.floor(rawLines.length * 0.6))) return parsed;
  return rawLines.map((line, i) => ({ num: i + 1, text: line }));
}

// CodeView renders a file body with a line-number gutter and syntax
// highlighting. Used for Read results. The body is highlighted as a single
// block (so multi-line constructs colour correctly) and the gutter is a
// parallel column aligned by line-height.
function CodeView({ code, lang }: { code: string; lang: string }) {
  const lines = useMemo(() => parseCodeLines(code), [code]);
  const body = useMemo(() => lines.map((l) => l.text).join("\n"), [lines]);
  const gutter = useMemo(() => lines.map((l) => (l.num == null ? "" : String(l.num))).join("\n"), [lines]);
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    void highlightCode(body, lang).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [body, lang]);
  return (
    <div className="code-view tool-raw-block">
      <pre className="code-view-gutter" aria-hidden="true">{gutter}</pre>
      <pre className="code-view-body">
        {html != null ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{body}</code>}
      </pre>
    </div>
  );
}

async function renderMarkdown(markdown: string) {
  const [
    { default: DOMPurify },
    { marked },
    hljs,
    bash,
    diff,
    go,
    json,
    markdownLang,
    typescript,
  ] = await Promise.all([
    import("dompurify"),
    import("marked"),
    import("highlight.js/lib/core"),
    import("highlight.js/lib/languages/bash"),
    import("highlight.js/lib/languages/diff"),
    import("highlight.js/lib/languages/go"),
    import("highlight.js/lib/languages/json"),
    import("highlight.js/lib/languages/markdown"),
    import("highlight.js/lib/languages/typescript"),
  ]);
  hljs.default.registerLanguage("bash", bash.default);
  hljs.default.registerLanguage("sh", bash.default);
  hljs.default.registerLanguage("shell", bash.default);
  hljs.default.registerLanguage("diff", diff.default);
  hljs.default.registerLanguage("go", go.default);
  hljs.default.registerLanguage("json", json.default);
  hljs.default.registerLanguage("markdown", markdownLang.default);
  hljs.default.registerLanguage("md", markdownLang.default);
  hljs.default.registerLanguage("typescript", typescript.default);
  hljs.default.registerLanguage("ts", typescript.default);
  hljs.default.registerLanguage("tsx", typescript.default);
  marked.setOptions({ gfm: true, breaks: false });
  configureMarkedOnce(marked);
  const rawHTML = marked.parse(markdown) as string;
  // Tag fenced code blocks with data-lang="<language>" so CSS can
  // render a language label without interfering with the copy button.
  // DOMPurify allows data-* attributes by default, so the value flows
  // through without extending ALLOWED_ATTR.
  const html = DOMPurify.sanitize(
    rawHTML.replace(codeBlockRE, '<pre class="code-shell" data-lang="$1"><code class="language-$1">'),
    {
      USE_PROFILES: { html: true },
      ALLOWED_ATTR: ["class", "href", "title", "target", "rel", "aria-label"],
      FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "input", "button"],
    },
  );
  // Only load KaTeX when math is actually present. The check is against the
  // sanitized HTML so we know DOMPurify kept our sentinel; if it ever strips the
  // sentinel, the data-tex spans render as empty and the lazy import is skipped.
  let renderMath: ((node: Element) => void) | null = null;
  if (html.includes("data-tex=")) {
    try {
      const [katexMod] = await Promise.all([
        import("katex"),
        // Side-effect CSS import — Vite injects the stylesheet on
        // first call. Subsequent renders find it already mounted.
        import("katex/dist/katex.min.css"),
      ]);
      const katex = katexMod.default;
      renderMath = (node: Element) => {
        const tex = node.getAttribute("data-tex") || "";
        // <div class="math-display"> → display mode (centered, large)
        // <span class="math-inline">  → inline mode (line-height aware)
        const displayMode = node.tagName.toLowerCase() === "div";
        try {
          katex.render(tex, node as HTMLElement, {
            throwOnError: false,
            displayMode,
            // output: "html" avoids MathML, keeping the DOM closer to plain
            // HTML and avoiding Safari MathML font fallback quirks.
            output: "html",
          });
        } catch {
          // Leave the sentinel as-is; CSS hides empty data-tex spans
          // so the user sees nothing rather than a stack trace.
        }
      };
    } catch {
      // KaTeX import failed (offline / CSP / etc.) — leave sentinels.
    }
  }
  return { html, highlightElement: hljs.default.highlightElement, renderMath };
}

// marked.use mutates a singleton and stacks renderer overrides on every call.
// Calling it once per renderMarkdown invocation grew the listitem renderer
// chain unbounded over the lifetime of the page. Gate behind a module-level flag
// so the renderer override is registered exactly once.
let markedConfigured = false;
function configureMarkedOnce(marked: typeof import("marked").marked) {
  if (markedConfigured) return;
  markedConfigured = true;
  // Rewrite GFM task-list items so the checkbox is a styled span, not
  // an <input>. marked 14's default emits `<li><input type="checkbox"
  // disabled checked> ...</li>`, but our DOMPurify config forbids the
  // input tag (kept out to deny XSS-friendly fields). Rendering the
  // checkbox via CSS on a span sidesteps the whole input-allowlist
  // discussion and keeps the sanitizer surface narrow.
  marked.use({
    renderer: {
      listitem(item) {
        if (!item.task) return false;
        const checked = item.checked ? " is-checked" : "";
        const inner = this.parser.parse(item.tokens);
        return `<li class="task-item"><span class="task-check${checked}" aria-hidden="true"></span>${inner}</li>\n`;
      },
    },
    // LaTeX math extensions. The tokenizer emits sentinel HTML nodes carrying
    // the raw TeX in data-tex; an opt-in lazy KaTeX pass in renderMarkdown then
    // replaces those sentinels with the rendered formula. Splitting "tokenize"
    // from "render" lets us skip loading KaTeX when no math is present.
    //
    // Block math: $$...$$  and  \[...\]
    // Inline math:           \(...\)
    //
    // Single-$ inline math is intentionally NOT supported — it
    // collides with currency mentions ("a $5 fix") which are common
    // in Claude transcripts. Users who want inline math should use
    // \( ... \).
    extensions: [
      {
        name: "mathBlock",
        level: "block",
        start(src: string) {
          const m = src.match(/\$\$|\\\[/);
          return m ? m.index : undefined;
        },
        tokenizer(src: string) {
          // $$ ... $$ (greedy through newlines)
          let match = src.match(/^\$\$([\s\S]+?)\$\$\n?/);
          if (match) {
            return { type: "mathBlock", raw: match[0], tex: match[1].trim() };
          }
          // \[ ... \]
          match = src.match(/^\\\[([\s\S]+?)\\\]\n?/);
          if (match) {
            return { type: "mathBlock", raw: match[0], tex: match[1].trim() };
          }
          return undefined;
        },
        renderer(token) {
          // marked's RendererExtensionFunction passes a Generic; the
          // tokenizer above guarantees a `tex` string field.
          const tex = (token as { tex?: string }).tex ?? "";
          return `<div class="math-display" data-tex="${escapeHtmlAttr(tex)}"></div>`;
        },
      },
      {
        name: "mathInline",
        level: "inline",
        start(src: string) {
          const m = src.match(/\\\(/);
          return m ? m.index : undefined;
        },
        tokenizer(src: string) {
          const match = src.match(/^\\\(([\s\S]+?)\\\)/);
          if (match) {
            return { type: "mathInline", raw: match[0], tex: match[1].trim() };
          }
          return undefined;
        },
        renderer(token) {
          const tex = (token as { tex?: string }).tex ?? "";
          return `<span class="math-inline" data-tex="${escapeHtmlAttr(tex)}"></span>`;
        },
      },
    ],
  });
}

// HTML-attribute escape for data-tex. KaTeX takes the raw TeX source, so this
// only needs to keep the value valid inside a double-quoted HTML attribute.
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Quick detector: returns true if the markdown contains any supported math
// delimiters outside obvious code-fence contexts. Used by renderMarkdown to
// skip the KaTeX lazy-load when no math is present.
export function hasMathSyntax(markdown: string): boolean {
  if (!markdown) return false;
  // Strip fenced code blocks before scanning so `$$x$$` inside ``` ```
  // doesn't trigger a false positive. Backtick inline code is a
  // narrower case — marked's inline tokenizer claims those before
  // our extension fires, so we don't need to strip them here.
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, "");
  return /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/.test(withoutFences);
}

function decorateCodeBlock(node: Element) {
  const pre = node.parentElement;
  if (!pre) return;
  if (!pre.querySelector(".copy-btn")) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-btn";
    copyBtn.textContent = tx("workspace.copy");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(node.textContent ?? "");
      copyBtn.textContent = tx("workspace.copied");
      window.setTimeout(() => {
        copyBtn.textContent = tx("workspace.copy");
      }, 1200);
    });
    pre.appendChild(copyBtn);
  }
  if (node.textContent && node.textContent.split("\n").length > 18 && !pre.querySelector(".collapse-btn")) {
    pre.classList.add("is-collapsed");
    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "collapse-btn";
    collapseBtn.textContent = tx("workspace.expand");
    collapseBtn.addEventListener("click", () => {
      const collapsed = pre.classList.toggle("is-collapsed");
      collapseBtn.textContent = collapsed ? tx("workspace.expand") : tx("workspace.collapse");
    });
    pre.appendChild(collapseBtn);
  }
}

// Exported so the renderer fixture can match the workspace's exact
// pre-render pipeline (sidechain nesting + adjacent-pair merging +
// consecutive-tool grouping). Tests that ship raw turn arrays would
// otherwise get a subtly different render order.
// Attachment payloads Claude Code injects as session context or control
// events are not conversation content. Permission requests render only in
// the composer-adjacent PermissionRequestsPanel while pending; resolved
// allow/deny events remain data-only and never become historical cards.
// Attachment blocks are Claude Code SESSION-CONTEXT PLUMBING, never conversation
// content. The conversation itself rides on user_message / assistant_text /
// thinking / tool_call / tool_result / image blocks; attachments are the side
// channel Claude uses to push context into the model — skill/agent listings,
// deferred-tool & MCP-instruction deltas, invoked-skills records, compaction
// file references, nested-memory loads, file-content injections, edited-file
// snapshots, hook context, queued commands, mode/effort/date markers, task
// reminders, permission prompts, and more.
//
// The type set is open-ended and grows every Claude release, so an explicit
// block-list always leaks the NEXT new type as an empty "附件 · <type>" card —
// which is exactly what kept happening (file, nested_memory, invoked_skills,
// compact_file_reference, edited_text_file, hook_additional_context, …). So we
// INVERT the rule: every attachment type is internal by default, and we surface
// only the ones we've built a real renderer for. There are none today —
// permission_request is rendered via its own dedicated card path (scanned
// separately from the conversation flow), not as a generic attachment. Add a
// type to SURFACED_ATTACHMENT_TYPES only once there's an actual renderer that
// makes it conversation-meaningful.
const SURFACED_ATTACHMENT_TYPES = new Set<string>([]);

// isInternalAttachmentType reports whether an attachment is Claude Code
// session-context plumbing (hidden) rather than something we deliberately
// surface as conversation content.
function isInternalAttachmentType(type: string): boolean {
  return !SURFACED_ATTACHMENT_TYPES.has(type);
}

export function isRenderableConversationTurn(turn: SessionTurn) {
  if (turn.kind === "meta") return false;
  if (turn.kind === "user_message") {
    const parsed = parseUserMessage(turn.payload?.text ?? "");
    return !(parsed.kind === "plain" && !parsed.text.trim());
  }
  if (turn.kind === "assistant_text") {
    return Boolean(stripInternalContent(turn.payload?.text ?? "").trim());
  }
  if (turn.kind === "attachment") {
    const t = (turn.payload?.attachment_type ?? "").toLowerCase();
    return !isInternalAttachmentType(t);
  }
  return true;
}

export function visibleConversationTurns(turns: SessionTurn[]) {
  // NOTE: consecutive same-tool runs are intentionally NOT pre-collapsed into
  // `tool_group` carriers here. The narrative renderer (segmentGroupBody →
  // ToolNarrativeGroup → narrativePhrase) already condenses a run into a single
  // line ("Edited 4 files") with a drill-in body of the individual cards. Doing
  // it twice produced two inconsistent renderings in one conversation — a run
  // of >=4 became a "4 次连续调用" ToolGroupCard while shorter/mixed runs stayed
  // narrative. Let every tool run flow through the narrative path so the styling
  // is uniform.
  // dedupeAssistantTextEchoes runs FIRST so a reply stored twice (live SDK
  // bridge copy + uuid-less jsonl sync copy — endemic to codex, whose rollouts
  // have no per-message ids) collapses before mergeAdjacentAssistantTurns
  // would otherwise fuse both copies into one bubble showing the sentence
  // twice.
  return mergeAdjacentToolPairs(
    mergeAdjacentAssistantTurns(
      nestSidechainTurns(dedupeAssistantTextEchoes(turns.filter(isRenderableConversationTurn))),
    ),
  );
}

// Move sidechain (subagent) turns under their spawning Task tool_call so
// the user gets a collapsible "subagent ran X tools" card instead of N
// loose blocks visually peer-leveled with the main agent's reply. Turns
// whose parent_tool_use_id matches a Task carrier elsewhere in the list
// are removed from the main flow and stashed on the carrier's
// payload._sidechain_items. Unmatched sidechain turns (broken chain,
// partial sync) stay in place — better to show them with a sidechain
// indent style than silently lose them.
export function nestSidechainTurns(turns: SessionTurn[]): SessionTurn[] {
  const carrierIndex = new Map<string, number>();
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.kind === "tool_call" && t.payload?.id && !t.payload.is_sidechain) {
      carrierIndex.set(t.payload.id, i);
    }
  }
  const collected = new Map<number, SessionTurn[]>();
  const dropped = new Set<number>();
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const parent = t.payload?.parent_tool_use_id;
    if (t.payload?.is_sidechain && parent) {
      const ci = carrierIndex.get(parent);
      if (ci !== undefined && ci !== i) {
        const bucket = collected.get(ci) ?? [];
        bucket.push(t);
        collected.set(ci, bucket);
        dropped.add(i);
      }
    }
  }
  if (collected.size === 0) return turns;
  const out: SessionTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (dropped.has(i)) continue;
    const t = turns[i];
    const items = collected.get(i);
    if (items && items.length > 0) {
      out.push({
        ...t,
        payload: { ...(t.payload ?? {}), _sidechain_items: items },
      });
    } else {
      out.push(t);
    }
  }
  return out;
}

// Cluster 4+ consecutive tool_call turns that share the same `payload.tool`
// into a single tool_group carrier turn. Browser-automation runs emit
// dozens of identical mcp_* calls back to back; rendered as individual
// cards they swamp the timeline. The carrier keeps the original turns
// under `_group_items` so the renderer can offer a click-to-expand drill-in.
const TOOL_GROUP_THRESHOLD = 4;

export function groupConsecutiveTools(turns: SessionTurn[]): SessionTurn[] {
  const out: SessionTurn[] = [];
  let i = 0;
  while (i < turns.length) {
    const turn = turns[i];
    const tool = turn.kind === "tool_call" ? turn.payload?.tool : undefined;
    if (!tool) {
      out.push(turn);
      i++;
      continue;
    }
    let j = i + 1;
    while (
      j < turns.length &&
      turns[j].kind === "tool_call" &&
      turns[j].payload?.tool === tool
    ) {
      j++;
    }
    const runLength = j - i;
    if (runLength >= TOOL_GROUP_THRESHOLD) {
      const items = turns.slice(i, j);
      out.push({
        ...turn,
        kind: "tool_group",
        timestamp: items[items.length - 1].timestamp || turn.timestamp,
        payload: {
          tool,
          _group_items: items,
        },
      });
      i = j;
    } else {
      out.push(turn);
      i++;
    }
  }
  return out;
}

// Pair a tool_call with its tool_result so the renderer can collapse the
// two articles into a single compact card. Matches by payload.id (the
// tool_use_id) when both turns expose one; falls back to adjacency for
// older payload shapes. The result is folded onto the call via the
// non-wire `_paired_result` field so the wire type SessionTurn stays
// untouched.
export function mergeAdjacentToolPairs(turns: SessionTurn[]): SessionTurn[] {
  const out: SessionTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const next = turns[i + 1];
    if (
      turn.kind === "tool_call" &&
      next &&
      next.kind === "tool_result" &&
      (!turn.payload?.id || !next.payload?.id || turn.payload.id === next.payload.id)
    ) {
      const callPayload = turn.payload ?? {};
      const resultPayload = next.payload ?? {};
      const mergedPayload: NonNullable<SessionTurn["payload"]> = {
        ...callPayload,
        _paired_result: true,
      };
      const resolvedResult = resultPayload.result ?? resultPayload.text ?? callPayload.result;
      if (resolvedResult !== undefined) mergedPayload.result = resolvedResult;
      const resolvedHasResult = resultPayload.has_result ?? Boolean(resultPayload.result ?? resultPayload.text);
      if (resolvedHasResult) mergedPayload.has_result = true;
      const resolvedError = resultPayload.is_error ?? callPayload.is_error;
      if (resolvedError) mergedPayload.is_error = true;
      out.push({
        ...turn,
        timestamp: next.timestamp || turn.timestamp,
        payload: mergedPayload,
      });
      i++;
      continue;
    }
    out.push(turn);
  }
  return out;
}

export function mergeAdjacentAssistantTurns(turns: SessionTurn[]): SessionTurn[] {
  const out: SessionTurn[] = [];
  for (const turn of turns) {
    const last = out[out.length - 1];
    if (last && last.kind === "assistant_text" && turn.kind === "assistant_text") {
      const lastText = last.payload?.text ?? "";
      const nextText = turn.payload?.text ?? "";
      const mergedText = lastText && nextText ? `${lastText}\n\n${nextText}` : lastText || nextText;
      out[out.length - 1] = {
        ...last,
        payload: { ...(last.payload ?? {}), text: mergedText },
        timestamp: turn.timestamp || last.timestamp,
      };
    } else {
      out.push(turn);
    }
  }
  return out;
}

// Shared empty / preparing / edge-state block used by the reader so
// transient "no turns yet" states keep one visual language.
function WsEmpty({
  icon,
  tone,
  head,
  sub,
  helper,
  footer,
}: {
  icon: ReactNode;
  tone?: "danger" | "live";
  head: ReactNode;
  sub?: ReactNode;
  helper?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="ws-empty">
      <div className={tone ? `icon-bubble is-${tone}` : "icon-bubble"} aria-hidden="true">
        {icon}
      </div>
      <div className="head">{head}</div>
      {sub ? <div className="sub">{sub}</div> : null}
      {helper ? <div className="helper">{helper}</div> : null}
      {footer}
    </div>
  );
}

// The reader's "a session is selected but there are no turns to show" state,
// resolved by the session's liveness and connection state: dead session, no
// connected computer, offline (read_only), a freshly-empty writable session
// ("ready to hand off"), or a load error.
function ReaderEdgeState({
  session,
  daemonDevices,
  hosts,
  turnsStatus,
  dead,
  onBack,
  onRefresh,
}: {
  session: SessionListItem;
  daemonDevices: Device[];
  hosts: HostSummary[];
  turnsStatus: string;
  dead: boolean;
  onBack: () => void;
  onRefresh: () => void;
}) {
  if (dead) {
    return (
      <WsEmpty
        icon={<Trash2 size={23} aria-hidden="true" />}
        head={tx("workspace.deadSessionTitle")}
        sub={tx("workspace.deadSessionBody")}
        footer={
          <button type="button" className="pockly-empty-inline-link" onClick={onBack}>
            {tx("workspace.backToSessions")} →
          </button>
        }
      />
    );
  }
  const hasDevice =
    daemonDevices.some((device) => device.device_id === session.device_id) ||
    hosts.some((host) => host.device_id === session.device_id);
  if (!hasDevice) {
    return (
      <WsEmpty
        icon={<Laptop size={24} aria-hidden="true" />}
        tone="danger"
        head={tx("workspace.bridgeNoDeviceTitle")}
        sub={tx("workspace.bridgeNoDeviceBody")}
      />
    );
  }
  if (sessionConnectionMode(session) === "read_only") {
    const lazyOffline = offlineLazyBackfillMessage(session);
    return (
      <WsEmpty
        icon={<MonitorOff size={24} aria-hidden="true" />}
        tone="danger"
        head={lazyOffline?.title ?? tx("workspace.bridgeOfflineTitle")}
        sub={lazyOffline?.body ?? tx("workspace.bridgeOfflineBody")}
      />
    );
  }
  // Writable session with no turns yet → ready to hand off. Any other status
  // here is a load error; keep the raw status so a maintainer can see it.
  if (turnsStatus === "empty") {
    return (
      <WsEmpty
        icon={<CheckCircle2 size={26} aria-hidden="true" />}
        tone="live"
        head={tx("workspace.bridgeReadyTitle")}
        sub={tx("workspace.bridgeReadyBody")}
      />
    );
  }
  return (
    <WsEmpty
      icon={<RefreshCw size={22} aria-hidden="true" />}
      head={turnsStatus}
      sub={tx("workspace.retryReader")}
      footer={
        <button type="button" className="pockly-empty-inline-link" onClick={onRefresh}>
          {tx("workspace.refresh")} →
        </button>
      }
    />
  );
}

function parseRoute(): Route {
  if (window.location.pathname === "/") return { view: "workspaceSessions" };
  if (window.location.pathname === "/login") return { view: "login" };
  if (window.location.pathname === "/duplex-test") {
    const env = window.POCKLY_CONFIG?.environment || "local";
    if (env === "local") return { view: "duplexTest" };
    return { view: "workspaceSessions" };
  }
  if (window.location.pathname === "/cli/login") {
    const deviceCode = new URLSearchParams(window.location.search).get("device_code")?.trim() ?? "";
    if (!deviceCode) {
      return {
        view: "routeError",
        title: tx("workspace.missingDeviceCode"),
        body: tx("workspace.missingDeviceCodeBody"),
      };
    }
    return { view: "cliLogin", deviceCode };
  }
  if (window.location.pathname === "/workspace/simple") return { view: "workspaceSessions" };
  if (window.location.pathname === "/workspace/connect") {
    const setupGrant = new URLSearchParams(window.location.search).get("daemon_setup")?.trim() ?? "";
    return { view: "workspaceConnect", ...(setupGrant ? { setupGrant } : {}) };
  }
  if (window.location.pathname === "/local-setup") {
    // The daemon's loopback handshake stuffs nonce + cb + grant into the URL
    // fragment so they do not appear in Referer, server logs, or browser
    // history search. We parse them with URLSearchParams after stripping the
    // leading "#".
    const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
    const params = new URLSearchParams(raw);
    const grant = params.get("grant")?.trim() ?? "";
    const nonce = params.get("nonce")?.trim() ?? "";
    const cb = params.get("cb")?.trim() ?? "";
    if (!grant || !nonce || !cb) {
      return {
        view: "routeError",
        title: tx("localSetup.invalidTitle"),
        body: tx("localSetup.invalidBody"),
      };
    }
    return { view: "localSetup", grant, nonce, cb };
  }
  if (window.location.pathname === "/mobile-join") {
    const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
    const grant = new URLSearchParams(raw).get("grant")?.trim() ?? "";
    if (!grant) {
      return {
        view: "routeError",
        title: tx("mobileJoin.invalidTitle"),
        body: tx("mobileJoin.invalidBody"),
      };
    }
    return { view: "mobileJoin", grant };
  }
  if (window.location.pathname === "/workspace/devices") return { view: "workspaceDevices" };
  if (window.location.pathname === "/workspace/live") return { view: "workspaceLive" };
  // /workspace/new was a standalone page; it is now a drawer overlaid on the
  // sessions view. Keep the URL as a graceful redirect for any in-flight links.
  if (window.location.pathname === "/workspace/new") return { view: "workspaceSessions" };
  if (window.location.pathname === "/workspace/settings") return { view: "workspaceSettings" };
  if (window.location.pathname === "/workspace/sessions") return { view: "workspaceSessions" };
  const match = window.location.pathname.match(/^\/workspace\/s\/([^/]+)$/);
  if (match) {
    const deviceId = new URLSearchParams(window.location.search).get("device_id")?.trim();
    if (!deviceId) {
      return {
        view: "routeError",
        title: tx("workspace.sessionMissingDevice"),
        body: tx("workspace.sessionMissingDeviceBody"),
      };
    }
    return {
      view: "workspaceSession",
      sessionId: decodeURIComponent(match[1]),
      deviceId,
    };
  }
  return { view: "workspaceSessions" };
}

function routeToPath(route: Route) {
  switch (route.view) {
    case "login":
      return "/login";
    case "cliLogin":
      return `/cli/login?device_code=${encodeURIComponent(route.deviceCode)}`;
    case "duplexTest":
      return "/duplex-test";
    case "workspaceConnect":
      return route.setupGrant ? `/workspace/connect?daemon_setup=${encodeURIComponent(route.setupGrant)}` : "/workspace/connect";
    case "localSetup":
      // Preserve fragment encoding so after-login redirect lands here intact.
      return `/local-setup#grant=${encodeURIComponent(route.grant)}&nonce=${encodeURIComponent(route.nonce)}&cb=${encodeURIComponent(route.cb)}`;
    case "mobileJoin":
      return `/mobile-join#grant=${encodeURIComponent(route.grant)}`;
    case "workspaceDevices":
      return "/workspace/devices";
    case "workspaceLive":
      return "/workspace/live";
    case "workspaceSettings":
      return "/workspace/settings";
    case "workspaceSessions":
      return "/workspace/sessions";
    case "workspaceSession": {
      const url = new URL(`/workspace/s/${encodeURIComponent(route.sessionId)}`, window.location.origin);
      url.searchParams.set("device_id", route.deviceId);
      return `${url.pathname}${url.search}`;
    }
    case "routeError":
      return window.location.pathname + window.location.search;
  }
}

function isReaderRoute(route: Route) {
  return route.view === "workspaceSessions" || route.view === "workspaceSession";
}

function isWorkspaceLiveRoute(route: Route) {
  return route.view === "workspaceLive";
}

function isPublicRoute(route: Route) {
  return route.view === "duplexTest" || route.view === "mobileJoin";
}

function isAuthenticatedWorkspaceRoute(route: Route) {
  return route.view === "workspaceSessions" ||
    route.view === "workspaceSession" ||
    route.view === "workspaceConnect" ||
    route.view === "workspaceDevices" ||
    route.view === "workspaceLive" ||
    route.view === "workspaceSettings";
}

export function shouldGateAuthenticatedWorkspaceSplash(route: Route) {
  return isAuthenticatedWorkspaceRoute(route);
}

export function pickSelection(
  sessions: SessionListItem[],
  route: Route,
  current?: ReaderSelection | null,
  devices: Device[] = [],
  hosts: HostSummary[] = [],
) {
  const context: SessionContinuationContext = {
    devicesById: new Map(devices.map((device) => [device.device_id, device])),
    hostsById: new Map(hosts.map((host) => [host.device_id, host])),
  };
  if (route.view === "workspaceSession") {
    const routed = sessions.find((session) =>
      session.session_id === route.sessionId && session.device_id === route.deviceId);
    if (routed) return { sessionId: routed.session_id, deviceId: routed.device_id };
    // Catalog may lag the route by a few seconds — e.g. a draft just got
    // promoted to a real session_id via the daemon's session_created event,
    // but Nexus catalog sync hasn't included it yet. If `current`
    // already points at this routed session_id, keep it instead of falling
    // through to bestContinuationCandidate, which would silently jump to a
    // different session (typically the most-active one on the same device).
    if (current && current.sessionId === route.sessionId && current.deviceId === route.deviceId) {
      return { sessionId: current.sessionId, deviceId: current.deviceId };
    }
    const sameSession = [...sessions]
      .filter((session) => session.session_id === route.sessionId)
      .sort((left, right) => compareSessionContinuation(right, left, context))[0];
    if (sameSession) return { sessionId: sameSession.session_id, deviceId: sameSession.device_id };
    const sameDevice = bestContinuationCandidate(sessions.filter((session) => session.device_id === route.deviceId), context);
    if (sameDevice) return { sessionId: sameDevice.session_id, deviceId: sameDevice.device_id };
    const best = bestContinuationCandidate(sessions, context);
    return best ? { sessionId: best.session_id, deviceId: best.device_id } : null;
  }
  if (current) {
    // Drafts are client-side only — they never appear in Nexus
    // session catalog. Without this short-circuit, every catalog
    // refresh that runs through pickSelection while a draft is the
    // current selection would fall through to bestContinuationCandidate
    // below and silently replace the draft with the most-active real
    // session. The user then types into a textarea bound to a different
    // session, their first prompt lands as a resume_session inject into
    // that real session, and the daemon's start_task path never runs.
    if (current.sessionId.startsWith("draft_")) {
      return { sessionId: current.sessionId, deviceId: current.deviceId };
    }
    const existing = sessions.find((session) => session.session_id === current.sessionId && session.device_id === current.deviceId);
    if (existing) return { sessionId: existing.session_id, deviceId: existing.device_id };
  }
  const first = bestContinuationCandidate(sessions, context);
  return first ? { sessionId: first.session_id, deviceId: first.device_id } : null;
}

function mergeTurns(current: SessionTurn[], incoming: SessionTurn[]) {
  const byKey = new Map<string, SessionTurn>();
  for (const turn of current) byKey.set(turnKey(turn), turn);
  for (const turn of incoming) byKey.set(turnKey(turn), turn);
  return [...byKey.values()].sort((a, b) => a.seq - b.seq);
}

// normalizeUserMessageKey hashes a user-message body for dedup matching.
// The optimistic "sending" bubble carries exactly what the user typed; the
// confirmed copy comes back from the agent's jsonl / event bridge, which can
// differ in whitespace OR full-/half-width punctuation — a Chinese IME emits
// the full-width "？" (U+FF1F) but the round-trip can surface the ASCII "?",
// and vice versa. Keying dedup on the raw trimmed text left BOTH bubbles
// (observed: one sent message rendered twice). NFKC folds full-width forms to
// their ASCII equivalents and we collapse whitespace, so the optimistic ghost
// and its confirmed twin hash identically and the ghost is dropped.
export function normalizeUserMessageKey(text: string | undefined): string {
  return (text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

// `authoritative` marks `hydrated` as the COMPLETE server-truth turn list for
// the session (a GET /turns response returns the whole session, ORDER BY seq,
// no window). In that mode a `current` genuine turn (seq < 9e8) is redundant: it is
// either already in `hydrated` under the same seq (mergeTurns folds it) or it is
// a STALE copy the live turnHub push (subscribeToSession → reconcile, App.tsx
// ~931) left behind under a DIFFERENT genuine-seq scheme — Nexus stamps live
// SDK `user_input`/`message_added` bridge turns with the terminal-event counter
// (evt.Seq) while the jsonl history sync stamps the same message with a
// block-index seq (minSeq+idx). Two genuine same-text turns at different seqs
// defeat dedupeUserMessageGhosts (it preserves them as a legit double-send), so
// one send rendered as two bubbles — for BOTH the user message and the assistant
// reply — until a full reload. Dropping stale genuine turns here lets the
// authoritative copy represent the message. The single-turn turnHub merge passes
// authoritative=false so it stays purely additive (it must not wipe history when
// only one new turn arrives).
export function reconcileHydratedTurns(current: SessionTurn[], hydrated: SessionTurn[], authoritative = false) {
  if (current.length === 0) return hydrated;
  if (hydrated.length === 0) return current;
  const confirmedHydrated = hydrated.filter((turn) => turn.seq < 900_000_000).sort((a, b) => a.seq - b.seq);
  const hydratedUserTexts = new Set(
    hydrated
      .filter((turn) => turn.kind === "user_message")
      .map((turn) => normalizeUserMessageKey(turn.payload?.text))
      .filter(Boolean),
  );
  // Confirmed hydrated assistant replies, used to dedup live/streamed
  // assistant turns the hydration has now caught up to. Without this a
  // streamed assistant turn (synthetic seq >= 1e9) and its hydrated
  // counterpart (real seq) both survive mergeTurns — they key on seq —
  // so the reply renders twice until a full reload. (SDK sessions hit
  // this on every turn; the persisted jsonl only ever has one copy.)
  // Normalize whitespace so the streamed copy and the persisted copy don't
  // diverge over trailing newlines / collapsed spaces — a mismatch there used
  // to defeat the dedup and leave the reply rendered twice until a reload.
  const normalizeReply = (value: string) => value.replace(/\s+/g, " ").trim();
  const hydratedAssistantTexts = confirmedHydrated
    .filter((turn) => turn.kind === "assistant_text")
    .map((turn) => normalizeReply(turn.payload?.text ?? ""))
    .filter(Boolean);
  const preserved: SessionTurn[] = [];
  for (let index = 0; index < current.length; index += 1) {
    const turn = current[index];
    if (turn.seq < 900_000_000) {
      // Stale genuine turn from a prior (possibly different-seq-scheme) copy.
      // The authoritative hydrated set already carries the durable history, so
      // drop it — this is what kills the live-vs-synced double bubble.
      if (authoritative) continue;
      preserved.push(turn);
      continue;
    }
    if (turn.kind === "assistant_text") {
      // Drop the live (synthetic-seq) turn once a hydrated reply covers the
      // same text. Whitespace-normalized and two-directional:
      //   - hydrated === live        → exact (post-normalize)
      //   - hydrated.includes(live)  → live is a still-partial prefix
      //   - live.includes(hydrated)  → live ran slightly ahead of the
      //     persisted copy (length floor so a short reply that's a substring
      //     of a longer, different live reply can't wrongly drop it)
      // If hydration hasn't caught up yet, keep the live turn so the reply
      // stays visible while streaming.
      const text = normalizeReply(turn.payload?.text ?? "");
      if (
        text &&
        hydratedAssistantTexts.some(
          (h) => h === text || h.includes(text) || (h.length >= 8 && text.includes(h)),
        )
      ) {
        continue;
      }
      preserved.push(turn);
      continue;
    }
    if (turn.kind !== "user_message") {
      preserved.push(turn);
      continue;
    }
    const text = normalizeUserMessageKey(turn.payload?.text);
    if (text && hydratedUserTexts.has(text)) continue;
    const previousSeq = current
      .slice(0, index)
      .filter((item) => item.seq < 900_000_000)
      .reduce((max, item) => Math.max(max, item.seq), 0);
    const turnTime = Date.parse(turn.timestamp);
    const nextByTime = Number.isFinite(turnTime)
      ? confirmedHydrated.find((item) => {
          const itemTime = Date.parse(item.timestamp);
          return Number.isFinite(itemTime) && itemTime > turnTime;
        })
      : undefined;
    const nextBySeq = confirmedHydrated.find((item) => item.seq > previousSeq);
    const next = nextByTime ?? nextBySeq;
    const displaySeq = next
      ? next.seq - 0.001 * (preserved.length + 1)
      : previousSeq + 0.001 * (preserved.length + 1);
    preserved.push({ ...turn, seq: displaySeq });
  }
  return dedupeUserMessageGhosts(dedupeTurnsByUuid(mergeTurns(preserved, hydrated)));
}

// turnBlockIdentity is a per-BLOCK key for de-duplication. Nexus can
// persist ONE logical block under TWO seqs: the live SDK stream bridge
// (control.go bridgeSDKTerminalEventToTurn) stamps the terminal-event counter,
// while the daemon's jsonl history sync stamps a block index — both carry the
// same record uuid (e.g. an assistant reply lands at seq 6 AND seq 8). Keyed on
// seq alone, mergeTurns keeps both and the reply renders twice.
//
// BUT a uuid is per jsonl RECORD, not per block: a single record routinely
// expands to MULTIPLE blocks — a user message is [image, text], an assistant
// turn is [thinking, text, tool_use] — and the daemon stamps every one of those
// blocks with the SAME record uuid (blocks.go sets UUID: rec.UUID). Keying
// dedup on uuid alone therefore collapses an entire record to its first block
// and silently drops the rest (this is what made a user's image+text message
// render as just the image, losing the text). So the key must also include the
// block kind plus a content discriminator that tells sibling blocks apart while
// still folding the SAME block arriving twice:
//   - id            → tool_call id / tool_result tool_use_id (unique per call,
//                     so parallel tool calls in one record stay distinct)
//   - text          → user_message / assistant_text / thinking / attachment
//   - image_data /
//     image_url     → inline images (so [image, image] stays two blocks)
// Returns null when there's no uuid (meta rows, still-streaming live turns) so
// those pass through untouched.
function turnBlockIdentity(turn: SessionTurn): string | null {
  const p = turn.payload as Record<string, unknown> | undefined;
  const uuid = typeof p?.uuid === "string" ? p.uuid : "";
  if (!uuid) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const disc =
    str(p?.id) || str(p?.text) || str(p?.image_data) || str(p?.image_url) || "";
  return JSON.stringify([uuid, turn.kind, disc]);
}

// dedupeTurnsByUuid collapses turns that are the SAME block stored twice (same
// uuid + kind + content), keeping the first (lowest seq, set by mergeTurns'
// sort). Distinct blocks of one record — different kind or content — are kept.
function dedupeTurnsByUuid(turns: SessionTurn[]): SessionTurn[] {
  const seen = new Set<string>();
  const out: SessionTurn[] = [];
  for (const turn of turns) {
    const key = turnBlockIdentity(turn);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(turn);
  }
  return out;
}

// dedupeUserMessageGhosts collapses duplicate user-message bubbles that
// the streaming + reconcile pipeline can leave behind. Two artifact
// kinds accumulate across repeated reconcile passes (reconcile is not
// idempotent on its own):
//   - optimistic turns (synthetic seq >= 9e8) that were never dropped
//   - fractional-seq "ghosts" minted by the displaySeq slotting above,
//     which on the next pass count as confirmed (< 9e8) and get
//     re-preserved, so each pass can mint another copy.
// Observed live: a single follow-up rendered as 5+ identical bubbles.
//
// dedupeAssistantTextEchoes collapses ONE assistant reply that the pipeline
// stored TWICE — the assistant-side sibling of dedupeUserMessageGhosts.
//
// Why it happens (worst for codex): the live SDK bridge stores the reply with
// the app-server item id as its uuid, while the jsonl history sync stores the
// SAME reply again with NO uuid at all — codex rollouts don't persist
// per-message ids (verified empirically: response_item.message payloads carry
// only {type, role, content, phase}). dedupeTurnsByUuid therefore can't fold
// the pair, both copies live in the server table under different seqs, and the
// same sentence renders twice. The optimistic live bubble (synthetic seq, no
// uuid) is a third copy when text-match reconcile misses.
//
// Rule: two assistant_text turns with the same whitespace-normalized text are
// one message stored twice when they are NOT both uuid-bearing (two DISTINCT
// uuids = genuinely repeated replies — keep both) AND they happened at ~the
// same moment (timestamps within ASSISTANT_ECHO_WINDOW_MS) or one copy is a
// live artifact (synthetic/fractional seq). Same-uuid copies always collapse.
// The survivor prefers the uuid-bearing copy (stable block identity) at the
// earlier copy's position. Genuine repeats minutes apart are untouched.
//
// Runs at RENDER time (visibleConversationTurns) so it also hides pairs that
// are already persisted server-side — a state-merge-only dedup can't help a
// session whose duplicate rows are in the table.
const ASSISTANT_ECHO_WINDOW_MS = 120_000;

export function dedupeAssistantTextEchoes(turns: SessionTurn[]): SessionTurn[] {
  const isArtifact = (t: SessionTurn) => t.seq >= 900_000_000 || !Number.isInteger(t.seq);
  const uuidOf = (t: SessionTurn) => (typeof t.payload?.uuid === "string" ? t.payload.uuid : "");
  const keptByText = new Map<string, number[]>(); // normalized text → indices into out
  const out: SessionTurn[] = [];
  for (const turn of turns) {
    if (turn.kind !== "assistant_text") {
      out.push(turn);
      continue;
    }
    const text = (turn.payload?.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) {
      out.push(turn);
      continue;
    }
    const peers = keptByText.get(text) ?? [];
    let absorbed = false;
    for (const idx of peers) {
      const kept = out[idx];
      const keptUuid = uuidOf(kept);
      const turnUuid = uuidOf(turn);
      const sameUuid = Boolean(keptUuid) && keptUuid === turnUuid;
      if (!sameUuid) {
        // Two distinct uuids = two durable jsonl records = genuine repeats.
        if (keptUuid && turnUuid) continue;
        const tKept = Date.parse(kept.timestamp);
        const tTurn = Date.parse(turn.timestamp);
        const closeInTime =
          Number.isFinite(tKept) && Number.isFinite(tTurn) &&
          Math.abs(tKept - tTurn) <= ASSISTANT_ECHO_WINDOW_MS;
        if (!closeInTime && !isArtifact(kept) && !isArtifact(turn)) continue;
      }
      // Same message stored twice → keep ONE. Prefer the uuid-bearing copy,
      // surfaced at the earlier copy's seq so ordering is stable.
      if (!keptUuid && turnUuid) out[idx] = { ...turn, seq: kept.seq };
      absorbed = true;
      break;
    }
    if (absorbed) continue;
    peers.push(out.length);
    keptByText.set(text, peers);
    out.push(turn);
  }
  return out;
}

// Rule: group user_message turns by trimmed text. A genuine hydrated
// copy is one with an INTEGER seq < 9e8. If a text has any genuine copy,
// drop all of that text's artifact copies (optimistic or fractional).
// Otherwise keep only the lowest-seq artifact so the message still shows
// while streaming. Genuine repeats (distinct integer seqs) are preserved
// — a user really sending the same text twice keeps both bubbles.
function dedupeUserMessageGhosts(turns: SessionTurn[]): SessionTurn[] {
  const isArtifact = (t: SessionTurn) => t.seq >= 900_000_000 || !Number.isInteger(t.seq);
  const uuidOf = (t: SessionTurn) => (typeof t.payload?.uuid === "string" ? t.payload.uuid : "");
  const genuineUserTexts = new Set(
    turns
      .filter((t) => t.kind === "user_message" && !isArtifact(t))
      .map((t) => normalizeUserMessageKey(t.payload?.text))
      .filter(Boolean),
  );
  // Does any GENUINE copy of this user text carry a jsonl uuid? A real
  // double-send produces TWO durable jsonl records (two distinct uuids); the
  // live-vs-synced artifact produces ONE uuid'd history record plus a no-uuid
  // live-bridge copy (Nexus SDK user_input bridge stamps text only, with
  // the terminal-event counter as seq — a genuine integer seq, so it can't be
  // told apart from a real second send by seq alone). When a uuid'd copy
  // exists, the no-uuid copies are duplicates of it and must be dropped.
  const textHasGenuineUuid = new Set<string>();
  for (const t of turns) {
    if (t.kind === "user_message" && !isArtifact(t) && uuidOf(t)) {
      const key = normalizeUserMessageKey(t.payload?.text);
      if (key) textHasGenuineUuid.add(key);
    }
  }
  const keptArtifactText = new Set<string>();
  const keptGenuineUuids = new Set<string>();
  const out: SessionTurn[] = [];
  for (const turn of [...turns].sort((a, b) => a.seq - b.seq)) {
    if (turn.kind !== "user_message") {
      out.push(turn);
      continue;
    }
    const text = normalizeUserMessageKey(turn.payload?.text);
    if (!text) {
      out.push(turn);
      continue;
    }
    if (isArtifact(turn)) {
      if (genuineUserTexts.has(text)) continue; // a genuine copy represents it
      if (keptArtifactText.has(text)) continue; // already kept one artifact for this text
      keptArtifactText.add(text);
      out.push(turn);
      continue;
    }
    // Genuine (durable, integer-seq) user turn. Dedup by uuid so live-vs-synced
    // copies of ONE message collapse, while genuine repeats (distinct uuids)
    // are both preserved.
    const uuid = uuidOf(turn);
    if (uuid) {
      const key = JSON.stringify([text, uuid]);
      if (keptGenuineUuids.has(key)) continue; // same message already kept
      keptGenuineUuids.add(key);
      out.push(turn);
      continue;
    }
    // No uuid → live-bridge copy. Drop it ONLY when a uuid'd history copy of
    // the same text exists (that durable copy supersedes it — this is the
    // live-vs-synced double-bubble fix). Absent any uuid'd copy, keep it: two
    // no-uuid copies with no durable counterpart are a still-live genuine
    // double-send, not an artifact.
    if (textHasGenuineUuid.has(text)) continue;
    out.push(turn);
  }
  return out;
}

function lastConfirmedSeq(turns: SessionTurn[]) {
  let max = 0;
  for (const turn of turns) {
    if (turn.seq > max && turn.seq < 900_000_000) max = turn.seq;
  }
  return max;
}

export function sessionTurnsFetchOptionsForCachedOpen(turns: SessionTurn[]) {
  const cachedMaxSeq = lastConfirmedSeq(turns);
  return {
    limit: SESSION_TURNS_WINDOW_LIMIT,
    ...(cachedMaxSeq > 0 ? { afterSeq: cachedMaxSeq } : {}),
  };
}

export function selectedSessionTailFetchOptions(turns: SessionTurn[]) {
  const confirmedMaxSeq = lastConfirmedSeq(turns);
  const afterSeq = confirmedMaxSeq > SELECTED_SESSION_TAIL_OVERLAP_TURNS
    ? confirmedMaxSeq - SELECTED_SESSION_TAIL_OVERLAP_TURNS
    : 0;
  return {
    limit: SESSION_TURNS_WINDOW_LIMIT,
    ...(afterSeq > 0 ? { afterSeq } : {}),
  };
}

export function shouldPollSelectedSessionTail(input: {
  authenticated: boolean;
  readerRoute: boolean;
  selected?: ReaderSelection | null;
  turnsStatus?: string;
}) {
  if (!input.authenticated || !input.readerRoute || !input.selected) return false;
  if (input.selected.sessionId.startsWith("draft_")) return false;
  if (input.turnsStatus === "loading" || input.turnsStatus === "syncing") return false;
  return true;
}

export function shouldRefreshSelectedSessionOpenHint(input: {
  now: number;
  lastHintAt: number;
  refreshHint: boolean;
  intervalMs?: number;
}) {
  if (!input.refreshHint) return false;
  const intervalMs = input.intervalMs ?? SELECTED_SESSION_OPEN_HINT_REFRESH_MS;
  return input.now - input.lastHintAt >= intervalMs;
}

function claimSelectedSessionOpenHint(selection: ReaderSelection, now: number) {
  try {
    const key = `${SELECTED_SESSION_OPEN_HINT_STORAGE_PREFIX}${selection.deviceId}:${selection.sessionId}`;
    const last = Number(globalThis.localStorage?.getItem(key) ?? 0) || 0;
    if (now - last < SELECTED_SESSION_OPEN_HINT_REFRESH_MS) return false;
    globalThis.localStorage?.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

export function shouldFetchHotTailAfterIncremental({
  cachedMaxSeq,
  response,
  session,
  limit = SESSION_TURNS_WINDOW_LIMIT,
}: {
  cachedMaxSeq: number;
  response: SessionTurnsResponse;
  session?: SessionListItem | null | undefined;
  limit?: number;
}) {
  if (cachedMaxSeq <= 0) return false;
  const responseLatestSeq = Number(response.latest_seq ?? response.turns.at(-1)?.seq ?? 0) || 0;
  const syncedMaxSeq = Number(response.synced_max_seq ?? session?.synced_max_seq ?? session?.last_seq ?? session?.turn_count ?? 0) || 0;
  const expectedLatestSeq = Math.max(responseLatestSeq, syncedMaxSeq);
  if (expectedLatestSeq <= cachedMaxSeq) return false;
  const loadedIncremental = response.turns.length;
  if (responseLatestSeq >= expectedLatestSeq) return false;
  if (loadedIncremental >= limit) return true;
  return expectedLatestSeq - cachedMaxSeq > loadedIncremental;
}

export function isAgentResponseTurnAfter(turn: SessionTurn, baselineSeq: number) {
  if (turn.seq <= baselineSeq || turn.seq >= 900_000_000) return false;
  if (turn.kind === "user_message" || turn.kind === "thinking") return false;
  if (turn.kind === "assistant_text") return Boolean(turn.payload?.text?.trim());
  return true;
}

export function appendStreamingTurn(current: SessionTurn[], incoming: SessionTurn) {
  const deviceID = incoming.device_id ?? current.at(-1)?.device_id;
  let hydrated: SessionTurn = incoming;
  if (deviceID) {
    hydrated = { ...incoming, device_id: deviceID };
  }
  if (hydrated.payload?.append) {
    const next = [...current];
    const candidate = next.at(-1);
    if (
      candidate?.kind === "assistant_text" &&
      candidate.seq >= 1_000_000_000 &&
      candidate.session_id === hydrated.session_id &&
      (candidate.device_id ?? deviceID) === (hydrated.device_id ?? deviceID)
    ) {
      next[next.length - 1] = {
        ...candidate,
        payload: {
          ...candidate.payload,
          text: `${candidate.payload?.text ?? ""}${hydrated.payload?.text ?? ""}`,
        },
      };
      return next;
    }
  }
  if (hydrated.kind === "assistant_text" && !hydrated.payload?.append && hydrated.seq >= 1_000_000_000) {
    const next = current.filter((candidate) => !(
      candidate.kind === "assistant_text" &&
      candidate.seq >= 1_000_000_000 &&
      candidate.session_id === hydrated.session_id &&
      (candidate.device_id ?? deviceID) === (hydrated.device_id ?? deviceID)
    ));
    return mergeTurns(next, [hydrated]);
  }
  return mergeTurns(current, [hydrated]);
}

function optimisticTurn(session: SessionListItem, text: string, kind: "user_message" | "assistant_text", seq: number): SessionTurn {
  return {
    device_id: session.device_id,
    session_id: session.session_id,
    seq,
    agent: session.agent,
    kind,
    timestamp: new Date().toISOString(),
    payload: { text },
  };
}

function nextOptimisticSeq(ref: { current: number }) {
  ref.current += 1
  return ref.current
}

function turnKey(turn: SessionTurn) {
  return `${turn.device_id ?? ""}:${turn.session_id}:${turn.seq}`;
}

function sameTurnIdentity(left: SessionTurn, right: SessionTurn) {
  return (
    left.seq === right.seq &&
    left.session_id === right.session_id &&
    (left.device_id ?? "") === (right.device_id ?? "") &&
    left.kind === right.kind
  );
}

export function shouldRestoreFailedSendOnControlError(phase: InjectPhase, reachedDurableAgentEvent: boolean) {
  if (phase === "failed" || phase === "cancelled") return true;
  if (reachedDurableAgentEvent) return false;
  return phase === "idle" || phase === "started";
}

export function shouldScheduleInjectRefreshAfterStream(phase: InjectPhase) {
  return phase !== "completed" && phase !== "failed" && phase !== "cancelled";
}

function hasSession(sessions: SessionListItem[], selection: ReaderSelection) {
  return sessions.some((session) => session.session_id === selection.sessionId && session.device_id === selection.deviceId);
}

export function findCreatedSessionForDraft(sessions: SessionListItem[], draft: DraftConversation) {
  // A draft with no cwd ("直接聊天，不选目录") has no project identity, so we
  // cannot distinguish it from any other recent claude-code session on the
  // same device via heuristics — the previous (draftProject && ...) gate
  // accidentally allowed cwd to be ignored entirely in that case, so the
  // next catalog refresh would silently bind the draft to an unrelated live
  // session (e.g. another wrapper's jsonl being actively written). For
  // these drafts the ONLY safe promotion path is the daemon's
  // session_created event, which carries the exact spawned session_id.
  if (!draft.cwd) return null;
  const draftTime = Date.parse(draft.last_timestamp) || 0;
  const draftProject = lastPathSegment(draft.cwd);
  return sessions
    .filter((session) => {
      if (session.device_id !== draft.device_id || session.agent !== draft.agent) return false;
      if (session.cwd !== draft.cwd && session.cwd !== draftProject) return false;
      const sessionTime = Date.parse(session.last_timestamp) || 0;
      return draftTime === 0 || sessionTime === 0 || sessionTime >= draftTime - 60_000;
    })
    .sort((a, b) => (Date.parse(b.last_timestamp) || 0) - (Date.parse(a.last_timestamp) || 0))[0] ?? null;
}

function isDraftConversation(session: SessionListItem | null): session is DraftConversation {
  return Boolean(session && "isDraft" in session && session.isDraft && session.session_id.startsWith("draft_"));
}

function projectKeyForSession(session: SessionListItem) {
  return `${session.device_id}::${normalizeCwdHint(session.cwd || "")}`;
}

function projectDisplayName(session: SessionListItem) {
  if (isDraftConversation(session)) return tx("task.newConversation");
  return lastPathSegment(session.cwd) || session.cwd || tx("workspace.untitledProject");
}

function shortDeviceName(deviceId: string) {
  if (!deviceId) return tx("devices.computer");
  if (deviceId.length <= 12) return deviceId;
  return `${deviceId.slice(0, 6)}...${deviceId.slice(-4)}`;
}

function shortConversationID(sessionId: string) {
  if (!sessionId) return tx("workspace.loadingConversation");
  if (sessionId.length <= 18) return sessionId;
  return `${sessionId.slice(0, 10)}...${sessionId.slice(-6)}`;
}

function sessionSyncState(session: SessionListItem) {
  if (isDraftConversation(session)) return "catalog_only";
  if (session.sync_state) return session.sync_state;
  if ((session.synced_turn_count ?? 0) > 0) {
    const total = session.turn_count || session.last_seq || 0;
    return total > 0 && (session.synced_turn_count ?? 0) >= total ? "fully_synced" : "partial";
  }
  return session.last_seq > 0 ? "ready" : "catalog_only";
}

function shouldLazySyncSession(session: SessionListItem) {
  const state = sessionSyncState(session);
  return state === "catalog_only" || state === "failed" || state === "syncing" || state === "partial";
}

export const AUTOMATIC_SESSION_BACKFILL_TURN_LIMIT = 1000;

export function isLargeSession(session: SessionListItem | null | undefined) {
  const total = Number(session?.turn_count ?? session?.last_seq ?? 0) || 0;
  return total > AUTOMATIC_SESSION_BACKFILL_TURN_LIMIT;
}

export function isLargeSessionForAutomaticBackfill(session: SessionListItem | null | undefined) {
  const loaded = Number(session?.synced_turn_count ?? 0) || 0;
  const total = Number(session?.turn_count ?? session?.last_seq ?? 0) || 0;
  return isLargeSession(session) && loaded < total;
}

export function sessionCatalogRefreshIntervalForSession(session: SessionListItem | null | undefined) {
  return isLargeSession(session) ? LARGE_SESSION_CATALOG_REFRESH_MS : SESSION_CATALOG_REFRESH_MS;
}

export function injectPollOptionsForSession(session: SessionListItem | null | undefined, realtimeLive: boolean) {
  // With the realtime socket live, TURN pushes carry the content and this poll
  // only tracks lifecycle. Large local-first sessions also use a slower poll
  // because their history reads are intentionally on-demand and cost-bounded.
  if (realtimeLive) return { pollIntervalMs: CONTROL_EVENT_POLL_RELAXED_MS };
  if (isLargeSession(session)) return { pollIntervalMs: LARGE_SESSION_ACTIVE_EVENT_POLL_MS };
  return {};
}

export function shouldSyncSessionOnOpen(session: SessionListItem, turns: SessionTurn[]) {
  if (turns.length > 0) return false;
  if (isLargeSessionForAutomaticBackfill(session)) return false;
  const state = sessionSyncState(session);
  if (state === "ready" || state === "fully_synced") return false;
  return shouldLazySyncSession(session);
}

export function shouldRefreshPersistentTurnsAfterSync(receivedTransientTurns: boolean) {
  // SYNC_SESSION_EVENT turns are intentionally transient for local-first
  // history windows. Re-reading /turns after receiving them can replace the
  // in-memory window with an empty remote hot window for large sessions.
  return !receivedTransientTurns;
}

export function nextLazyBackfillBeforeSeq(
  hydration: SessionTurnsResponse | null,
  turns: SessionTurn[],
  session: SessionListItem | null,
) {
  const loadedBefore = Number(hydration?.next_loaded_before_seq ?? 0) || 0;
  if (loadedBefore > 1) return loadedBefore;
  // Non-contiguous lazy history can have rows 1..40 and 141..240. In that case
  // oldest_seq is already 1, so the only valid cursor is Nexus' next gap hint.
  const hinted = Number(hydration?.next_before_seq ?? 0) || 0;
  if (hinted > 1) return hinted;
  const contiguous = Number(hydration?.latest_contiguous_min_seq ?? 0) || 0;
  if (contiguous > 1) return contiguous;
  return Number(hydration?.oldest_seq ?? 0) || Number(turns[0]?.seq ?? 0) || Number(session?.synced_min_seq ?? 0) || 0;
}

function loadedTurnCount(hydration: SessionTurnsResponse | null, turns: SessionTurn[]) {
  return Math.max(
    turns.length,
    visibleConversationTurns(hydration?.turns ?? []).length,
  );
}

export function hasEarlierTurns(
  hydration: SessionTurnsResponse | null,
  turns: SessionTurn[],
  session: SessionListItem | null,
) {
  if (Number(hydration?.next_loaded_before_seq ?? 0) > 1) return true;
  if (hydration?.has_older_turns || session?.has_older_turns) return true;
  const total = Number(hydration?.total_turn_count ?? session?.turn_count ?? session?.last_seq ?? 0) || 0;
  return total > loadedTurnCount(hydration, turns);
}

function isCompleteTurnsResponse(response: SessionTurnsResponse | null | undefined) {
  const limit = Number(response?.window_limit ?? 0) || 0;
  return limit <= 0;
}

function mergeTurnHydration(current: SessionTurnsResponse | null, incoming: SessionTurnsResponse): SessionTurnsResponse {
  if (!current) return { ...incoming, source: sessionTurnsHydrationSource(incoming) };
  const oldestSeq = Math.min(
    positiveSeq(current.oldest_seq, incoming.oldest_seq),
    positiveSeq(incoming.oldest_seq, current.oldest_seq),
  );
  const latestSeq = Math.max(Number(current.latest_seq ?? 0) || 0, Number(incoming.latest_seq ?? 0) || 0);
  const out: SessionTurnsResponse = {
    ...current,
    ...incoming,
    turns: mergeTurns(current.turns ?? [], incoming.turns ?? []),
    next_loaded_before_seq: incoming.next_loaded_before_seq ?? 0,
    has_older_turns: Boolean(incoming.has_older_turns || current.has_older_turns),
    source: mergeSessionTurnsSources(current, incoming),
  };
  if (oldestSeq > 0) out.oldest_seq = oldestSeq;
  if (latestSeq > 0) out.latest_seq = latestSeq;
  const nextBeforeSeq = incoming.next_before_seq ?? current.next_before_seq;
  if (nextBeforeSeq !== undefined) out.next_before_seq = nextBeforeSeq;
  return out;
}

function incrementalTurnsHydration(
  current: SessionTurnsResponse | null,
  incoming: SessionTurnsResponse,
  turns: SessionTurn[],
): SessionTurnsResponse {
  const oldest = Number(turns[0]?.seq ?? current?.oldest_seq ?? incoming.oldest_seq ?? 0) || 0;
  const latest = Number(turns[turns.length - 1]?.seq ?? incoming.latest_seq ?? current?.latest_seq ?? 0) || 0;
  const out: SessionTurnsResponse = {
    ...(current ?? incoming),
    ...incoming,
    turns,
    ...(oldest ? { oldest_seq: oldest } : {}),
    ...(latest ? { latest_seq: latest } : {}),
    next_loaded_before_seq: current?.next_loaded_before_seq ?? incoming.next_loaded_before_seq ?? 0,
    has_older_turns: Boolean(incoming.has_older_turns || current?.has_older_turns),
    source: mergeSessionTurnsSources(current, incoming),
  };
  const syncedTurnCount = incoming.synced_turn_count ?? current?.synced_turn_count;
  const syncedMinSeq = incoming.synced_min_seq ?? current?.synced_min_seq;
  const syncedMaxSeq = incoming.synced_max_seq ?? current?.synced_max_seq;
  const latestContiguousMinSeq = incoming.latest_contiguous_min_seq ?? current?.latest_contiguous_min_seq;
  const nextBeforeSeq = incoming.next_before_seq ?? current?.next_before_seq;
  const totalTurnCount = incoming.total_turn_count ?? current?.total_turn_count;
  if (syncedTurnCount !== undefined) out.synced_turn_count = syncedTurnCount;
  if (syncedMinSeq !== undefined) out.synced_min_seq = syncedMinSeq;
  if (syncedMaxSeq !== undefined) out.synced_max_seq = syncedMaxSeq;
  if (latestContiguousMinSeq !== undefined) out.latest_contiguous_min_seq = latestContiguousMinSeq;
  if (nextBeforeSeq !== undefined) out.next_before_seq = nextBeforeSeq;
  if (totalTurnCount !== undefined) out.total_turn_count = totalTurnCount;
  return out;
}

export function transientTurnsHydration(sessionId: string, turns: SessionTurn[], event: SyncSessionEvent): SessionTurnsResponse {
  const sorted = [...turns].sort((a, b) => Number(a.seq) - Number(b.seq));
  const oldest = Number(sorted[0]?.seq ?? 0) || 0;
  const latest = Number(sorted[sorted.length - 1]?.seq ?? 0) || 0;
  return {
    session_id: sessionId,
    turns: sorted,
    source: "local_transient",
    ...(oldest ? { oldest_seq: oldest } : {}),
    ...(latest ? { latest_seq: latest } : {}),
    window_limit: sorted.length,
    next_loaded_before_seq: 0,
    synced_turn_count: sorted.length,
    synced_min_seq: oldest,
    synced_max_seq: latest,
    latest_contiguous_min_seq: oldest,
    next_before_seq: oldest > 1 && (event.has_older || Number(event.total_turn_count ?? 0) > sorted.length) ? oldest : 0,
    ...(event.total_turn_count !== undefined ? { total_turn_count: event.total_turn_count } : {}),
    has_older_turns: Boolean(event.has_older || oldest > 1),
  };
}

function sessionTurnsHydrationSource(response: SessionTurnsResponse | null | undefined): NonNullable<SessionTurnsResponse["source"]> {
  return response?.source ?? "remote_hot_window";
}

function mergeSessionTurnsSources(
  current: SessionTurnsResponse | null | undefined,
  incoming: SessionTurnsResponse | null | undefined,
): NonNullable<SessionTurnsResponse["source"]> {
  const left = sessionTurnsHydrationSource(current);
  const right = sessionTurnsHydrationSource(incoming);
  if (left === right) return left;
  return "mixed";
}

function positiveSeq(value: unknown, fallback: unknown) {
  const parsed = Number(value ?? 0) || 0;
  if (parsed > 0) return parsed;
  return Number(fallback ?? 0) || 0;
}

export function offlineLazyBackfillMessage(session: SessionListItem) {
  if (sessionConnectionMode(session) !== "read_only") return null;
  const state = sessionSyncState(session);
  const total = session.turn_count || session.last_seq || 0;
  const loaded = session.synced_turn_count ?? 0;
  if ((state === "catalog_only" || state === "partial" || state === "failed") && total > loaded) {
    return {
      title: tx("workspace.lazyBackfillOfflineTitle"),
      body: tx("workspace.lazyBackfillOfflineBody", { loaded, total }),
    };
  }
  return null;
}

function sessionSyncLabel(session: SessionListItem) {
  switch (sessionSyncState(session)) {
    case "syncing":
      return tx("common.syncing");
    case "ready":
    case "fully_synced":
      return tx("common.ready");
    case "partial":
      return tx("common.latestSynced");
    case "failed":
      return tx("common.failed");
    default:
      return tx("common.catalog");
  }
}

export function sessionConnectionMode(session: SessionListItem | null) {
  const raw = session?.connection_mode;
  // Dual-driver model: PTY mirror, SDK headless (idle), or SDK currently
  // emitting. `read_only` is the daemon-offline state. Legacy values from
  // pre-2026-05-25 builds (read_only_sync / detached) decay to read_only
  // and unknown respectively so a stale catalog never gates writability.
  if (
    raw === "pty_backed_duplex" ||
    raw === "sdk_headless" ||
    raw === "sdk_running" ||
    raw === "read_only" ||
    raw === "unknown"
  ) {
    return raw;
  }
  if (raw === "read_only_sync" || raw === "detached") return "read_only";
  return "unknown";
}

export function canControlSession(session: SessionListItem | null) {
  // Draft conversations live only on the client until the first message is
  // sent — they have no Nexus-side writable flag yet, but the composer must
  // be usable so sending can promote the draft into a real session.
  if (isDraftConversation(session)) return true;
  // Writability follows Nexus's `writable` field, not a specific mode.
  // PTY mirror and SDK headless are both writable when daemon is online.
  return session?.writable === true;
}

export function shouldUseBrowserRealtime(capabilities: NexusRuntimeCapabilities | null | undefined) {
  return capabilities?.browser_realtime === true;
}

export function shouldUseBrowserRealtimeControl(capabilities: NexusRuntimeCapabilities | null | undefined) {
  return capabilities?.browser_realtime === true && capabilities?.browser_realtime_control === true;
}

export function shouldAutoAttachReaderTerminalBridge(capabilities: NexusRuntimeCapabilities | null | undefined) {
  // Managed runtimes keep browser reader pages local-first and polling
  // based; terminal streaming is an explicit user action, not an automatic
  // read-screen side effect. Unknown runtime defaults closed so bootstrap does
  // not briefly open a terminal poll before /api/runtime resolves.
  return capabilities?.runtime === "self_hosted";
}

export function shouldRunWorkspaceNetworkLeader(isLeader: boolean) {
  return isLeader;
}

export function shouldRefreshSessionCatalog({
  now,
  lastSessionRefreshAt,
  visible,
  force = false,
  intervalMs = SESSION_CATALOG_REFRESH_MS,
}: {
  now: number;
  lastSessionRefreshAt: number;
  visible: boolean;
  force?: boolean;
  intervalMs?: number;
}) {
  return force || (visible && now - lastSessionRefreshAt >= intervalMs);
}

export function shouldLoadMoreSessionCatalogFromScroll({
  scrollTop,
  scrollHeight,
  clientHeight,
  hasMore,
  loading,
  prefetchPx = SESSION_CATALOG_PREFETCH_PX,
}: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  hasMore: boolean;
  loading: boolean;
  prefetchPx?: number;
}) {
  if (!hasMore || loading) return false;
  const remaining = Math.max(0, scrollHeight - scrollTop - clientHeight);
  return remaining <= Math.max(0, prefetchPx);
}

export function shouldFallbackToFullSessionCatalog(error: unknown, hasCachedCatalog: boolean) {
  if (!hasCachedCatalog) return true;
  if (!(error instanceof ApiError)) return false;
  if (error.status === 404 || error.status === 501) return true;
  const code = error.data && typeof error.data === "object" ? String((error.data as { code?: unknown }).code || "") : "";
  return code === "unsupported_runtime" || code === "not_supported";
}

export function shouldPollWorkspacePresence({
  now,
  visible,
  hiddenSinceAt,
  force = false,
  pauseAfterMs = BACKGROUND_PRESENCE_PAUSE_AFTER_MS,
}: {
  now: number;
  visible: boolean;
  hiddenSinceAt: number;
  force?: boolean;
  pauseAfterMs?: number;
}) {
  if (force || visible) return true;
  if (!hiddenSinceAt) return true;
  return now - hiddenSinceAt <= pauseAfterMs;
}

function isHostStatusUpdate(value: unknown): value is HostStatusUpdate {
  return Boolean(value && typeof value === "object" && typeof (value as { device_id?: unknown }).device_id === "string");
}

function isSessionCatalogChangedEvent(value: unknown): value is SessionCatalogChangedEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as { session_ids?: unknown; device_ids?: unknown; reason?: unknown };
  return (
    event.session_ids === undefined || Array.isArray(event.session_ids)
  ) && (
    event.device_ids === undefined || Array.isArray(event.device_ids)
  ) && (
    event.reason === undefined || typeof event.reason === "string"
  );
}

function isSessionTurn(value: unknown): value is SessionTurn {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { session_id?: unknown }).session_id === "string" &&
    typeof (value as { kind?: unknown }).kind === "string",
  );
}

export function mergeHostPresenceIntoSessions(sessions: SessionListItem[], hosts: HostSummary[]) {
  const hostsByDeviceID = new Map(hosts.map((host) => [host.device_id, host]));
  let changed = false;
  const next = sessions.map((session) => {
    const host = hostsByDeviceID.get(session.device_id);
    if (!host) return session;
    const online = host.presence_status === "online" || (host.presence_status === undefined && host.connected === true);
    const writable = Boolean(online && host.remote_access_enabled && host.status === "active");
    const connectionMode = writable
      ? (sessionConnectionMode(session) === "read_only" ? "sdk_headless" : sessionConnectionMode(session))
      : "read_only";
    const channelLastSeenAt = writable
      ? (host.last_channel_seen_at || host.last_seen_at || session.channel_last_seen_at)
      : session.channel_last_seen_at;
    if (
      session.writable === writable &&
      session.connection_mode === connectionMode &&
      session.channel_last_seen_at === channelLastSeenAt
    ) {
      return session;
    }
    changed = true;
    return {
      ...session,
      writable,
      connection_mode: connectionMode,
      ...(channelLastSeenAt ? { channel_last_seen_at: channelLastSeenAt } : {}),
    };
  });
  return changed ? next : sessions;
}

export function devicePresenceStatus(device: Device | null, host: HostSummary | null): DevicePresenceStatus {
  if (host?.presence_status === "online" || host?.presence_status === "connecting" || host?.presence_status === "degraded" || host?.presence_status === "offline") {
    return host.presence_status;
  }
  if (device?.status === "revoked" || host?.status === "revoked") return "offline";
  if (host?.status === "active") return "online";
  if (device?.status === "offline" || host?.status === "offline") {
    if (device?.status === "active") return device.remote_access_enabled ? "degraded" : "offline";
    return "offline";
  }
  if (device?.status === "active" && device.remote_access_enabled) return "connecting";
  if (device?.status === "active") return "degraded";
  return "offline";
}

function clientDotClassName(status: DevicePresenceStatus) {
  switch (status) {
    case "online":
      return "client-dot is-online";
    case "connecting":
      return "client-dot is-connecting";
    case "degraded":
      return "client-dot is-degraded";
    default:
      return "client-dot";
  }
}

export function browserBindingStatus(device: Device | null, host: HostSummary | null): BrowserBindingStatus {
  if (device?.status === "revoked" || host?.status === "revoked") return "revoked";
  if (host?.connected) return "paired";
  if (device || host) return "pairing_required";
  return "unpaired";
}

export function sessionContinuationScore(session: SessionListItem, context: SessionContinuationContext) {
  const device = context.devicesById.get(session.device_id) ?? null;
  const host = context.hostsById.get(session.device_id) ?? null;
  const presence = devicePresenceStatus(device, host);
  const binding = browserBindingStatus(device, host);
  const syncState = sessionSyncState(session);
  const mode = sessionConnectionMode(session);
  let score = 0;
  if (mode === "pty_backed_duplex") score += 420;
  else if (mode === "sdk_running") score += 380;
  else if (mode === "sdk_headless") score += 320;
  else if (mode === "read_only") score += 120;
  if (presence === "online") score += 220;
  else if (presence === "connecting") score += 150;
  else if (presence === "degraded") score += 90;
  if (binding === "paired") score += 140;
  else if (binding === "pairing_required") score += 30;
  else if (binding === "revoked") score -= 120;
  if (syncState === "ready" || syncState === "fully_synced") score += 55;
  else if (syncState === "partial") score += 35;
  else if (syncState === "syncing") score += 15;
  else if (syncState === "failed") score -= 25;
  if (session.writable) score += 40;
  const channelSeenAt = Date.parse(session.channel_last_seen_at || "");
  if (Number.isFinite(channelSeenAt)) {
    const channelMinutesAgo = Math.max(0, (Date.now() - channelSeenAt) / 60_000);
    if (channelMinutesAgo <= 2) score += 70;
    else if (channelMinutesAgo <= 10) score += 25;
    else score -= Math.min(80, channelMinutesAgo * 2);
  }
  score += Math.min(session.turn_count || session.last_seq || 0, 40);
  const ts = Date.parse(session.last_timestamp || "");
  if (Number.isFinite(ts)) {
    const minutesAgo = Math.max(0, (Date.now() - ts) / 60_000);
    score += Math.max(0, 160 - minutesAgo);
  }
  return score;
}

export function compareSessionContinuation(left: SessionListItem, right: SessionListItem, context: SessionContinuationContext) {
  const scoreDiff = sessionContinuationScore(left, context) - sessionContinuationScore(right, context);
  if (scoreDiff !== 0) return scoreDiff;
  const timeDiff = (Date.parse(left.last_timestamp || "") || 0) - (Date.parse(right.last_timestamp || "") || 0);
  if (timeDiff !== 0) return timeDiff;
  const seqDiff = (left.last_seq || 0) - (right.last_seq || 0);
  if (seqDiff !== 0) return seqDiff;
  return left.session_id.localeCompare(right.session_id);
}

export function bestContinuationCandidate(sessions: SessionListItem[], context: SessionContinuationContext) {
  return [...sessions].sort((left, right) => compareSessionContinuation(right, left, context))[0] ?? null;
}
export function workspaceHomeEmptyState({
  sessions,
  filteredGroups,
  daemonCount,
  hosts,
  sessionsStatus,
  query,
}: {
  sessions: SessionListItem[];
  filteredGroups: SessionGroup[];
  daemonCount: number;
  hosts: HostSummary[];
  sessionsStatus: string;
  query: string;
}): { title: string; body: string; action: "connect" | "refresh"; kind?: "bootstrap_loading" | "catalog_warming" | "session_status" } | null {
  if (sessionsStatus) {
    if (sessionsStatus === BOOTSTRAP_LOADING_STATUS) {
      return {
        title: tx("workspace.loadingWorkspaceTitle"),
        body: tx("workspace.loadingWorkspaceBody"),
        action: "refresh",
        kind: "bootstrap_loading",
      };
    }
    if (sessionsStatus !== tx("errors.noCatalog") && sessionsStatus !== "No session catalog yet.") {
      return {
        title: tx("workspace.workspaceUnavailableTitle"),
        body: tx("workspace.workspaceUnavailableBody"),
        action: daemonCount === 0 ? "connect" : "refresh",
        kind: "session_status",
      };
    }
  }
  if (filteredGroups.length > 0) return null;
  if (daemonCount === 0) {
    return {
      title: tx("empty.firstComputerTitle"),
      body: tx("empty.firstComputerBody"),
      action: "connect",
    };
  }
  if (sessions.length === 0) {
    const anyOnline = hosts.some((host) => host.presence_status ? host.presence_status === "online" : host.status === "active");
    return {
      title: anyOnline ? tx("empty.noSessionsYetTitle") : tx("empty.offlineTitle"),
      body: anyOnline
        ? tx("empty.noSessionsYetBody")
        : tx("empty.offlineBody"),
      action: "refresh",
    };
  }
  return {
    title: query.trim() ? tx("empty.noMatchingProjects") : tx("empty.noMatchingSessions"),
    body: tx("empty.adjustFilters"),
    action: "refresh",
  };
}

function syncStageLabel(stage: SyncSessionEvent["stage"]) {
  switch (stage) {
    case "queued":
      return tx("syncStage.queued");
    case "locating":
      return tx("syncStage.locating");
    case "extracting":
      return tx("syncStage.extracting");
    case "uploading":
      return tx("syncStage.uploading");
    case "completed":
      return tx("syncStage.completed");
    case "failed":
      return tx("syncStage.failed");
    default:
      return stage;
  }
}

function syncErrorMessage(message: string) {
  if (message === "daemon offline") return tx("errors.daemonOffline");
  // Daemon API returns "session not found" (with spaces); the sync
  // stream uses the snake_case "session_not_found". Map both to the
  // friendly localized copy so the user never sees the raw English.
  if (message === "session_not_found" || message === "session not found") return tx("errors.sessionNotFoundComputer");
  return message || tx("errors.sessionSyncFailed");
}

// isSessionNotFoundMessage normalizes the two spellings the daemon
// and sync stream can produce, so caller code can short-circuit on
// "expected 404 because the session's jsonl doesn't exist yet"
// without caring about formatting.
function isSessionNotFoundMessage(message: string): boolean {
  const m = (message || "").toLowerCase().trim();
  return m === "session not found" || m === "session_not_found";
}

export function liveMessageStableSeqKey(
  payload: {
    role?: string;
    uuid?: string;
    segment?: number;
    id?: string;
    timestamp?: string;
  },
  eventTimestamp?: string,
) {
  if (payload.role === "tool_call" || payload.role === "tool_result") {
    return `${payload.role}:${payload.id || payload.uuid || payload.timestamp || eventTimestamp || ""}`;
  }
  if (payload.role === "assistant" && payload.uuid) {
    return payload.segment ? `${payload.uuid}:segment:${payload.segment}` : payload.uuid;
  }
  return `${payload.role || "message"}:${payload.uuid || payload.id || payload.timestamp || eventTimestamp || ""}`;
}

function isStaleBrowserDeviceError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("revoked browser access") ||
    message.includes("device_revoked") ||
    message.includes("eligible device not found");
}

export function groupSessions(sessions: SessionListItem[], context: SessionContinuationContext): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const label = projectDisplayName(session);
    const key = projectKeyForSession(session);
    if (!groups.has(key)) groups.set(key, { key, label, agent: session.agent, cwd: session.cwd, deviceId: session.device_id, sessionId: session.session_id, sessions: [] });
    groups.get(key)?.sessions.push(session);
  }
  return [...groups.values()]
    .map((group) => {
      const sorted = group.sessions.sort((left, right) => compareSessionContinuation(right, left, context));
      return {
        ...group,
        agent: sorted[0]?.agent ?? group.agent,
        cwd: sorted[0]?.cwd ?? group.cwd,
        deviceId: sorted[0]?.device_id ?? group.deviceId,
        sessions: sorted,
        sessionId: sorted[0]?.session_id ?? group.sessionId,
      };
    })
    .sort((left, right) => compareSessionContinuation(right.sessions[0], left.sessions[0], context));
}

type RecencyBucketKey = "today" | "yesterday" | "week" | "earlier";

// bucketSessionsByRecency splits an already recency-sorted list into
// Today / Yesterday / Previous-7-days / Earlier groups so a long sidebar list
// stays scannable. Only non-empty buckets are returned, in recency order;
// intra-bucket order is preserved (so the active/continuation session still
// floats to the top of its bucket).
function bucketSessionsByRecency(sessions: SessionListItem[]): { key: RecencyBucketKey; sessions: SessionListItem[] }[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfWeek = startOfToday - 6 * 86_400_000;
  const buckets: Record<RecencyBucketKey, SessionListItem[]> = { today: [], yesterday: [], week: [], earlier: [] };
  for (const session of sessions) {
    const ts = session.last_timestamp ? new Date(session.last_timestamp).getTime() : NaN;
    if (Number.isNaN(ts) || ts < startOfWeek) buckets.earlier.push(session);
    else if (ts >= startOfToday) buckets.today.push(session);
    else if (ts >= startOfYesterday) buckets.yesterday.push(session);
    else buckets.week.push(session);
  }
  const order: RecencyBucketKey[] = ["today", "yesterday", "week", "earlier"];
  return order.filter((key) => buckets[key].length > 0).map((key) => ({ key, sessions: buckets[key] }));
}

function recencyBucketLabel(key: RecencyBucketKey): string {
  switch (key) {
    case "today":
      return tx("workspace.recencyToday");
    case "yesterday":
      return tx("workspace.recencyYesterday");
    case "week":
      return tx("workspace.recencyThisWeek");
    default:
      return tx("workspace.recencyEarlier");
  }
}

function buildDrawerProjects(sessions: SessionListItem[]) {
  return groupSessions(
    sessions.filter((session) => Boolean(lastPathSegment(session.cwd || ""))),
    { devicesById: new Map(), hostsById: new Map() },
  );
}

function buildDrawerLooseSessions(sessions: SessionListItem[]) {
  return sessions
    .filter((session) => !lastPathSegment(session.cwd || ""))
    .sort((a, b) => Date.parse(b.last_timestamp || "") - Date.parse(a.last_timestamp || ""));
}

function filterSessions(
  sessions: SessionListItem[],
  query: string,
  agent: string,
  deviceID: string,
  context?: SessionContinuationContext,
  sessionTitles?: Record<string, string>,
) {
  const needle = query.trim().toLowerCase();
  const filtered = sessions.filter((session) => {
    if (agent !== "all" && session.agent !== agent) return false;
    if (deviceID !== "all" && session.device_id !== deviceID) return false;
    if (!needle) return true;
    // The label users see may come from the locally derived title
    // (sessionTitles[id]); search must include it or queries against
    // the displayed text silently fail.
    const derived = sessionTitles?.[session.session_id] ?? "";
    return [
      session.session_id,
      session.device_id,
      session.agent,
      session.cwd,
      session.snippet,
      derived,
      sessionDisplayName(session, derived),
    ].some((value) => value.toLowerCase().includes(needle));
  });
  if (!context) return filtered;
  return filtered.sort((left, right) => compareSessionContinuation(right, left, context));
}

// sessionDisplayName picks the best human-readable label for a session.
// Precedence: (1) the Nexus-generated `title` (summary of the
// first message) when present — it's a strictly better automatic label than
// the mechanical snippet truncation; (2) the `override` arg, the web-derived
// title from sessionTitles (shown immediately as a fallback before the async
// server title lands); (3) the daemon-supplied non-sensitive snippet; then
// (4) the synthesised project · agent · date · shortId label.
function sessionDisplayName(session: SessionListItem, override?: string) {
  const serverTitle = (session.title || "").trim();
  if (serverTitle) return serverTitle;
  const trimmedOverride = override?.trim();
  if (trimmedOverride) return trimmedOverride;
  const snippet = (session.snippet || "").trim();
  if (snippet) {
    return snippet;
  }
  const project = lastPathSegment(session.cwd) || session.cwd || tx("workspace.session");
  const agent = session.agent === "codex" ? "Codex" : session.agent === "claude-code" ? "Claude Code" : session.agent;
  const updated = session.last_timestamp ? shortDateTime(session.last_timestamp) : "";
  const shortID = session.session_id.length > 8 ? session.session_id.slice(0, 8) : session.session_id;
  return [project, agent, updated, shortID].filter(Boolean).join(" / ");
}

// ── Session title cache ──────────────────────────────────────────────
//
// The daemon catalog uploads synthesised snippets to Nexus. Once the browser
// has loaded a session's turns it can locally derive a short title from the
// first user message — that's `deriveSessionTitle` below. The derived title is
// cached per session_id in localStorage so previously-opened sessions render
// with a useful label even on a cold list view.

// Scope by user so two accounts on the same browser don't share derived
// titles (and so that logout actually erases an account's local prompt
// breadcrumbs instead of leaving them sitting under a global key).
const sessionTitlesStorageKeyPrefix = "pockly:sessionTitles:v3:";
const sessionTitleMaxChars = 80;
const sessionTitleMaxEntries = 500;

function sessionTitlesStorageKey(userKey: string): string {
  return sessionTitlesStorageKeyPrefix + userKey;
}

function loadSessionTitlesFromStorage(userKey: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  if (!userKey) return {};
  try {
    const raw = window.localStorage.getItem(sessionTitlesStorageKey(userKey));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

// boundSessionTitles trims the map to the most-recent sessionTitleMaxEntries
// entries. Returned value is what gets BOTH stored AND held in React
// state, so the in-memory copy and the persisted copy never diverge.
function boundSessionTitles(map: Record<string, string>): Record<string, string> {
  const keys = Object.keys(map);
  if (keys.length <= sessionTitleMaxEntries) return map;
  const trimmed: Record<string, string> = {};
  for (const key of keys.slice(keys.length - sessionTitleMaxEntries)) {
    trimmed[key] = map[key];
  }
  return trimmed;
}

function saveSessionTitlesToStorage(userKey: string, map: Record<string, string>) {
  if (typeof window === "undefined") return;
  if (!userKey) return;
  try {
    window.localStorage.setItem(sessionTitlesStorageKey(userKey), JSON.stringify(map));
  } catch {
    // localStorage may be full or disabled (private browsing). Title
    // cache is best-effort; silently drop the write.
  }
}

function clearSessionTitlesInStorage(userKey: string) {
  if (typeof window === "undefined" || !userKey) return;
  try {
    window.localStorage.removeItem(sessionTitlesStorageKey(userKey));
  } catch {
    // Best-effort; nothing meaningful to do if storage is locked.
  }
}

// deriveSessionTitle squeezes a single-line title out of a user-message
// turn's plain text. Strips Claude's auto-injected wrappers (system-
// reminder, command-*) so the surfaced label is the prompt itself, not
// the tooling envelope. Empty if the text has no usable prose.
export function deriveSessionTitle(text: string): string {
  if (!text) return "";
  let cleaned = text;
  cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  cleaned = cleaned.replace(/<command-name>[\s\S]*?<\/command-name>/gi, "");
  cleaned = cleaned.replace(/<command-args>[\s\S]*?<\/command-args>/gi, "");
  cleaned = cleaned.replace(/<command-message>[\s\S]*?<\/command-message>/gi, "");
  cleaned = cleaned.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, "");
  cleaned = cleaned.replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/gi, "");
  // The local-command caveat envelope is an instruction to the model, not
  // the user's prompt — otherwise it becomes the conversation title.
  cleaned = cleaned.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "");
  // Subagent task envelopes — these wrap the user's actual prompt or the
  // subagent's output and otherwise leak as the conversation title.
  cleaned = cleaned.replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, "");
  cleaned = cleaned.replace(/<task-id>[\s\S]*?<\/task-id>/gi, "");
  cleaned = cleaned.replace(/<task-input>[\s\S]*?<\/task-input>/gi, "");
  cleaned = cleaned.replace(/<task-output>[\s\S]*?<\/task-output>/gi, "");
  cleaned = cleaned.replace(/<tool-use-id>[\s\S]*?<\/tool-use-id>/gi, "");
  cleaned = cleaned.replace(/<tool-name>[\s\S]*?<\/tool-name>/gi, "");
  // Collapse whitespace so the snippet stays single-line.
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= sessionTitleMaxChars) return cleaned;
  return cleaned.slice(0, sessionTitleMaxChars - 1).trim() + "…";
}

function uniqueValues(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

function preferredDaemonDeviceID(devices: Device[], excludedDeviceID = "") {
  const candidates = visibleComputerDevices(devices).filter((device) => device.device_id !== excludedDeviceID);
  return candidates.find((device) => device.status === "active")?.device_id ?? candidates[0]?.device_id ?? "";
}

function visibleComputerDevices(devices: Device[]) {
  const byComputer = new Map<string, Device>();
  for (const device of devices) {
    if (device.device_type !== "daemon" || device.status === "revoked" || device.superseded_by_device_id) continue;
    const key = device.computer_id || device.device_id;
    const existing = byComputer.get(key);
    if (!existing || (device.last_seen_at || "") > (existing.last_seen_at || "")) {
      byComputer.set(key, device);
    }
  }
  return [...byComputer.values()];
}

function isMobileBrowser() {
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua)) return true;
  return window.matchMedia?.("(pointer: coarse)").matches && Math.min(window.innerWidth, window.innerHeight) < 900;
}

function browserDeviceName() {
  const platform = navigator.platform || "Browser";
  return `Pockly ${platform}`;
}

async function copyTextToClipboard(value: string) {
  const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
  try {
    if (writeText) {
      await writeText(value);
      return;
    }
  } catch {
    // Fall back for embedded browsers that block the async Clipboard API.
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("copy failed");
  }
}

function accountInitial(value: string) {
  const trimmed = value.trim();
  return (trimmed[0] ?? "P").toUpperCase();
}

function normalizeTelemetryError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("ed25519") || lower.includes("subtle") || lower.includes("crypto")) return "browser_crypto";
  if (lower.includes("login") || lower.includes("unauthorized") || lower.includes("401")) return "auth_required";
  if (lower.includes("expired")) return "expired";
  if (lower.includes("denied")) return "denied";
  if (lower.includes("network") || lower.includes("fetch")) return "network";
  return "unknown";
}

function supportsPush() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function base64URLToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function supportedVoiceMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

async function optimizeVoiceBlob(audio: Blob, measuredDurationMs?: number) {
  const fallbackDurationMs = Math.max(0, Math.round(measuredDurationMs ?? 0));
  try {
    const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      return {
        audio,
        filename: "pockly-voice.webm",
        originalDurationMs: fallbackDurationMs,
        optimizedDurationMs: fallbackDurationMs,
        optimized: false,
      };
    }
    const ctx = new AudioContextCtor();
    const decoded = await ctx.decodeAudioData(await audio.arrayBuffer());
    await ctx.close();
    const originalDurationMs = Math.max(1, Math.round(decoded.duration * 1000));
    const mono = mixToMono(decoded);
    const trim = detectSpeechWindow(mono, decoded.sampleRate);
    if (!trim || trim.endSample <= trim.startSample) {
      return {
        audio,
        filename: "pockly-voice.webm",
        originalDurationMs,
        optimizedDurationMs: originalDurationMs,
        optimized: false,
      };
    }
    const savedMs = Math.round(((mono.length - (trim.endSample - trim.startSample)) / decoded.sampleRate) * 1000);
    if (savedMs < 300) {
      return {
        audio,
        filename: "pockly-voice.webm",
        originalDurationMs,
        optimizedDurationMs: originalDurationMs,
        optimized: false,
      };
    }
    const trimmed = mono.slice(trim.startSample, trim.endSample);
    const targetSampleRate = Math.min(decoded.sampleRate, 16_000);
    const encodedSamples = resampleMono(trimmed, decoded.sampleRate, targetSampleRate);
    const wav = encodeMonoWav(encodedSamples, targetSampleRate);
    if (wav.size >= audio.size) {
      return {
        audio,
        filename: "pockly-voice.webm",
        originalDurationMs,
        optimizedDurationMs: originalDurationMs,
        optimized: false,
      };
    }
    return {
      audio: wav,
      filename: "pockly-voice.wav",
      originalDurationMs,
      optimizedDurationMs: Math.max(1, Math.round((trimmed.length / decoded.sampleRate) * 1000)),
      optimized: true,
    };
  } catch {
    return {
      audio,
      filename: "pockly-voice.webm",
      originalDurationMs: fallbackDurationMs,
      optimizedDurationMs: fallbackDurationMs,
      optimized: false,
    };
  }
}

export function resampleMono(samples: Float32Array, sourceRate: number, targetRate: number) {
  const safeSourceRate = Math.max(1, Math.round(sourceRate));
  const safeTargetRate = Math.max(1, Math.round(targetRate));
  if (safeSourceRate === safeTargetRate) return samples;
  const targetLength = Math.max(1, Math.round((samples.length * safeTargetRate) / safeSourceRate));
  const out = new Float32Array(targetLength);
  const scale = safeSourceRate / safeTargetRate;
  for (let i = 0; i < targetLength; i += 1) {
    const position = i * scale;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const fraction = position - leftIndex;
    const left = samples[leftIndex] ?? 0;
    const right = samples[rightIndex] ?? left;
    out[i] = left + (right - left) * fraction;
  }
  return out;
}

function mixToMono(buffer: AudioBuffer) {
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

function detectSpeechWindow(samples: Float32Array, sampleRate: number) {
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
  const frameCount = Math.ceil(samples.length / frameSize);
  const rmsValues: number[] = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSize;
    const end = Math.min(samples.length, start + frameSize);
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
    rmsValues.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  const sorted = [...rmsValues].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
  const peak = sorted[sorted.length - 1] ?? 0;
  const threshold = Math.max(0.008, Math.min(0.03, noiseFloor * 2.5), peak * 0.08);
  let firstFrame = -1;
  let lastFrame = -1;
  for (let i = 0; i < rmsValues.length; i += 1) {
    if (rmsValues[i] >= threshold) {
      if (firstFrame < 0) firstFrame = i;
      lastFrame = i;
    }
  }
  if (firstFrame < 0 || lastFrame < 0) return null;
  const padding = Math.round(sampleRate * 0.22);
  return {
    startSample: Math.max(0, firstFrame * frameSize - padding),
    endSample: Math.min(samples.length, (lastFrame + 1) * frameSize + padding),
  };
}

function encodeMonoWav(samples: Float32Array, sampleRate: number) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeASCII(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeASCII(view, 8, "WAVE");
  writeASCII(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeASCII(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeASCII(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
}

function lastPathSegment(cwd: string) {
  const parts = cwd.split("/").filter(Boolean);
  return parts.at(-1) ?? cwd;
}

function AgentLogo({ agent }: { agent: string }) {
  const label = agentLogoLabel(agent);
  const className = `agent-logo ${agent === "claude-code" ? "agent-logo-claude-code" : agent === "codex" ? "agent-logo-codex" : "agent-logo-unknown"}`;
  return (
    <span className={className} role="img" aria-label={label} title={label}>
      {agent === "claude-code" ? (
        <ClaudeLogoMark />
      ) : agent === "codex" ? (
        <CodexLogoMark />
      ) : (
        <span className="agent-logo-fallback" aria-hidden="true">{label.slice(0, 1).toUpperCase() || "A"}</span>
      )}
    </span>
  );
}

function ClaudeLogoMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
        fill="currentColor"
        fillRule="nonzero"
      />
    </svg>
  );
}

function CodexLogoMark() {
  const rawId = useId();
  const gradientId = `agent-codex-${rawId.replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z" fill="#fff" />
      <path
        d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
        fill={`url(#${gradientId})`}
      />
      <defs>
        <linearGradient id={gradientId} x1="12" x2="12" y1="3" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#B1A7FF" />
          <stop offset=".5" stopColor="#7A9DFF" />
          <stop offset="1" stopColor="#3941FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function agentLogoLabel(agent: string) {
  if (agent === "claude-code") return "Claude Code";
  if (agent === "codex") return "Codex";
  return agent || "Agent";
}

function agentLabel(agent: string) {
  if (agent === "claude-code") return "Claude";
  if (agent === "codex") return "Codex";
  return agent;
}

function authErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : tx("errors.authFailed");
  switch (message) {
    case "invalid_email_or_password":
      return tx("errors.invalidEmailOrPassword");
    case "email_not_verified":
      return tx("errors.emailNotVerified");
    case "password_too_short":
      return tx("errors.passwordTooShort");
    case "password_too_long":
      return tx("errors.passwordTooLong");
    case "invalid_email":
      return tx("errors.invalidEmail");
    case "email_already_registered":
      return tx("errors.emailAlreadyRegistered");
    case "invalid_verification_code":
      return tx("errors.invalidVerificationCode");
    case "verification_code_expired":
      return tx("errors.verificationExpired");
    case "verification_resend_cooldown":
      return tx("errors.verificationCooldown");
    case "email_rate_limited":
    case "ip_rate_limited":
      return tx("errors.rateLimited");
    case "verification_email_failed":
      return tx("errors.verificationEmailFailed");
    case "verification_not_configured":
      return tx("errors.verificationNotConfigured");
    default:
      return message;
  }
}

function feedbackErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : tx("feedback.submitFailed");
  switch (message) {
    case "feedback_message_required":
      return tx("feedback.messageRequired");
    case "feedback_attachment_too_large":
      return tx("feedback.attachmentTooLarge");
    case "invalid multipart feedback upload":
      return tx("feedback.invalidAttachment");
    default:
      return message;
  }
}

function injectControlErrorMessage(message: string) {
  // Daemon-side drift surfaces as "session_drifted current=<sid>" from
  // control.injectIntoPTY. Same root cause as Nexus-side session_drifted,
  // just emitted later (after the request reached the daemon). Translate
  // to the same actionable copy so users get a consistent message;
  // sendPromptForSession's catch handles the actual switch.
  if (message.startsWith("session_drifted")) {
    return tx("workspace.sendBlockedConnectionMode", { mode: tx("workspace.connectionModeReadOnly") });
  }
  if (message.includes("codex_app_server_unavailable")) {
    return tx("errors.codexAppServerUnavailable");
  }
  switch (message) {
    case "unsupported_mode":
      return tx("errors.injectUnsupportedMode");
    case "session_id_required":
      return tx("errors.injectMissingSessionId");
    case "text_required":
      return tx("errors.injectMissingText");
    case "session_not_attached":
    case "not_pty_backed":
      // Legacy daemon/Nexus codes from before the SDK-headless mode.
      // Both meant "no PTY wrapper bound" — under the new model that
      // case is supposed to be served by an SDK subprocess instead. If a
      // build of either side still emits these, fall back to the
      // read-only banner so the user knows the inject didn't land.
      return tx("workspace.sendBlockedConnectionMode", { mode: tx("workspace.connectionModeReadOnly") });
    case "daemon_offline":
    case "device_offline":
      return tx("errors.daemonOffline");
    case "browser_not_authorized":
      return tx("errors.browserNotAuthorized");
    case "session_not_found":
      return tx("errors.sessionNotFoundComputer");
    case "session_hydration_incomplete":
      return tx("errors.sessionHydrationIncomplete");
    case "daemon_busy":
      return tx("errors.daemonBusy");
    case "binary_missing":
    case "agent_binary_missing":
    case "claude_binary_missing":
      return tx("errors.agentBinaryMissing");
    case "approval_required":
      return tx("errors.approvalRequired");
    case "upload_failed":
      return tx("errors.uploadFailed");
    case "unknown":
      return tx("errors.unknownInject");
    default:
      return message;
  }
}

function injectTelemetryErrorCode(message: string) {
  const lower = message.toLowerCase();
  for (const code of [
    "session_drifted",
    "session_not_found",
    "session_not_attached",
    "daemon_offline",
    "device_offline",
    "daemon_busy",
    "binary_missing",
    "agent_binary_missing",
    "claude_binary_missing",
    "codex_app_server_unavailable",
    "sdk_busy",
    "sdk_unsupported_agent",
    "text_required",
    "cwd_required",
    "cwd_invalid",
    "inject_failed",
  ]) {
    if (lower.includes(code)) return code;
  }
  if (lower.includes("executable file not found") || lower.includes("not found in path")) return "binary_missing";
  if (lower.includes("timeout") || lower.includes("deadline exceeded")) return "timeout";
  if (lower.includes("permission")) return "permission_error";
  if (lower.includes("token") || lower.includes("authorization") || lower.includes("bearer") || lower.includes("secret")) return "redacted_error";
  return "unknown";
}

function kindLabel(kind: string) {
  switch (kind) {
    case "assistant_text":
      return tx("workspace.assistant");
    case "user_message":
      return tx("workspace.user");
    case "tool_call":
    case "tool_result":
    case "tool_group":
      return tx("workspace.assistant");
    case "attachment":
      return tx("workspace.attachment");
    case "thinking":
      return tx("workspace.thinking");
    case "meta":
      return tx("workspace.meta");
    default:
      return kind;
  }
}

// Codex rollout session files are named with an ISO-ish stamp that uses DASHES
// between the time fields ("2026-06-05T17-06-32"), and the daemon forwards that
// raw string as the session timestamp. `new Date()` cannot parse it, so any
// formatter would fall back to printing the raw string. Convert the time-field
// dashes back to colons so it parses like a normal ISO timestamp. Claude
// sessions already emit RFC3339 and pass through untouched.
function normalizeTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(.*)$/.exec(value);
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}${match[5]}` : value;
}

function shortTime(value: string) {
  if (!value) return "--";
  const date = new Date(normalizeTimestamp(value));
  if (Number.isNaN(date.getTime())) return value;
  const now = Date.now();
  const delta = now - date.getTime();
  if (delta < 60_000) return tx("common.now");
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return date.toLocaleDateString(appI18n.language, { month: "short", day: "numeric" });
}

// clockTime renders an absolute wall-clock HH:MM. shortTime is a PAST-relative
// "time ago" formatter — a future timestamp yields a negative delta that falls
// into its "just now" bucket, so it rendered a 5-minute-out QR-grant expiry as
// "刚刚", making "{{time}} 过期" read as "just expired". Use this for future
// expiries instead.
function clockTime(value: string) {
  if (!value) return "--";
  const date = new Date(normalizeTimestamp(value));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(appI18n.language, { hour: "2-digit", minute: "2-digit" });
}

function shortDateTime(value: string) {
  const date = new Date(normalizeTimestamp(value));
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleDateString(appI18n.language, { month: "short", day: "numeric" });
  }
  return value.slice(0, 16);
}
