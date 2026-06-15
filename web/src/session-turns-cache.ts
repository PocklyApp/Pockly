/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionTurn, SessionTurnsResponse } from "./api";

const turnsCacheSchemaVersion = 1;
const turnsCacheLocalStoragePrefix = "pockly.sessionTurns.v1.";
const turnsCacheDBName = "pockly-web-cache";
const turnsCacheStoreName = "session_turns";
export const SESSION_TURNS_CACHE_LIMIT = 500;

export type SessionTurnsCacheSnapshot = {
  device_id: string;
  session_id: string;
  turns: SessionTurn[];
  hydration: SessionTurnsResponse | null;
  updated_at: number;
};

type SessionTurnsCacheRecord = {
  key: string;
  snapshot: SessionTurnsCacheSnapshot;
  schema_version: number;
};

export function sessionTurnsCacheKey(userKey: string, deviceId: string, sessionId: string) {
  const normalizedUser = userKey.trim().toLowerCase();
  if (!normalizedUser || !deviceId || !sessionId) return "";
  return `${normalizedUser}:${deviceId}:${sessionId}`;
}

export function mergeSessionTurnsCache(
  current: SessionTurnsCacheSnapshot | null,
  next: {
    userKey?: string;
    deviceId: string;
    sessionId: string;
    turns: SessionTurn[];
    hydration?: SessionTurnsResponse | null;
  },
): SessionTurnsCacheSnapshot {
  const mergedTurns = trimCachedTurns(mergeTurns(current?.turns ?? [], next.turns));
  return {
    device_id: next.deviceId,
    session_id: next.sessionId,
    turns: mergedTurns,
    hydration: next.hydration === undefined
      ? current?.hydration ?? null
      : next.hydration
        ? {
            ...next.hydration,
            turns: mergedTurns,
            oldest_seq: mergedTurns[0]?.seq ?? next.hydration.oldest_seq,
            latest_seq: mergedTurns[mergedTurns.length - 1]?.seq ?? next.hydration.latest_seq,
          }
        : null,
    updated_at: Date.now(),
  };
}

export async function loadSessionTurnsCache(userKey: string, deviceId: string, sessionId: string): Promise<SessionTurnsCacheSnapshot | null> {
  const key = sessionTurnsCacheKey(userKey, deviceId, sessionId);
  if (!key) return null;
  const idbSnapshot = await loadSessionTurnsCacheFromIDB(key).catch(() => null);
  if (idbSnapshot) return idbSnapshot;
  return loadSessionTurnsCacheFromLocalStorage(key);
}

export async function saveSessionTurnsCache(userKey: string, snapshot: SessionTurnsCacheSnapshot): Promise<void> {
  const key = sessionTurnsCacheKey(userKey, snapshot.device_id, snapshot.session_id);
  if (!key) return;
  const normalized: SessionTurnsCacheSnapshot = {
    device_id: snapshot.device_id,
    session_id: snapshot.session_id,
    turns: trimCachedTurns(snapshot.turns),
    hydration: snapshot.hydration,
    updated_at: snapshot.updated_at || Date.now(),
  };
  await saveSessionTurnsCacheToIDB(key, normalized).catch(() => {
    saveSessionTurnsCacheToLocalStorage(key, normalized);
  });
}

export async function clearSessionTurnsCache(userKey: string, deviceId?: string, sessionId?: string): Promise<void> {
  const normalizedUser = userKey.trim().toLowerCase();
  if (!normalizedUser) return;
  if (deviceId && sessionId) {
    const key = sessionTurnsCacheKey(normalizedUser, deviceId, sessionId);
    await deleteSessionTurnsCacheFromIDB(key).catch(() => undefined);
    removeLocalStorageKey(key);
    return;
  }
  await clearSessionTurnsCacheForUserFromIDB(normalizedUser).catch(() => undefined);
  clearLocalStorageForUser(normalizedUser);
}

function mergeTurns(current: SessionTurn[], incoming: SessionTurn[]) {
  const byKey = new Map<string, SessionTurn>();
  for (const turn of current) byKey.set(turnKey(turn), turn);
  for (const turn of incoming) byKey.set(turnKey(turn), turn);
  return [...byKey.values()].sort((left, right) => Number(left.seq) - Number(right.seq));
}

function trimCachedTurns(turns: SessionTurn[]) {
  if (turns.length <= SESSION_TURNS_CACHE_LIMIT) return turns;
  return turns.slice(turns.length - SESSION_TURNS_CACHE_LIMIT);
}

function turnKey(turn: SessionTurn) {
  return `${turn.device_id ?? ""}:${turn.session_id}:${turn.seq}`;
}

function localStorageKey(key: string) {
  return `${turnsCacheLocalStoragePrefix}${encodeURIComponent(key)}`;
}

function loadSessionTurnsCacheFromLocalStorage(key: string) {
  try {
    const raw = globalThis.localStorage?.getItem(localStorageKey(key));
    if (!raw) return null;
    return parseCacheRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveSessionTurnsCacheToLocalStorage(key: string, snapshot: SessionTurnsCacheSnapshot) {
  try {
    globalThis.localStorage?.setItem(
      localStorageKey(key),
      JSON.stringify({
        key,
        schema_version: turnsCacheSchemaVersion,
        snapshot,
      } satisfies SessionTurnsCacheRecord),
    );
  } catch {
    // Best effort only; the network path still works without local cache.
  }
}

function removeLocalStorageKey(key: string) {
  try {
    globalThis.localStorage?.removeItem(localStorageKey(key));
  } catch {
    // Storage may be unavailable in privacy modes or tests.
  }
}

function clearLocalStorageForUser(userKey: string) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const prefix = `${turnsCacheLocalStoragePrefix}${encodeURIComponent(`${userKey}:`)}`;
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) storage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable in privacy modes or tests.
  }
}

function parseCacheRecord(value: unknown): SessionTurnsCacheSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<SessionTurnsCacheRecord>;
  if (record.schema_version !== turnsCacheSchemaVersion) return null;
  const snapshot = record.snapshot;
  if (!snapshot || !Array.isArray(snapshot.turns)) return null;
  return {
    device_id: String(snapshot.device_id || ""),
    session_id: String(snapshot.session_id || ""),
    turns: trimCachedTurns(snapshot.turns),
    hydration: snapshot.hydration ?? null,
    updated_at: Number(snapshot.updated_at ?? 0) || 0,
  };
}

function indexedDBAvailable() {
  return typeof globalThis.indexedDB !== "undefined";
}

function openTurnsCacheDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!indexedDBAvailable()) {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const request = globalThis.indexedDB.open(turnsCacheDBName);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(turnsCacheStoreName)) {
        db.createObjectStore(turnsCacheStoreName, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("session_catalog")) {
        db.createObjectStore("session_catalog", { keyPath: "key" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("open indexedDB failed"));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(turnsCacheStoreName)) {
        db.close();
        const upgrade = globalThis.indexedDB.open(turnsCacheDBName, db.version + 1);
        upgrade.onupgradeneeded = () => {
          const upgraded = upgrade.result;
          if (!upgraded.objectStoreNames.contains(turnsCacheStoreName)) {
            upgraded.createObjectStore(turnsCacheStoreName, { keyPath: "key" });
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

async function loadSessionTurnsCacheFromIDB(key: string): Promise<SessionTurnsCacheSnapshot | null> {
  const db = await openTurnsCacheDB();
  try {
    const record = await idbRequest<SessionTurnsCacheRecord | undefined>(
      db.transaction(turnsCacheStoreName, "readonly").objectStore(turnsCacheStoreName).get(key),
    );
    return parseCacheRecord(record);
  } finally {
    db.close();
  }
}

async function saveSessionTurnsCacheToIDB(key: string, snapshot: SessionTurnsCacheSnapshot): Promise<void> {
  const db = await openTurnsCacheDB();
  try {
    await idbRequest(
      db.transaction(turnsCacheStoreName, "readwrite").objectStore(turnsCacheStoreName).put({
        key,
        schema_version: turnsCacheSchemaVersion,
        snapshot,
      } satisfies SessionTurnsCacheRecord),
    );
  } finally {
    db.close();
  }
}

async function deleteSessionTurnsCacheFromIDB(key: string): Promise<void> {
  const db = await openTurnsCacheDB();
  try {
    await idbRequest(db.transaction(turnsCacheStoreName, "readwrite").objectStore(turnsCacheStoreName).delete(key));
  } finally {
    db.close();
  }
}

async function clearSessionTurnsCacheForUserFromIDB(userKey: string): Promise<void> {
  const readDB = await openTurnsCacheDB();
  let keys: string[] = [];
  try {
    const store = readDB.transaction(turnsCacheStoreName, "readonly").objectStore(turnsCacheStoreName);
    keys = (await idbRequest<IDBValidKey[]>(store.getAllKeys()))
      .map((key) => String(key))
      .filter((key) => key.startsWith(`${userKey}:`));
  } finally {
    readDB.close();
  }
  if (!keys.length) return;
  const writeDB = await openTurnsCacheDB();
  try {
    const store = writeDB.transaction(turnsCacheStoreName, "readwrite").objectStore(turnsCacheStoreName);
    await Promise.all(keys.map((key) => idbRequest(store.delete(key))));
  } finally {
    writeDB.close();
  }
}

function idbRequest<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
    request.onsuccess = () => resolve(request.result);
  });
}
