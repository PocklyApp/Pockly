/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { SessionListItem } from "./api";
import {
  clearSessionCatalogCache,
  loadSessionCatalogCache,
  mergeSessionCatalogDelta,
  mergeSessionCatalogPage,
  replaceSessionCatalogPage,
  saveSessionCatalogCache,
  sessionCatalogCacheKey,
} from "./session-catalog-cache";
import { installFakeIndexedDB, memoryStorage, throwingStorage } from "./test/fake-indexeddb";

function session(sessionId: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: sessionId,
    device_id: "dd_test",
    agent: "claude-code",
    cwd: "/tmp/project",
    snippet: sessionId,
    last_seq: 1,
    last_timestamp: "2026-06-13T00:00:00.000Z",
    ...overrides,
  };
}

test("session catalog delta merges upserts, tombstones, and keeps recency order", () => {
  const current = {
    cursor: "sc_1",
    updated_at: 1,
    sessions: [
      session("old", { last_timestamp: "2026-06-13T00:00:00.000Z" }),
      session("deleted", { last_timestamp: "2026-06-13T00:01:00.000Z" }),
    ],
  };

  const merged = mergeSessionCatalogDelta(current, {
    upserts: [
      session("new", { last_timestamp: "2026-06-13T00:03:00.000Z" }),
      session("old", { last_seq: 9, last_timestamp: "2026-06-13T00:02:00.000Z" }),
    ],
    deletes: [{ device_id: "dd_test", session_id: "deleted" }],
    next_cursor: "sc_2",
    has_more: false,
  });

  assert.deepEqual(merged.sessions.map((item) => item.session_id), ["new", "old"]);
  assert.equal(merged.sessions.find((item) => item.session_id === "old")?.last_seq, 9);
  assert.equal(merged.cursor, "sc_2");
});

test("session catalog delta tombstone hides a Codex session archived in the native app", () => {
  const current = {
    cursor: "sc_before_archive",
    updated_at: 1,
    sessions: [
      session("codex_visible", { agent: "codex", device_id: "dd_codex", last_timestamp: "2026-06-13T00:02:00.000Z" }),
      session("codex_archived", { agent: "codex", device_id: "dd_codex", last_timestamp: "2026-06-13T00:01:00.000Z" }),
    ],
  };

  const merged = mergeSessionCatalogDelta(current, {
    upserts: [],
    deletes: [{ device_id: "dd_codex", session_id: "codex_archived" }],
    next_cursor: "sc_after_archive",
    has_more: false,
  });

  assert.deepEqual(merged.sessions.map((item) => item.session_id), ["codex_visible"]);
  assert.equal(merged.cursor, "sc_after_archive");
});

test("session catalog reset delta replaces stale cached sessions", () => {
  const merged = mergeSessionCatalogDelta({
    cursor: "sc_old",
    updated_at: 1,
    sessions: [
      session("stale", { last_timestamp: "2026-06-13T00:01:00.000Z" }),
    ],
  }, {
    reset: true,
    upserts: [
      session("fresh", { last_timestamp: "2026-06-13T00:02:00.000Z" }),
    ],
    deletes: [],
    next_cursor: "sc_fresh",
    next_page_cursor: "page_next",
    has_more: true,
  });

  assert.deepEqual(merged.sessions.map((item) => item.session_id), ["fresh"]);
  assert.equal(merged.cursor, "sc_fresh");
  assert.equal(merged.page_cursor, "page_next");
  assert.equal(merged.has_more_pages, true);
});

test("session catalog initial page reset clears stale cached sessions", () => {
  const merged = replaceSessionCatalogPage({
    upserts: [
      session("first_page", { last_timestamp: "2026-06-13T00:02:00.000Z" }),
    ],
    deletes: [],
    next_cursor: "sc_page",
    next_page_cursor: "page_2",
    has_more: true,
  });

  assert.deepEqual(merged.sessions.map((item) => item.session_id), ["first_page"]);
  assert.equal(merged.cursor, "sc_page");
  assert.equal(merged.page_cursor, "page_2");
  assert.equal(merged.has_more_pages, true);
});

test("session catalog initial page records the delta cursor for future incremental refreshes", () => {
  const merged = replaceSessionCatalogPage({
    upserts: [
      session("first_page", { last_timestamp: "2026-06-13T00:02:00.000Z" }),
    ],
    deletes: [],
    next_cursor: "sc_initial_cursor",
    next_page_cursor: "page_2",
    has_more: true,
  });

  assert.deepEqual(merged.sessions.map((item) => item.session_id), ["first_page"]);
  assert.equal(merged.cursor, "sc_initial_cursor");
  assert.equal(merged.page_cursor, "page_2");
  assert.equal(merged.has_more_pages, true);
});

test("session catalog next page merges without clearing cached sessions", () => {
  const merged = mergeSessionCatalogPage({
    cursor: "sc_cached",
    page_cursor: "page_2",
    has_more_pages: true,
    updated_at: 1,
    sessions: [
      session("first_page", { last_timestamp: "2026-06-13T00:02:00.000Z" }),
    ],
  }, {
    upserts: [
      session("second_page", { last_timestamp: "2026-06-13T00:01:00.000Z" }),
    ],
    deletes: [],
    next_cursor: "sc_cached",
    next_page_cursor: "",
    has_more: false,
  });

  assert.deepEqual(merged.sessions.map((item) => item.session_id), ["first_page", "second_page"]);
  assert.equal(merged.cursor, "sc_cached");
  assert.equal(merged.page_cursor, "");
  assert.equal(merged.has_more_pages, false);
});

test("session catalog next page does not advance the delta cursor", () => {
  const merged = mergeSessionCatalogPage({
    cursor: "sc_before_page_load",
    page_cursor: "page_2",
    has_more_pages: true,
    updated_at: 1,
    sessions: [
      session("first_page", { last_timestamp: "2026-06-13T00:03:00.000Z" }),
    ],
  }, {
    upserts: [
      session("older_page", { last_timestamp: "2026-06-13T00:01:00.000Z" }),
    ],
    deletes: [],
    next_cursor: "sc_concurrent_newer_change",
    next_page_cursor: "",
    has_more: false,
  });

  assert.deepEqual(merged.sessions.map((item) => item.session_id), ["first_page", "older_page"]);
  assert.equal(merged.cursor, "sc_before_page_load");
  assert.equal(merged.page_cursor, "");
  assert.equal(merged.has_more_pages, false);
});

test("session catalog cache is scoped by normalized user key and falls back to localStorage", async () => {
  const globals = globalThis as unknown as {
    indexedDB: IDBFactory | undefined;
    localStorage: Storage | undefined;
  };
  const originalIndexedDB = globals.indexedDB;
  const originalLocalStorage = globals.localStorage;
  globals.indexedDB = undefined;
  globals.localStorage = memoryStorage();
  try {
    const userKey = sessionCatalogCacheKey("User@Example.Local ");
    assert.equal(userKey, "user@example.local");
    await saveSessionCatalogCache(userKey, {
      cursor: "sc_saved",
      updated_at: 42,
      sessions: [session("saved")],
    });

    const loaded = await loadSessionCatalogCache("USER@example.local");
    assert.equal(loaded?.cursor, "sc_saved");
    assert.deepEqual(loaded?.sessions.map((item) => item.session_id), ["saved"]);

    await clearSessionCatalogCache(userKey);
    assert.equal(await loadSessionCatalogCache(userKey), null);
  } finally {
    globals.indexedDB = originalIndexedDB;
    globals.localStorage = originalLocalStorage;
  }
});

test("session catalog cache uses IndexedDB before localStorage", async () => {
  const globals = globalThis as unknown as {
    indexedDB: IDBFactory | undefined;
    localStorage: Storage | undefined;
  };
  const originalIndexedDB = globals.indexedDB;
  const originalLocalStorage = globals.localStorage;
  globals.indexedDB = installFakeIndexedDB();
  globals.localStorage = throwingStorage();
  try {
    await saveSessionCatalogCache("User@Example.Local ", {
      cursor: "sc_idb",
      page_cursor: "page_2",
      has_more_pages: true,
      updated_at: 42,
      sessions: [
        session("older", { last_timestamp: "2026-06-13T00:00:00.000Z" }),
        session("newer", { last_timestamp: "2026-06-13T00:01:00.000Z" }),
      ],
    });

    const loaded = await loadSessionCatalogCache("user@example.local");
    assert.equal(loaded?.cursor, "sc_idb");
    assert.equal(loaded?.page_cursor, "page_2");
    assert.equal(loaded?.has_more_pages, true);
    assert.deepEqual(loaded?.sessions.map((item) => item.session_id), ["newer", "older"]);
  } finally {
    globals.indexedDB = originalIndexedDB;
    globals.localStorage = originalLocalStorage;
  }
});

test("session catalog cache deletes IndexedDB records", async () => {
  const globals = globalThis as unknown as {
    indexedDB: IDBFactory | undefined;
    localStorage: Storage | undefined;
  };
  const originalIndexedDB = globals.indexedDB;
  const originalLocalStorage = globals.localStorage;
  globals.indexedDB = installFakeIndexedDB();
  globals.localStorage = memoryStorage();
  try {
    await saveSessionCatalogCache("user@example.local", {
      cursor: "sc_idb",
      updated_at: 42,
      sessions: [session("saved")],
    });
    assert.equal((await loadSessionCatalogCache("user@example.local"))?.cursor, "sc_idb");

    await clearSessionCatalogCache("user@example.local");
    assert.equal(await loadSessionCatalogCache("user@example.local"), null);
  } finally {
    globals.indexedDB = originalIndexedDB;
    globals.localStorage = originalLocalStorage;
  }
});
