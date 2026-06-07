/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { SQLNexusStore } from "../store.js";

const migrationPath = fileURLToPath(new URL("../../migrations/0001_initial.sql", import.meta.url));

export async function createPostgresNexusStore(options = {}) {
  const client = options.client || new pg.Pool({
    connectionString: options.connectionString || process.env.POCKLY_NEXUS_DATABASE_URL || process.env.DATABASE_URL,
    max: Number(options.maxConnections || process.env.POCKLY_NEXUS_POSTGRES_MAX_CONNECTIONS || 10),
    ssl: normalizeSSL(options.ssl ?? process.env.POCKLY_NEXUS_POSTGRES_SSL),
  });
  if (!client) throw new Error("Postgres client required");
  if (options.migrate !== false) await client.query(fs.readFileSync(migrationPath, "utf8"));
  const store = new SQLNexusStore(new PostgresStatementAdapter(client));
  store.databaseURL = redactDatabaseURL(options.connectionString || process.env.POCKLY_NEXUS_DATABASE_URL || process.env.DATABASE_URL || "");
  store.close = typeof client.end === "function" ? () => client.end() : () => Promise.resolve();
  return store;
}

export class PostgresStatementAdapter {
  constructor(client) {
    this.client = client;
  }

  prepare(sql) {
    return new PostgresStatement(this.client, translateSQLPlaceholders(sql));
  }
}

class PostgresStatement {
  constructor(client, sql, values = []) {
    this.client = client;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new PostgresStatement(this.client, this.sql, values);
  }

  async run() {
    const result = await this.client.query(this.sql, this.values);
    return {
      success: true,
      meta: {
        changes: result.rowCount ?? 0,
      },
    };
  }

  async first() {
    const result = await this.client.query(this.sql, this.values);
    return result.rows?.[0] ?? null;
  }

  async all() {
    const result = await this.client.query(this.sql, this.values);
    return {
      results: result.rows ?? [],
      success: true,
    };
  }
}

export function translateSQLPlaceholders(sql) {
  let index = 0;
  let out = "";
  let quote = "";
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1] || "";
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (next === quote) {
          out += next;
          i += 1;
        } else {
          quote = "";
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "?") {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += ch;
  }
  return out;
}

function normalizeSSL(value) {
  if (value === true || value === "1" || value === "true") return { rejectUnauthorized: true };
  if (value === "no-verify") return { rejectUnauthorized: false };
  return undefined;
}

function redactDatabaseURL(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.password) url.password = "redacted";
    if (url.username) url.username = "redacted";
    return url.toString();
  } catch {
    return "redacted";
  }
}
