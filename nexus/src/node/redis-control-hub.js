/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import { InMemoryControlHub, injectStreamOptions, syncStreamOptions } from "../control.js";
import { ErrorCode, errorResponse } from "../contract.js";

const defaultOwnerTTLSeconds = 60;
const defaultRequestTimeoutMs = 30_000;

export async function createRedisControlHub(options = {}) {
  const redisURL = options.redisURL || options.env?.POCKLY_NEXUS_REDIS_URL || options.env?.REDIS_URL || process.env.POCKLY_NEXUS_REDIS_URL || process.env.REDIS_URL || "";
  if (!redisURL && !options.commandClient) throw new Error("redis URL required");
  let commandClient = options.commandClient;
  let subscriberClient = options.subscriberClient;
  let ownsClients = false;
  let ownsSubscriberClient = false;
  if (!commandClient) {
    const { createClient } = await import("redis");
    commandClient = createClient({ url: redisURL });
    subscriberClient = commandClient.duplicate();
    await Promise.all([commandClient.connect(), subscriberClient.connect()]);
    ownsClients = true;
  } else if (!subscriberClient && typeof commandClient.duplicate === "function") {
    subscriberClient = commandClient.duplicate();
    if (typeof subscriberClient.connect === "function") await subscriberClient.connect();
    ownsSubscriberClient = true;
  }
  const hub = new RedisControlHub({
    ...options,
    commandClient,
    subscriberClient,
    ownsClients,
    ownsSubscriberClient,
  });
  await hub.start();
  return hub;
}

export class RedisControlHub {
  constructor(options = {}) {
    if (!options.commandClient) throw new Error("redis command client required");
    this.commandClient = options.commandClient;
    this.subscriberClient = options.subscriberClient || options.commandClient;
    this.ownsClients = Boolean(options.ownsClients);
    this.ownsSubscriberClient = Boolean(options.ownsSubscriberClient);
    this.nodeID = options.nodeID || randomUUID();
    this.keyPrefix = options.keyPrefix || "pockly:nexus";
    this.ownerTTLSeconds = Number(options.ownerTTLSeconds || defaultOwnerTTLSeconds);
    this.logger = options.logger || console;
    this.pendingRemote = new Map();
    this.remoteStreams = new Map();
    this.remoteStreamRoutes = new Map();
    this.localDaemonUsers = new Map();
    this.started = false;
    const localEventSink = options.eventSink || null;
    this.localHub = options.localHub || new InMemoryControlHub({
      terminalStorage: options.terminalStorage || null,
      notificationSink: options.notificationSink || null,
      eventSink: localEventSink,
      presenceResolver: async (deviceID) => this.resolvePresence(deviceID),
      distributedSink: {
        onDaemonEnvelope: (deviceID, envelope, userID) => {
          void this.routeDaemonEnvelope(deviceID, envelope, userID);
        },
        onTurn: (turn, userID) => {
          void this.publishEvent("turn", { userID, turn });
        },
        onHostStatus: (status) => {
          void this.handleLocalHostStatus(status);
        },
        onTerminalSession: (session) => {
          void this.publishEvent("terminal_session", { session });
        },
        onTerminalEvent: (event) => {
          void this.publishEvent("terminal_event", { event });
        },
      },
    });
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await Promise.all([
      subscribe(this.subscriberClient, this.nodeChannel(this.nodeID), (message) => {
        void this.handleNodeMessage(message);
      }),
      subscribe(this.subscriberClient, this.eventsChannel(), (message) => {
        void this.handleEventMessage(message);
      }),
    ]);
    this.ownerRefreshTimer = setInterval(() => {
      void this.refreshLocalOwners();
    }, Math.max(1, Math.floor(this.ownerTTLSeconds / 2)) * 1000);
    this.ownerRefreshTimer.unref?.();
  }

  setEventSink(eventSink) {
    this.eventSink = eventSink;
    if (this.localHub) this.localHub.eventSink = eventSink;
  }

  async close() {
    clearInterval(this.ownerRefreshTimer);
    for (const deviceID of this.localDaemonUsers.keys()) {
      await this.deleteOwnerIfCurrent(deviceID).catch(() => undefined);
    }
    if (this.ownsClients) {
      await Promise.all([
        closeRedisClient(this.subscriberClient),
        this.subscriberClient === this.commandClient ? Promise.resolve() : closeRedisClient(this.commandClient),
      ]);
    } else if (this.ownsSubscriberClient) {
      await closeRedisClient(this.subscriberClient);
    }
  }

  isDaemonOnline(deviceID) {
    if (this.localHub.isDaemonOnline(deviceID)) return true;
    return this.getOwner(deviceID).then((owner) => Boolean(owner?.nodeID));
  }

  async onlineDevices(deviceIDs = []) {
    const ids = uniqueStrings(deviceIDs);
    const online = {};
    const remoteIDs = [];
    for (const deviceID of ids) {
      if (this.localHub.isDaemonOnline(deviceID)) online[deviceID] = true;
      else remoteIDs.push(deviceID);
    }
    if (remoteIDs.length === 0) return online;
    const keys = remoteIDs.map((deviceID) => this.ownerKey(deviceID));
    let values;
    if (typeof this.commandClient.mGet === "function") values = await this.commandClient.mGet(keys);
    else if (typeof this.commandClient.mget === "function") values = await this.commandClient.mget(keys);
    else values = await Promise.all(keys.map((key) => this.commandClient.get(key)));
    for (let i = 0; i < remoteIDs.length; i += 1) {
      online[remoteIDs[i]] = Boolean(parseOwnerValue(values?.[i])?.nodeID);
    }
    return online;
  }

  acceptDaemonWebSocket(request, input) {
    return this.localHub.acceptDaemonWebSocket(request, input);
  }

  attachDaemonWebSocketConnection(input) {
    return this.localHub.attachDaemonWebSocketConnection(input);
  }

  attachDaemonForTest(deviceID, userID, handler) {
    return this.localHub.attachDaemonForTest(deviceID, userID, handler);
  }

  acceptBrowserWebSocket(request, input) {
    return this.localHub.acceptBrowserWebSocket(request, input);
  }

  attachBrowserWebSocketConnection(input) {
    return this.localHub.attachBrowserWebSocketConnection(input);
  }

  attachBrowserForTest(input) {
    return this.localHub.attachBrowserForTest(input);
  }

  async requestResponse(daemonDeviceID, envelope, responseType, requestID, timeoutMs = defaultRequestTimeoutMs) {
    if (this.localHub.isDaemonOnline(daemonDeviceID)) {
      return await this.localHub.requestResponse(daemonDeviceID, envelope, responseType, requestID, timeoutMs);
    }
    const owner = await this.requireOwner(daemonDeviceID);
    const commandID = randomID("rr");
    const waiter = this.waitForRemoteResult(commandID, timeoutMs);
    await this.publishNode(owner.nodeID, {
      kind: "request_response",
      command_id: commandID,
      origin_node_id: this.nodeID,
      daemon_device_id: daemonDeviceID,
      envelope,
      response_type: responseType,
      request_id: requestID,
      timeout_ms: timeoutMs,
    });
    return await waiter;
  }

  async dispatch(daemonDeviceID, envelope) {
    if (this.localHub.isDaemonOnline(daemonDeviceID)) {
      await this.localHub.dispatch(daemonDeviceID, envelope);
      return;
    }
    const owner = await this.requireOwner(daemonDeviceID);
    await this.publishNode(owner.nodeID, {
      kind: "dispatch",
      origin_node_id: this.nodeID,
      daemon_device_id: daemonDeviceID,
      envelope,
    });
  }

  async cancelInject(userID, requestID) {
    if (this.remoteStreams.has(requestID)) {
      const entry = this.remoteStreams.get(requestID);
      if (entry.userID && entry.userID !== userID) throw new Error("inject request not found");
      await this.dispatch(entry.daemonDeviceID, {
        type: "CANCEL_INJECT",
        cancel_inject: { request_id: requestID },
      });
      return { status: "queued", request_id: requestID };
    }
    return await this.localHub.cancelInject(userID, requestID);
  }

  streamRequest(daemonDeviceID, envelope, requestID, options) {
    if (!requestID) return errorResponse("request_id required", ErrorCode.BadRequest, { status: 400 });
    if (this.localHub.isDaemonOnline(daemonDeviceID)) {
      return this.localHub.streamRequest(daemonDeviceID, envelope, requestID, options);
    }
    return this.remoteStreamRequest(daemonDeviceID, envelope, requestID, options);
  }

  async createTerminalSession(session) {
    if (this.localHub.isDaemonOnline(session.daemon_device_id)) {
      return await this.localHub.createTerminalSession(session);
    }
    await this.requireOwner(session.daemon_device_id);
    const now = new Date().toISOString();
    const next = {
      ...session,
      session_status: "starting",
      turn_status: "idle",
      created_at: now,
      updated_at: now,
    };
    this.localHub.terminalSessions.set(next.terminal_session_id, next);
    this.localHub.terminalHistory.set(next.terminal_session_id, []);
    await this.localHub.persistTerminalState();
    await this.publishEvent("terminal_session", { session: next });
    await this.dispatch(session.daemon_device_id, {
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
    return this.localHub.listTerminalSessions(userID);
  }

  async sendTerminalInput(userID, terminalSessionID, text) {
    const session = this.localHub.requireTerminalSession(userID, terminalSessionID);
    if (this.localHub.isDaemonOnline(session.daemon_device_id)) {
      await this.localHub.sendTerminalInput(userID, terminalSessionID, text);
      return;
    }
    await this.dispatch(session.daemon_device_id, {
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
    await this.dispatchTerminalAction(userID, terminalSessionID, "TERMINAL_OPEN_TERMINAL");
  }

  async stopTerminalSession(userID, terminalSessionID) {
    await this.dispatchTerminalAction(userID, terminalSessionID, "TERMINAL_STOP");
  }

  streamTerminalSession(userID, terminalSessionID) {
    return this.localHub.streamTerminalSession(userID, terminalSessionID);
  }

  async subscribeTerminalSession(userID, terminalSessionID) {
    await this.dispatchTerminalAction(userID, terminalSessionID, "TERMINAL_SUBSCRIBE");
    return { status: "subscribed", terminal_session_id: terminalSessionID };
  }

  async unsubscribeTerminalSession(userID, terminalSessionID) {
    await this.dispatchTerminalAction(userID, terminalSessionID, "TERMINAL_UNSUBSCRIBE");
    return { status: "unsubscribed", terminal_session_id: terminalSessionID };
  }

  listTerminalEvents(userID, terminalSessionID, options = {}) {
    return this.localHub.listTerminalEvents(userID, terminalSessionID, options);
  }

  async dispatchTerminalAction(userID, terminalSessionID, type) {
    const session = this.localHub.requireTerminalSession(userID, terminalSessionID);
    if (this.localHub.isDaemonOnline(session.daemon_device_id)) {
      if (type === "TERMINAL_STOP") return await this.localHub.stopTerminalSession(userID, terminalSessionID);
      if (type === "TERMINAL_OPEN_TERMINAL") return await this.localHub.openTerminalSession(userID, terminalSessionID);
      if (type === "TERMINAL_SUBSCRIBE") return await this.localHub.subscribeTerminalSession(userID, terminalSessionID);
      if (type === "TERMINAL_UNSUBSCRIBE") return await this.localHub.unsubscribeTerminalSession(userID, terminalSessionID);
    }
    await this.dispatch(session.daemon_device_id, {
      type,
      terminal_request: {
        request_id: randomID("term"),
        terminal_session_id: terminalSessionID,
        daemon_device_id: session.daemon_device_id,
        browser_device_id: session.browser_device_id,
      },
    });
  }

  remoteStreamRequest(daemonDeviceID, envelope, requestID, options) {
    const encoder = new TextEncoder();
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
            this.closeRemoteStream(requestID);
          }, options.timeoutMs ?? defaultRequestTimeoutMs),
          encoder,
        };
        this.remoteStreams.set(requestID, entry);
        if (options.initialEvent) this.writeSSE(controller, entry.eventName, options.initialEvent);
        void this.requireOwner(daemonDeviceID)
          .then((owner) => this.publishNode(owner.nodeID, {
            kind: "stream_request",
            origin_node_id: this.nodeID,
            daemon_device_id: daemonDeviceID,
            envelope,
            request_id: requestID,
            stream_kind: entry.eventName === "sync_session_event" ? "sync" : "inject",
            user_id: entry.userID,
          }))
          .catch((error) => {
            this.writeSSE(controller, entry.eventName, options.errorEvent(requestID, error.message || "daemon send failed"));
            this.closeRemoteStream(requestID);
          });
      },
      cancel: () => {
        this.closeRemoteStream(requestID, false);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  async handleNodeMessage(raw) {
    const message = parseMessage(raw);
    if (!message || message.origin_node_id === this.nodeID) return;
    try {
      switch (message.kind) {
        case "request_response":
          return await this.handleRemoteRequestResponse(message);
        case "request_response_result":
          return this.resolveRemoteResult(message);
        case "dispatch":
          return await this.localHub.dispatch(message.daemon_device_id, message.envelope);
        case "stream_request":
          return await this.handleRemoteStreamRequest(message);
        case "stream_event":
          return this.deliverRemoteStreamEvent(message);
        default:
          return;
      }
    } catch (error) {
      if (message.kind === "request_response" && message.command_id && message.origin_node_id) {
        await this.publishNode(message.origin_node_id, {
          kind: "request_response_result",
          command_id: message.command_id,
          origin_node_id: this.nodeID,
          error: error instanceof Error ? error.message : "remote request failed",
        }).catch(() => undefined);
      }
    }
  }

  async handleEventMessage(raw) {
    const message = parseMessage(raw);
    if (!message || message.origin_node_id === this.nodeID) return;
    switch (message.kind) {
      case "turn":
        if (message.turn) this.localHub.broadcastTurn(message.turn, message.userID || "", { skipDistributedSink: true });
        return;
      case "host_status":
        if (message.status) this.localHub.broadcastHostStatus(message.status, { skipDistributedSink: true });
        return;
      case "terminal_session":
        return await this.applyRemoteTerminalSession(message.session);
      case "terminal_event":
        if (message.event) this.localHub.publishTerminalEvent(message.event, { skipDistributedSink: true });
        return;
      default:
        return;
    }
  }

  async handleRemoteRequestResponse(message) {
    const result = await this.localHub.requestResponse(
      message.daemon_device_id,
      message.envelope,
      message.response_type,
      message.request_id,
      Number(message.timeout_ms || defaultRequestTimeoutMs),
    );
    await this.publishNode(message.origin_node_id, {
      kind: "request_response_result",
      command_id: message.command_id,
      origin_node_id: this.nodeID,
      result,
    });
  }

  resolveRemoteResult(message) {
    const pending = this.pendingRemote.get(message.command_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRemote.delete(message.command_id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  async handleRemoteStreamRequest(message) {
    const options = message.stream_kind === "sync"
      ? syncStreamOptions(message.envelope?.sync_request?.session_id || "", message.daemon_device_id || "")
      : injectStreamOptions(message.envelope?.request?.session_id || "");
    this.remoteStreamRoutes.set(message.request_id, {
      originNodeID: message.origin_node_id,
      userID: message.user_id || "",
      eventName: options.eventName,
      closeWhen: options.closeWhen,
    });
    try {
      await this.localHub.dispatch(message.daemon_device_id, message.envelope);
    } catch (error) {
      await this.publishNode(message.origin_node_id, {
        kind: "stream_event",
        origin_node_id: this.nodeID,
        request_id: message.request_id,
        event_name: options.eventName,
        payload: options.errorEvent(message.request_id, error.message || "daemon send failed"),
      });
      this.remoteStreamRoutes.delete(message.request_id);
    }
  }

  deliverRemoteStreamEvent(message) {
    const entry = this.remoteStreams.get(message.request_id);
    if (!entry) return;
    this.writeSSE(entry.controller, message.event_name || entry.eventName, message.payload);
    if (entry.closeWhen(message.payload)) this.closeRemoteStream(message.request_id);
  }

  async routeDaemonEnvelope(deviceID, envelope, userID) {
    const routed = streamPayloadFromEnvelope(envelope);
    if (routed?.requestID) {
      const route = this.remoteStreamRoutes.get(routed.requestID);
      if (route) {
        await this.publishNode(route.originNodeID, {
          kind: "stream_event",
          origin_node_id: this.nodeID,
          request_id: routed.requestID,
          event_name: route.eventName,
          payload: routed.payload,
        }).catch(() => undefined);
        if (route.closeWhen(routed.payload)) this.remoteStreamRoutes.delete(routed.requestID);
      }
    }
  }

  async handleLocalHostStatus(status) {
    if (!status?.deviceID) return;
    if (status.control_connected) {
      this.localDaemonUsers.set(status.deviceID, status.userID || "");
      await this.setOwner(status.deviceID, status.userID || "");
    } else {
      this.localDaemonUsers.delete(status.deviceID);
      await this.deleteOwnerIfCurrent(status.deviceID);
    }
    await this.publishEvent("host_status", { status });
  }

  async refreshLocalOwners() {
    for (const [deviceID, userID] of this.localDaemonUsers.entries()) {
      if (this.localHub.isDaemonOnline(deviceID)) await this.setOwner(deviceID, userID).catch(() => undefined);
    }
  }

  async resolvePresence(deviceID) {
    const online = await this.isDaemonOnline(deviceID);
    return {
      online,
      presence_status: online ? "online" : "offline",
      presence_reason: online ? "control_connected" : "control_disconnected",
      control_connected: online,
    };
  }

  async applyRemoteTerminalSession(session) {
    if (!session?.terminal_session_id) return;
    this.localHub.terminalSessions.set(session.terminal_session_id, session);
    if (!this.localHub.terminalHistory.has(session.terminal_session_id)) this.localHub.terminalHistory.set(session.terminal_session_id, []);
    await this.localHub.persistTerminalState();
  }

  waitForRemoteResult(commandID, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRemote.delete(commandID);
        reject(new Error("daemon ack timeout"));
      }, timeoutMs);
      this.pendingRemote.set(commandID, { resolve, reject, timer });
    });
  }

  closeRemoteStream(requestID, closeController = true) {
    const entry = this.remoteStreams.get(requestID);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.remoteStreams.delete(requestID);
    if (closeController) {
      try {
        entry.controller.close();
      } catch {
        // Browser may have already closed the stream.
      }
    }
  }

  writeSSE(controller, eventName, payload) {
    controller.enqueue(new TextEncoder().encode(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`));
  }

  async requireOwner(deviceID) {
    const owner = await this.getOwner(deviceID);
    if (!owner?.nodeID) throw new Error("daemon offline");
    return owner;
  }

  async getOwner(deviceID) {
    const value = await this.commandClient.get(this.ownerKey(deviceID));
    return parseOwnerValue(value);
  }

  async setOwner(deviceID, userID) {
    await this.commandClient.set(this.ownerKey(deviceID), JSON.stringify({
      node_id: this.nodeID,
      user_id: userID || "",
      updated_at: new Date().toISOString(),
    }), { EX: this.ownerTTLSeconds });
  }

  async deleteOwnerIfCurrent(deviceID) {
    const owner = await this.getOwner(deviceID);
    if (owner?.nodeID === this.nodeID) await this.commandClient.del(this.ownerKey(deviceID));
  }

  async publishNode(nodeID, message) {
    const delivered = await this.commandClient.publish(this.nodeChannel(nodeID), JSON.stringify(message));
    if (typeof delivered === "number" && delivered === 0) throw new Error("daemon offline");
  }

  async publishEvent(kind, payload) {
    await this.commandClient.publish(this.eventsChannel(), JSON.stringify({
      kind,
      origin_node_id: this.nodeID,
      ...payload,
    })).catch((error) => {
      this.logger?.warn?.(`nexus redis control event publish failed: ${error.message || error}`);
    });
  }

  ownerKey(deviceID) {
    return `${this.keyPrefix}:daemon:${deviceID}`;
  }

  nodeChannel(nodeID) {
    return `${this.keyPrefix}:node:${nodeID}`;
  }

  eventsChannel() {
    return `${this.keyPrefix}:events`;
  }
}

function streamPayloadFromEnvelope(envelope) {
  const type = envelope?.type || envelope?.Type || "";
  if (type === "INJECT_EVENT") {
    const payload = envelope.event || envelope.Event;
    if (payload?.request_id) return { requestID: payload.request_id, payload };
  }
  if (type === "SYNC_SESSION_EVENT") {
    const payload = envelope.sync_event || envelope.SyncEvent;
    if (payload?.request_id) return { requestID: payload.request_id, payload };
  }
  return null;
}

async function subscribe(client, channel, listener) {
  if (!client?.subscribe) throw new Error("redis subscriber client required");
  await client.subscribe(channel, listener);
}

async function closeRedisClient(client) {
  if (!client) return;
  if (typeof client.quit === "function") return await client.quit();
  if (typeof client.disconnect === "function") return client.disconnect();
}

function parseMessage(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function parseOwnerValue(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return { nodeID: parsed.node_id || parsed.nodeID || "", userID: parsed.user_id || parsed.userID || "" };
  } catch {
    return { nodeID: String(value), userID: "" };
  }
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const next = String(value || "");
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

function randomID(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}
