/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTROL_EVENT_POLL_INITIAL_DELAY_MS,
  CONTROL_EVENT_POLL_INTERVAL_MS,
  CONTROL_EVENT_POLL_MAX_MS,
  DEFAULT_INITIAL_TURN_LIMIT,
  TERMINAL_EVENT_POLL_INTERVAL_MS,
  buildNewTaskRequestBody,
  markSessionOpened,
  reportWebTelemetry,
  streamSessionSync,
} from "./api";

test("new task request body carries codex effort and permission settings", () => {
  assert.deepEqual(
    buildNewTaskRequestBody({
      daemonDeviceId: "dd_test",
      agent: "codex",
      cwd: "/tmp/project",
      text: "hello",
      model: "gpt-5.1-codex",
      permissionMode: "auto",
      effort: "minimal",
    }),
    {
      daemon_device_id: "dd_test",
      agent: "codex",
      cwd: "/tmp/project",
      text: "hello",
      model: "gpt-5.1-codex",
      permission_mode: "auto",
      effort: "minimal",
    },
  );
});

test("web telemetry is network-disabled by default", () => {
  const globals = globalThis as unknown as {
    window: { POCKLY_CONFIG?: Record<string, unknown> } | undefined;
    fetch: typeof fetch | undefined;
  };
  const originalWindow = globals.window;
  const originalFetch = globals.fetch;
  let fetchCalled = false;
  globals.window = { POCKLY_CONFIG: {} };
  globals.fetch = (() => {
    fetchCalled = true;
    throw new Error("fetch should not be called");
  }) as typeof fetch;
  try {
    reportWebTelemetry({ name: "web_page_error", errorCode: "test" });
    assert.equal(fetchCalled, false);
  } finally {
    globals.window = originalWindow;
    globals.fetch = originalFetch;
  }
});

test("polling fallback event budget matches long-running agent turns", () => {
  assert.equal(CONTROL_EVENT_POLL_INITIAL_DELAY_MS, 300);
  assert.equal(CONTROL_EVENT_POLL_INTERVAL_MS, 2000);
  assert.equal(CONTROL_EVENT_POLL_MAX_MS, 35 * 60 * 1000);
  assert.equal(TERMINAL_EVENT_POLL_INTERVAL_MS, 2000);
});

test("lazy session sync defaults to latest 20 turns", async () => {
  const globals = globalThis as unknown as {
    window: { location?: { origin?: string } } | undefined;
    localStorage: Storage | undefined;
    crypto: Crypto | undefined;
    fetch: typeof fetch | undefined;
  };
  const originalWindow = globals.window;
  const originalFetch = globals.fetch;
  const originalLocalStorage = globals.localStorage;
  const originalCrypto = globals.crypto;
  const bodies: unknown[] = [];
  globals.window = { ...(originalWindow ?? {}), location: { origin: "https://pockly.test" } };
  globals.localStorage = memoryStorage({
    "pockly.browser_device": JSON.stringify({
      deviceId: "bd_test",
      devicePublicKey: "public",
      devicePrivateKeyPkcs8: "private",
      deviceAccessToken: "dt_test",
      deviceRefreshToken: "drt_test",
    }),
  });
  const testCrypto = {
    ...(originalCrypto ?? {}),
    subtle: {
      ...(originalCrypto?.subtle ?? {}),
      importKey: async () => ({} as CryptoKey),
      sign: async () => new ArrayBuffer(0),
    } as SubtleCrypto,
  } as Crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: testCrypto,
  });
  globals.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/api/device-challenge/verify")) {
      return Response.json({ verified: true, device_access_token: "dt_test" });
    }
    if (url.includes("/api/device-challenge")) {
      return Response.json({
        challenge_id: "ch_test",
        device_id: "bd_test",
        audience: "browser-ws",
        nonce: "nonce",
      });
    }
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("event: done\ndata: {}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    await streamSessionSync({
      sessionId: "sess_lazy",
      deviceId: "dd_test",
      onEvent: () => {},
    });
  } finally {
    globals.window = originalWindow;
    globals.fetch = originalFetch;
    globals.localStorage = originalLocalStorage;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
  }

  assert.equal(DEFAULT_INITIAL_TURN_LIMIT, 20);
  assert.deepEqual(bodies[0], { limit: 20, before_seq: 0 });
});

test("markSessionOpened writes a recently-opened lazy sync hint", async () => {
  const globals = globalThis as unknown as {
    window: { location?: { origin?: string } } | undefined;
    localStorage: Storage | undefined;
    crypto: Crypto | undefined;
    fetch: typeof fetch | undefined;
  };
  const originalWindow = globals.window;
  const originalFetch = globals.fetch;
  const originalLocalStorage = globals.localStorage;
  const originalCrypto = globals.crypto;
  const requests: Array<{ url: string; body: unknown }> = [];
  globals.window = { ...(originalWindow ?? {}), location: { origin: "https://pockly.test" } };
  globals.localStorage = memoryStorage({
    "pockly.browser_device": JSON.stringify({
      deviceId: "bd_test",
      devicePublicKey: "public",
      devicePrivateKeyPkcs8: "private",
      deviceAccessToken: "dt_test",
      deviceRefreshToken: "drt_test",
    }),
  });
  const testCrypto = {
    ...(originalCrypto ?? {}),
    subtle: {
      ...(originalCrypto?.subtle ?? {}),
      importKey: async () => ({} as CryptoKey),
      sign: async () => new ArrayBuffer(0),
    } as SubtleCrypto,
  } as Crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: testCrypto,
  });
  globals.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/api/device-challenge/verify")) {
      return Response.json({ verified: true, device_access_token: "dt_test" });
    }
    if (url.includes("/api/device-challenge")) {
      return Response.json({
        challenge_id: "ch_test",
        device_id: "bd_test",
        audience: "browser-ws",
        nonce: "nonce",
      });
    }
    requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({ device_id: "dd_test", session_id: "sess_lazy", last_opened_at: "2026-06-10T08:00:00.000Z" });
  }) as typeof fetch;
  try {
    await markSessionOpened({
      sessionId: "sess_lazy",
      deviceId: "dd_test",
      openedAt: "2026-06-10T08:00:00.000Z",
    });
  } finally {
    globals.window = originalWindow;
    globals.fetch = originalFetch;
    globals.localStorage = originalLocalStorage;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
  }

  assert.equal(requests[0].url, "/api/sessions/sess_lazy/opened");
  assert.deepEqual(requests[0].body, {
    device_id: "dd_test",
    opened_at: "2026-06-10T08:00:00.000Z",
  });
});

function memoryStorage(seed: Record<string, string> = {}): Storage {
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
