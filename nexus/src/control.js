/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ErrorCode, errorResponse, jsonResponse } from "./contract.js";

const defaultRequestTimeoutMs = 30_000;
const injectTimeoutMs = 35 * 60_000;
const syncTimeoutMs = 35 * 60_000;

export function createControlHub(env = {}) {
  if (env.POCKLY_CONTROL_HUB) return env.POCKLY_CONTROL_HUB;
  if (env.POCKLY_CONTROL_HUB_FACTORY) return controlHubFromFactory(env.POCKLY_CONTROL_HUB_FACTORY, env.POCKLY_CONTROL_USER_ID || "");
  globalThis.__POCKLY_CONTROL_HUB ??= new InMemoryControlHub();
  return globalThis.__POCKLY_CONTROL_HUB;
}

export function createControlHubForUser(env = {}, userID = "") {
  if (env.POCKLY_CONTROL_HUB) return env.POCKLY_CONTROL_HUB;
  if (env.POCKLY_CONTROL_HUB_FACTORY) return controlHubFromFactory(env.POCKLY_CONTROL_HUB_FACTORY, userID);
  return createControlHub(env);
}

function controlHubFromFactory(factory, userID) {
  if (typeof factory === "function") return factory(userID);
  if (typeof factory?.forUser === "function") return factory.forUser(userID);
  throw new Error("invalid control hub factory");
}

export class InMemoryControlHub {
  constructor(options = {}) {
    this.terminalStorage = options.terminalStorage || null;
    this.notificationSink = options.notificationSink || null;
    this.distributedSink = options.distributedSink || null;
    this.presenceResolver = options.presenceResolver || null;
    this.terminalPersistChain = Promise.resolve();
    this.notificationChain = Promise.resolve();
    this.notificationDedup = new Map();
    this.daemons = new Map();
    this.pending = new Map();
    this.streams = new Map();
    this.browserSockets = new Map();
    this.terminalSessions = new Map();
    this.terminalStreams = new Map();
    this.terminalHistory = new Map();
  }

  async hydrateTerminalState() {
    if (!this.terminalStorage) return;
    const state = await this.terminalStorage.load();
    for (const session of state.sessions || []) {
      if (!session?.terminal_session_id) continue;
      this.terminalSessions.set(session.terminal_session_id, session);
    }
    for (const [terminalSessionID, history] of Object.entries(state.history || {})) {
      if (!Array.isArray(history)) continue;
      this.terminalHistory.set(terminalSessionID, history);
    }
  }

  isDaemonOnline(deviceID) {
    return this.daemons.has(deviceID);
  }

  attachDaemonForTest(deviceID, userID, handler) {
    const conn = {
      deviceID,
      userID,
      sendEnvelope: async (envelope) => {
        await handler(envelope, (reply) => this.receiveDaemonEnvelope(deviceID, reply));
      },
      close: () => {},
    };
    this.daemons.set(deviceID, conn);
    this.broadcastHostStatus({
      userID,
      deviceID,
      presence_status: "online",
      presence_reason: "control_connected",
      control_connected: true,
    });
    return () => {
      if (this.daemons.get(deviceID) === conn) {
        this.daemons.delete(deviceID);
        this.broadcastHostStatus({
          userID,
          deviceID,
          presence_status: "offline",
          presence_reason: "control_disconnected",
          control_connected: false,
        });
      }
    };
  }

  attachBrowserForTest({ userID, browserDeviceID, daemonDeviceID, sessionID }) {
    const messages = [];
    const ws = {
      send: (message) => messages.push(JSON.parse(String(message))),
    };
    const socket = { userID, deviceID: browserDeviceID, ws, subscriptions: new Set([subscriptionKey(userID, daemonDeviceID, sessionID)]) };
    this.browserSockets.set(ws, socket);
    return {
      messages,
      cleanup: () => this.browserSockets.delete(ws),
    };
  }

  acceptDaemonWebSocket(request, { userID, deviceID }) {
    if (typeof WebSocketPair === "undefined") {
      return errorResponse("websocket upgrade is unavailable in this runtime", ErrorCode.UnsupportedRuntime, { status: 501 });
    }
    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
      return errorResponse("websocket upgrade required", ErrorCode.BadRequest, { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.attachDaemonWebSocketConnection({ userID, deviceID, socket: server });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Register (or replace) a daemon connection and announce presence. Split out
  // from the WebSocket accept path so alternative transports can reuse the
  // registry/presence bookkeeping while supplying their own socket.
  registerDaemonConnection({ userID, deviceID, socket }) {
    const conn = {
      deviceID,
      userID,
      socket,
      sendEnvelope: async (envelope) => {
        socketSend(socket, JSON.stringify(envelope));
      },
      close: () => socketClose(socket, 1000, "replaced"),
    };
    const previous = this.daemons.get(deviceID);
    if (previous?.close) previous.close();
    this.daemons.set(deviceID, conn);
    this.broadcastHostStatus({
      userID,
      deviceID,
      presence_status: "online",
      presence_reason: "control_connected",
      control_connected: true,
    });
    return conn;
  }

  // Tear down a daemon connection: drop it from the registry (if it is still the
  // active one for this socket), announce offline, and fail in-flight streams.
  onDaemonConnectionClosed(userID, deviceID, socket) {
    const conn = this.daemons.get(deviceID);
    if (conn && conn.socket === socket) {
      this.daemons.delete(deviceID);
      this.broadcastHostStatus({
        userID,
        deviceID,
        presence_status: "offline",
        presence_reason: "control_disconnected",
        control_connected: false,
      });
    }
    this.failStreamsForDaemon(deviceID, "daemon control connection closed");
  }

  attachDaemonWebSocketConnection({ userID, deviceID, socket }) {
    const conn = this.registerDaemonConnection({ userID, deviceID, socket });
    socketAddListener(socket, "message", (event) => {
      try {
        this.receiveDaemonEnvelope(deviceID, JSON.parse(String(socketMessageData(event))));
      } catch {
        // Ignore malformed daemon frames. The daemon reconnect loop will
        // surface real protocol failures through telemetry and close events.
      }
    });
    const cleanup = once(() => this.onDaemonConnectionClosed(userID, deviceID, socket));
    socketAddListener(socket, "close", cleanup);
    socketAddListener(socket, "error", cleanup);
    return conn;
  }

  acceptBrowserWebSocket(request, { userID, deviceID }) {
    if (typeof WebSocketPair === "undefined") {
      return errorResponse("websocket upgrade is unavailable in this runtime", ErrorCode.UnsupportedRuntime, { status: 501 });
    }
    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
      return errorResponse("websocket upgrade required", ErrorCode.BadRequest, { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.attachBrowserWebSocketConnection({ userID, deviceID, socket: server });
    return new Response(null, { status: 101, webSocket: client });
  }

  attachBrowserWebSocketConnection({ userID, deviceID, socket }) {
    const browserSocket = { userID, deviceID, ws: socket, subscriptions: new Set() };
    this.browserSockets.set(socket, browserSocket);
    socketAddListener(socket, "message", (event) => {
      try {
        const msg = JSON.parse(String(socketMessageData(event)));
        if (msg.type !== "SUBSCRIBE") return;
        const sessionID = String(msg.session_id || "");
        const daemonDeviceID = String(msg.device_id || "");
        if (!sessionID || !daemonDeviceID) {
          socketSend(socket, JSON.stringify({ type: "ERROR", message: "session_id and device_id are required" }));
          return;
        }
        browserSocket.subscriptions.add(subscriptionKey(browserSocket.userID, daemonDeviceID, sessionID));
        socketSend(socket, JSON.stringify({ type: "SESSION_STATUS", message: "subscribed" }));
        const localOnline = this.isDaemonOnline(daemonDeviceID);
        socketSend(socket, JSON.stringify({
          type: "HOST_STATUS",
          device_id: daemonDeviceID,
          presence_status: localOnline ? "online" : "offline",
          presence_reason: localOnline ? "control_connected" : "control_disconnected",
          control_connected: localOnline,
        }));
        if (this.presenceResolver) {
          Promise.resolve(this.presenceResolver(daemonDeviceID))
            .then((status) => {
              if (!status || this.browserSockets.get(socket) !== browserSocket) return;
              socketSend(socket, JSON.stringify({
                type: "HOST_STATUS",
                device_id: daemonDeviceID,
                presence_status: status.presence_status || (status.online ? "online" : "offline"),
                presence_reason: status.presence_reason || (status.online ? "control_connected" : "control_disconnected"),
                control_connected: Boolean(status.control_connected ?? status.online),
              }));
            })
            .catch(() => undefined);
        }
      } catch {
        socketSend(socket, JSON.stringify({ type: "ERROR", message: "invalid websocket message" }));
      }
    });
    const cleanup = once(() => {
      this.browserSockets.delete(socket);
    });
    socketAddListener(socket, "close", cleanup);
    socketAddListener(socket, "error", cleanup);
    return browserSocket;
  }

  async requestResponse(daemonDeviceID, envelope, responseType, requestID, timeoutMs = defaultRequestTimeoutMs) {
    if (!requestID) throw new Error("request_id required");
    if (this.pending.has(requestID)) throw new Error("request_id already in flight");
    const daemon = this.daemons.get(daemonDeviceID);
    if (!daemon) throw new Error("daemon offline");
    const waiter = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestID);
        reject(new Error("daemon ack timeout"));
      }, timeoutMs);
      this.pending.set(requestID, { responseType, resolve, timer });
    });
    try {
      await daemon.sendEnvelope(envelope);
    } catch (error) {
      this.clearPending(requestID);
      throw error;
    }
    return await waiter;
  }

  async dispatch(daemonDeviceID, envelope) {
    const daemon = this.daemons.get(daemonDeviceID);
    if (!daemon) throw new Error("daemon offline");
    await daemon.sendEnvelope(envelope);
  }

  async cancelInject(userID, requestID) {
    const entry = this.streams.get(requestID);
    if (!entry || (entry.userID && entry.userID !== userID)) throw new Error("inject request not found");
    await this.dispatch(entry.daemonDeviceID, {
      type: "CANCEL_INJECT",
      cancel_inject: { request_id: requestID },
    });
    return { status: "queued", request_id: requestID };
  }

  streamRequest(daemonDeviceID, envelope, requestID, options) {
    if (!requestID) return errorResponse("request_id required", ErrorCode.BadRequest, { status: 400 });
    const daemon = this.daemons.get(daemonDeviceID);
    if (!daemon) return errorResponse("daemon offline", ErrorCode.DaemonOffline, { status: 503 });
    const encoder = new TextEncoder();
    const timeoutMs = options.timeoutMs ?? defaultRequestTimeoutMs;
    const stream = new ReadableStream({
      start: (controller) => {
        const entry = {
          daemonDeviceID,
          userID: options.userID || "",
          controller,
          closeWhen: options.closeWhen,
          eventName: options.eventName ?? "message",
          timer: setTimeout(() => {
            this.writeSSE(controller, options.eventName ?? "message", options.timeoutEvent(requestID));
            this.closeStream(requestID);
          }, timeoutMs),
          encoder,
        };
        this.streams.set(requestID, entry);
        if (options.initialEvent) {
          this.writeSSE(controller, options.eventName ?? "message", options.initialEvent);
        }
        daemon.sendEnvelope(envelope).catch((error) => {
          this.writeSSE(controller, options.eventName ?? "message", options.errorEvent(requestID, error.message || "daemon send failed"));
          this.closeStream(requestID);
        });
      },
      cancel: () => {
        this.closeStream(requestID, false);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  receiveDaemonEnvelope(deviceID, envelope, options = {}) {
    if (!options.skipDistributedSink) {
      this.distributedSink?.onDaemonEnvelope?.(deviceID, envelope, this.daemons.get(deviceID)?.userID || "");
    }
    const type = envelope?.type || envelope?.Type || "";
    switch (type) {
      case "DAEMON_STATUS":
        return this.deliverDaemonStatus(deviceID, envelope.daemon_status || envelope.DaemonStatus || envelope.status || {});
      case "INJECT_EVENT":
        return this.deliverInjectEvent(envelope.event || envelope.Event, options.userID ?? this.daemons.get(deviceID)?.userID ?? "");
      case "SYNC_SESSION_EVENT":
        return this.deliverStream(envelope.sync_event || envelope.SyncEvent);
      case "LIST_DIR_RESPONSE":
        return this.deliverPending(type, envelope.list_dir_response || envelope.ListDirResponse);
      case "PERMISSION_DECIDE_EVENT":
        return this.deliverPending(type, envelope.permission_decide_event || envelope.PermissionDecideEvent);
      case "AGENT_SETTINGS_RESULT":
        return this.deliverPending(type, envelope.agent_settings_result || envelope.AgentSettingsResult);
      case "AGENT_DEFAULTS_RESULT":
        return this.deliverPending(type, envelope.agent_defaults_result || envelope.AgentDefaultsResult);
      case "GIT_DIFF_RESULT":
        return this.deliverPending(type, envelope.git_diff_result || envelope.GitDiffResult);
      case "TERMINAL_EVENT":
        return this.publishTerminalEvent(envelope.terminal_event || envelope.TerminalEvent, options);
      default:
        return;
    }
  }

  async createTerminalSession(session) {
    const daemon = this.daemons.get(session.daemon_device_id);
    if (!daemon) throw new Error("daemon offline");
    const now = new Date().toISOString();
    const next = {
      ...session,
      session_status: "starting",
      turn_status: "idle",
      created_at: now,
      updated_at: now,
    };
    this.terminalSessions.set(next.terminal_session_id, next);
    this.terminalHistory.set(next.terminal_session_id, []);
    await this.persistTerminalState();
    this.distributedSink?.onTerminalSession?.(next);
    await daemon.sendEnvelope({
      type: "TERMINAL_CREATE",
      terminal_request: {
        request_id: next.request_id,
        terminal_session_id: next.terminal_session_id,
        daemon_device_id: next.daemon_device_id,
        browser_device_id: next.browser_device_id,
        session_id: next.session_id || "",
        agent: next.agent || "",
        cwd: next.cwd || "",
      },
    });
    return next;
  }

  listTerminalSessions(userID) {
    return [...this.terminalSessions.values()]
      .filter((session) => session.user_id === userID)
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  }

  async sendTerminalInput(userID, terminalSessionID, text) {
    const session = this.requireTerminalSession(userID, terminalSessionID);
    const daemon = this.daemons.get(session.daemon_device_id);
    if (!daemon) throw new Error("daemon offline");
    await daemon.sendEnvelope({
      type: "TERMINAL_INPUT",
      terminal_request: {
        request_id: randomID("term"),
        terminal_session_id: terminalSessionID,
        daemon_device_id: session.daemon_device_id,
        browser_device_id: session.browser_device_id,
        text,
      },
    });
  }

  async openTerminalSession(userID, terminalSessionID) {
    const session = this.requireTerminalSession(userID, terminalSessionID);
    const daemon = this.daemons.get(session.daemon_device_id);
    if (!daemon) throw new Error("daemon offline");
    await daemon.sendEnvelope({
      type: "TERMINAL_OPEN_TERMINAL",
      terminal_request: {
        request_id: randomID("term"),
        terminal_session_id: terminalSessionID,
        daemon_device_id: session.daemon_device_id,
        browser_device_id: session.browser_device_id,
      },
    });
  }

  async stopTerminalSession(userID, terminalSessionID) {
    const session = this.requireTerminalSession(userID, terminalSessionID);
    const daemon = this.daemons.get(session.daemon_device_id);
    if (!daemon) throw new Error("daemon offline");
    await daemon.sendEnvelope({
      type: "TERMINAL_STOP",
      terminal_request: {
        request_id: randomID("term"),
        terminal_session_id: terminalSessionID,
        daemon_device_id: session.daemon_device_id,
        browser_device_id: session.browser_device_id,
      },
    });
  }

  streamTerminalSession(userID, terminalSessionID) {
    const session = this.requireTerminalSession(userID, terminalSessionID);
    const encoder = new TextEncoder();
    let currentEntry;
    const stream = new ReadableStream({
      start: (controller) => {
        const entry = { controller, encoder };
        currentEntry = entry;
        const streams = this.terminalStreams.get(terminalSessionID) ?? new Set();
        streams.add(entry);
        this.terminalStreams.set(terminalSessionID, streams);
        writeSSE(controller, "terminal_session", { terminal_session_id: terminalSessionID, kind: "terminal_session", session_status: session.session_status, turn_status: session.turn_status, timestamp: session.updated_at });
        for (const event of this.terminalHistory.get(terminalSessionID) ?? []) {
          writeSSE(controller, event.kind || "terminal_event", event);
        }
      },
      cancel: () => {
        const streams = this.terminalStreams.get(terminalSessionID);
        if (!streams) return;
        if (currentEntry) streams.delete(currentEntry);
        if (streams.size === 0) this.terminalStreams.delete(terminalSessionID);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  publishTerminalEvent(event, options = {}) {
    if (!event?.terminal_session_id) return;
    if (!options.skipDistributedSink) this.distributedSink?.onTerminalEvent?.(event);
    const existing = this.terminalSessions.get(event.terminal_session_id);
    const now = new Date().toISOString();
    let nextSession = existing;
    if (existing) {
      nextSession = {
        ...existing,
        session_id: event.session_id || existing.session_id,
        agent: event.agent || existing.agent,
        cwd: event.cwd || existing.cwd,
        session_status: event.session_status || existing.session_status,
        turn_status: event.turn_status || existing.turn_status,
        error: event.error || (event.session_status === "live" ? "" : existing.error),
        updated_at: event.timestamp || now,
      };
      this.terminalSessions.set(event.terminal_session_id, nextSession);
    }
    const history = this.terminalHistory.get(event.terminal_session_id) ?? [];
    history.push(event);
    if (history.length > 800) history.splice(0, history.length - 800);
    this.terminalHistory.set(event.terminal_session_id, history);
    this.persistTerminalState();
    this.emitNotificationForTerminalEvent(event, nextSession);
    const streams = this.terminalStreams.get(event.terminal_session_id);
    if (!streams) return;
    for (const entry of [...streams]) {
      try {
        writeSSE(entry.controller, event.kind || "terminal_event", event);
      } catch {
        streams.delete(entry);
      }
    }
  }

  requireTerminalSession(userID, terminalSessionID) {
    const session = this.terminalSessions.get(terminalSessionID);
    if (!session || session.user_id !== userID) throw new Error("terminal session not found");
    return session;
  }

  persistTerminalState() {
    if (!this.terminalStorage) return Promise.resolve();
    const state = {
      sessions: [...this.terminalSessions.values()],
      history: Object.fromEntries([...this.terminalHistory.entries()]),
    };
    this.terminalPersistChain = this.terminalPersistChain
      .catch(() => undefined)
      .then(() => this.terminalStorage.save(state))
      .catch(() => undefined);
    return this.terminalPersistChain;
  }

  clearPending(requestID) {
    const pending = this.pending.get(requestID);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestID);
  }

  deliverPending(responseType, payload) {
    if (!payload?.request_id) return;
    const pending = this.pending.get(payload.request_id);
    if (!pending || pending.responseType !== responseType) return;
    this.clearPending(payload.request_id);
    pending.resolve(payload);
  }

  deliverInjectEvent(payload, userID) {
    if (!payload) return;
    this.deliverStream(payload);
    if (payload.turn) this.broadcastTurn(payload.turn, userID);
    this.emitNotificationForInjectEvent(payload, userID);
  }

  deliverStream(payload) {
    if (!payload?.request_id) return;
    const entry = this.streams.get(payload.request_id);
    if (!entry) return;
    this.writeSSE(entry.controller, entry.eventName, payload);
    if (entry.closeWhen(payload)) this.closeStream(payload.request_id);
  }

  broadcastTurn(turn, userID, options = {}) {
    if (!options.skipDistributedSink) this.distributedSink?.onTurn?.(turn, userID);
    const key = subscriptionKey(userID, turn.device_id, turn.session_id);
    for (const socket of this.browserSockets.values()) {
      if (!socket.subscriptions.has(key)) continue;
      try {
        socket.ws.send(JSON.stringify({ type: "TURN", turn }));
      } catch {
        this.browserSockets.delete(socket.ws);
      }
    }
  }

  deliverDaemonStatus(deviceID, status) {
    const daemon = this.daemons.get(deviceID);
    if (!daemon) return;
    this.broadcastHostStatus({
      userID: daemon.userID,
      deviceID,
      presence_status: status.presence_status || status.status || "online",
      presence_reason: status.presence_reason || "daemon_status",
      control_connected: true,
      app_version: status.app_version || status.version || "",
      message: status.message || "",
    });
  }

  broadcastHostStatus(status, options = {}) {
    if (!options.skipDistributedSink) this.distributedSink?.onHostStatus?.(status);
    const payload = {
      type: "HOST_STATUS",
      device_id: status.deviceID,
      presence_status: status.presence_status,
      presence_reason: status.presence_reason,
      control_connected: Boolean(status.control_connected),
      ...(status.app_version ? { app_version: status.app_version } : {}),
      ...(status.message ? { message: status.message } : {}),
    };
    for (const socket of this.browserSockets.values()) {
      if (socket.userID !== status.userID) continue;
      try {
        socket.ws.send(JSON.stringify(payload));
      } catch {
        this.browserSockets.delete(socket.ws);
      }
    }
  }

  failStreamsForDaemon(daemonDeviceID, reason) {
    for (const [requestID, stream] of [...this.streams.entries()]) {
      if (stream.daemonDeviceID !== daemonDeviceID) continue;
      this.writeSSE(stream.controller, stream.eventName, { request_id: requestID, type: "inject_failed", error: reason });
      this.closeStream(requestID);
    }
  }

  closeStream(requestID, closeController = true) {
    const entry = this.streams.get(requestID);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.streams.delete(requestID);
    if (closeController) {
      try {
        entry.controller.close();
      } catch {
        // Stream may already be closed by the browser.
      }
    }
  }

  writeSSE(controller, eventName, payload) {
    writeSSE(controller, eventName, payload);
  }

  emitNotificationForInjectEvent(payload, userID) {
    if (!userID) return;
    const turnNotification = notificationFromTurn(payload.turn);
    if (turnNotification) {
      const requestID = turnNotification.requestID || payload.request_id || "";
      this.emitNotification(userID, turnNotification.notification, `inject:permission:${requestID || turnDedupID(payload.turn)}`);
      return;
    }
    const type = String(payload.type || payload.status || "");
    if (type !== "inject_completed" && type !== "inject_failed" && type !== "agent_error") return;
    const sessionID = payload.session_id || payload.turn?.session_id || "";
    const deviceID = payload.device_id || payload.turn?.device_id || "";
    const failed = type === "inject_failed" || type === "agent_error";
    this.emitNotification(userID, {
      title: failed ? "Pockly task failed" : "Pockly task finished",
      summary: failed ? "A remote agent run failed. Open Pockly to inspect it." : "A remote agent run finished.",
      session_id: sessionID,
      device_id: deviceID,
      url: sessionURL(sessionID, deviceID),
    }, `inject:${type}:${payload.request_id || ""}:${deviceID}:${sessionID}`);
  }

  emitNotificationForTerminalEvent(event, session) {
    if (String(event.kind || "") !== "permission_request") return;
    const status = String(event.status || event.payload?.status || "pending");
    if (status && !["pending", "waiting", "requested"].includes(status)) return;
    const userID = event.user_id || session?.user_id || "";
    if (!userID) return;
    const sessionID = event.session_id || session?.session_id || "";
    const deviceID = event.daemon_device_id || session?.daemon_device_id || "";
    const requestID = event.request_id || event.permission_request_id || event.payload?.request_id || event.payload?.permission_request_id || "";
    this.emitNotification(userID, {
      title: "Pockly needs approval",
      summary: "An agent is waiting for a local approval decision.",
      session_id: sessionID,
      device_id: deviceID,
      url: sessionURL(sessionID, deviceID),
    }, `terminal:permission:${requestID || `${event.terminal_session_id}:${event.timestamp || ""}`}`);
  }

  emitNotification(userID, notification, dedupKey) {
    if (!this.notificationSink || !userID || !notification) return Promise.resolve();
    const now = Date.now();
    for (const [key, timestamp] of this.notificationDedup.entries()) {
      if (now - timestamp > 10 * 60_000) this.notificationDedup.delete(key);
    }
    const key = `${userID}:${dedupKey}`;
    if (this.notificationDedup.has(key)) return Promise.resolve();
    this.notificationDedup.set(key, now);
    this.notificationChain = this.notificationChain
      .catch(() => undefined)
      .then(() => this.notificationSink(userID, notification))
      .catch(() => undefined);
    return this.notificationChain;
  }
}

export function handleControlHubRequest(hub, request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "GET" && path === "/control/online") {
    return jsonControl(async () => ({ online: await hub.isDaemonOnline(url.searchParams.get("device_id") || "") }));
  }
  if (path === "/control/daemon-ws") {
    return hub.acceptDaemonWebSocket(request, {
      userID: requiredQuery(url, "user_id"),
      deviceID: requiredQuery(url, "device_id"),
    });
  }
  if (path === "/control/browser-ws") {
    return hub.acceptBrowserWebSocket(request, {
      userID: requiredQuery(url, "user_id"),
      deviceID: requiredQuery(url, "device_id"),
    });
  }
  if (request.method === "POST" && path === "/control/request-response") {
    return jsonControl(async () => {
      const body = await request.json();
      return {
        result: await hub.requestResponse(
          body.daemon_device_id,
          body.envelope,
          body.response_type,
          body.request_id,
          Number(body.timeout_ms || defaultRequestTimeoutMs),
        ),
      };
    });
  }
  if (request.method === "POST" && path === "/control/dispatch") {
    return jsonControl(async () => {
      const body = await request.json();
      await hub.dispatch(body.daemon_device_id, body.envelope);
      return { status: "queued" };
    });
  }
  const injectAction = path.match(/^\/control\/injects\/([^/]+)\/cancel$/);
  if (injectAction && request.method === "POST") {
    return jsonControl(async () => {
      const body = await request.json();
      return { result: await hub.cancelInject(requiredValue(body.user_id, "user_id"), decodeURIComponent(injectAction[1])) };
    });
  }
  if (request.method === "POST" && path === "/control/stream-request") {
    return jsonControl(async () => {
      const body = await request.json();
      const options = body.stream_kind === "sync"
        ? syncStreamOptions(body.session_id || "", body.daemon_device_id || "")
        : injectStreamOptions(body.session_id || "");
      options.userID = body.user_id || "";
      options.initialEvent = body.initial_event || options.initialEvent;
      return hub.streamRequest(body.daemon_device_id, body.envelope, body.request_id, options);
    }, true);
  }
  if (path === "/control/terminal-sessions" && request.method === "GET") {
    return jsonControl(async () => ({ terminal_sessions: await hub.listTerminalSessions(requiredQuery(url, "user_id")) }));
  }
  if (path === "/control/terminal-sessions" && request.method === "POST") {
    return jsonControl(async () => {
      const body = await request.json();
      return { terminal_session: await hub.createTerminalSession(body) };
    });
  }
  const terminalAction = path.match(/^\/control\/terminal-sessions\/([^/]+)\/(input|stop|open-terminal|stream)$/);
  if (terminalAction) {
    return handleTerminalControlRequest(hub, request, url, decodeURIComponent(terminalAction[1]), terminalAction[2]);
  }
  return errorResponse("not found", ErrorCode.NotFound, { status: 404 });
}

async function handleTerminalControlRequest(hub, request, url, terminalSessionID, action) {
  const userID = url.searchParams.get("user_id") || (request.method === "POST" ? (await request.clone().json()).user_id : "");
  if (action === "stream") return hub.streamTerminalSession(requiredValue(userID, "user_id"), terminalSessionID);
  if (request.method !== "POST") return errorResponse("method not allowed", ErrorCode.MethodNotAllowed, { status: 405, headers: { allow: "POST" } });
  const body = await request.json();
  switch (action) {
    case "input":
      await hub.sendTerminalInput(requiredValue(body.user_id, "user_id"), terminalSessionID, String(body.text || ""));
      return jsonResponse({ status: "queued" });
    case "stop":
      await hub.stopTerminalSession(requiredValue(body.user_id, "user_id"), terminalSessionID);
      return jsonResponse({ status: "queued" });
    case "open-terminal":
      await hub.openTerminalSession(requiredValue(body.user_id, "user_id"), terminalSessionID);
      return jsonResponse({ status: "queued" });
    default:
      return errorResponse("not found", ErrorCode.NotFound, { status: 404 });
  }
}

async function jsonControl(fn, passthroughResponse = false) {
  try {
    const value = await fn();
    if (passthroughResponse && value instanceof Response) return value;
    return jsonResponse(value);
  } catch (error) {
    return mapControlError(error);
  }
}

function subscriptionKey(userID, deviceID, sessionID) {
  return `${userID}\x00${deviceID}\x00${sessionID}`;
}

function notificationFromTurn(turn) {
  if (!turn) return null;
  const payload = parsePayload(turn.payload);
  if (payload?.attachment_type !== "permission_request") return null;
  const status = String(payload.status || "pending");
  if (status && !["pending", "waiting", "requested"].includes(status)) return null;
  const sessionID = turn.session_id || payload.session_id || "";
  const deviceID = turn.device_id || payload.device_id || "";
  const requestID = payload.permission_request_id || payload.request_id || "";
  return {
    requestID,
    notification: {
      title: "Pockly needs approval",
      summary: "An agent is waiting for a local approval decision.",
      session_id: sessionID,
      device_id: deviceID,
      url: sessionURL(sessionID, deviceID),
    },
  };
}

function parsePayload(payload) {
  if (!payload) return {};
  if (typeof payload === "object") return payload;
  try {
    return JSON.parse(String(payload));
  } catch {
    return {};
  }
}

function turnDedupID(turn) {
  if (!turn) return "";
  return `${turn.device_id || ""}:${turn.session_id || ""}:${turn.seq || ""}:${turn.timestamp || ""}`;
}

function sessionURL(sessionID, deviceID) {
  if (!sessionID || !deviceID) return "/workspace/sessions";
  return `/workspace/s/${encodeURIComponent(sessionID)}?device_id=${encodeURIComponent(deviceID)}`;
}

function writeSSE(controller, eventName, payload) {
  const data = JSON.stringify(payload);
  controller.enqueue(new TextEncoder().encode(`event: ${eventName}\ndata: ${data}\n\n`));
}

function socketAddListener(socket, eventName, listener) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(eventName, listener);
    return;
  }
  if (typeof socket.on === "function") {
    socket.on(eventName, listener);
    return;
  }
  throw new Error("unsupported websocket implementation");
}

function socketMessageData(event) {
  if (event && typeof event === "object" && "data" in event) return event.data;
  return event;
}

function socketSend(socket, message) {
  socket.send(message);
}

function socketClose(socket, code, reason) {
  if (typeof socket.close === "function") socket.close(code, reason);
}

function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    return fn(...args);
  };
}

function randomID(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

async function responseErrorText(response) {
  try {
    const body = await response.json();
    return body.error || `${response.status} ${response.statusText}`.trim();
  } catch {
    return (await response.text()) || `${response.status} ${response.statusText}`.trim();
  }
}

function requiredQuery(url, name) {
  return requiredValue(url.searchParams.get(name), name);
}

function requiredValue(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} required`);
  return value.trim();
}

export function injectStreamOptions(sessionID) {
  return {
    timeoutMs: injectTimeoutMs,
    eventName: "inject_event",
    initialEvent: undefined,
    timeoutEvent: (requestID) => ({ request_id: requestID, type: "inject_failed", session_id: sessionID, error: "inject stream timed out" }),
    errorEvent: (requestID, error) => ({ request_id: requestID, type: "inject_failed", session_id: sessionID, error }),
    closeWhen: (event) => ["inject_completed", "inject_failed", "inject_cancelled"].includes(event.type),
  };
}

export function syncStreamOptions(sessionID, deviceID) {
  return {
    timeoutMs: syncTimeoutMs,
    eventName: "sync_session_event",
    initialEvent: { request_id: "", session_id: sessionID, device_id: deviceID, stage: "queued", status: "running", message: "Queued" },
    timeoutEvent: (requestID) => ({ request_id: requestID, session_id: sessionID, device_id: deviceID, stage: "failed", status: "failed", error: "sync stream timed out" }),
    errorEvent: (requestID, error) => ({ request_id: requestID, session_id: sessionID, device_id: deviceID, stage: "failed", status: "failed", error }),
    closeWhen: (event) => event.status === "completed" || event.status === "failed" || event.stage === "completed" || event.stage === "failed",
  };
}

export function mapControlError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "daemon offline") {
    return errorResponse("daemon offline", ErrorCode.DaemonOffline, { status: 503 });
  }
  if (message === "request_id required") {
    return errorResponse(message, ErrorCode.BadRequest, { status: 400 });
  }
  return errorResponse(message, ErrorCode.ServiceUnavailable, { status: 503 });
}

export function okControlResponse(payload) {
  return jsonResponse(payload);
}
