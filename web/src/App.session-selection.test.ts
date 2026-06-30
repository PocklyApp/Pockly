/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ApiError, SESSION_TURNS_WINDOW_LIMIT, type Device, type HostSummary, type SessionListItem } from "./api";
import {
  AUTOMATIC_SESSION_BACKFILL_TURN_LIMIT,
  bestContinuationCandidate,
  daemonUpdateTargets,
  devicePresenceStatus,
  findCreatedSessionForDraft,
  groupSessions,
  hasEarlierTurns,
  injectPollOptionsForSession,
  isLargeSessionForAutomaticBackfill,
  LARGE_SESSION_ACTIVE_EVENT_POLL_MS,
  LARGE_SESSION_CATALOG_REFRESH_MS,
  mergeHostPresenceIntoSessions,
  nextLazyBackfillBeforeSeq,
  offlineLazyBackfillMessage,
  pickSelection,
  BACKGROUND_PRESENCE_PAUSE_AFTER_MS,
  PRESENCE_REFRESH_BACKGROUND_MS,
  PRESENCE_REFRESH_FOREGROUND_MS,
  SESSION_CATALOG_PAGE_LIMIT,
  SESSION_CATALOG_PREFETCH_PX,
  SESSION_CATALOG_REFRESH_MS,
  SELECTED_SESSION_OPEN_HINT_REFRESH_MS,
  SELECTED_SESSION_TAIL_OVERLAP_TURNS,
  SELECTED_SESSION_TAIL_REFRESH_MS,
  sessionCatalogRefreshIntervalForSession,
  selectedSessionTailFetchOptions,
  shouldLoadMoreSessionCatalogFromScroll,
  shouldPollSelectedSessionTail,
  shouldPollWorkspacePresence,
  shouldRefreshSelectedSessionOpenHint,
  shouldRefreshSessionCatalog,
  shouldRunWorkspaceNetworkLeader,
  shouldFallbackToFullSessionCatalog,
  shouldRefreshPersistentTurnsAfterSync,
  shouldScheduleInjectRefreshAfterStream,
  shouldSyncSessionOnOpen,
  shouldAutoAttachReaderTerminalBridge,
  shouldUseBrowserRealtime,
  shouldGateAuthenticatedWorkspaceSplash,
  sessionTurnsFetchOptionsForCachedOpen,
  shouldFetchHotTailAfterIncremental,
  transientTurnsHydration,
  workspaceHomeEmptyState,
  type ReaderSelection,
  type Route,
  type SessionContinuationContext,
} from "./App";

function daemonDevice(deviceId: string, overrides: Partial<Device> = {}): Device {
  return {
    device_id: deviceId,
    device_type: "daemon",
    device_name: deviceId,
    status: "active",
    remote_access_enabled: true,
    ...overrides,
  };
}

function host(deviceId: string, overrides: Partial<HostSummary> = {}): HostSummary {
  return {
    device_id: deviceId,
    device_name: deviceId,
    status: "active",
    presence_status: "online",
    remote_access_enabled: true,
    last_seen_at: "2026-05-23T08:00:00Z",
    active_session_count: 1,
    connected: true,
    ...overrides,
  };
}

function session(sessionId: string, deviceId: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: sessionId,
    device_id: deviceId,
    agent: "claude-code",
    runner_alias: "claude" as const,
    cwd: "/tmp/project",
    snippet: "hello",
    last_seq: 12,
    last_timestamp: "2026-05-23T08:00:00Z",
    channel_last_seen_at: "2026-05-23T08:00:00Z",
    sync_state: "ready",
    connection_mode: "pty_backed_duplex",
    writable: true,
    turn_count: 12,
    ...overrides,
  };
}

function context(devices: Device[], hosts: HostSummary[]): SessionContinuationContext {
  return {
    devicesById: new Map(devices.map((item) => [item.device_id, item])),
    hostsById: new Map(hosts.map((item) => [item.device_id, item])),
  };
}

test("bestContinuationCandidate prefers PTY-backed paired online session", () => {
  const devices = [daemonDevice("dd_best"), daemonDevice("dd_readonly")];
  const hosts = [
    host("dd_best", { connected: true, presence_status: "online" }),
    host("dd_readonly", { connected: true, presence_status: "online" }),
  ];
  const sessions = [
    session("sess_readonly", "dd_readonly", {
      connection_mode: "read_only_sync",
      writable: false,
      channel_last_seen_at: "2026-05-23T07:58:00Z",
    }),
    session("sess_best", "dd_best", {
      connection_mode: "pty_backed_duplex",
      writable: true,
      channel_last_seen_at: "2026-05-23T08:00:00Z",
    }),
  ];

  const picked = bestContinuationCandidate(sessions, context(devices, hosts));
  assert.equal(picked?.session_id, "sess_best");
  assert.equal(picked?.device_id, "dd_best");
});

test("daemonUpdateTargets uses release latest metadata", () => {
  const devices = [
    daemonDevice("dd_old", { app_version: "v0.4.36" }),
    daemonDevice("dd_current", { app_version: "v0.4.37" }),
  ];
  const hosts = [
    host("dd_old", {
      app_version: "v0.4.36",
      daemon_latest_version: "v0.4.37",
      daemon_update_available: true,
      daemon_update_source: "cdn_latest",
    }),
    host("dd_current", {
      app_version: "v0.4.37",
      daemon_latest_version: "v0.4.37",
      daemon_update_available: false,
      daemon_update_source: "cdn_latest",
    }),
  ];

  const targets = daemonUpdateTargets(devices, hosts, "v0.1.37");

  assert.equal(targets.length, 1);
  assert.equal(targets[0].device_id, "dd_old");
  assert.equal(targets[0].daemon_latest_version, "v0.4.37");
  assert.equal(targets[0].daemon_update_source, "cdn_latest");
});

test("daemonUpdateTargets falls back to minimum recommended version for old Nexus runtimes", () => {
  const devices = [
    daemonDevice("dd_old", { app_version: "v0.1.36" }),
    daemonDevice("dd_current", { app_version: "v0.1.37" }),
  ];

  const targets = daemonUpdateTargets(devices, [], "v0.1.37");

  assert.equal(targets.length, 1);
  assert.equal(targets[0].device_id, "dd_old");
  assert.equal(targets[0].daemon_latest_version, "v0.1.37");
  assert.equal(targets[0].daemon_update_source, "minimum_recommended");
});

test("daemonUpdateTargets can use release latest metadata from device records", () => {
  const devices = [
    daemonDevice("dd_old", {
      app_version: "v0.4.36",
      daemon_latest_version: "v0.4.37",
      daemon_update_available: true,
      daemon_update_source: "cdn_latest",
    }),
  ];

  const targets = daemonUpdateTargets(devices, [], "v0.1.37");

  assert.equal(targets.length, 1);
  assert.equal(targets[0].device_id, "dd_old");
  assert.equal(targets[0].daemon_latest_version, "v0.4.37");
  assert.equal(targets[0].daemon_update_source, "cdn_latest");
});

test("pickSelection recovers stale device route to the same session on a better device", () => {
  const devices = [daemonDevice("dd_new"), daemonDevice("dd_other")];
  const hosts = [host("dd_new"), host("dd_other")];
  const sessions = [
    session("sess_resume", "dd_new"),
    session("sess_other", "dd_other", { last_timestamp: "2026-05-23T07:50:00Z" }),
  ];
  const route: Route = { view: "workspaceSession", sessionId: "sess_resume", deviceId: "dd_old" };

  const picked = pickSelection(sessions, route, null, devices, hosts);
  assert.deepEqual(picked, { sessionId: "sess_resume", deviceId: "dd_new" });
});

test("pickSelection falls back to the global best continuation when route is fully stale", () => {
  const devices = [daemonDevice("dd_best"), daemonDevice("dd_degraded")];
  const hosts = [
    host("dd_best", { presence_status: "online" }),
    host("dd_degraded", { presence_status: "degraded" }),
  ];
  const sessions = [
    session("sess_best", "dd_best"),
    session("sess_degraded", "dd_degraded", {
      channel_last_seen_at: "2026-05-23T07:40:00Z",
      last_timestamp: "2026-05-23T07:40:00Z",
    }),
  ];
  const route: Route = { view: "workspaceSession", sessionId: "missing", deviceId: "dd_missing" };

  const picked = pickSelection(sessions, route, null, devices, hosts);
  assert.deepEqual(picked, { sessionId: "sess_best", deviceId: "dd_best" });
});

test("devicePresenceStatus trusts Nexus presence_status when provided", () => {
  const device = daemonDevice("dd_test");
  const connectingHost = host("dd_test", { presence_status: "connecting" });
  const degradedHost = host("dd_test", { presence_status: "degraded" });
  const onlineHost = host("dd_test", { presence_status: "online" });

  assert.equal(devicePresenceStatus(device, connectingHost), "connecting");
  assert.equal(devicePresenceStatus(device, degradedHost), "degraded");
  assert.equal(devicePresenceStatus(device, onlineHost), "online");
});

test("workspaceHomeEmptyState treats empty online catalog as a stable empty state", () => {
  const degraded = workspaceHomeEmptyState({
    sessions: [],
    filteredGroups: [],
    daemonCount: 1,
    hosts: [host("dd_test", { presence_status: "degraded" })],
    sessionsStatus: "",
    query: "",
  });
  assert.equal(degraded?.kind, undefined);
  assert.equal(degraded?.action, "refresh");

  const online = workspaceHomeEmptyState({
    sessions: [],
    filteredGroups: [],
    daemonCount: 1,
    hosts: [host("dd_test", { presence_status: "online" })],
    sessionsStatus: "",
    query: "",
  });
  assert.equal(online?.kind, undefined);
  assert.equal(online?.action, "refresh");
  assert.match(online?.title ?? "", /No conversations|还没有会话/);
});

test("workspaceHomeEmptyState treats bootstrap loading as a loading state", () => {
  const state = workspaceHomeEmptyState({
    sessions: [],
    filteredGroups: [],
    daemonCount: 0,
    hosts: [],
    sessionsStatus: "__pockly_workspace_bootstrap_loading__",
    query: "",
  });

  assert.equal(state?.kind, "bootstrap_loading");
  assert.equal(state?.action, "refresh");
  assert.match(state?.title ?? "", /Loading|正在加载/);
});

test("workspace splash gate does not block local setup auth flows", () => {
  assert.equal(shouldGateAuthenticatedWorkspaceSplash({ view: "workspaceSessions" }), true);
  assert.equal(shouldGateAuthenticatedWorkspaceSplash({ view: "workspaceConnect" }), true);
  assert.equal(shouldGateAuthenticatedWorkspaceSplash({ view: "localSetup", grant: "ds_1", nonce: "n", cb: "http://127.0.0.1:1234/callback" }), false);
  assert.equal(shouldGateAuthenticatedWorkspaceSplash({ view: "cliLogin", deviceCode: "dc_1" }), false);
  assert.equal(shouldGateAuthenticatedWorkspaceSplash({ view: "login" }), false);
});

test("groupSessions merges Claude Code and Codex sessions in the same workspace", () => {
  const devices = [daemonDevice("dd_a")];
  const hosts = [host("dd_a")];
  const sessions = [
    session("sess_claude", "dd_a", {
      agent: "claude-code",
      cwd: "/Users/dev/workspace/Pockly",
      last_timestamp: "2026-06-06T08:00:00Z",
    }),
    session("sess_codex", "dd_a", {
      agent: "codex",
      cwd: "/Users/dev/workspace/Pockly/",
      last_timestamp: "2026-06-06T08:05:00Z",
    }),
  ];

  const groups = groupSessions(sessions, context(devices, hosts));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "Pockly");
  assert.equal(groups[0].sessions.length, 2);
  assert.deepEqual(groups[0].sessions.map((item) => item.session_id), ["sess_codex", "sess_claude"]);
  assert.deepEqual(new Set(groups[0].sessions.map((item) => item.agent)), new Set(["claude-code", "codex"]));
});

test("groupSessions keeps the same workspace name separate across computers", () => {
  const devices = [daemonDevice("dd_a"), daemonDevice("dd_b")];
  const hosts = [host("dd_a"), host("dd_b")];
  const sessions = [
    session("sess_a", "dd_a", { agent: "claude-code", cwd: "/repo/Pockly" }),
    session("sess_b", "dd_b", { agent: "codex", cwd: "/repo/Pockly" }),
  ];

  const groups = groupSessions(sessions, context(devices, hosts));

  assert.equal(groups.length, 2);
  assert.deepEqual(new Set(groups.map((group) => group.deviceId)), new Set(["dd_a", "dd_b"]));
});

test("pickSelection keeps the current selection when it still exists", () => {
  const devices = [daemonDevice("dd_a"), daemonDevice("dd_b")];
  const hosts = [host("dd_a"), host("dd_b")];
  const sessions = [
    session("sess_a", "dd_a"),
    session("sess_b", "dd_b"),
  ];
  const route: Route = { view: "workspaceSessions" };
  const current: ReaderSelection = { sessionId: "sess_b", deviceId: "dd_b" };

  const picked = pickSelection(sessions, route, current, devices, hosts);
  assert.deepEqual(picked, current);
});

// Regression: pre-fix, a catalog refresh fired while a draft was the
// current selection would scan `sessions` for the draft id, find
// nothing (drafts are client-only), and silently swap the user's draft
// for the best real session — so the next sendPromptForSession was
// looking at a real session, not a draft, and the daemon's start_task
// path never fired. End user symptom: their first prompt landed inside
// the most recently active existing session instead of creating a new
// one.
test("pickSelection preserves a draft selection even when not in catalog", () => {
  const devices = [daemonDevice("dd_a")];
  const hosts = [host("dd_a")];
  const sessions = [
    session("sess_real", "dd_a"),
  ];
  const route: Route = { view: "workspaceSessions" };
  const draftSelection: ReaderSelection = { sessionId: "draft_abc123", deviceId: "dd_a" };

  const picked = pickSelection(sessions, route, draftSelection, devices, hosts);
  assert.deepEqual(picked, draftSelection);
});

test("pickSelection keeps a just-promoted session_id even before catalog catches up", () => {
  // Regression: after a draft is promoted to a real session_id via the
  // daemon's session_created event, the URL replaces to the new sid.
  // The next catalog refresh runs before Nexus has caught up, so the
  // new sid isn't in `sessions` yet. Without this short-circuit, the
  // workspaceSession branch would fall through to bestContinuationCandidate
  // and silently swap the user onto the most-active existing session on
  // the same device (e.g. another live wrapper's jsonl).
  const devices = [daemonDevice("dd_a")];
  const hosts = [host("dd_a")];
  const sessions = [
    session("sess_other_live", "dd_a", { channel_last_seen_at: "2026-05-23T09:00:00Z" }),
  ];
  const route: Route = { view: "workspaceSession", sessionId: "sess_just_promoted", deviceId: "dd_a" };
  const current: ReaderSelection = { sessionId: "sess_just_promoted", deviceId: "dd_a" };

  const picked = pickSelection(sessions, route, current, devices, hosts);
  assert.deepEqual(picked, current);
});

test("findCreatedSessionForDraft does not bind a no-cwd draft to any session", () => {
  // "直接聊天，不选目录" mode creates a draft with cwd="". Without the
  // explicit bail-out, the cwd filter would be skipped entirely and the
  // draft would be heuristically matched to whichever recent claude-code
  // session on the same device happened to have the newest last_timestamp
  // — typically a completely unrelated live wrapper jsonl. The only safe
  // promotion path for these drafts is the daemon's session_created event.
  const noCwdDraft = {
    isDraft: true as const,
    session_id: `draft_${Date.now().toString(36)}_xyz789`,
    device_id: "dd_a",
    agent: "claude-code" as const,
    runner_alias: "claude" as const,
    cwd: "",
    snippet: "draft",
    last_seq: 0,
    last_timestamp: new Date().toISOString(),
    sync_state: "catalog_only" as const,
    turn_count: 0,
    synced_turn_count: 0,
    has_older_turns: false,
  };
  const recentRealSession = session("sess_unrelated_live", "dd_a", {
    last_timestamp: new Date().toISOString(),
    channel_last_seen_at: new Date().toISOString(),
  });
  assert.equal(findCreatedSessionForDraft([recentRealSession], noCwdDraft), null);
});

test("findCreatedSessionForDraft still binds a draft with explicit cwd to a matching session", () => {
  const draftWithCwd = {
    isDraft: true as const,
    session_id: `draft_${Date.now().toString(36)}_proj01`,
    device_id: "dd_a",
    agent: "claude-code" as const,
    runner_alias: "claude" as const,
    cwd: "/tmp/project",
    snippet: "draft",
    last_seq: 0,
    last_timestamp: new Date(Date.now() - 1000).toISOString(),
    sync_state: "catalog_only" as const,
    turn_count: 0,
    synced_turn_count: 0,
    has_older_turns: false,
  };
  const matchingSession = session("sess_matched", "dd_a", {
    cwd: "/tmp/project",
    last_timestamp: new Date().toISOString(),
  });
  const unrelatedSession = session("sess_other_project", "dd_a", {
    cwd: "/tmp/other-project",
    last_timestamp: new Date().toISOString(),
  });
  const matched = findCreatedSessionForDraft([unrelatedSession, matchingSession], draftWithCwd);
  assert.equal(matched?.session_id, "sess_matched");
});

test("presence polling refreshes session catalog only on interval or forced resume", () => {
  assert.equal(PRESENCE_REFRESH_FOREGROUND_MS, 15_000);
  assert.equal(PRESENCE_REFRESH_BACKGROUND_MS, 60_000);
  assert.equal(SESSION_CATALOG_REFRESH_MS, 60_000);
  assert.equal(SELECTED_SESSION_TAIL_REFRESH_MS, 5_000);
  assert.equal(SELECTED_SESSION_OPEN_HINT_REFRESH_MS, 15_000);
  assert.equal(SELECTED_SESSION_TAIL_OVERLAP_TURNS, 5);
  assert.equal(SESSION_CATALOG_PAGE_LIMIT, 50);
  assert.equal(shouldRefreshSessionCatalog({
    now: 5_000,
    lastSessionRefreshAt: 0,
    visible: true,
    intervalMs: 60_000,
  }), false);
  assert.equal(shouldRefreshSessionCatalog({
    now: 60_000,
    lastSessionRefreshAt: 0,
    visible: true,
    intervalMs: 60_000,
  }), true);
  assert.equal(shouldRefreshSessionCatalog({
    now: 120_000,
    lastSessionRefreshAt: 0,
    visible: false,
    intervalMs: 60_000,
  }), false);
  assert.equal(shouldRefreshSessionCatalog({
    now: 5_000,
    lastSessionRefreshAt: 0,
    visible: false,
    force: true,
    intervalMs: 60_000,
  }), true);
});

test("selected session tail polling overlaps recent confirmed turns", () => {
  assert.deepEqual(selectedSessionTailFetchOptions([]), {
    limit: SESSION_TURNS_WINDOW_LIMIT,
  });
  assert.deepEqual(selectedSessionTailFetchOptions([
    {
      device_id: "dd_test",
      session_id: "sess_tail",
      seq: 101,
      agent: "codex",
      kind: "assistant_text",
      timestamp: "2026-06-13T00:00:00.000Z",
      payload: { text: "partial" },
    },
    {
      device_id: "dd_test",
      session_id: "sess_tail",
      seq: 900_000_001,
      agent: "codex",
      kind: "assistant_text",
      timestamp: "2026-06-13T00:00:01.000Z",
      payload: { text: "live ghost" },
    },
  ]), {
    limit: SESSION_TURNS_WINDOW_LIMIT,
    afterSeq: 96,
  });
});

test("selected session tail polling is owned by the reader route", () => {
  const selected: ReaderSelection = { sessionId: "sess_visible", deviceId: "dd_test" };
  assert.equal(shouldPollSelectedSessionTail({
    authenticated: true,
    readerRoute: true,
    selected,
    turnsStatus: "",
  }), true);
  assert.equal(shouldPollSelectedSessionTail({
    authenticated: true,
    readerRoute: true,
    selected: { ...selected, sessionId: "draft_1" },
    turnsStatus: "",
  }), false);
  assert.equal(shouldPollSelectedSessionTail({
    authenticated: true,
    readerRoute: true,
    selected,
    turnsStatus: "loading",
  }), false);
  assert.equal(shouldPollSelectedSessionTail({
    authenticated: true,
    readerRoute: false,
    selected,
    turnsStatus: "",
  }), false);
});

test("selected session open hint refresh is interval-limited", () => {
  assert.equal(shouldRefreshSelectedSessionOpenHint({
    now: 20_000,
    lastHintAt: 10_000,
    refreshHint: true,
    intervalMs: SELECTED_SESSION_OPEN_HINT_REFRESH_MS,
  }), false);
  assert.equal(shouldRefreshSelectedSessionOpenHint({
    now: 25_000,
    lastHintAt: 10_000,
    refreshHint: true,
    intervalMs: SELECTED_SESSION_OPEN_HINT_REFRESH_MS,
  }), true);
  assert.equal(shouldRefreshSelectedSessionOpenHint({
    now: 25_000,
    lastHintAt: 10_000,
    refreshHint: false,
    intervalMs: SELECTED_SESSION_OPEN_HINT_REFRESH_MS,
  }), false);
});

test("session catalog pagination loads more only near the drawer bottom", () => {
  assert.equal(SESSION_CATALOG_PREFETCH_PX, 240);
  assert.equal(shouldLoadMoreSessionCatalogFromScroll({
    scrollTop: 1_270,
    scrollHeight: 2_000,
    clientHeight: 500,
    hasMore: true,
    loading: false,
  }), true);
  assert.equal(shouldLoadMoreSessionCatalogFromScroll({
    scrollTop: 800,
    scrollHeight: 2_000,
    clientHeight: 500,
    hasMore: true,
    loading: false,
  }), false);
  assert.equal(shouldLoadMoreSessionCatalogFromScroll({
    scrollTop: 1_300,
    scrollHeight: 2_000,
    clientHeight: 500,
    hasMore: false,
    loading: false,
  }), false);
  assert.equal(shouldLoadMoreSessionCatalogFromScroll({
    scrollTop: 1_300,
    scrollHeight: 2_000,
    clientHeight: 500,
    hasMore: true,
    loading: true,
  }), false);
});

test("session catalog delta failures do not fall back to full catalog when cache exists", () => {
  assert.equal(shouldFallbackToFullSessionCatalog(new Error("network"), true), false);
  assert.equal(shouldFallbackToFullSessionCatalog(new ApiError("server_error", 500, { code: "internal" }), true), false);
  assert.equal(shouldFallbackToFullSessionCatalog(new ApiError("unsupported", 501, { code: "unsupported_runtime" }), true), true);
  assert.equal(shouldFallbackToFullSessionCatalog(new ApiError("missing", 404, { code: "not_found" }), true), true);
  assert.equal(shouldFallbackToFullSessionCatalog(new Error("first load needs compatibility fallback"), false), true);
});

test("cached session reopen uses incremental turns before falling back to the hot tail", () => {
  assert.deepEqual(sessionTurnsFetchOptionsForCachedOpen([]), {
    limit: SESSION_TURNS_WINDOW_LIMIT,
  });
  assert.deepEqual(sessionTurnsFetchOptionsForCachedOpen([
    {
      device_id: "dd_test",
      session_id: "sess_cached",
      seq: 101,
      agent: "claude-code",
      kind: "assistant_text",
      timestamp: "2026-06-13T00:00:00.000Z",
      payload: { text: "cached" },
    },
    {
      device_id: "dd_test",
      session_id: "sess_cached",
      seq: 120,
      agent: "claude-code",
      kind: "assistant_text",
      timestamp: "2026-06-13T00:00:01.000Z",
      payload: { text: "cached latest" },
    },
    {
      device_id: "dd_test",
      session_id: "sess_cached",
      seq: 900_000_001,
      agent: "claude-code",
      kind: "assistant_text",
      timestamp: "2026-06-13T00:00:02.000Z",
      payload: { text: "optimistic live ghost" },
    },
  ]), {
    limit: SESSION_TURNS_WINDOW_LIMIT,
    afterSeq: 120,
  });
});

test("cached session reopen fetches hot tail only when incremental reads may miss the latest window", () => {
  const session = {
    session_id: "sess_cached",
    device_id: "dd_test",
    agent: "claude-code",
    cwd: "/tmp",
    snippet: "",
    last_seq: 260,
    last_timestamp: "2026-06-13T00:00:00.000Z",
    synced_max_seq: 260,
    turn_count: 260,
  } satisfies SessionListItem;

  assert.equal(shouldFetchHotTailAfterIncremental({
    cachedMaxSeq: 120,
    response: {
      session_id: "sess_cached",
      turns: [{ session_id: "sess_cached", seq: 121, agent: "claude-code", kind: "assistant_text", timestamp: "2026-06-13T00:00:01.000Z", payload: { text: "121" } }],
      after_seq: 120,
      latest_seq: 121,
      synced_max_seq: 121,
    },
    session: { ...session, last_seq: 121, synced_max_seq: 121, turn_count: 121 },
    limit: 100,
  }), false);

  assert.equal(shouldFetchHotTailAfterIncremental({
    cachedMaxSeq: 120,
    response: {
      session_id: "sess_cached",
      turns: Array.from({ length: 100 }, (_, index) => ({
        session_id: "sess_cached",
        seq: 121 + index,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-13T00:00:01.000Z",
        payload: { text: String(121 + index) },
      })),
      after_seq: 120,
      latest_seq: 220,
      synced_max_seq: 260,
    },
    session,
    limit: 100,
  }), true);

  assert.equal(shouldFetchHotTailAfterIncremental({
    cachedMaxSeq: 120,
    response: {
      session_id: "sess_cached",
      turns: Array.from({ length: 100 }, (_, index) => ({
        session_id: "sess_cached",
        seq: 121 + index,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-13T00:00:01.000Z",
        payload: { text: String(121 + index) },
      })),
      after_seq: 120,
      latest_seq: 220,
      synced_max_seq: 220,
    },
    session: { ...session, last_seq: 220, synced_max_seq: 220, turn_count: 220 },
    limit: 100,
  }), false);

  assert.equal(shouldFetchHotTailAfterIncremental({
    cachedMaxSeq: 120,
    response: {
      session_id: "sess_cached",
      turns: [{ session_id: "sess_cached", seq: 121, agent: "claude-code", kind: "assistant_text", timestamp: "2026-06-13T00:00:01.000Z", payload: { text: "121" } }],
      after_seq: 120,
      latest_seq: 121,
      synced_max_seq: 260,
    },
    session,
    limit: 100,
  }), true);

  assert.equal(shouldFetchHotTailAfterIncremental({
    cachedMaxSeq: 120,
    response: {
      session_id: "sess_cached",
      turns: [],
      after_seq: 120,
      synced_max_seq: 260,
      total_turn_count: 260,
    },
    session,
    limit: 100,
  }), true);
});

test("inject completion ACK keeps polling until a visible reply lands", () => {
  assert.equal(shouldScheduleInjectRefreshAfterStream("reply_visible"), false);
  assert.equal(shouldScheduleInjectRefreshAfterStream("failed"), false);
  assert.equal(shouldScheduleInjectRefreshAfterStream("cancelled"), false);
  assert.equal(shouldScheduleInjectRefreshAfterStream("idle"), true);
  assert.equal(shouldScheduleInjectRefreshAfterStream("started"), true);
  assert.equal(shouldScheduleInjectRefreshAfterStream("streaming"), true);
});

test("workspace presence polling pauses after a tab has been backgrounded for ten minutes", () => {
  assert.equal(BACKGROUND_PRESENCE_PAUSE_AFTER_MS, 600_000);
  assert.equal(shouldPollWorkspacePresence({
    now: 1_000,
    visible: true,
    hiddenSinceAt: 0,
  }), true);
  assert.equal(shouldPollWorkspacePresence({
    now: 60_000,
    visible: false,
    hiddenSinceAt: 0,
  }), true);
  assert.equal(shouldPollWorkspacePresence({
    now: 9 * 60_000,
    visible: false,
    hiddenSinceAt: 1_000,
  }), true);
  assert.equal(shouldPollWorkspacePresence({
    now: 11 * 60_000,
    visible: false,
    hiddenSinceAt: 1_000,
  }), false);
  assert.equal(shouldPollWorkspacePresence({
    now: 11 * 60_000,
    visible: false,
    hiddenSinceAt: 1_000,
    force: true,
  }), true);
});

test("workspace network leader suppresses duplicate realtime and polling work in follower tabs", () => {
  assert.equal(shouldRunWorkspaceNetworkLeader(true), true);
  assert.equal(shouldRunWorkspaceNetworkLeader(false), false);
});

test("session websocket requires explicit runtime support", () => {
  assert.equal(shouldUseBrowserRealtime(null), false);
  assert.equal(shouldUseBrowserRealtime({ runtime: "self_hosted" }), false);
  assert.equal(shouldUseBrowserRealtime({ runtime: "self_hosted", browser_realtime: false }), false);
  assert.equal(shouldUseBrowserRealtime({ runtime: "self_hosted", browser_realtime: true }), true);
});

test("reader terminal bridge auto-attach is self-hosted only", () => {
  assert.equal(shouldAutoAttachReaderTerminalBridge(null), false);
  assert.equal(shouldAutoAttachReaderTerminalBridge({ runtime: "managed", terminal_streaming: true }), false);
  assert.equal(shouldAutoAttachReaderTerminalBridge({ runtime: "managed", browser_realtime: true, terminal_streaming: true }), false);
  assert.equal(shouldAutoAttachReaderTerminalBridge({ runtime: "self_hosted" }), true);
});

test("host-only presence refresh updates session writability without catalog refresh", () => {
  const current = [
    session("sess_a", "dd_a", {
      connection_mode: "read_only",
      writable: false,
      channel_last_seen_at: "2026-05-23T07:50:00Z",
    }),
    session("sess_b", "dd_b", {
      connection_mode: "sdk_headless",
      writable: true,
    }),
  ];

  const online = mergeHostPresenceIntoSessions(current, [
    host("dd_a", {
      presence_status: "online",
      remote_access_enabled: true,
      status: "active",
      last_seen_at: "2026-05-23T08:10:00Z",
      last_channel_seen_at: "2026-05-23T08:10:00Z",
    }),
    host("dd_b", {
      presence_status: "offline",
      remote_access_enabled: true,
      status: "active",
    }),
  ]);

  assert.notEqual(online, current);
  assert.equal(online[0].writable, true);
  assert.equal(online[0].connection_mode, "sdk_headless");
  assert.equal(online[0].channel_last_seen_at, "2026-05-23T08:10:00Z");
  assert.equal(online[1].writable, false);
  assert.equal(online[1].connection_mode, "read_only");
});

test("host-only presence refresh preserves session object identity when unchanged", () => {
  const current = [session("sess_a", "dd_a")];
  const next = mergeHostPresenceIntoSessions(current, [
    host("dd_a", {
      presence_status: "online",
      remote_access_enabled: true,
      status: "active",
      last_channel_seen_at: "2026-05-23T08:00:00Z",
    }),
  ]);

  assert.equal(next, current);
});

test("offline catalog-only session explains lazy history backfill instead of loss", () => {
  const message = offlineLazyBackfillMessage(session("sess_old", "dd_a", {
    connection_mode: "read_only",
    writable: false,
    sync_state: "catalog_only",
    turn_count: 80,
    synced_turn_count: 0,
  }));

  assert.equal(message?.title, "Complete history needs this computer online");
  assert.match(message?.body ?? "", /0 \/ 80/);
});

test("offline partial session keeps synced history visible with complete-history hint", () => {
  const message = offlineLazyBackfillMessage(session("sess_partial", "dd_a", {
    connection_mode: "read_only",
    writable: false,
    sync_state: "partial",
    turn_count: 80,
    synced_turn_count: 20,
  }));

  assert.equal(message?.title, "Complete history needs this computer online");
  assert.match(message?.body ?? "", /20 \/ 80/);
});

test("offline fully synced session keeps the generic offline handoff copy", () => {
  const message = offlineLazyBackfillMessage(session("sess_done", "dd_a", {
    connection_mode: "read_only",
    writable: false,
    sync_state: "fully_synced",
    turn_count: 20,
    synced_turn_count: 20,
  }));

  assert.equal(message, null);
});

test("opening catalog-only or empty partial sessions triggers lazy sync", () => {
  assert.equal(shouldSyncSessionOnOpen(session("sess_old", "dd_a", {
    sync_state: "catalog_only",
    turn_count: 80,
    synced_turn_count: 0,
  }), []), true);
  assert.equal(shouldSyncSessionOnOpen(session("sess_partial", "dd_a", {
    sync_state: "partial",
    turn_count: 80,
    synced_turn_count: 20,
  }), []), true);
});

test("opening large catalog-only sessions does not auto backfill", () => {
  const large = session("sess_large", "dd_a", {
    sync_state: "catalog_only",
    turn_count: AUTOMATIC_SESSION_BACKFILL_TURN_LIMIT + 1,
    synced_turn_count: 0,
    has_older_turns: true,
  });

  assert.equal(isLargeSessionForAutomaticBackfill(large), true);
  assert.equal(shouldSyncSessionOnOpen(large, []), false);
});

test("large active sessions use a slower polling fallback", () => {
  const normal = session("sess_normal", "dd_a", {
    turn_count: AUTOMATIC_SESSION_BACKFILL_TURN_LIMIT,
  });
  const large = session("sess_large", "dd_a", {
    turn_count: AUTOMATIC_SESSION_BACKFILL_TURN_LIMIT + 1,
  });

  assert.equal(LARGE_SESSION_ACTIVE_EVENT_POLL_MS, 3_000);
  assert.deepEqual(injectPollOptionsForSession(normal, false), {});
  assert.deepEqual(injectPollOptionsForSession(large, false), { pollIntervalMs: LARGE_SESSION_ACTIVE_EVENT_POLL_MS });
  assert.deepEqual(injectPollOptionsForSession(large, true), { pollIntervalMs: 5_000 });
});

test("large open sessions use a slower catalog safety refresh", () => {
  const normal = session("sess_normal", "dd_a", {
    turn_count: AUTOMATIC_SESSION_BACKFILL_TURN_LIMIT,
  });
  const large = session("sess_large", "dd_a", {
    turn_count: AUTOMATIC_SESSION_BACKFILL_TURN_LIMIT + 1,
  });

  assert.equal(LARGE_SESSION_CATALOG_REFRESH_MS, 120_000);
  assert.equal(sessionCatalogRefreshIntervalForSession(null), SESSION_CATALOG_REFRESH_MS);
  assert.equal(sessionCatalogRefreshIntervalForSession(normal), SESSION_CATALOG_REFRESH_MS);
  assert.equal(sessionCatalogRefreshIntervalForSession(large), LARGE_SESSION_CATALOG_REFRESH_MS);
});

test("large session guard clears after the catalog is fully synced", () => {
  const synced = session("sess_large_done", "dd_a", {
    sync_state: "fully_synced",
    turn_count: AUTOMATIC_SESSION_BACKFILL_TURN_LIMIT + 1,
    synced_turn_count: AUTOMATIC_SESSION_BACKFILL_TURN_LIMIT + 1,
  });

  assert.equal(isLargeSessionForAutomaticBackfill(synced), false);
  assert.equal(shouldSyncSessionOnOpen(synced, []), false);
});

test("opening already hydrated or fully synced sessions does not re-sync", () => {
  assert.equal(shouldSyncSessionOnOpen(session("sess_partial", "dd_a", {
    sync_state: "partial",
    turn_count: 80,
    synced_turn_count: 20,
  }), [{ session_id: "sess_partial", device_id: "dd_a", seq: 61, kind: "assistant_text", agent: "claude-code", timestamp: "2026-05-23T08:00:00Z", payload: { text: "loaded" } }]), false);
  assert.equal(shouldSyncSessionOnOpen(session("sess_done", "dd_a", {
    sync_state: "fully_synced",
    turn_count: 20,
    synced_turn_count: 20,
  }), []), false);
});

test("load-earlier cursor prefers Nexus next_before_seq for non-contiguous history", () => {
  const selected = session("sess_gap", "dd_a", {
    sync_state: "partial",
    turn_count: 240,
    synced_turn_count: 140,
    synced_min_seq: 1,
    synced_max_seq: 240,
    has_older_turns: true,
  });

  assert.equal(nextLazyBackfillBeforeSeq({
    session_id: "sess_gap",
    turns: [],
    oldest_seq: 1,
    latest_seq: 240,
    synced_turn_count: 140,
    synced_min_seq: 1,
    synced_max_seq: 240,
    latest_contiguous_min_seq: 141,
    next_before_seq: 141,
    total_turn_count: 240,
    has_older_turns: true,
  }, [], selected), 141);
});

test("load-earlier cursor prefers already-persisted window before daemon sync", () => {
  const selected = session("sess_windowed", "dd_a", {
    sync_state: "fully_synced",
    turn_count: 240,
    synced_turn_count: 240,
    synced_min_seq: 1,
    synced_max_seq: 240,
    has_older_turns: false,
  });

  const hydration = {
    session_id: "sess_windowed",
    turns: [],
    oldest_seq: 141,
    latest_seq: 240,
    window_limit: 100,
    next_loaded_before_seq: 141,
    synced_turn_count: 240,
    synced_min_seq: 1,
    synced_max_seq: 240,
    latest_contiguous_min_seq: 1,
    next_before_seq: 0,
    total_turn_count: 240,
    has_older_turns: false,
  };

  assert.equal(nextLazyBackfillBeforeSeq(hydration, [], selected), 141);
  assert.equal(hasEarlierTurns(hydration, [], selected), true);
});

test("windowed fully-synced session has no earlier turns at the beginning", () => {
  const selected = session("sess_windowed_start", "dd_a", {
    sync_state: "fully_synced",
    turn_count: 20,
    synced_turn_count: 20,
    synced_min_seq: 1,
    synced_max_seq: 20,
    has_older_turns: false,
  });

  assert.equal(hasEarlierTurns({
    session_id: "sess_windowed_start",
    turns: [],
    oldest_seq: 1,
    latest_seq: 20,
    window_limit: 100,
    next_loaded_before_seq: 0,
    synced_turn_count: 20,
    synced_min_seq: 1,
    synced_max_seq: 20,
    latest_contiguous_min_seq: 1,
    total_turn_count: 20,
    has_older_turns: false,
  }, Array.from({ length: 20 }, (_, index) => ({
    session_id: "sess_windowed_start",
    device_id: "dd_a",
    seq: index + 1,
    agent: "claude-code",
    kind: "assistant_text",
    timestamp: "",
    payload: { text: `turn ${index + 1}` },
  })), selected), false);
});

test("load-earlier cursor falls back to oldest loaded seq for contiguous partial history", () => {
  const selected = session("sess_partial", "dd_a", {
    sync_state: "partial",
    turn_count: 240,
    synced_turn_count: 100,
    synced_min_seq: 141,
    synced_max_seq: 240,
    has_older_turns: true,
  });

  assert.equal(nextLazyBackfillBeforeSeq({
    session_id: "sess_partial",
    turns: [],
    oldest_seq: 141,
    latest_seq: 240,
    synced_turn_count: 100,
    synced_min_seq: 141,
    synced_max_seq: 240,
    latest_contiguous_min_seq: 141,
    next_before_seq: 0,
    total_turn_count: 240,
    has_older_turns: true,
  }, [], selected), 141);
});

test("load-earlier cursor uses zero for the first manual window", () => {
  const selected = session("sess_large", "dd_a", {
    sync_state: "catalog_only",
    turn_count: AUTOMATIC_SESSION_BACKFILL_TURN_LIMIT + 1,
    synced_turn_count: 0,
    synced_min_seq: 0,
    synced_max_seq: 0,
    has_older_turns: true,
  });

  assert.equal(nextLazyBackfillBeforeSeq(null, [], selected), 0);
});

test("transient daemon history windows keep load-earlier cursor without remote persistence", () => {
  const selected = session("sess_transient", "dd_a", {
    sync_state: "partial",
    turn_count: 240,
    synced_turn_count: 100,
    synced_min_seq: 141,
    synced_max_seq: 240,
    has_older_turns: true,
  });
  const hydration = transientTurnsHydration("sess_transient", [{
    session_id: "sess_transient",
    device_id: "dd_a",
    seq: 121,
    agent: "claude-code",
    kind: "assistant_text",
    timestamp: "2026-06-06T00:00:00Z",
    payload: { text: "older window" },
  }, {
    session_id: "sess_transient",
    device_id: "dd_a",
    seq: 140,
    agent: "claude-code",
    kind: "assistant_text",
    timestamp: "2026-06-06T00:00:01Z",
    payload: { text: "older window tail" },
  }], {
    request_id: "sync_1",
    session_id: "sess_transient",
    stage: "completed",
    status: "completed",
    has_older: true,
    total_turn_count: 240,
  });

  assert.equal(hydration.source, "local_transient");
  assert.equal(hydration.next_loaded_before_seq, 0);
  assert.equal(hydration.next_before_seq, 121);
  assert.equal(nextLazyBackfillBeforeSeq(hydration, [], selected), 121);
  assert.equal(hasEarlierTurns(hydration, [], selected), true);
});

test("transient sync turns are not overwritten by an empty persisted remote window", () => {
  assert.equal(shouldRefreshPersistentTurnsAfterSync(true), false);
  assert.equal(shouldRefreshPersistentTurnsAfterSync(false), true);
});
