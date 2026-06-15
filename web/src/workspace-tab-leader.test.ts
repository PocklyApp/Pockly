/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createWorkspaceTabLeader, workspaceLeaderStorageKey } from "./workspace-tab-leader";
import { memoryStorage, throwingStorage } from "./test/fake-indexeddb";

class FakeBroadcastChannel {
  closed = false;
  messages: unknown[] = [];
  addEventListener() {}
  removeEventListener() {}
  postMessage(message: unknown) {
    this.messages.push(message);
  }
  close() {
    this.closed = true;
  }
}

test("workspace tab leader lets only one live tab hold the lease", () => {
  let now = 1_000;
  let timers = 0;
  const storage = memoryStorage();
  const first = createWorkspaceTabLeader("user@example.com", {
    now: () => now,
    storage,
    channel: new FakeBroadcastChannel() as unknown as BroadcastChannel,
    setInterval: (() => ++timers) as unknown as typeof window.setInterval,
    clearInterval: (() => {}) as unknown as typeof window.clearInterval,
    tabID: "tab_a",
    leaseMs: 8_000,
  });
  const second = createWorkspaceTabLeader("user@example.com", {
    now: () => now,
    storage,
    channel: new FakeBroadcastChannel() as unknown as BroadcastChannel,
    setInterval: (() => ++timers) as unknown as typeof window.setInterval,
    clearInterval: (() => {}) as unknown as typeof window.clearInterval,
    tabID: "tab_b",
    leaseMs: 8_000,
  });

  assert.equal(first.isLeader, true);
  assert.equal(first.coordinatesTabs, true);
  assert.equal(second.isLeader, false);
  assert.equal(second.coordinatesTabs, true);
  assert.equal(JSON.parse(storage.getItem(workspaceLeaderStorageKey("user@example.com")) || "{}").tab_id, "tab_a");

  first.close();
  now += 9_000;
  const third = createWorkspaceTabLeader("user@example.com", {
    now: () => now,
    storage,
    channel: new FakeBroadcastChannel() as unknown as BroadcastChannel,
    setInterval: (() => ++timers) as unknown as typeof window.setInterval,
    clearInterval: (() => {}) as unknown as typeof window.clearInterval,
    tabID: "tab_c",
    leaseMs: 8_000,
  });

  assert.equal(third.isLeader, true);
  assert.equal(timers, 3);
  second.close();
  third.close();
});

test("workspace tab leader falls back to current tab when storage is unavailable", () => {
  const leader = createWorkspaceTabLeader("user@example.com", {
    storage: throwingStorage(),
    channel: null,
    setInterval: (() => 1) as unknown as typeof window.setInterval,
    clearInterval: (() => {}) as unknown as typeof window.clearInterval,
    tabID: "tab_single",
  });

  assert.equal(leader.isLeader, true);
  assert.equal(leader.coordinatesTabs, false);
  leader.close();
});

test("workspace tab leader does not suppress tabs when broadcasts are unavailable", () => {
  const storage = memoryStorage();
  const first = createWorkspaceTabLeader("user@example.com", {
    storage,
    channel: null,
    setInterval: (() => 1) as unknown as typeof window.setInterval,
    clearInterval: (() => {}) as unknown as typeof window.clearInterval,
    tabID: "tab_a",
  });
  const second = createWorkspaceTabLeader("user@example.com", {
    storage,
    channel: null,
    setInterval: (() => 1) as unknown as typeof window.setInterval,
    clearInterval: (() => {}) as unknown as typeof window.clearInterval,
    tabID: "tab_b",
  });

  assert.equal(first.isLeader, true);
  assert.equal(second.isLeader, true);
  assert.equal(first.coordinatesTabs, false);
  assert.equal(second.coordinatesTabs, false);
  assert.equal(storage.getItem(workspaceLeaderStorageKey("user@example.com")), null);
  first.close();
  second.close();
});

test("workspace tab leader forwards non-leader messages to listeners", () => {
  let dispatch: (event: { data: unknown }) => void = (_event) => {
    throw new Error("expected broadcast listener to be registered");
  };
  const channel = {
    addEventListener(_type: string, next: (event: { data: unknown }) => void) {
      dispatch = next;
    },
    removeEventListener() {
      dispatch = () => {};
    },
    postMessage() {},
    close() {},
  } as unknown as BroadcastChannel;
  const leader = createWorkspaceTabLeader("user@example.com", {
    storage: memoryStorage(),
    channel,
    setInterval: (() => 1) as unknown as typeof window.setInterval,
    clearInterval: (() => {}) as unknown as typeof window.clearInterval,
    tabID: "tab_a",
  });
  const messages: unknown[] = [];
  leader.onMessage((message) => messages.push(message));

  dispatch({ data: { type: "host_status", host: { device_id: "dev_1" } } });

  assert.deepEqual(messages, [{ type: "host_status", host: { device_id: "dev_1" } }]);
  leader.close();
});
