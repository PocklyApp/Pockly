/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionCatalogDelta, SessionListItem } from "./api";

const catalogCacheSchemaVersion = 1;
const catalogCacheLocalStoragePrefix = "pockly.sessionCatalog.v1.";
const catalogCacheDBName = "pockly-web-cache";
const catalogCacheStoreName = "session_catalog";

export type SessionCatalogSnapshot = {
  sessions: SessionListItem[];
  cursor: string;
  page_cursor?: string;
  has_more_pages?: boolean;
  updated_at: number;
};

type SessionCatalogCacheRecord = {
  key: string;
  snapshot: SessionCatalogSnapshot;
  schema_version: number;
};

export function sessionCatalogCacheKey(userKey: string) {
  return userKey.trim().toLowerCase();
}

export function mergeSessionCatalogDelta(
  current: SessionCatalogSnapshot | { sessions: SessionListItem[]; cursor?: string },
  delta: SessionCatalogDelta,
): SessionCatalogSnapshot {
  if (delta.reset) return sessionCatalogSnapshotFromPage(delta);
  const byKey = new Map<string, SessionListItem>();
  for (const session of current.sessions) {
    byKey.set(sessionCatalogItemKey(session), session);
  }
  for (const deleted of delta.deletes ?? []) {
    byKey.delete(sessionCatalogItemKey(deleted));
  }
  for (const session of delta.upserts ?? []) {
    byKey.set(sessionCatalogItemKey(session), session);
  }
  return {
    sessions: sortSessionCatalog(Array.from(byKey.values())),
    cursor: delta.next_cursor || current.cursor || "",
    page_cursor: "page_cursor" in current ? current.page_cursor : "",
    has_more_pages: "has_more_pages" in current ? current.has_more_pages : false,
    updated_at: Date.now(),
  };
}

export function mergeSessionCatalogPage(
  current: SessionCatalogSnapshot | { sessions: SessionListItem[]; cursor?: string },
  page: SessionCatalogDelta,
): SessionCatalogSnapshot {
  if (page.reset) return sessionCatalogSnapshotFromPage(page);
  const merged = mergeSessionCatalogDelta(current, page);
  return {
    ...merged,
    // Page loads fetch older catalog rows by a page cursor; they are not a
    // replay of the change log. Advancing the delta cursor here can skip
    // concurrent upserts/deletes that happened after the previous cursor.
    cursor: current.cursor || "",
    page_cursor: page.next_page_cursor || "",
    has_more_pages: Boolean(page.has_more && page.next_page_cursor),
  };
}

export function replaceSessionCatalogPage(page: SessionCatalogDelta): SessionCatalogSnapshot {
  return sessionCatalogSnapshotFromPage({ ...page, reset: true });
}

function sessionCatalogSnapshotFromPage(page: SessionCatalogDelta): SessionCatalogSnapshot {
  return {
    sessions: sortSessionCatalog(page.upserts ?? []),
    cursor: page.next_cursor || "",
    page_cursor: page.next_page_cursor || "",
    has_more_pages: Boolean(page.has_more && page.next_page_cursor),
    updated_at: Date.now(),
  };
}

export async function loadSessionCatalogCache(userKey: string): Promise<SessionCatalogSnapshot | null> {
  const key = sessionCatalogCacheKey(userKey);
  if (!key) return null;
  const idbSnapshot = await loadSessionCatalogCacheFromIDB(key).catch(() => null);
  if (idbSnapshot) return idbSnapshot;
  return loadSessionCatalogCacheFromLocalStorage(key);
}

export async function saveSessionCatalogCache(userKey: string, snapshot: SessionCatalogSnapshot): Promise<void> {
  const key = sessionCatalogCacheKey(userKey);
  if (!key) return;
  const normalized: SessionCatalogSnapshot = {
    sessions: sortSessionCatalog(snapshot.sessions),
    cursor: snapshot.cursor || "",
    page_cursor: snapshot.page_cursor || "",
    has_more_pages: Boolean(snapshot.has_more_pages),
    updated_at: snapshot.updated_at || Date.now(),
  };
  await saveSessionCatalogCacheToIDB(key, normalized).catch(() => {
    saveSessionCatalogCacheToLocalStorage(key, normalized);
  });
}

export async function clearSessionCatalogCache(userKey: string): Promise<void> {
  const key = sessionCatalogCacheKey(userKey);
  if (!key) return;
  await deleteSessionCatalogCacheFromIDB(key).catch(() => undefined);
  try {
    globalThis.localStorage?.removeItem(localStorageKey(key));
  } catch {
    // Storage may be unavailable in privacy modes or tests.
  }
}

function sessionCatalogItemKey(item: { device_id: string; session_id: string }) {
  return `${item.device_id}:${item.session_id}`;
}

function sortSessionCatalog(sessions: SessionListItem[]) {
  return [...sessions].sort((left, right) => {
    const timeDiff = (Date.parse(right.last_timestamp || "") || 0) - (Date.parse(left.last_timestamp || "") || 0);
    if (timeDiff !== 0) return timeDiff;
    const seqDiff = (right.last_seq || 0) - (left.last_seq || 0);
    if (seqDiff !== 0) return seqDiff;
    const deviceDiff = left.device_id.localeCompare(right.device_id);
    if (deviceDiff !== 0) return deviceDiff;
    return left.session_id.localeCompare(right.session_id);
  });
}

function localStorageKey(key: string) {
  return `${catalogCacheLocalStoragePrefix}${encodeURIComponent(key)}`;
}

function loadSessionCatalogCacheFromLocalStorage(key: string) {
  try {
    const raw = globalThis.localStorage?.getItem(localStorageKey(key));
    if (!raw) return null;
    return parseCacheRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveSessionCatalogCacheToLocalStorage(key: string, snapshot: SessionCatalogSnapshot) {
  try {
    globalThis.localStorage?.setItem(
      localStorageKey(key),
      JSON.stringify({
        key,
        schema_version: catalogCacheSchemaVersion,
        snapshot,
      } satisfies SessionCatalogCacheRecord),
    );
  } catch {
    // Best effort only; network delta still works without local cache.
  }
}

function parseCacheRecord(value: unknown): SessionCatalogSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<SessionCatalogCacheRecord>;
  if (record.schema_version !== catalogCacheSchemaVersion) return null;
  const snapshot = record.snapshot;
  if (!snapshot || !Array.isArray(snapshot.sessions)) return null;
  return {
    sessions: sortSessionCatalog(snapshot.sessions),
    cursor: typeof snapshot.cursor === "string" ? snapshot.cursor : "",
    page_cursor: typeof snapshot.page_cursor === "string" ? snapshot.page_cursor : "",
    has_more_pages: Boolean(snapshot.has_more_pages),
    updated_at: Number(snapshot.updated_at ?? 0) || 0,
  };
}

function indexedDBAvailable() {
  return typeof globalThis.indexedDB !== "undefined";
}

function openCatalogCacheDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!indexedDBAvailable()) {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const request = globalThis.indexedDB.open(catalogCacheDBName);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(catalogCacheStoreName)) {
        db.createObjectStore(catalogCacheStoreName, { keyPath: "key" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("open indexedDB failed"));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(catalogCacheStoreName)) {
        const nextVersion = db.version + 1;
        db.close();
        const upgrade = globalThis.indexedDB.open(catalogCacheDBName, nextVersion);
        upgrade.onupgradeneeded = () => {
          const upgraded = upgrade.result;
          if (!upgraded.objectStoreNames.contains(catalogCacheStoreName)) {
            upgraded.createObjectStore(catalogCacheStoreName, { keyPath: "key" });
          }
        };
        upgrade.onerror = () => reject(upgrade.error ?? new Error("upgrade indexedDB failed"));
        upgrade.onsuccess = () => resolve(upgrade.result);
        return;
      }
      resolve(db);
    };
  });
}

async function loadSessionCatalogCacheFromIDB(key: string): Promise<SessionCatalogSnapshot | null> {
  const db = await openCatalogCacheDB();
  try {
    const record = await idbRequest<SessionCatalogCacheRecord | undefined>(
      db.transaction(catalogCacheStoreName, "readonly").objectStore(catalogCacheStoreName).get(key),
    );
    return parseCacheRecord(record);
  } finally {
    db.close();
  }
}

async function saveSessionCatalogCacheToIDB(key: string, snapshot: SessionCatalogSnapshot): Promise<void> {
  const db = await openCatalogCacheDB();
  try {
    await idbRequest(
      db.transaction(catalogCacheStoreName, "readwrite").objectStore(catalogCacheStoreName).put({
        key,
        schema_version: catalogCacheSchemaVersion,
        snapshot,
      } satisfies SessionCatalogCacheRecord),
    );
  } finally {
    db.close();
  }
}

async function deleteSessionCatalogCacheFromIDB(key: string): Promise<void> {
  const db = await openCatalogCacheDB();
  try {
    await idbRequest(db.transaction(catalogCacheStoreName, "readwrite").objectStore(catalogCacheStoreName).delete(key));
  } finally {
    db.close();
  }
}

function idbRequest<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
    request.onsuccess = () => resolve(request.result);
  });
}
