/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { Device, HostSummary, SessionListItem } from "./api";
import {
  bestContinuationCandidate,
  daemonUpdateTargets,
  devicePresenceStatus,
  findCreatedSessionForDraft,
  groupSessions,
  pickSelection,
  shouldGateAuthenticatedWorkspaceSplash,
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

test("daemonUpdateTargets uses relay CDN latest metadata", () => {
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

test("daemonUpdateTargets falls back to minimum recommended version for old relays", () => {
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

test("daemonUpdateTargets can use CDN latest metadata from device records", () => {
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

test("devicePresenceStatus trusts relay presence_status when provided", () => {
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
      cwd: "/Users/example/Desktop/workspace/Pockly",
      last_timestamp: "2026-06-06T08:00:00Z",
    }),
    session("sess_codex", "dd_a", {
      agent: "codex",
      cwd: "/Users/example/Desktop/workspace/Pockly/",
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
  // The next catalog refresh runs before the relay has caught up, so the
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
