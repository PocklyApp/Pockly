/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleControlHubRequest, InMemoryControlHub } from "../src/control.js";

describe("in-process Nexus control hub", () => {
  it("broadcasts daemon presence changes to browser sockets", () => {
    const hub = new InMemoryControlHub();
    const browser = hub.attachBrowserForTest({
      userID: "usr_control",
      browserDeviceID: "bd_control",
      daemonDeviceID: "dd_control",
      sessionID: "sess_control",
    });

    const cleanup = hub.attachDaemonForTest("dd_control", "usr_control", async () => {});
    assert.deepEqual(browser.messages[0], {
      type: "HOST_STATUS",
      device_id: "dd_control",
      presence_status: "online",
      presence_reason: "control_connected",
      control_connected: true,
    });

    hub.receiveDaemonEnvelope("dd_control", {
      type: "DAEMON_STATUS",
      daemon_status: { presence_status: "degraded", presence_reason: "heartbeat_lag", message: "lagging" },
    });
    assert.deepEqual(browser.messages[1], {
      type: "HOST_STATUS",
      device_id: "dd_control",
      presence_status: "degraded",
      presence_reason: "heartbeat_lag",
      control_connected: true,
      message: "lagging",
    });

    cleanup();
    assert.deepEqual(browser.messages[2], {
      type: "HOST_STATUS",
      device_id: "dd_control",
      presence_status: "offline",
      presence_reason: "control_disconnected",
      control_connected: false,
    });
    browser.cleanup();
  });

  it("broadcasts catalog changes only to the owning user's browser sockets", () => {
    const hub = new InMemoryControlHub();
    const ownerBrowser = hub.attachBrowserForTest({
      userID: "usr_owner",
      browserDeviceID: "bd_owner",
      daemonDeviceID: "dd_owner",
      sessionID: "sess_owner",
    });
    const otherBrowser = hub.attachBrowserForTest({
      userID: "usr_other",
      browserDeviceID: "bd_other",
      daemonDeviceID: "dd_owner",
      sessionID: "sess_owner",
    });

    hub.broadcastSessionCatalogChanged({
      userID: "usr_owner",
      session_ids: ["sess_owner"],
      device_ids: ["dd_owner"],
      reason: "daemon_sync",
    });

    assert.deepEqual(ownerBrowser.messages, [{
      type: "SESSION_CATALOG_CHANGED",
      session_ids: ["sess_owner"],
      device_ids: ["dd_owner"],
      reason: "daemon_sync",
    }]);
    assert.deepEqual(otherBrowser.messages, []);
    ownerBrowser.cleanup();
    otherBrowser.cleanup();
  });

  it("handles control request/response through the neutral control endpoint", async () => {
    const hub = new InMemoryControlHub();
    hub.attachDaemonForTest("dd_control", "usr_control", async (envelope, reply) => {
      assert.equal(envelope.type, "AGENT_SETTINGS_GET");
      reply({
        type: "AGENT_SETTINGS_RESULT",
        agent_settings_result: {
          request_id: envelope.agent_settings_get.request_id,
          status: "ok",
          model: "sonnet",
        },
      });
    });

    const online = await handleControlHubRequest(hub, new Request("https://control.test/control/online?device_id=dd_control"));
    assert.deepEqual(await online.json(), { online: true });

    const response = await handleControlHubRequest(hub, new Request("https://control.test/control/request-response", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        daemon_device_id: "dd_control",
        envelope: {
          type: "AGENT_SETTINGS_GET",
          agent_settings_get: { request_id: "as_control" },
        },
        response_type: "AGENT_SETTINGS_RESULT",
        request_id: "as_control",
        timeout_ms: 1000,
      }),
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      result: {
        request_id: "as_control",
        status: "ok",
        model: "sonnet",
      },
    });
  });

  it("routes browser realtime inject commands to the daemon and streams command events", async () => {
    const envelopes = [];
    const hub = new InMemoryControlHub({
      browserCommandHandler: async ({ userID, browserDeviceID, message }) => {
        assert.equal(userID, "usr_control");
        assert.equal(browserDeviceID, "bd_control");
        return {
          mode: "stream",
          daemonDeviceID: "dd_control",
          daemonRequestID: message.request_id,
          sessionID: "sess_control",
          closeWhen: (event) => event.type === "inject_completed",
          initialEvent: { request_id: message.request_id, type: "inject_started", session_id: "sess_control" },
          ack: { status: "accepted", session_id: "sess_control", device_id: "dd_control" },
          envelope: {
            type: "INJECT_REQUEST",
            request: {
              request_id: message.request_id,
              daemon_device_id: "dd_control",
              browser_device_id: "bd_control",
              session_id: "sess_control",
              text: message.payload.text,
            },
          },
        };
      },
    });
    hub.attachDaemonForTest("dd_control", "usr_control", async (envelope, reply) => {
      envelopes.push(envelope);
      reply({
        type: "INJECT_EVENT",
        event: {
          request_id: envelope.request.request_id,
          type: "inject_completed",
          session_id: "sess_control",
          turn: {
            device_id: "dd_control",
            session_id: "sess_control",
            seq: 2,
            kind: "assistant_text",
            payload: { text: "done" },
          },
        },
      });
    });
    const browser = hub.attachBrowserForTest({
      userID: "usr_control",
      browserDeviceID: "bd_control",
      daemonDeviceID: "dd_control",
      sessionID: "sess_control",
    });
    browser.messages.length = 0;

    hub.handleBrowserSocketMessage(browser.socket, JSON.stringify({
      type: "COMMAND",
      request_id: "bcmd_control",
      command: "inject_session",
      daemon_device_id: "dd_control",
      session_id: "sess_control",
      payload: { text: "hello" },
    }));

    await eventually(() => {
      assert.deepEqual(envelopes.map((envelope) => envelope.type), ["INJECT_REQUEST"]);
      assert.deepEqual(browser.messages.map((message) => message.type), ["COMMAND_ACK", "COMMAND_EVENT", "COMMAND_EVENT", "TURN"]);
    });
    assert.equal(browser.messages[0].request_id, "bcmd_control");
    assert.equal(browser.messages[1].event.type, "inject_started");
    assert.equal(browser.messages[2].event.type, "inject_completed");
    assert.equal(browser.messages[3].turn.payload.text, "done");
    browser.cleanup();
  });

  it("keeps realtime inject streams open after daemon acceptance ack", async () => {
    const hub = new InMemoryControlHub({
      browserCommandHandler: async ({ message }) => ({
        mode: "stream",
        daemonDeviceID: "dd_control",
        daemonRequestID: message.request_id,
        sessionID: "sess_control",
        closeWhen: (event) => event.type === "inject_failed",
        ack: { status: "accepted", session_id: "sess_control", device_id: "dd_control" },
        envelope: {
          type: "INJECT_REQUEST",
          request: {
            request_id: message.request_id,
            daemon_device_id: "dd_control",
            session_id: "sess_control",
            text: message.payload.text,
          },
        },
      }),
    });
    hub.attachDaemonForTest("dd_control", "usr_control", async (envelope, reply) => {
      reply({
        type: "INJECT_EVENT",
        event: { request_id: envelope.request.request_id, type: "inject_completed", session_id: "sess_control" },
      });
      reply({
        type: "INJECT_EVENT",
        event: { request_id: envelope.request.request_id, type: "inject_failed", session_id: "sess_control", error: "codex_turn_timeout" },
      });
    });
    const browser = hub.attachBrowserForTest({
      userID: "usr_control",
      browserDeviceID: "bd_control",
      daemonDeviceID: "dd_control",
      sessionID: "sess_control",
    });
    browser.messages.length = 0;

    hub.handleBrowserSocketMessage(browser.socket, JSON.stringify({
      type: "COMMAND",
      request_id: "bcmd_ack_then_fail",
      command: "inject_session",
      daemon_device_id: "dd_control",
      session_id: "sess_control",
      payload: { text: "hello" },
    }));

    await eventually(() => {
      assert.deepEqual(browser.messages.map((message) => message.event?.type).filter(Boolean), ["inject_completed", "inject_failed"]);
    });
    assert.equal(browser.messages.at(-1).event.error, "codex_turn_timeout");
    browser.cleanup();
  });

  it("returns browser realtime daemon_offline without a separate presence precheck", async () => {
    const hub = new InMemoryControlHub({
      browserCommandHandler: async (input) => ({
        mode: "dispatch",
        daemonDeviceID: input.message.daemon_device_id,
        envelope: { type: "SYNC_HINT", sync_hint: { session_id: "sess_control" } },
      }),
    });
    const browser = hub.attachBrowserForTest({
      userID: "usr_control",
      browserDeviceID: "bd_control",
      daemonDeviceID: "dd_missing",
      sessionID: "sess_control",
    });
    browser.messages.length = 0;

    hub.handleBrowserSocketMessage(browser.socket, JSON.stringify({
      type: "COMMAND",
      request_id: "bcmd_offline",
      command: "session_opened_hint",
      daemon_device_id: "dd_missing",
      payload: { session_id: "sess_control" },
    }));

    await eventually(() => {
      assert.equal(browser.messages.length, 1);
      assert.equal(browser.messages[0].type, "COMMAND_ERROR");
      assert.equal(browser.messages[0].code, "daemon_offline");
    });
    browser.cleanup();
  });

  it("persists terminal sessions and history through injected terminal storage", async () => {
    const terminalStorage = new FakeTerminalStorage();
    const hub = new InMemoryControlHub({ terminalStorage });
    await hub.hydrateTerminalState();
    hub.attachDaemonForTest("dd_control", "usr_control", async () => {});

    const create = await handleControlHubRequest(hub, new Request("https://control.test/control/terminal-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "term_req",
        terminal_session_id: "ts_persist",
        user_id: "usr_control",
        daemon_device_id: "dd_control",
        browser_device_id: "bd_control",
        session_id: "sess_control",
        agent: "claude-code",
        cwd: "/work/app",
      }),
    }));
    assert.equal(create.status, 200);

    hub.receiveDaemonEnvelope("dd_control", {
      type: "TERMINAL_EVENT",
      terminal_event: {
        terminal_session_id: "ts_persist",
        kind: "text_delta",
        text: "hello from terminal",
        session_status: "live",
        turn_status: "idle",
        timestamp: "2026-06-06T01:00:00Z",
      },
    });
    await hub.terminalPersistChain;

    const restarted = new InMemoryControlHub({ terminalStorage });
    await restarted.hydrateTerminalState();
    const list = await handleControlHubRequest(restarted, new Request("https://control.test/control/terminal-sessions?user_id=usr_control"));
    const listed = await list.json();
    assert.equal(listed.terminal_sessions.length, 1);
    assert.equal(listed.terminal_sessions[0].terminal_session_id, "ts_persist");
    assert.equal(listed.terminal_sessions[0].session_status, "live");

    const stream = await handleControlHubRequest(restarted, new Request("https://control.test/control/terminal-sessions/ts_persist/stream?user_id=usr_control"));
    const events = await readSSEEvents(stream, 2);
    assert.equal(events[0].kind, "terminal_session");
    assert.equal(events[1].kind, "text_delta");
    assert.equal(events[1].text, "hello from terminal");
  });

  it("subscribes terminal output only while a stream is open", async () => {
    const envelopes = [];
    const hub = new InMemoryControlHub();
    hub.attachDaemonForTest("dd_control", "usr_control", async (envelope) => {
      envelopes.push(envelope);
    });

    await hub.createTerminalSession({
      request_id: "term_req",
      terminal_session_id: "ts_subscribe",
      user_id: "usr_control",
      daemon_device_id: "dd_control",
      browser_device_id: "bd_control",
      session_id: "sess_control",
      agent: "claude-code",
      cwd: "/work/app",
    });
    envelopes.length = 0;

    const stream = hub.streamTerminalSession("usr_control", "ts_subscribe");
    const { reader } = await readFirstSSEEvent(stream);
    await eventually(() => {
      assert.equal(envelopes.at(-1)?.type, "TERMINAL_SUBSCRIBE");
    });
    assert.equal(envelopes.at(-1).terminal_request.terminal_session_id, "ts_subscribe");

    await reader.cancel();
    await eventually(() => {
      assert.equal(envelopes.at(-1)?.type, "TERMINAL_UNSUBSCRIBE");
    });
    assert.equal(envelopes.at(-1).terminal_request.terminal_session_id, "ts_subscribe");
  });

  it("supports terminal subscribe and cursor polling without a long stream", async () => {
    const envelopes = [];
    const hub = new InMemoryControlHub();
    hub.attachDaemonForTest("dd_control", "usr_control", async (envelope) => {
      envelopes.push(envelope);
    });

    await hub.createTerminalSession({
      request_id: "term_req",
      terminal_session_id: "ts_poll",
      user_id: "usr_control",
      daemon_device_id: "dd_control",
      browser_device_id: "bd_control",
      session_id: "sess_control",
      agent: "claude-code",
      cwd: "/work/app",
    });
    envelopes.length = 0;

    const subscribe = await handleControlHubRequest(hub, new Request("https://control.test/control/terminal-sessions/ts_poll/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "usr_control" }),
    }));
    assert.equal(subscribe.status, 200);
    assert.equal(envelopes.at(-1)?.type, "TERMINAL_SUBSCRIBE");

    hub.receiveDaemonEnvelope("dd_control", {
      type: "TERMINAL_EVENT",
      terminal_event: {
        terminal_session_id: "ts_poll",
        kind: "text_delta",
        payload: "batched output",
        session_status: "live",
        turn_status: "idle",
        timestamp: "2026-06-06T01:00:00Z",
      },
    });
    const events = await handleControlHubRequest(hub, new Request("https://control.test/control/terminal-sessions/ts_poll/events?user_id=usr_control"));
    const body = await events.json();
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].payload.payload, "batched output");
    assert.match(body.next_cursor, /^ev_/);

    const after = await handleControlHubRequest(hub, new Request(`https://control.test/control/terminal-sessions/ts_poll/events?user_id=usr_control&after=${encodeURIComponent(body.next_cursor)}`));
    assert.deepEqual(await after.json(), { events: [], next_cursor: body.next_cursor });

    const unsubscribe = await handleControlHubRequest(hub, new Request("https://control.test/control/terminal-sessions/ts_poll/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "usr_control" }),
    }));
    assert.equal(unsubscribe.status, 200);
    assert.equal(envelopes.at(-1)?.type, "TERMINAL_UNSUBSCRIBE");
  });

  it("pushes terminal output to browser realtime terminal subscribers", async () => {
    const envelopes = [];
    const hub = new InMemoryControlHub();
    hub.attachDaemonForTest("dd_control", "usr_control", async (envelope) => {
      envelopes.push(envelope);
    });
    await hub.createTerminalSession({
      request_id: "term_req",
      terminal_session_id: "ts_browser",
      user_id: "usr_control",
      daemon_device_id: "dd_control",
      browser_device_id: "bd_control",
      session_id: "sess_control",
      agent: "claude-code",
      cwd: "/work/app",
    });
    const browser = hub.attachBrowserForTest({
      userID: "usr_control",
      browserDeviceID: "bd_control",
      daemonDeviceID: "dd_control",
      sessionID: "sess_control",
    });
    browser.messages.length = 0;

    hub.handleBrowserSocketMessage(browser.socket, JSON.stringify({
      type: "SUBSCRIBE_TERMINAL",
      terminal_session_id: "ts_browser",
    }));
    await eventually(() => {
      assert.equal(envelopes.at(-1)?.type, "TERMINAL_SUBSCRIBE");
    });
    browser.messages.length = 0;

    hub.receiveDaemonEnvelope("dd_control", {
      type: "TERMINAL_EVENT",
      terminal_event: {
        terminal_session_id: "ts_browser",
        kind: "text_delta",
        payload: "batched output",
        timestamp: "2026-06-06T01:00:00Z",
      },
    });

    assert.equal(browser.messages.length, 1);
    assert.equal(browser.messages[0].type, "TERMINAL_EVENT");
    assert.equal(browser.messages[0].event.payload, "batched output");
    browser.cleanup();
  });

  it("forwards terminal batches to the recent-event sink", async () => {
    const terminalEvents = [];
    const hub = new InMemoryControlHub({
      eventSink: {
        onTerminalEvent: async (event, meta) => terminalEvents.push({ event, meta }),
      },
    });
    hub.attachDaemonForTest("dd_control", "usr_control", async () => {});

    hub.receiveDaemonEnvelope("dd_control", {
      type: "TERMINAL_EVENT",
      terminal_event: {
        terminal_session_id: "ts_sink",
        kind: "text_delta",
        payload: "batched output",
        session_id: "sess_control",
        timestamp: "2026-06-06T01:00:00Z",
      },
    });

    assert.equal(terminalEvents.length, 1);
    assert.equal(terminalEvents[0].event.payload, "batched output");
    assert.equal(terminalEvents[0].meta.userID, "usr_control");
    assert.equal(terminalEvents[0].meta.daemonDeviceID, "dd_control");
    assert.equal(terminalEvents[0].meta.sessionID, "sess_control");
  });

  it("emits deduplicated notifications for inject outcomes and permission requests", async () => {
    const notifications = [];
    const hub = new InMemoryControlHub({
      notificationSink: async (userID, notification) => {
        notifications.push({ userID, notification });
        return { attempted: 1, sent: 1, failed: 0 };
      },
    });
    hub.attachDaemonForTest("dd_notify", "usr_notify", async () => {});

    hub.receiveDaemonEnvelope("dd_notify", {
      type: "INJECT_EVENT",
      event: {
        request_id: "inj_done",
        type: "inject_ready",
        session_id: "sess_notify",
        device_id: "dd_notify",
      },
    });
    await hub.notificationChain;
    assert.deepEqual(notifications[0], {
      userID: "usr_notify",
      notification: {
        title: "Pockly task finished",
        summary: "A remote agent run finished.",
        session_id: "sess_notify",
        device_id: "dd_notify",
        url: "/workspace/s/sess_notify?device_id=dd_notify",
      },
    });

    const permissionTurn = {
      device_id: "dd_notify",
      session_id: "sess_notify",
      seq: 2,
      kind: "attachment",
      payload: JSON.stringify({
        attachment_type: "permission_request",
        permission_request_id: "perm_notify",
        status: "pending",
      }),
    };
    hub.receiveDaemonEnvelope("dd_notify", {
      type: "INJECT_EVENT",
      event: { request_id: "inj_perm", turn: permissionTurn },
    });
    hub.receiveDaemonEnvelope("dd_notify", {
      type: "INJECT_EVENT",
      event: { request_id: "inj_perm", turn: permissionTurn },
    });
    await hub.notificationChain;
    assert.equal(notifications.length, 2);
    assert.deepEqual(notifications[1], {
      userID: "usr_notify",
      notification: {
        title: "Pockly needs approval",
        summary: "An agent is waiting for a local approval decision.",
        session_id: "sess_notify",
        device_id: "dd_notify",
        url: "/workspace/s/sess_notify?device_id=dd_notify",
      },
    });
  });
});

class FakeTerminalStorage {
  constructor() {
    this.state = { sessions: [], history: {} };
  }

  async load() {
    return structuredClone(this.state);
  }

  async save(state) {
    this.state = structuredClone(state);
  }
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

async function readFirstSSEEvent(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (readSSEText(text).length < 1) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return { event: readSSEText(text)[0], reader };
}

async function eventually(fn, timeoutMs = 1000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}
