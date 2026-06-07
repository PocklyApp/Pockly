/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import http from "node:http";
import { STATUS_CODES } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { WebSocketServer } from "ws";
import { authorizeNexusWebSocket, handleRequest } from "../app.js";
import { InMemoryControlHub, createControlHubForUser } from "../control.js";
import { createLocalBlobStore } from "./blob-store.js";
import { createPostgresNexusStore } from "./postgres-store.js";
import { createRedisControlHub } from "./redis-control-hub.js";
import { createS3BlobStore } from "./s3-store.js";
import { createSQLiteNexusStore, defaultNexusDataDir } from "./sqlite-store.js";

export async function serveNodeNexus(options = {}) {
  const host = options.host || "127.0.0.1";
  const port = Number.isFinite(options.port) ? options.port : 8787;
  const dataDir = options.dataDir || options.env?.POCKLY_NEXUS_DATA_DIR || defaultNexusDataDir();
  const { store, ownsStore } = await createNodeNexusStore(options, dataDir);
  const controlHub = await createNodeControlHub(options);
  const releases = createNodeReleaseBlobStore(options, dataDir);
  const env = {
    ...options.env,
    POCKLY_NEXUS_RUNTIME: options.env?.POCKLY_NEXUS_RUNTIME || "self_hosted",
    POCKLY_NEXUS_DATA_DIR: dataDir,
    POCKLY_NEXUS_STORE: options.env?.POCKLY_NEXUS_STORE || store,
    POCKLY_CONTROL_HUB: controlHub,
    REALTIME_ENABLED: options.env?.REALTIME_ENABLED || "1",
    TERMINAL_ENABLED: options.env?.TERMINAL_ENABLED || "1",
    RELEASE_UPDATE_ENABLED: options.env?.RELEASE_UPDATE_ENABLED || "1",
    RELEASES: options.env?.RELEASES || releases,
  };
  const server = http.createServer((req, res) => {
    void handleNodeRequest(req, res, env);
  });
  const wsServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    void handleNodeWebSocketUpgrade(req, socket, head, env, wsServer);
  });
  server.once("close", () => {
    for (const client of wsServer.clients) client.close(1001, "server closing");
    wsServer.close();
  });
  if (ownsStore && typeof store.close === "function") {
    server.once("close", () => {
      store.close();
    });
  }
  if (typeof controlHub.close === "function") {
    server.once("close", () => {
      void controlHub.close();
    });
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(`pockly-nexus listening on http://${host}:${server.address().port}`);
  return server;
}

async function createNodeControlHub(options) {
  if (options.controlHub) return options.controlHub;
  if (options.env?.POCKLY_CONTROL_HUB) return options.env.POCKLY_CONTROL_HUB;
  const redisURL = options.redisURL || options.env?.POCKLY_NEXUS_REDIS_URL || options.env?.REDIS_URL || process.env.POCKLY_NEXUS_REDIS_URL || process.env.REDIS_URL || "";
  if (!redisURL) return new InMemoryControlHub();
  return await createRedisControlHub({
    redisURL,
    keyPrefix: options.redisKeyPrefix || options.env?.POCKLY_NEXUS_REDIS_PREFIX,
  });
}

function createNodeReleaseBlobStore(options, dataDir) {
  if (options.releases) return options.releases;
  if (options.env?.RELEASES) return options.env.RELEASES;
  const bucket = options.s3Bucket || options.env?.POCKLY_NEXUS_S3_BUCKET || options.env?.S3_BUCKET || process.env.POCKLY_NEXUS_S3_BUCKET || process.env.S3_BUCKET || "";
  if (bucket) {
    return createS3BlobStore({
      bucket,
      region: options.s3Region || options.env?.POCKLY_NEXUS_S3_REGION,
      endpoint: options.s3Endpoint || options.env?.POCKLY_NEXUS_S3_ENDPOINT,
      prefix: options.s3Prefix ?? options.env?.POCKLY_NEXUS_S3_PREFIX,
      forcePathStyle: options.s3ForcePathStyle ?? options.env?.POCKLY_NEXUS_S3_FORCE_PATH_STYLE,
    });
  }
  return createLocalBlobStore(options.releasesDir || path.join(dataDir, "releases"));
}

async function createNodeNexusStore(options, dataDir) {
  if (options.store) return { store: options.store, ownsStore: false };
  if (options.env?.POCKLY_NEXUS_STORE) return { store: options.env.POCKLY_NEXUS_STORE, ownsStore: false };
  const databaseURL = options.databaseURL || options.env?.POCKLY_NEXUS_DATABASE_URL || options.env?.DATABASE_URL || process.env.POCKLY_NEXUS_DATABASE_URL || process.env.DATABASE_URL || "";
  if (databaseURL) {
    return {
      store: await createPostgresNexusStore({
        connectionString: databaseURL,
        ssl: options.postgresSSL ?? options.env?.POCKLY_NEXUS_POSTGRES_SSL,
        maxConnections: options.postgresMaxConnections ?? options.env?.POCKLY_NEXUS_POSTGRES_MAX_CONNECTIONS,
      }),
      ownsStore: true,
    };
  }
  return {
    store: createSQLiteNexusStore({ dataDir, databasePath: options.databasePath }),
    ownsStore: true,
  };
}

async function handleNodeWebSocketUpgrade(req, socket, head, env, wsServer) {
  try {
    const request = toWebRequest(req);
    const authorization = await authorizeNexusWebSocket(request, env);
    if (!authorization.ok) {
      await rejectUpgrade(socket, authorization.response);
      return;
    }
    const control = createControlHubForUser(env, authorization.userID);
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      if (authorization.endpoint === "daemon") {
        control.attachDaemonWebSocketConnection({
          userID: authorization.userID,
          deviceID: authorization.deviceID,
          socket: ws,
        });
      } else {
        control.attachBrowserWebSocketConnection({
          userID: authorization.userID,
          deviceID: authorization.deviceID,
          socket: ws,
        });
      }
    });
  } catch (error) {
    await rejectUpgrade(socket, new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "internal error",
      code: "internal_error",
    }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
  }
}

export async function handleNodeRequest(req, res, env) {
  try {
    const request = toWebRequest(req);
    const response = await handleRequest(request, env, {});
    await writeNodeResponse(res, response);
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "internal error", code: "internal_error" }));
  }
}

async function rejectUpgrade(socket, response) {
  const status = response?.status || 500;
  const body = response ? await response.text() : JSON.stringify({ error: "websocket upgrade failed", code: "internal_error" });
  const contentType = response?.headers?.get("content-type") || "application/json; charset=utf-8";
  socket.write([
    `HTTP/1.1 ${status} ${STATUS_CODES[status] || "Error"}`,
    `Content-Type: ${contentType}`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n"));
  socket.destroy();
}

function toWebRequest(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || "127.0.0.1";
  const url = `${proto}://${host}${req.url || "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const init = { method: req.method || "GET", headers };
  if (!["GET", "HEAD"].includes(init.method)) {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeNodeResponse(res, response) {
  res.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) {
    res.setHeader(key, value);
  }
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } finally {
    reader.releaseLock();
  }
}
