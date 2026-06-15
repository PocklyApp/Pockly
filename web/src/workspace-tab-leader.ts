/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export const WORKSPACE_TAB_LEADER_CHANNEL = "pockly.workspace-tab-leader.v1";
const leaderStoragePrefix = "pockly.workspaceTabLeader.v1.";
const defaultLeaseMs = 8000;
const defaultRenewMs = 2500;

export type WorkspaceTabLeaderMessage =
  | { type: "leader"; tab_id: string; expires_at: number }
  | { type: "host_status"; host: unknown }
  | { type: "turn"; turn: unknown }
  | { type: "session_status"; status: string; detail?: string }
  | { type: "subscribe_session"; tab_id: string; session_id: string; device_id: string; after_seq: number }
  | { type: "unsubscribe_session"; tab_id: string; session_id: string; device_id: string };

export type WorkspaceTabLeaderHandle = {
  readonly tabID: string;
  readonly isLeader: boolean;
  readonly coordinatesTabs: boolean;
  onChange(listener: (isLeader: boolean) => void): () => void;
  onMessage(listener: (message: WorkspaceTabLeaderMessage) => void): () => void;
  post(message: WorkspaceTabLeaderMessage): void;
  close(): void;
};

export function createWorkspaceTabLeader(
  userKey: string,
  options: {
    now?: () => number;
    storage?: Storage | null;
    channel?: BroadcastChannel | null;
    leaseMs?: number;
    renewMs?: number;
    setInterval?: typeof window.setInterval;
    clearInterval?: typeof window.clearInterval;
    tabID?: string;
  } = {},
): WorkspaceTabLeaderHandle {
  const key = workspaceLeaderStorageKey(userKey);
  const now = options.now ?? (() => Date.now());
  const rawStorage = options.storage === undefined ? safeLocalStorage() : options.storage;
  const channel = options.channel === undefined ? createBroadcastChannelSafe() : options.channel;
  const coordinatesTabs = Boolean(rawStorage && channel);
  const storage = coordinatesTabs ? rawStorage : null;
  const leaseMs = Math.max(1000, options.leaseMs ?? defaultLeaseMs);
  const renewMs = Math.max(250, Math.min(leaseMs / 2, options.renewMs ?? defaultRenewMs));
  const setTimer = options.setInterval ?? window.setInterval.bind(window);
  const clearTimer = options.clearInterval ?? window.clearInterval.bind(window);
  const tabID = options.tabID ?? randomTabID();
  const listeners = new Set<(isLeader: boolean) => void>();
  const messageListeners = new Set<(message: WorkspaceTabLeaderMessage) => void>();
  let closed = false;
  let leader = false;

  const notify = () => {
    for (const listener of listeners) listener(leader);
  };
  const setLeader = (next: boolean) => {
    if (leader === next) return;
    leader = next;
    notify();
  };
  const heartbeat = () => {
    if (closed) return;
    if (!storage) {
      setLeader(true);
      return;
    }
    const current = readLeaderLease(storage, key);
    const currentLive = current && current.expires_at > now();
    if (!currentLive || current.tab_id === tabID) {
      const lease = { tab_id: tabID, expires_at: now() + leaseMs };
      writeLeaderLease(storage, key, lease);
      setLeader(true);
      channel?.postMessage({ type: "leader", ...lease });
      return;
    }
    setLeader(false);
  };

  const onChannelMessage = (event: MessageEvent) => {
    const message = event.data as WorkspaceTabLeaderMessage | undefined;
    if (!message || typeof message !== "object") return;
    if (coordinatesTabs && message.type === "leader" && message.tab_id !== tabID && message.expires_at > now()) {
      setLeader(false);
    }
    for (const listener of messageListeners) listener(message);
  };
  channel?.addEventListener("message", onChannelMessage);
  heartbeat();
  const timer = setTimer(heartbeat, renewMs);

  return {
    tabID,
    coordinatesTabs,
    get isLeader() {
      return leader;
    },
    onChange(listener) {
      listeners.add(listener);
      listener(leader);
      return () => listeners.delete(listener);
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    post(message) {
      channel?.postMessage(message);
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimer(timer);
      if (leader && storage) {
        const current = readLeaderLease(storage, key);
        if (current?.tab_id === tabID) storage.removeItem(key);
      }
      channel?.removeEventListener("message", onChannelMessage);
      channel?.close();
      listeners.clear();
      messageListeners.clear();
    },
  };
}

export function workspaceLeaderStorageKey(userKey: string) {
  return `${leaderStoragePrefix}${encodeURIComponent(userKey.trim().toLowerCase())}`;
}

function readLeaderLease(storage: Storage, key: string): { tab_id: string; expires_at: number } | null {
  try {
    const value = JSON.parse(storage.getItem(key) || "null") as { tab_id?: unknown; expires_at?: unknown } | null;
    if (!value || typeof value.tab_id !== "string") return null;
    const expiresAt = Number(value.expires_at ?? 0) || 0;
    if (expiresAt <= 0) return null;
    return { tab_id: value.tab_id, expires_at: expiresAt };
  } catch {
    return null;
  }
}

function writeLeaderLease(storage: Storage, key: string, lease: { tab_id: string; expires_at: number }) {
  try {
    storage.setItem(key, JSON.stringify(lease));
  } catch {
    // Local storage may be unavailable; caller falls back to per-tab leader.
  }
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function createBroadcastChannelSafe() {
  try {
    if (typeof BroadcastChannel === "undefined") return null;
    return new BroadcastChannel(WORKSPACE_TAB_LEADER_CHANNEL);
  } catch {
    return null;
  }
}

function randomTabID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
