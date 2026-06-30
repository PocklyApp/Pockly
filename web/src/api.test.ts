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
  getSessionCatalogItem,
  getSessionTurns,
  listSessionsDelta,
  markSessionOpened,
  reportWebTelemetry,
  subscribeToSession,
  createTerminalSession,
  decidePermissionRequest,
  sendTerminalInput,
  stopTerminalSession,
  streamSessionSync,
  streamTerminalSession,
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

test("session catalog delta API carries cursor and page limit", async () => {
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
  let requestedURL = "";
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
  globals.fetch = (async (input) => {
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
    requestedURL = url;
    return Response.json({
      upserts: [],
      deletes: [{ device_id: "dd_test", session_id: "sess_deleted" }],
      next_cursor: "sc_next",
      has_more: false,
    });
  }) as typeof fetch;
  try {
    const body = await listSessionsDelta({ since: "sc_prev", limit: 25, pageCursor: "pg_prev" });
    const url = new URL(requestedURL);
    assert.equal(url.pathname, "/api/sessions/delta");
    assert.equal(url.searchParams.get("since"), "sc_prev");
    assert.equal(url.searchParams.get("limit"), "25");
    assert.equal(url.searchParams.get("page_cursor"), "pg_prev");
    assert.deepEqual(body.deletes, [{ device_id: "dd_test", session_id: "sess_deleted" }]);
    assert.equal(body.next_cursor, "sc_next");
  } finally {
    globals.window = originalWindow;
    globals.fetch = originalFetch;
    globals.localStorage = originalLocalStorage;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
  }
});

test("session catalog item API fetches one session without full catalog", async () => {
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
  let requestedURL = "";
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
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      ...(originalCrypto ?? {}),
      subtle: {
        ...(originalCrypto?.subtle ?? {}),
        importKey: async () => ({} as CryptoKey),
        sign: async () => new ArrayBuffer(0),
      } as SubtleCrypto,
    } as Crypto,
  });
  globals.fetch = (async (input) => {
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
    requestedURL = url;
    return Response.json({
      session: {
        session_id: "sess_old",
        device_id: "dd_test",
        agent: "claude-code",
        cwd: "/work",
        snippet: "old",
        last_seq: 1,
        last_timestamp: "2026-06-06T01:00:00Z",
      },
    });
  }) as typeof fetch;
  try {
    const body = await getSessionCatalogItem("sess_old", "dd_test");
    const url = new URL(requestedURL);
    assert.equal(url.pathname, "/api/sessions/sess_old");
    assert.equal(url.searchParams.get("device_id"), "dd_test");
    assert.equal(body.session.session_id, "sess_old");
  } finally {
    globals.window = originalWindow;
    globals.fetch = originalFetch;
    globals.localStorage = originalLocalStorage;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
  }
});

test("session turns API carries after_seq for incremental hot-window reads", async () => {
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
  let requestedURL = "";
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
  globals.fetch = (async (input) => {
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
    requestedURL = url;
    return Response.json({ session_id: "sess_hot", turns: [], after_seq: 120 });
  }) as typeof fetch;
  try {
    await getSessionTurns("sess_hot", "dd_test", { limit: 100, afterSeq: 120 });
    const url = new URL(requestedURL);
    assert.equal(url.pathname, "/api/sessions/sess_hot/turns");
    assert.equal(url.searchParams.get("device_id"), "dd_test");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.get("after_seq"), "120");
  } finally {
    globals.window = originalWindow;
    globals.fetch = originalFetch;
    globals.localStorage = originalLocalStorage;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
  }
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

test("polling fallback surfaces transient sync turns from request events", async () => {
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
  const events: unknown[] = [];
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
    if (url.includes("/api/sessions/sess_lazy/events")) {
      return Response.json({
        events: [{
          cursor: "ev_1",
          payload: {
            request_id: "sync_1",
            session_id: "sess_lazy",
            stage: "completed",
            status: "completed",
            turns: [{
              session_id: "sess_lazy",
              device_id: "dd_test",
              seq: 41,
              agent: "claude-code",
              kind: "assistant_text",
              timestamp: "2026-06-06T00:00:00Z",
              payload: { text: "older window" },
            }],
          },
        }],
        next_cursor: "ev_1",
      });
    }
    if (url.includes("/api/sessions/sess_lazy/sync")) {
      assert.deepEqual(JSON.parse(String(init?.body ?? "{}")), { limit: 50, before_seq: 42 });
      return Response.json({
        request_id: "sync_1",
        session_id: "sess_lazy",
        device_id: "dd_test",
        stage: "queued",
        status: "running",
        streaming: false,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    await streamSessionSync({
      sessionId: "sess_lazy",
      deviceId: "dd_test",
      limit: 50,
      beforeSeq: 42,
      onEvent: (event) => events.push(event),
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

  assert.ok(events.some((event) =>
    typeof event === "object" &&
    event !== null &&
    (event as { turn?: { seq?: number; payload?: { text?: string } } }).turn?.seq === 41 &&
    (event as { turn?: { payload?: { text?: string } } }).turn?.payload?.text === "older window"
  ));
});

test("realtime ACK-only commands resolve and do not leak into later messages", async () => {
  const globals = globalThis as unknown as {
    window: Record<string, unknown> | undefined;
    WebSocket: typeof WebSocket | undefined;
  };
  const originalWindow = globals.window;
  const originalWebSocket = globals.WebSocket;
  const sockets: FakeWebSocket[] = [];
  globals.window = {
    ...(globalThis as typeof globalThis),
    location: { origin: "https://pockly.test" },
  };
  globals.WebSocket = fakeWebSocketClass(sockets) as unknown as typeof WebSocket;
  try {
    const subscription = subscribeToSession({
      onTurn: () => {},
      onStatus: () => {},
    });
    await tick();
    const socket = sockets[0];
    assert.ok(socket);
    const accepted = subscription.sendCommand?.({
      command: "session_opened_hint",
      daemonDeviceId: "dd_test",
      sessionId: "sess_test",
      payload: { session_id: "sess_test" },
    });
    const command = socket.sentJSON().find((msg) => msg.type === "COMMAND");
    assert.equal(command?.command, "session_opened_hint");
    socket.emitMessage(JSON.stringify({
      type: "COMMAND_ACK",
      request_id: command.request_id,
      command: "session_opened_hint",
      status: "accepted",
      session_id: "sess_test",
      device_id: "dd_test",
    }));
    assert.equal((await accepted)?.status, "accepted");
    socket.emitMessage(JSON.stringify({
      type: "COMMAND_ERROR",
      request_id: command.request_id,
      command: "session_opened_hint",
      code: "late_error",
      error: "should be ignored after ack",
    }));
    subscription.close();
  } finally {
    globals.window = originalWindow;
    globals.WebSocket = originalWebSocket;
  }
});

test("realtime catalog change messages invoke the catalog callback", async () => {
  const globals = globalThis as unknown as {
    window: Record<string, unknown> | undefined;
    WebSocket: typeof WebSocket | undefined;
  };
  const originalWindow = globals.window;
  const originalWebSocket = globals.WebSocket;
  const sockets: FakeWebSocket[] = [];
  const events: unknown[] = [];
  globals.window = {
    ...(globalThis as typeof globalThis),
    location: { origin: "https://pockly.test" },
  };
  globals.WebSocket = fakeWebSocketClass(sockets) as unknown as typeof WebSocket;
  try {
    const subscription = subscribeToSession({
      onTurn: () => {},
      onStatus: () => {},
      onSessionCatalogChanged: (event) => events.push(event),
    });
    await tick();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitMessage(JSON.stringify({
      type: "SESSION_CATALOG_CHANGED",
      session_ids: ["sess_one", "", 123],
      device_ids: ["dd_one", null],
      reason: "daemon_sync",
    }));
    assert.deepEqual(events, [{
      session_ids: ["sess_one"],
      device_ids: ["dd_one"],
      reason: "daemon_sync",
    }]);
    subscription.close();
  } finally {
    globals.window = originalWindow;
    globals.WebSocket = originalWebSocket;
  }
});

test("terminal realtime subscription sends a single command subscription", async () => {
  const globals = globalThis as unknown as {
    window: Record<string, unknown> | undefined;
    WebSocket: typeof WebSocket | undefined;
  };
  const originalWindow = globals.window;
  const originalWebSocket = globals.WebSocket;
  const sockets: FakeWebSocket[] = [];
  const abort = new AbortController();
  globals.window = {
    ...(globalThis as typeof globalThis),
    location: { origin: "https://pockly.test" },
  };
  globals.WebSocket = fakeWebSocketClass(sockets) as unknown as typeof WebSocket;
  try {
    const subscription = subscribeToSession({
      onTurn: () => {},
      onStatus: () => {},
    });
    await tick();
    const socket = sockets[0];
    assert.ok(socket);
    const stream = streamTerminalSession({
      terminalSessionId: "ts_test",
      daemonDeviceId: "dd_test",
      realtime: subscription,
      signal: abort.signal,
      onEvent: () => {},
    });
    await tick();
    const command = socket.sentJSON().find((msg) => msg.type === "COMMAND" && msg.command === "terminal_subscribe");
    assert.ok(command);
    socket.emitMessage(JSON.stringify({
      type: "COMMAND_ACK",
      request_id: command.request_id,
      command: "terminal_subscribe",
      status: "accepted",
      terminal_session_id: "ts_test",
    }));
    await tick();
    assert.equal(socket.sentJSON().filter((msg) => msg.type === "SUBSCRIBE_TERMINAL").length, 0);
    assert.equal(socket.sentJSON().filter((msg) => msg.type === "COMMAND" && msg.command === "terminal_subscribe").length, 1);
    abort.abort();
    await stream;
    subscription.close();
  } finally {
    globals.window = originalWindow;
    globals.WebSocket = originalWebSocket;
  }
});

test("permission and terminal controls prefer realtime commands", async () => {
  const globals = globalThis as unknown as {
    window: Record<string, unknown> | undefined;
    WebSocket: typeof WebSocket | undefined;
    fetch: typeof fetch | undefined;
  };
  const originalWindow = globals.window;
  const originalWebSocket = globals.WebSocket;
  const originalFetch = globals.fetch;
  const sockets: FakeWebSocket[] = [];
  let fetchCalled = false;
  globals.window = {
    ...(globalThis as typeof globalThis),
    location: { origin: "https://pockly.test" },
  };
  globals.WebSocket = fakeWebSocketClass(sockets) as unknown as typeof WebSocket;
  globals.fetch = (() => {
    fetchCalled = true;
    throw new Error("fetch should not be called when realtime is open");
  }) as typeof fetch;
  try {
    const subscription = subscribeToSession({
      onTurn: () => {},
      onStatus: () => {},
    });
    await tick();
    const socket = sockets[0];
    assert.ok(socket);

    const permission = decidePermissionRequest("perm_test", "dd_test", "allow", subscription);
    const permissionCommand = latestCommand(socket, "permission_decide");
    assert.equal(permissionCommand?.payload.permission_request_id, "perm_test");
    socket.emitMessage(JSON.stringify({
      type: "COMMAND_ACK",
      request_id: permissionCommand.request_id,
      command: "permission_decide",
      status: "accepted",
      device_id: "dd_test",
    }));
    assert.deepEqual(await permission, { request_id: "perm_test", status: "accepted" });

    const created = createTerminalSession({
      daemonDeviceId: "dd_test",
      sessionId: "sess_test",
      agent: "claude-code",
      cwd: "/tmp/project",
      realtime: subscription,
    });
    const createCommand = latestCommand(socket, "terminal_create");
    assert.equal(createCommand?.payload.cwd, "/tmp/project");
    socket.emitMessage(JSON.stringify({
      type: "COMMAND_ACK",
      request_id: createCommand.request_id,
      command: "terminal_create",
      status: "accepted",
      terminal_session_id: "ts_test",
      terminal_session: {
        terminal_session_id: "ts_test",
        daemon_device_id: "dd_test",
        agent: "claude-code",
        cwd: "/tmp/project",
        session_status: "starting",
        turn_status: "idle",
      },
    }));
    assert.equal((await created).terminal_session.terminal_session_id, "ts_test");

    const input = sendTerminalInput("ts_test", "hello", subscription, "dd_test");
    const inputCommand = latestCommand(socket, "terminal_input");
    assert.equal(inputCommand?.payload.text, "hello");
    socket.emitMessage(JSON.stringify({
      type: "COMMAND_ACK",
      request_id: inputCommand.request_id,
      command: "terminal_input",
      status: "accepted",
      terminal_session_id: "ts_test",
    }));
    assert.deepEqual(await input, { status: "queued" });

    const stop = stopTerminalSession("ts_test", subscription, "dd_test");
    const stopCommand = latestCommand(socket, "terminal_stop");
    assert.equal(stopCommand?.payload.terminal_session_id, "ts_test");
    socket.emitMessage(JSON.stringify({
      type: "COMMAND_ACK",
      request_id: stopCommand.request_id,
      command: "terminal_stop",
      status: "accepted",
      terminal_session_id: "ts_test",
    }));
    assert.deepEqual(await stop, { status: "queued" });

    assert.equal(fetchCalled, false);
    subscription.close();
  } finally {
    globals.window = originalWindow;
    globals.WebSocket = originalWebSocket;
    globals.fetch = originalFetch;
  }
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

type FakeListener = (event?: unknown) => void;

class FakeWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  private listeners = new Map<string, FakeListener[]>();

  constructor(public url: string) {
    queueMicrotask(() => this.emit("open"));
  }

  addEventListener(type: string, listener: FakeListener) {
    const next = this.listeners.get(type) ?? [];
    next.push(listener);
    this.listeners.set(type, next);
  }

  send(data: string) {
    this.sent.push(String(data));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  emitMessage(data: string) {
    this.emit("message", { data });
  }

  sentJSON() {
    return this.sent
      .filter((raw) => raw.startsWith("{"))
      .map((raw) => JSON.parse(raw));
  }

  private emit(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function fakeWebSocketClass(sockets: FakeWebSocket[]) {
  return class extends FakeWebSocket {
    static override OPEN = FakeWebSocket.OPEN;
    static override CLOSING = FakeWebSocket.CLOSING;
    static override CLOSED = FakeWebSocket.CLOSED;
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function latestCommand(socket: FakeWebSocket, command: string) {
  return socket.sentJSON().filter((msg) => msg.type === "COMMAND" && msg.command === command).at(-1);
}
