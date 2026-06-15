/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

type StoreState = {
  keyPath: string;
  records: Map<IDBValidKey, unknown>;
};

type DatabaseState = {
  version: number;
  stores: Map<string, StoreState>;
};

type FakeIndexedDBState = {
  databases: Map<string, DatabaseState>;
};

type MutableIDBRequest<T> = {
  result: T;
  error: DOMException | Error | null;
  onsuccess: ((this: IDBRequest<T>, ev: Event) => unknown) | null;
  onerror: ((this: IDBRequest<T>, ev: Event) => unknown) | null;
};

type MutableIDBOpenRequest = MutableIDBRequest<IDBDatabase> & {
  onupgradeneeded: ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown) | null;
};

export function installFakeIndexedDB(): IDBFactory {
  const state: FakeIndexedDBState = { databases: new Map() };
  const factory = {
    open(name: string, version?: number) {
      const request = createOpenRequest();
      queueMicrotask(() => {
        const existing = state.databases.get(name);
        const requestedVersion = version ?? existing?.version ?? 1;
        const shouldUpgrade = !existing || requestedVersion > existing.version;
        const database = existing ?? { version: requestedVersion, stores: new Map() };
        if (requestedVersion > database.version) database.version = requestedVersion;
        state.databases.set(name, database);
        request.result = createDatabase(database);
        if (shouldUpgrade) {
          request.onupgradeneeded?.call(
            request as unknown as IDBOpenDBRequest,
            { type: "upgradeneeded" } as IDBVersionChangeEvent,
          );
        }
        request.onsuccess?.call(request as unknown as IDBRequest<IDBDatabase>, { type: "success" } as Event);
      });
      return request as unknown as IDBOpenDBRequest;
    },
  };
  return factory as unknown as IDBFactory;
}

export function memoryStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed));
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
  };
}

export function throwingStorage(): Storage {
  return {
    get length(): number {
      throw new Error("localStorage should not be read");
    },
    clear() {
      throw new Error("localStorage should not be cleared");
    },
    getItem(_key: string) {
      throw new Error("localStorage should not be read");
    },
    key(_index: number) {
      throw new Error("localStorage should not be read");
    },
    removeItem(_key: string) {
      throw new Error("localStorage should not be written");
    },
    setItem(_key: string, _value: string) {
      throw new Error("localStorage should not be written");
    },
  };
}

function createOpenRequest(): MutableIDBOpenRequest {
  return {
    result: undefined as unknown as IDBDatabase,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
  };
}

function createRequest<T>(resultFactory: () => T): IDBRequest<T> {
  const request: MutableIDBRequest<T> = {
    result: undefined as T,
    error: null,
    onsuccess: null,
    onerror: null,
  };
  queueMicrotask(() => {
    try {
      request.result = resultFactory();
      request.onsuccess?.call(request as unknown as IDBRequest<T>, { type: "success" } as Event);
    } catch (error) {
      request.error = error instanceof Error ? error : new Error(String(error));
      request.onerror?.call(request as unknown as IDBRequest<T>, { type: "error" } as Event);
    }
  });
  return request as unknown as IDBRequest<T>;
}

function createDatabase(database: DatabaseState): IDBDatabase {
  return {
    get version() {
      return database.version;
    },
    objectStoreNames: createObjectStoreNames(database),
    createObjectStore(name: string, options?: IDBObjectStoreParameters) {
      database.stores.set(name, {
        keyPath: String(options?.keyPath ?? "key"),
        records: new Map(),
      });
      return createObjectStore(database, name);
    },
    transaction(storeName: string) {
      if (!database.stores.has(storeName)) throw new Error(`missing object store ${storeName}`);
      return {
        objectStore(name: string) {
          return createObjectStore(database, name);
        },
      } as unknown as IDBTransaction;
    },
    close() {
      // No-op for the in-memory fake.
    },
  } as unknown as IDBDatabase;
}

function createObjectStoreNames(database: DatabaseState): DOMStringList {
  return {
    contains(name: string) {
      return database.stores.has(name);
    },
    item(index: number) {
      return Array.from(database.stores.keys())[index] ?? null;
    },
    get length() {
      return database.stores.size;
    },
  } as unknown as DOMStringList;
}

function createObjectStore(database: DatabaseState, name: string): IDBObjectStore {
  const store = database.stores.get(name);
  if (!store) throw new Error(`missing object store ${name}`);
  return {
    get(key: IDBValidKey) {
      return createRequest(() => cloneValue(store.records.get(key)));
    },
    put(value: unknown) {
      return createRequest(() => {
        const key = readRecordKey(value, store.keyPath);
        store.records.set(key, cloneValue(value));
        return key;
      });
    },
    delete(key: IDBValidKey) {
      return createRequest(() => {
        store.records.delete(key);
        return undefined;
      });
    },
    getAllKeys() {
      return createRequest(() => Array.from(store.records.keys()));
    },
  } as unknown as IDBObjectStore;
}

function readRecordKey(value: unknown, keyPath: string): IDBValidKey {
  if (!value || typeof value !== "object") throw new Error("record must be an object");
  const key = (value as Record<string, unknown>)[keyPath];
  if (!isIDBValidKey(key)) throw new Error(`record missing valid keyPath ${keyPath}`);
  return key;
}

function isIDBValidKey(value: unknown): value is IDBValidKey {
  return typeof value === "string" || typeof value === "number" || value instanceof Date || Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
