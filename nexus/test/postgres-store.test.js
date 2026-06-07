/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPostgresNexusStore, translateSQLPlaceholders } from "../src/node/postgres-store.js";

describe("Node production Postgres Nexus store adapter", () => {
  it("translates positional parameters without touching quoted literals", () => {
    assert.equal(
      translateSQLPlaceholders(`SELECT '?' AS literal, "?" AS ident WHERE a = ? AND b = '?' AND c = ?`),
      `SELECT '?' AS literal, "?" AS ident WHERE a = $1 AND b = '?' AND c = $2`,
    );
  });

  it("applies migrations, reuses SQLNexusStore methods, and closes the pg client", async () => {
    const client = new FakePostgresClient();
    const store = await createPostgresNexusStore({
      client,
      connectionString: "postgres://user:secret@nexus.example/pockly",
    });

    assert.equal(client.queries[0].sql.includes("CREATE TABLE IF NOT EXISTS users"), true);
    assert.equal(store.databaseURL, "postgres://redacted:redacted@nexus.example/pockly");

    const user = await store.upsertUser({
      user_id: "usr_pg",
      email: "pg@example.local",
      name: "Postgres User",
      created_at: "2026-06-06T00:00:00Z",
      updated_at: "2026-06-06T00:00:00Z",
    });
    assert.deepEqual(user, {
      user_id: "usr_pg",
      email: "pg@example.local",
      name: "Postgres User",
      password_hash: null,
      created_at: "2026-06-06T00:00:00Z",
      updated_at: "2026-06-06T00:00:00Z",
    });
    assert.equal(client.queries.some((query) => query.sql.includes("VALUES ($1, $2, $3, $4, $5, $6)")), true);

    await store.close();
    assert.equal(client.closed, true);
  });
});

class FakePostgresClient {
  constructor() {
    this.queries = [];
    this.usersByEmail = new Map();
    this.closed = false;
  }

  async query(sql, values = []) {
    this.queries.push({ sql, values });
    if (sql.includes("CREATE TABLE IF NOT EXISTS")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO users")) {
      const [user_id, email, name, password_hash, created_at, updated_at] = values;
      this.usersByEmail.set(email, { user_id, email, name, password_hash, created_at, updated_at });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT * FROM users WHERE email")) {
      const row = this.usersByEmail.get(values[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  async end() {
    this.closed = true;
  }
}
