/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { SessionTurn } from "./api";
import {
  SESSION_TURNS_CACHE_LIMIT,
  clearSessionTurnsCache,
  loadSessionTurnsCache,
  mergeSessionTurnsCache,
  saveSessionTurnsCache,
  sessionTurnsCacheKey,
} from "./session-turns-cache";
import { installFakeIndexedDB, memoryStorage, throwingStorage } from "./test/fake-indexeddb";

function turn(seq: number, text = `turn ${seq}`): SessionTurn {
  return {
    device_id: "dd_test",
    session_id: "sess_test",
    seq,
    agent: "claude-code",
    kind: "assistant_text",
    timestamp: "2026-06-13T00:00:00.000Z",
    payload: { text },
  };
}

test("session turns cache merges by turn identity and trims old rows", () => {
  const seed = Array.from({ length: SESSION_TURNS_CACHE_LIMIT }, (_, index) => turn(index + 1));
  const merged = mergeSessionTurnsCache({
    device_id: "dd_test",
    session_id: "sess_test",
    turns: seed,
    hydration: {
      session_id: "sess_test",
      turns: seed,
      source: "local_transient",
      oldest_seq: 1,
      latest_seq: SESSION_TURNS_CACHE_LIMIT,
      synced_turn_count: SESSION_TURNS_CACHE_LIMIT,
    },
    updated_at: 1,
  }, {
    deviceId: "dd_test",
    sessionId: "sess_test",
    turns: [turn(SESSION_TURNS_CACHE_LIMIT, "updated"), turn(SESSION_TURNS_CACHE_LIMIT + 1)],
    hydration: {
      session_id: "sess_test",
      turns: [],
      source: "remote_hot_window",
      latest_seq: SESSION_TURNS_CACHE_LIMIT + 1,
      synced_turn_count: SESSION_TURNS_CACHE_LIMIT + 1,
    },
  });

  assert.equal(merged.turns.length, SESSION_TURNS_CACHE_LIMIT);
  assert.equal(merged.turns[0].seq, 2);
  assert.equal(merged.turns.at(-1)?.seq, SESSION_TURNS_CACHE_LIMIT + 1);
  assert.equal(merged.turns.find((item) => item.seq === SESSION_TURNS_CACHE_LIMIT)?.payload?.text, "updated");
  assert.equal(merged.hydration?.oldest_seq, 2);
  assert.equal(merged.hydration?.latest_seq, SESSION_TURNS_CACHE_LIMIT + 1);
  assert.equal(merged.hydration?.source, "remote_hot_window");
});

test("session turns cache is scoped by user, device, and session with localStorage fallback", async () => {
  const globals = globalThis as unknown as {
    indexedDB: IDBFactory | undefined;
    localStorage: Storage | undefined;
  };
  const originalIndexedDB = globals.indexedDB;
  const originalLocalStorage = globals.localStorage;
  globals.indexedDB = undefined;
  globals.localStorage = memoryStorage();
  try {
    assert.equal(sessionTurnsCacheKey("User@Example.Local ", "dd_test", "sess_test"), "user@example.local:dd_test:sess_test");
    await saveSessionTurnsCache("User@Example.Local ", {
      device_id: "dd_test",
      session_id: "sess_test",
      turns: [turn(1)],
      hydration: { session_id: "sess_test", turns: [turn(1)], latest_seq: 1, source: "local_transient" },
      updated_at: 42,
    });

    const loaded = await loadSessionTurnsCache("user@example.local", "dd_test", "sess_test");
    assert.equal(loaded?.turns.length, 1);
    assert.equal(loaded?.hydration?.latest_seq, 1);
    assert.equal(loaded?.hydration?.source, "local_transient");

    await clearSessionTurnsCache("user@example.local", "dd_test", "sess_test");
    assert.equal(await loadSessionTurnsCache("user@example.local", "dd_test", "sess_test"), null);
  } finally {
    globals.indexedDB = originalIndexedDB;
    globals.localStorage = originalLocalStorage;
  }
});

test("session turns cache uses IndexedDB before localStorage", async () => {
  const globals = globalThis as unknown as {
    indexedDB: IDBFactory | undefined;
    localStorage: Storage | undefined;
  };
  const originalIndexedDB = globals.indexedDB;
  const originalLocalStorage = globals.localStorage;
  globals.indexedDB = installFakeIndexedDB();
  globals.localStorage = throwingStorage();
  try {
    await saveSessionTurnsCache("User@Example.Local ", {
      device_id: "dd_test",
      session_id: "sess_test",
      turns: [turn(2), turn(1)],
      hydration: { session_id: "sess_test", turns: [turn(1), turn(2)], oldest_seq: 1, latest_seq: 2 },
      updated_at: 42,
    });

    const loaded = await loadSessionTurnsCache("user@example.local", "dd_test", "sess_test");
    assert.deepEqual(loaded?.turns.map((item) => item.seq), [2, 1]);
    assert.equal(loaded?.hydration?.latest_seq, 2);
  } finally {
    globals.indexedDB = originalIndexedDB;
    globals.localStorage = originalLocalStorage;
  }
});

test("session turns cache clears all IndexedDB records for a user", async () => {
  const globals = globalThis as unknown as {
    indexedDB: IDBFactory | undefined;
    localStorage: Storage | undefined;
  };
  const originalIndexedDB = globals.indexedDB;
  const originalLocalStorage = globals.localStorage;
  globals.indexedDB = installFakeIndexedDB();
  globals.localStorage = memoryStorage();
  try {
    await saveSessionTurnsCache("user@example.local", {
      device_id: "dd_a",
      session_id: "sess_a",
      turns: [turn(1)],
      hydration: { session_id: "sess_a", turns: [turn(1)], latest_seq: 1 },
      updated_at: 42,
    });
    await saveSessionTurnsCache("user@example.local", {
      device_id: "dd_b",
      session_id: "sess_b",
      turns: [turn(2)],
      hydration: { session_id: "sess_b", turns: [turn(2)], latest_seq: 2 },
      updated_at: 43,
    });
    await saveSessionTurnsCache("other@example.local", {
      device_id: "dd_c",
      session_id: "sess_c",
      turns: [turn(3)],
      hydration: { session_id: "sess_c", turns: [turn(3)], latest_seq: 3 },
      updated_at: 44,
    });

    await clearSessionTurnsCache("user@example.local");

    assert.equal(await loadSessionTurnsCache("user@example.local", "dd_a", "sess_a"), null);
    assert.equal(await loadSessionTurnsCache("user@example.local", "dd_b", "sess_b"), null);
    assert.equal((await loadSessionTurnsCache("other@example.local", "dd_c", "sess_c"))?.turns[0]?.seq, 3);
  } finally {
    globals.indexedDB = originalIndexedDB;
    globals.localStorage = originalLocalStorage;
  }
});
