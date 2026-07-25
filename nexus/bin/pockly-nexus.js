#!/usr/bin/env node
/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseArgs } from "node:util";
import { serveNodeNexus } from "../src/node/server.js";

const command = process.argv[2] || "help";

if (command === "serve") {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      help: { type: "boolean", short: "h", default: false },
      host: { type: "string", default: process.env.POCKLY_NEXUS_HOST || "127.0.0.1" },
      port: { type: "string", default: process.env.POCKLY_NEXUS_PORT || "8787" },
      "data-dir": { type: "string", default: process.env.POCKLY_NEXUS_DATA_DIR || "" },
      "sqlite-path": { type: "string", default: process.env.POCKLY_NEXUS_SQLITE_PATH || "" },
      "database-url": { type: "string", default: process.env.POCKLY_NEXUS_DATABASE_URL || process.env.DATABASE_URL || "" },
      "postgres-ssl": { type: "string", default: process.env.POCKLY_NEXUS_POSTGRES_SSL || "" },
      "redis-url": { type: "string", default: process.env.POCKLY_NEXUS_REDIS_URL || process.env.REDIS_URL || "" },
      "redis-prefix": { type: "string", default: process.env.POCKLY_NEXUS_REDIS_PREFIX || "" },
      "s3-bucket": { type: "string", default: process.env.POCKLY_NEXUS_S3_BUCKET || process.env.S3_BUCKET || "" },
      "s3-endpoint": { type: "string", default: process.env.POCKLY_NEXUS_S3_ENDPOINT || process.env.S3_ENDPOINT || "" },
      "s3-region": { type: "string", default: process.env.POCKLY_NEXUS_S3_REGION || process.env.AWS_REGION || "" },
      "s3-prefix": { type: "string", default: process.env.POCKLY_NEXUS_S3_PREFIX || "" },
      "s3-force-path-style": { type: "string", default: process.env.POCKLY_NEXUS_S3_FORCE_PATH_STYLE || process.env.S3_FORCE_PATH_STYLE || "" },
    },
  });
  if (values.help) {
    printUsage();
    process.exit(0);
  }
  const server = await serveNodeNexus({
    host: values.host,
    port: Number.parseInt(values.port, 10),
    dataDir: values["data-dir"] || undefined,
    databasePath: values["sqlite-path"] || undefined,
    databaseURL: values["database-url"] || undefined,
    postgresSSL: values["postgres-ssl"] || undefined,
    redisURL: values["redis-url"] || undefined,
    redisKeyPrefix: values["redis-prefix"] || undefined,
    s3Bucket: values["s3-bucket"] || undefined,
    s3Endpoint: values["s3-endpoint"] || undefined,
    s3Region: values["s3-region"] || undefined,
    s3Prefix: values["s3-prefix"] || undefined,
    s3ForcePathStyle: values["s3-force-path-style"] || undefined,
    env: {
      ...process.env,
      POCKLY_NEXUS_RUNTIME: process.env.POCKLY_NEXUS_RUNTIME || "self_hosted",
      POCKLY_NEXUS_ENVIRONMENT: process.env.POCKLY_NEXUS_ENVIRONMENT || "self_hosted",
    },
  });
  process.on("SIGINT", () => server.close(() => process.exit(0)));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else {
  printUsage();
  process.exit(command === "help" || command === "--help" || command === "-h" ? 0 : 2);
}

function printUsage() {
  console.error(`Usage:
  pockly-nexus serve [--host 127.0.0.1] [--port 8787]
                     [--data-dir ~/.pockly/nexus]
                     [--sqlite-path ~/.pockly/nexus/nexus.sqlite]
                     [--database-url postgres://...]
                     [--postgres-ssl true|no-verify]
                     [--redis-url redis://...] [--redis-prefix pockly:nexus]
                     [--s3-bucket bucket] [--s3-endpoint https://...]
                     [--s3-region region] [--s3-prefix releases]

Legacy relay compatibility:
  POCKLY_RELAY_* environment variables remain supported as fallbacks.
  There are no legacy /api/relay/* request paths.`);
}
