/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { WebSocket } from "ws";

import { serveNodeNexus } from "../src/node/server.js";

describe("Node self-hosted Nexus server", () => {
  it("starts through the packaged pockly-nexus serve CLI", async () => {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-cli-"));
    const cliPath = new URL("../bin/pockly-nexus.js", import.meta.url);
    const child = spawn(process.execPath, [
      cliPath.pathname,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--data-dir",
      dataDir,
    ], {
      env: {
        ...process.env,
        POCKLY_NEXUS_RUNTIME: "self_hosted",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const port = await waitForCLIListenPort(child);
      const res = await fetch(`http://127.0.0.1:${port}/api/runtime`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).runtime, "self_hosted");
      assert.equal(fs.existsSync(path.join(dataDir, "nexus.sqlite")), true);
    } finally {
      child.kill("SIGTERM");
      await waitForProcessExit(child);
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("serves the Nexus runtime contract over Node HTTP", async () => {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-server-"));
    const server = await serveNodeNexus({ host: "127.0.0.1", port: 0, dataDir });
    try {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/runtime`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        runtime: "self_hosted",
        realtime: true,
        terminal: true,
        web_push: false,
        stt: false,
        release_update: true,
        contract_version: "1",
      });
      assert.equal(fs.existsSync(path.join(dataDir, "nexus.sqlite")), true);
      assert.equal(fs.existsSync(path.join(dataDir, "releases")), true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps dev login disabled by default over Node HTTP", async () => {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-dev-login-"));
    const server = await serveNodeNexus({ host: "127.0.0.1", port: 0, dataDir });
    try {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/dev/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "test@example.local",
          name: "Test User",
        }),
      });
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), {
        error: "dev_login_disabled",
        code: "not_found",
      });
      assert.equal(res.headers.get("set-cookie"), null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("routes daemon and browser realtime websockets through the in-process hub", async () => {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-ws-"));
    const server = await serveNodeNexus({ host: "127.0.0.1", port: 0, dataDir });
    const sockets = [];
    try {
      const baseURL = `http://127.0.0.1:${server.address().port}`;
      const cookie = await loginCookie(baseURL);
      const browser = await registerBrowser(baseURL, cookie);
      const daemon = await loginDaemon(baseURL, cookie);
      await syncSession(baseURL, daemon);

      const daemonSocket = await openWebSocket(`${baseURL}/api/daemon/control`, {
        authorization: `Bearer ${daemon.device_access_token}`,
      });
      sockets.push(daemonSocket);
      daemonSocket.on("message", (data) => {
        const envelope = JSON.parse(String(data));
        if (envelope.type === "AGENT_DEFAULTS_GET") {
          daemonSocket.send(JSON.stringify({
            type: "AGENT_DEFAULTS_RESULT",
            agent_defaults_result: {
              request_id: envelope.agent_defaults_get.request_id,
              status: "ok",
              default_model: "opus",
              resolved_model: "anthropic-compatible-pro",
              available_models: ["opus"],
              available_model_options: [{ value: "opus", resolved_model: "anthropic-compatible-pro" }],
              available_permission_modes: ["default", "acceptEdits", "plan"],
              available_efforts: ["default"],
            },
          }));
        }
        if (envelope.type === "INJECT_REQUEST") {
          daemonSocket.send(JSON.stringify({
            type: "INJECT_EVENT",
            event: {
              request_id: envelope.request.request_id,
              type: "inject_completed",
              session_id: "sess_node_ws",
              turn: {
                device_id: daemon.daemon_device_id,
                session_id: "sess_node_ws",
                seq: 2,
                agent: "claude-code",
                kind: "assistant_text",
                timestamp: "2026-06-06T01:00:02Z",
                payload: { text: "node realtime done" },
              },
            },
          }));
        }
      });

      const browserSocket = await openWebSocket(`${baseURL.replace("http:", "ws:")}/api/ws?access_token=${encodeURIComponent(browser.device_access_token)}`);
      sockets.push(browserSocket);
      const sessionStatusPromise = waitForWebSocketJSON(browserSocket, (message) => message.type === "SESSION_STATUS");
      const hostStatusPromise = waitForWebSocketJSON(browserSocket, (message) => message.type === "HOST_STATUS");
      browserSocket.send(JSON.stringify({
        type: "SUBSCRIBE",
        device_id: daemon.daemon_device_id,
        session_id: "sess_node_ws",
      }));
      await sessionStatusPromise;
      const hostStatus = await hostStatusPromise;
      assert.equal(hostStatus.presence_status, "online");
      assert.equal(hostStatus.control_connected, true);

      const defaults = await jsonFetch(`${baseURL}/api/agent-defaults?daemon_device_id=${daemon.daemon_device_id}&cwd=%2Fwork%2Fapp`, {
        headers: { authorization: `Bearer ${browser.device_access_token}` },
      });
      assert.equal(defaults.resolved_model, "anthropic-compatible-pro");

      const pushedTurnPromise = waitForWebSocketJSON(browserSocket, (message) => message.type === "TURN");
      const injectRes = await fetch(`${baseURL}/api/sessions/sess_node_ws/inject?device_id=${daemon.daemon_device_id}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${browser.device_access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "hello from node ws", model: "opus" }),
      });
      assert.equal(injectRes.status, 200);
      const injectEvents = parseSSE(await injectRes.text());
      assert.deepEqual(injectEvents.map((event) => event.type), ["inject_started", "inject_completed"]);
      const pushedTurn = await pushedTurnPromise;
      assert.equal(pushedTurn.turn.payload.text, "node realtime done");
    } finally {
      for (const socket of sockets) socket.close();
      await new Promise((resolve) => server.close(resolve));
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("runs the self-hosted Nexus browser/daemon control and sync chain", async () => {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-flow-"));
    await fs.promises.mkdir(path.join(dataDir, "releases", "pockly-daemon", "latest"), { recursive: true });
    await fs.promises.writeFile(
      path.join(dataDir, "releases", "pockly-daemon", "latest", "checksums.txt"),
      `${"0".repeat(64)}  pockly-daemon_v0.2.0_linux_amd64.tar.gz\n`,
    );
    const server = await serveNodeNexus({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      env: { DAEMON_RELEASE_CACHE_SECONDS: "0" },
    });
    const sockets = [];
    try {
      const baseURL = `http://127.0.0.1:${server.address().port}`;
      const cookie = await loginCookie(baseURL);
      const browser = await registerBrowser(baseURL, cookie);
      const daemon = await loginDaemon(baseURL, cookie);
      const connectedBrowser = await jsonFetch(`${baseURL}/api/hosts/${daemon.daemon_device_id}/connect`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          browser_device_id: browser.browser_device_id,
          browser_device_pubkey: "browser-public-key",
          device_name: "Connected Test Browser",
          user_agent: "node-test",
        }),
      });
      assert.equal(connectedBrowser.status, "connected");

      const daemonSocket = await openWebSocket(`${baseURL}/api/daemon/control`, {
        authorization: `Bearer ${daemon.device_access_token}`,
      });
      sockets.push(daemonSocket);
      const daemonEnvelopes = [];
      daemonSocket.on("message", (data) => {
        const envelope = JSON.parse(String(data));
        daemonEnvelopes.push(envelope);
        switch (envelope.type) {
          case "PERMISSION_DECIDE":
            daemonSocket.send(JSON.stringify({
              type: "PERMISSION_DECIDE_EVENT",
              permission_decide_event: {
                request_id: envelope.permission_decide.request_id,
                status: "accepted",
                decision: envelope.permission_decide.decision,
              },
            }));
            break;
          case "INJECT_REQUEST":
            daemonSocket.send(JSON.stringify({
              type: "INJECT_EVENT",
              event: {
                request_id: envelope.request.request_id,
                type: "inject_completed",
                session_id: envelope.request.session_id,
                turn: {
                  device_id: daemon.daemon_device_id,
                  session_id: envelope.request.session_id,
                  seq: 3,
                  agent: "claude-code",
                  kind: "assistant_text",
                  timestamp: "2026-06-06T01:00:03Z",
                  payload: { text: "self-hosted flow done" },
                },
              },
            }));
            break;
          case "TERMINAL_CREATE":
            daemonSocket.send(JSON.stringify({
              type: "TERMINAL_EVENT",
              terminal_event: {
                request_id: envelope.terminal_request.request_id,
                terminal_session_id: envelope.terminal_request.terminal_session_id,
                kind: "session_ready",
                session_status: "live",
                turn_status: "idle",
                timestamp: "2026-06-06T01:00:04Z",
              },
            }));
            break;
          case "TERMINAL_INPUT":
            daemonSocket.send(JSON.stringify({
              type: "TERMINAL_EVENT",
              terminal_event: {
                request_id: envelope.terminal_request.request_id,
                terminal_session_id: envelope.terminal_request.terminal_session_id,
                kind: "output",
                text: "terminal echoed input",
                session_status: "live",
                turn_status: "idle",
                timestamp: "2026-06-06T01:00:05Z",
              },
            }));
            break;
          case "TERMINAL_STOP":
            daemonSocket.send(JSON.stringify({
              type: "TERMINAL_EVENT",
              terminal_event: {
                request_id: envelope.terminal_request.request_id,
                terminal_session_id: envelope.terminal_request.terminal_session_id,
                kind: "session_stopped",
                session_status: "stopped",
                turn_status: "idle",
                timestamp: "2026-06-06T01:00:06Z",
              },
            }));
            break;
          default:
            break;
        }
      });

      const syncResult = await jsonFetch(`${baseURL}/api/daemon/sync`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.device_access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
          sessions: [
            {
              session_id: "sess_node_flow",
              agent: "claude-code",
              cwd: "/work/app",
              snippet: "synced history",
              last_seq: 2,
              last_timestamp: "2026-06-06T01:00:02Z",
              turn_count: 2,
              min_seq: 1,
              max_seq: 2,
            },
          ],
          turns: [
            {
              session_id: "sess_node_flow",
              seq: 1,
              agent: "claude-code",
              kind: "user_message",
              timestamp: "2026-06-06T01:00:01Z",
              payload: { text: "hello" },
            },
            {
              session_id: "sess_node_flow",
              seq: 2,
              agent: "claude-code",
              kind: "assistant_text",
              timestamp: "2026-06-06T01:00:02Z",
              payload: { text: "synced assistant reply" },
            },
          ],
        }),
      });
      assert.deepEqual(syncResult, {
        ok: true,
        session_count: 1,
        turn_count: 2,
        daemon_device: daemon.daemon_device_id,
        daemon_version: "0.1.0-test",
      });

      const syncedTurns = await sessionTurns(baseURL, connectedBrowser.device_access_token, daemon.daemon_device_id, "sess_node_flow");
      assert.equal(syncedTurns.turns.length, 2);
      assert.deepEqual(syncedTurns.turns.map((turn) => turn.payload?.text), ["hello", "synced assistant reply"]);

      const hosts = await jsonFetch(`${baseURL}/api/hosts/online`, { headers: { cookie } });
      assert.equal(hosts.hosts[0].presence_status, "online");
      assert.equal(hosts.hosts[0].control_connected, true);
      assert.equal(hosts.hosts[0].daemon_latest_version, "v0.2.0");
      assert.equal(hosts.hosts[0].daemon_update_available, true);

      const browserSocket = await openWebSocket(`${baseURL}/api/ws?access_token=${encodeURIComponent(connectedBrowser.device_access_token)}`);
      sockets.push(browserSocket);
      const turnPromise = waitForWebSocketJSON(browserSocket, (message) => message.type === "TURN");
      browserSocket.send(JSON.stringify({
        type: "SUBSCRIBE",
        device_id: daemon.daemon_device_id,
        session_id: "sess_node_flow",
      }));
      const injectRes = await fetch(`${baseURL}/api/sessions/sess_node_flow/inject?device_id=${daemon.daemon_device_id}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connectedBrowser.device_access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "continue", model: "opus" }),
      });
      assert.equal(injectRes.status, 200);
      assert.deepEqual(parseSSE(await injectRes.text()).map((event) => event.type), ["inject_started", "inject_completed"]);
      assert.equal((await turnPromise).turn.payload.text, "self-hosted flow done");

      const permissionDecision = await jsonFetch(`${baseURL}/api/permission-requests/perm_node_flow/decide`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connectedBrowser.device_access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          daemon_device_id: daemon.daemon_device_id,
          decision: "allow",
        }),
      });
      assert.equal(permissionDecision.status, "accepted");

      const terminalCreate = await jsonFetch(`${baseURL}/api/terminal-sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connectedBrowser.device_access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          daemon_device_id: daemon.daemon_device_id,
          session_id: "sess_node_flow",
          agent: "claude-code",
          cwd: "/work/app",
        }),
      });
      const terminalID = terminalCreate.terminal_session.terminal_session_id;
      const terminalInput = await jsonFetch(`${baseURL}/api/terminal-sessions/${terminalID}/input`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connectedBrowser.device_access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "pwd\n" }),
      });
      assert.equal(terminalInput.status, "queued");
      const terminalStop = await jsonFetch(`${baseURL}/api/terminal-sessions/${terminalID}/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${connectedBrowser.device_access_token}` },
      });
      assert.equal(terminalStop.status, "queued");
      const terminalStream = await fetch(`${baseURL}/api/terminal-sessions/${terminalID}/stream`, {
        headers: { authorization: `Bearer ${connectedBrowser.device_access_token}` },
      });
      assert.equal(terminalStream.status, 200);
      const terminalEvents = await readSSEEvents(terminalStream, 4);
      assert.deepEqual(terminalEvents.map((event) => event.kind), [
        "terminal_session",
        "session_ready",
        "output",
        "session_stopped",
      ]);

      assert.deepEqual(daemonEnvelopes.map((envelope) => envelope.type), [
        "INJECT_REQUEST",
        "PERMISSION_DECIDE",
        "TERMINAL_CREATE",
        "TERMINAL_INPUT",
        "TERMINAL_STOP",
      ]);
    } finally {
      for (const socket of sockets) socket.close();
      await new Promise((resolve) => server.close(resolve));
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });
});

async function loginCookie(baseURL) {
  const res = await fetch(`${baseURL}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "test@example.local",
      name: "Test User",
      password: "correct horse battery staple",
    }),
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie").split(";")[0];
}

async function registerBrowser(baseURL, cookie) {
  return await jsonFetch(`${baseURL}/api/devices/register-browser`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      browser_device_pubkey: "browser-public-key",
      device_name: "Node Browser",
      user_agent: "node-ws-test",
    }),
  });
}

async function loginDaemon(baseURL, cookie) {
  const code = await jsonFetch(`${baseURL}/api/daemon/login-codes`, {
    method: "POST",
    headers: { cookie },
  });
  return await jsonFetch(`${baseURL}/api/daemon/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      login_code: code.login_code,
      daemon_device_id: "dd_node_ws",
      daemon_pubkey: "daemon-public-key",
      device_name: "Node Host",
      hostname: "node-host",
      os: "linux",
      app_version: "0.1.0-test",
      computer_id: "dc_node_ws",
    }),
  });
}

async function syncSession(baseURL, daemon) {
  const res = await fetch(`${baseURL}/api/daemon/sync`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.device_access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      hello: { device_id: daemon.daemon_device_id, version: "0.1.0-test" },
      sessions: [
        {
          session_id: "sess_node_ws",
          agent: "claude-code",
          cwd: "/work/app",
          snippet: "node ws",
          last_seq: 1,
          last_timestamp: "2026-06-06T01:00:01Z",
          turn_count: 1,
        },
      ],
    }),
  });
  assert.equal(res.status, 200);
}

async function sessionTurns(baseURL, deviceAccessToken, daemonDeviceID, sessionID) {
  return await jsonFetch(`${baseURL}/api/sessions/${sessionID}/turns?device_id=${daemonDeviceID}`, {
    headers: { authorization: `Bearer ${deviceAccessToken}` },
  });
}

async function jsonFetch(url, init = {}) {
  const res = await fetch(url, init);
  if (res.status !== 200) assert.equal(res.status, 200, await res.text());
  return await res.json();
}

async function openWebSocket(url, headers = {}) {
  const wsURL = url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const socket = new WebSocket(wsURL, { headers });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`websocket open timeout: ${wsURL}`)), 5_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}

function waitForWebSocketJSON(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("websocket message timeout"));
    }, 5_000);
    const onMessage = (data) => {
      const message = JSON.parse(String(data));
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

function parseSSE(text) {
  return text.split(/\n\n+/)
    .map((chunk) => chunk.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

async function readSSEEvents(response, count, timeoutMs = 5_000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (parseSSE(text).length < count) {
      const remaining = Math.max(1, deadline - Date.now());
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`SSE event timeout after ${timeoutMs}ms; got ${parseSSE(text).length}/${count}: ${text}`)), remaining)),
      ]);
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return parseSSE(text).slice(0, count);
}

function waitForCLIListenPort(child) {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`pockly-nexus CLI did not start in time; stdout=${out}; stderr=${err}`));
    }, 10_000);
    const onStdout = (chunk) => {
      out += chunk.toString();
      const match = out.match(/pockly-nexus listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      cleanup();
      resolve(Number(match[1]));
    };
    const onStderr = (chunk) => {
      err += chunk.toString();
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`pockly-nexus CLI exited before listening: code=${code} signal=${signal} stdout=${out} stderr=${err}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process exit timeout")), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
