/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { injectStreamOptions } from "../src/control.js";
import { RedisControlHub } from "../src/node/redis-control-hub.js";

describe("Node production Redis control hub", () => {
  it("routes request/response calls to the node that owns the daemon websocket", async () => {
    const bus = new FakeRedisBus();
    const hubA = await createStartedHub(bus, "node_a");
    const hubB = await createStartedHub(bus, "node_b");
    try {
      hubB.attachDaemonForTest("dd_remote", "usr_remote", async (envelope, reply) => {
        assert.equal(envelope.type, "AGENT_SETTINGS_GET");
        reply({
          type: "AGENT_SETTINGS_RESULT",
          agent_settings_result: {
            request_id: envelope.agent_settings_get.request_id,
            status: "ok",
            model: "opus",
          },
        });
      });
      await eventually(async () => assert.equal(await hubA.isDaemonOnline("dd_remote"), true));

      const result = await hubA.requestResponse("dd_remote", {
        type: "AGENT_SETTINGS_GET",
        agent_settings_get: { request_id: "as_remote" },
      }, "AGENT_SETTINGS_RESULT", "as_remote", 1000);

      assert.deepEqual(result, { request_id: "as_remote", status: "ok", model: "opus" });
    } finally {
      await hubA.close();
      await hubB.close();
    }
  });

  it("streams remote inject events and fans out turns to browser sockets on other nodes", async () => {
    const bus = new FakeRedisBus();
    const hubA = await createStartedHub(bus, "node_a");
    const hubB = await createStartedHub(bus, "node_b");
    try {
      const browser = hubA.attachBrowserForTest({
        userID: "usr_remote",
        browserDeviceID: "bd_remote",
        daemonDeviceID: "dd_remote",
        sessionID: "sess_remote",
      });
      hubB.attachDaemonForTest("dd_remote", "usr_remote", async (envelope, reply) => {
        assert.equal(envelope.type, "INJECT_REQUEST");
        reply({
          type: "INJECT_EVENT",
          event: {
            request_id: envelope.request.request_id,
            type: "inject_completed",
            session_id: "sess_remote",
            turn: {
              device_id: "dd_remote",
              session_id: "sess_remote",
              seq: 2,
              agent: "claude-code",
              kind: "assistant_text",
              timestamp: "2026-06-06T01:00:00Z",
              payload: { text: "remote done" },
            },
          },
        });
      });
      await eventually(async () => assert.equal(await hubA.isDaemonOnline("dd_remote"), true));

      const options = injectStreamOptions("sess_remote");
      options.userID = "usr_remote";
      options.initialEvent = { request_id: "inj_remote", type: "inject_started", session_id: "sess_remote" };
      const response = hubA.streamRequest("dd_remote", {
        type: "INJECT_REQUEST",
        request: {
          request_id: "inj_remote",
          daemon_device_id: "dd_remote",
          browser_device_id: "bd_remote",
          session_id: "sess_remote",
          mode: "resume_session",
          text: "hello",
        },
      }, "inj_remote", options);
      const events = await readSSEEvents(response, 2);
      assert.deepEqual(events.map((event) => event.type), ["inject_started", "inject_completed"]);
      await eventually(() => {
        const turnMessage = browser.messages.find((message) => message.type === "TURN");
        assert.equal(turnMessage?.turn?.payload?.text, "remote done");
      });
      browser.cleanup();
    } finally {
      await hubA.close();
      await hubB.close();
    }
  });

  it("fans out session catalog change events to browser sockets on other nodes", async () => {
    const bus = new FakeRedisBus();
    const hubA = await createStartedHub(bus, "node_a");
    const hubB = await createStartedHub(bus, "node_b");
    try {
      const browser = hubA.attachBrowserForTest({
        userID: "usr_remote",
        browserDeviceID: "bd_remote",
        daemonDeviceID: "dd_remote",
        sessionID: "sess_remote",
      });

      hubB.broadcastSessionCatalogChanged({
        userID: "usr_remote",
        session_ids: ["sess_remote"],
        device_ids: ["dd_remote"],
        reason: "daemon_sync",
      });

      await eventually(() => {
        assert.deepEqual(browser.messages.filter((message) => message.type === "SESSION_CATALOG_CHANGED"), [{
          type: "SESSION_CATALOG_CHANGED",
          session_ids: ["sess_remote"],
          device_ids: ["dd_remote"],
          reason: "daemon_sync",
        }]);
      });
      browser.cleanup();
    } finally {
      await hubA.close();
      await hubB.close();
    }
  });

  it("replicates terminal session state and terminal events across nodes", async () => {
    const bus = new FakeRedisBus();
    const hubA = await createStartedHub(bus, "node_a");
    const hubB = await createStartedHub(bus, "node_b");
    try {
      hubB.attachDaemonForTest("dd_remote", "usr_remote", async (envelope, reply) => {
        if (envelope.type !== "TERMINAL_CREATE") return;
        reply({
          type: "TERMINAL_EVENT",
          terminal_event: {
            terminal_session_id: envelope.terminal_request.terminal_session_id,
            kind: "text_delta",
            text: "terminal ready",
            session_status: "live",
            turn_status: "idle",
            timestamp: "2026-06-06T01:00:01Z",
          },
        });
      });
      await eventually(async () => assert.equal(await hubA.isDaemonOnline("dd_remote"), true));

      const terminal = await hubA.createTerminalSession({
        request_id: "term_remote",
        terminal_session_id: "ts_remote",
        user_id: "usr_remote",
        daemon_device_id: "dd_remote",
        browser_device_id: "bd_remote",
        session_id: "sess_remote",
        agent: "claude-code",
        cwd: "/work/app",
      });
      assert.equal(terminal.session_status, "starting");

      const stream = hubA.streamTerminalSession("usr_remote", "ts_remote");
      const events = await readSSEEvents(stream, 2);
      assert.equal(events[0].kind, "terminal_session");
      assert.equal(events[1].kind, "text_delta");
      assert.equal(events[1].text, "terminal ready");
      await eventually(() => {
        const listed = hubB.listTerminalSessions("usr_remote");
        assert.equal(listed.length, 1);
        assert.equal(listed[0].terminal_session_id, "ts_remote");
      });
    } finally {
      await hubA.close();
      await hubB.close();
    }
  });

  it("routes remote terminal subscription hints to the daemon owner node", async () => {
    const bus = new FakeRedisBus();
    const hubA = await createStartedHub(bus, "node_a");
    const hubB = await createStartedHub(bus, "node_b");
    const envelopes = [];
    try {
      hubB.attachDaemonForTest("dd_remote", "usr_remote", async (envelope) => {
        envelopes.push(envelope);
      });
      await eventually(async () => assert.equal(await hubA.isDaemonOnline("dd_remote"), true));

      await hubA.createTerminalSession({
        request_id: "term_remote",
        terminal_session_id: "ts_remote_sub",
        user_id: "usr_remote",
        daemon_device_id: "dd_remote",
        browser_device_id: "bd_remote",
        session_id: "sess_remote",
        agent: "claude-code",
        cwd: "/work/app",
      });
      envelopes.length = 0;

      await hubA.subscribeTerminalSession("usr_remote", "ts_remote_sub");
      await eventually(() => {
        assert.equal(envelopes.at(-1)?.type, "TERMINAL_SUBSCRIBE");
      });
      assert.equal(envelopes.at(-1).terminal_request.terminal_session_id, "ts_remote_sub");

      await hubA.unsubscribeTerminalSession("usr_remote", "ts_remote_sub");
      await eventually(() => {
        assert.equal(envelopes.at(-1)?.type, "TERMINAL_UNSUBSCRIBE");
      });
      assert.equal(envelopes.at(-1).terminal_request.terminal_session_id, "ts_remote_sub");
    } finally {
      await hubA.close();
      await hubB.close();
    }
  });

  it("persists remote daemon control events through the inner hub event sink", async () => {
    const bus = new FakeRedisBus();
    const persisted = [];
    const hubA = await createStartedHub(bus, "node_a");
    const hubB = await createStartedHub(bus, "node_b", {
      onControlEvent: (payload, meta) => persisted.push({ payload, meta }),
    });
    try {
      hubB.attachDaemonForTest("dd_remote", "usr_remote", async (envelope, reply) => {
        if (envelope.type !== "INJECT_REQUEST") return;
        reply({
          type: "INJECT_EVENT",
          event: {
            request_id: envelope.request.request_id,
            type: "inject_completed",
            session_id: "sess_remote",
            turn: {
              device_id: "dd_remote",
              session_id: "sess_remote",
              seq: 2,
              agent: "claude-code",
              kind: "assistant_text",
              timestamp: "2026-06-06T01:00:00Z",
              payload: { text: "remote persisted" },
            },
          },
        });
      });
      await eventually(async () => assert.equal(await hubA.isDaemonOnline("dd_remote"), true));

      const options = injectStreamOptions("sess_remote");
      options.userID = "usr_remote";
      const response = hubA.streamRequest("dd_remote", {
        type: "INJECT_REQUEST",
        request: {
          request_id: "inj_remote_persist",
          daemon_device_id: "dd_remote",
          browser_device_id: "bd_remote",
          session_id: "sess_remote",
          mode: "resume_session",
          text: "hello",
        },
      }, "inj_remote_persist", options);
      await readSSEEvents(response, 1);

      await eventually(() => {
        assert.equal(persisted.length, 1);
      });
      assert.equal(persisted[0].payload.type, "inject_completed");
      assert.equal(persisted[0].meta.userID, "usr_remote");
      assert.equal(persisted[0].meta.daemonDeviceID, "dd_remote");
    } finally {
      await hubA.close();
      await hubB.close();
    }
  });

  it("persists remote daemon dispatch events for polling fallback without stream routes", async () => {
    const bus = new FakeRedisBus();
    const persisted = [];
    const hubA = await createStartedHub(bus, "node_a");
    const hubB = await createStartedHub(bus, "node_b", {
      onControlEvent: (payload, meta) => persisted.push({ payload, meta }),
    });
    try {
      hubB.attachDaemonForTest("dd_remote", "usr_remote", async (envelope, reply) => {
        if (envelope.type !== "INJECT_REQUEST") return;
        reply({
          type: "INJECT_EVENT",
          event: {
            request_id: envelope.request.request_id,
            type: "inject_completed",
            session_id: "sess_remote",
            turn: {
              device_id: "dd_remote",
              session_id: "sess_remote",
              seq: 2,
              agent: "claude-code",
              kind: "assistant_text",
              timestamp: "2026-06-06T01:00:00Z",
              payload: { text: "remote polling fallback persisted" },
            },
          },
        });
      });
      await eventually(async () => assert.equal(await hubA.isDaemonOnline("dd_remote"), true));

      await hubA.dispatch("dd_remote", {
        type: "INJECT_REQUEST",
        request: {
          request_id: "inj_remote_polling",
          daemon_device_id: "dd_remote",
          browser_device_id: "bd_remote",
          session_id: "sess_remote",
          mode: "resume_session",
          text: "hello",
        },
      });

      await eventually(() => {
        assert.equal(persisted.length, 1);
      });
      assert.equal(hubA.remoteStreams.size, 0);
      assert.equal(persisted[0].payload.request_id, "inj_remote_polling");
      assert.equal(persisted[0].payload.type, "inject_completed");
      assert.equal(persisted[0].payload.turn.payload.text, "remote polling fallback persisted");
      assert.equal(persisted[0].meta.userID, "usr_remote");
      assert.equal(persisted[0].meta.daemonDeviceID, "dd_remote");
    } finally {
      await hubA.close();
      await hubB.close();
    }
  });
});

async function createStartedHub(bus, nodeID, eventSink = null) {
  const hub = new RedisControlHub({
    commandClient: bus.createClient(),
    subscriberClient: bus.createClient(),
    nodeID,
    keyPrefix: "test:nexus",
    ownerTTLSeconds: 30,
    logger: { warn: () => {} },
    ownsClients: true,
    ...(eventSink ? { eventSink } : {}),
  });
  await hub.start();
  return hub;
}

class FakeRedisBus {
  constructor() {
    this.values = new Map();
    this.subscribers = new Map();
  }

  createClient() {
    return new FakeRedisClient(this);
  }
}

class FakeRedisClient {
  constructor(bus) {
    this.bus = bus;
    this.handlers = [];
  }

  duplicate() {
    return new FakeRedisClient(this.bus);
  }

  async connect() {}

  async get(key) {
    return this.bus.values.get(key) || null;
  }

  async set(key, value) {
    this.bus.values.set(key, value);
  }

  async del(key) {
    return this.bus.values.delete(key) ? 1 : 0;
  }

  async publish(channel, message) {
    const subscribers = this.bus.subscribers.get(channel) || new Set();
    for (const listener of subscribers) queueMicrotask(() => listener(message, channel));
    return subscribers.size;
  }

  async subscribe(channel, listener) {
    const subscribers = this.bus.subscribers.get(channel) || new Set();
    subscribers.add(listener);
    this.bus.subscribers.set(channel, subscribers);
    this.handlers.push({ channel, listener });
  }

  async quit() {
    for (const { channel, listener } of this.handlers) {
      const subscribers = this.bus.subscribers.get(channel);
      if (!subscribers) continue;
      subscribers.delete(listener);
      if (subscribers.size === 0) this.bus.subscribers.delete(channel);
    }
    this.handlers = [];
  }
}

async function eventually(assertion, timeoutMs = 1000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError || new Error("timed out");
}

async function readSSEEvents(response, count) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (readSSEText(text).length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return readSSEText(text).slice(0, count);
}

function readSSEText(text) {
  return text.split(/\n\n+/)
    .map((chunk) => chunk.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice("data: ".length)));
}
