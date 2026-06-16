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

  it("allows replaying session add-column migrations", async () => {
    const client = new FakePostgresClient({ duplicateSessionAddColumns: true });
    const store = await createPostgresNexusStore({ client });
    assert.equal(
      client.queries.some((query) => query.sql.includes("ALTER TABLE sessions ADD COLUMN synced_window_hash")),
      true,
    );
    assert.equal(
      client.queries.some((query) => query.sql.includes("ALTER TABLE sessions ADD COLUMN actual_turn_count")),
      true,
    );
    await store.close();
  });

  it("uses a lightweight session sync snapshot query", async () => {
    const client = new FakePostgresClient();
    const store = await createPostgresNexusStore({
      client,
      migrate: false,
    });

    const rows = await store.listDeviceSessionSyncSnapshots("usr_pg", "dd_pg");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, "sess_pg");
    const query = client.queries.at(-1);
    assert.match(query.sql, /SELECT\s+user_id, computer_id, device_id, session_id, agent/i);
    assert.doesNotMatch(query.sql, /SELECT\s+\*/i);
    assert.deepEqual(query.values, ["usr_pg", "dd_pg"]);
  });

  it("uses a lightweight session hint snapshot query", async () => {
    const client = new FakePostgresClient();
    const store = await createPostgresNexusStore({
      client,
      migrate: false,
    });

    const rows = await store.listDeviceSessionHintSnapshots("usr_pg", "dd_pg");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, "sess_pg");
    const query = client.queries.at(-1);
    assert.match(query.sql, /SELECT\s+user_id, device_id, session_id, turn_count/i);
    assert.doesNotMatch(query.sql, /SELECT\s+\*/i);
    assert.doesNotMatch(query.sql, /first_message/i);
    assert.doesNotMatch(query.sql, /snippet/i);
    assert.deepEqual(query.values, ["usr_pg", "dd_pg"]);
  });

  it("persists batched session events through translated Postgres statements", async () => {
    const client = new FakePostgresClient();
    const store = await createPostgresNexusStore({
      client,
      migrate: false,
    });

    const saved = await store.appendSessionEvents([
      {
        event_id: "ev_pg_batch_0001",
        user_id: "usr_pg",
        device_id: "dd_pg",
        session_id: "sess_pg",
        request_id: "inj_pg",
        event_type: "inject_started",
        payload: { phase: "start" },
        created_at: "2026-06-06T00:00:01Z",
      },
      {
        event_id: "ev_pg_batch_0002",
        user_id: "usr_pg",
        device_id: "dd_pg",
        session_id: "sess_pg",
        request_id: "inj_pg",
        event_type: "inject_completed",
        payload: JSON.stringify({ phase: "done" }),
        created_at: "2026-06-06T00:00:02Z",
      },
    ]);

    assert.deepEqual(saved.map((event) => event.payload), [
      JSON.stringify({ phase: "start" }),
      JSON.stringify({ phase: "done" }),
    ]);
    const inserts = client.queries.filter((query) => query.sql.includes("INSERT INTO session_events"));
    assert.equal(inserts.length, 2);
    assert.equal(inserts[0].sql.includes("VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"), true);
    assert.deepEqual(inserts.map((query) => query.values[0]), ["ev_pg_batch_0001", "ev_pg_batch_0002"]);
    assert.deepEqual(inserts.map((query) => query.values[6]), [
      JSON.stringify({ phase: "start" }),
      JSON.stringify({ phase: "done" }),
    ]);
  });
});

class FakePostgresClient {
  constructor(options = {}) {
    this.queries = [];
    this.usersByEmail = new Map();
    this.closed = false;
    this.duplicateSessionAddColumns = Boolean(options.duplicateSessionAddColumns);
  }

  async query(sql, values = []) {
    this.queries.push({ sql, values });
    if (this.duplicateSessionAddColumns && sql.includes("ALTER TABLE sessions ADD COLUMN")) {
      const column = sql.match(/ADD COLUMN\s+(\w+)/i)?.[1] || "unknown";
      const error = new Error(`column "${column}" of relation "sessions" already exists`);
      error.code = "42701";
      throw error;
    }
    if (sql.includes("CREATE TABLE IF NOT EXISTS") || sql.includes("CREATE INDEX IF NOT EXISTS") || sql.includes("ALTER TABLE sessions ADD COLUMN")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO users")) {
      const [user_id, email, name, password_hash, created_at, updated_at] = values;
      this.usersByEmail.set(email, { user_id, email, name, password_hash, created_at, updated_at });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT * FROM users WHERE email")) {
      const row = this.usersByEmail.get(values[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO session_events")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM session_events")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM sessions") && sql.includes("session_id") && !sql.includes("SELECT *")) {
      return {
        rows: [{
          user_id: values[0],
          computer_id: null,
          device_id: values[1],
          session_id: "sess_pg",
          agent: "claude-code",
          runner_alias: null,
          cwd: "/workspace",
          snippet: "hello",
          first_message: "hello",
          title: null,
          last_seq: 1,
          last_timestamp: "2026-06-06T00:00:00Z",
          channel_last_seen_at: "2026-06-06T00:00:00Z",
          sync_state: "catalog_only",
          turn_count: 1,
          last_sync_error: null,
          synced_turn_count: 0,
          synced_min_seq: 0,
          synced_max_seq: 0,
          synced_window_hash: "",
          has_older_turns: 0,
          updated_at: "2026-06-06T00:00:00Z",
        }],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  async end() {
    this.closed = true;
  }
}
