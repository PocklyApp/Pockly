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
        type: "inject_completed",
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
