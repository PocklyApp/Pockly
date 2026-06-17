/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createLocalBlobStore } from "../src/node/blob-store.js";
import { createSQLiteNexusStore } from "../src/node/sqlite-store.js";

describe("Node self-hosted Nexus storage adapters", () => {
  it("persists Nexus metadata in SQLite across store instances", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-sqlite-"));
    const databasePath = path.join(dir, "nexus.sqlite");

    const first = createSQLiteNexusStore({ databasePath });
    await first.upsertUser({
      user_id: "usr_sqlite",
      email: "sqlite@example.local",
      name: "SQLite User",
      created_at: "2026-06-06T00:00:00Z",
      updated_at: "2026-06-06T00:00:00Z",
    });
    first.close();

    const second = createSQLiteNexusStore({ databasePath });
    try {
      assert.deepEqual(await second.getUserByEmail("sqlite@example.local"), {
        user_id: "usr_sqlite",
        email: "sqlite@example.local",
        name: "SQLite User",
        password_hash: null,
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
      });
    } finally {
      second.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("rate-limits SQL device touch writes", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-touch-"));
    const databasePath = path.join(dir, "nexus.sqlite");
    const store = createSQLiteNexusStore({ databasePath });
    try {
      await store.upsertUser({
        user_id: "usr_touch",
        email: "touch@example.local",
        name: "Touch User",
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
      });
      await store.upsertDevice({
        device_id: "dd_touch",
        user_id: "usr_touch",
        device_type: "daemon",
        device_name: "daemon",
        public_key: "pub",
        status: "active",
        remote_access_enabled: true,
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
        last_seen_at: "2026-06-06T00:00:00Z",
      });

      await store.touchDevice("dd_touch", "2026-06-06T00:00:30Z");
      assert.equal((await store.getDevice("dd_touch")).last_seen_at, "2026-06-06T00:00:00Z");

      await store.touchDevice("dd_touch", "2026-06-06T00:01:00Z");
      assert.equal((await store.getDevice("dd_touch")).last_seen_at, "2026-06-06T00:01:00Z");
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("supersedes SQL daemon devices and migrates session state", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-supersede-"));
    const databasePath = path.join(dir, "nexus.sqlite");
    const store = createSQLiteNexusStore({ databasePath });
    try {
      await store.upsertUser({
        user_id: "usr_supersede",
        email: "supersede@example.local",
        name: "Supersede User",
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
      });
      await store.upsertComputer({
        computer_id: "dc_old",
        user_id: "usr_supersede",
        display_name: "Old computer",
        status: "active",
        current_daemon_device_id: "dd_old",
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
      });
      await store.upsertComputer({
        computer_id: "dc_new",
        user_id: "usr_supersede",
        display_name: "New computer",
        status: "active",
        current_daemon_device_id: "dd_new",
        created_at: "2026-06-06T00:01:00Z",
        updated_at: "2026-06-06T00:01:00Z",
      });
      await store.upsertDevice({
        device_id: "dd_old",
        user_id: "usr_supersede",
        computer_id: "dc_old",
        device_type: "daemon",
        device_name: "Old daemon",
        public_key: "old-pub",
        status: "active",
        remote_access_enabled: true,
        machine_fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
      });
      await store.upsertDevice({
        device_id: "dd_new",
        user_id: "usr_supersede",
        computer_id: "dc_new",
        device_type: "daemon",
        device_name: "New daemon",
        public_key: "new-pub",
        status: "active",
        remote_access_enabled: true,
        machine_fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        created_at: "2026-06-06T00:01:00Z",
        updated_at: "2026-06-06T00:01:00Z",
      });
      await store.upsertDevice({
        device_id: "bd_1",
        user_id: "usr_supersede",
        device_type: "browser",
        device_name: "Browser",
        public_key: "browser-pub",
        status: "active",
        remote_access_enabled: false,
        created_at: "2026-06-06T00:00:01Z",
        updated_at: "2026-06-06T00:00:01Z",
      });
      await store.upsertSession({
        user_id: "usr_supersede",
        computer_id: "dc_old",
        device_id: "dd_old",
        session_id: "sess_move",
        agent: "claude-code",
        cwd: "/work/move",
        snippet: "move",
        last_seq: 1,
        last_timestamp: "2026-06-06T00:00:01Z",
        turn_count: 1,
        synced_turn_count: 1,
        synced_min_seq: 1,
        synced_max_seq: 1,
        updated_at: "2026-06-06T00:00:01Z",
      });
      await store.upsertSession({
        user_id: "usr_supersede",
        computer_id: "dc_old",
        device_id: "dd_old",
        session_id: "sess_conflict",
        agent: "claude-code",
        cwd: "/work/conflict",
        snippet: "old conflict",
        last_seq: 1,
        last_timestamp: "2026-06-06T00:00:01Z",
        turn_count: 1,
        synced_turn_count: 1,
        synced_min_seq: 1,
        synced_max_seq: 1,
        updated_at: "2026-06-06T00:00:01Z",
      });
      await store.upsertSession({
        user_id: "usr_supersede",
        computer_id: "dc_new",
        device_id: "dd_new",
        session_id: "sess_conflict",
        agent: "claude-code",
        cwd: "/work/conflict",
        snippet: "new conflict wins",
        last_seq: 1,
        last_timestamp: "2026-06-06T00:01:01Z",
        turn_count: 1,
        synced_turn_count: 1,
        synced_min_seq: 1,
        synced_max_seq: 1,
        updated_at: "2026-06-06T00:01:01Z",
      });
      await store.upsertTurn({
        user_id: "usr_supersede",
        device_id: "dd_old",
        session_id: "sess_move",
        seq: 1,
        agent: "claude-code",
        kind: "user_message",
        timestamp: "2026-06-06T00:00:01Z",
        payload: JSON.stringify({ text: "move" }),
        updated_at: "2026-06-06T00:00:01Z",
      });
      await store.upsertTurn({
        user_id: "usr_supersede",
        device_id: "dd_old",
        session_id: "sess_conflict",
        seq: 1,
        agent: "claude-code",
        kind: "user_message",
        timestamp: "2026-06-06T00:00:01Z",
        payload: JSON.stringify({ text: "old conflict turn" }),
        updated_at: "2026-06-06T00:00:01Z",
      });
      await store.upsertTurn({
        user_id: "usr_supersede",
        device_id: "dd_new",
        session_id: "sess_conflict",
        seq: 1,
        agent: "claude-code",
        kind: "user_message",
        timestamp: "2026-06-06T00:01:01Z",
        payload: JSON.stringify({ text: "new conflict turn" }),
        updated_at: "2026-06-06T00:01:01Z",
      });
      await store.upsertSessionPref({
        user_id: "usr_supersede",
        device_id: "dd_old",
        session_id: "sess_move",
        pinned: 1,
        updated_at: "2026-06-06T00:00:01Z",
      });
      await store.upsertProjectPref({
        user_id: "usr_supersede",
        device_id: "dd_old",
        cwd: "/work/move",
        pinned: 1,
        updated_at: "2026-06-06T00:00:01Z",
      });
      await store.upsertDeviceBinding({
        user_id: "usr_supersede",
        daemon_device_id: "dd_old",
        browser_device_id: "bd_1",
        status: "active",
        created_at: "2026-06-06T00:00:01Z",
        updated_at: "2026-06-06T00:00:01Z",
      });

      const result = await store.supersedeDaemonDevice("usr_supersede", "dd_old", "dd_new", "2026-06-06T00:02:00Z");
      assert.equal(result.superseded, true);
      assert.equal(result.deleted_sessions.length, 2);
      assert.equal(result.upserted_sessions.length, 1);
      assert.equal((await store.getDevice("dd_old")).superseded_by_device_id, "dd_new");
      assert.equal((await store.getDevice("dd_old")).status, "offline");
      assert.equal((await store.getSession("usr_supersede", "dd_old", "sess_move")), null);
      assert.equal((await store.getSession("usr_supersede", "dd_new", "sess_move")).computer_id, "dc_new");
      assert.equal((await store.listTurns("usr_supersede", "dd_new", "sess_move")).length, 1);
      const conflictTurns = await store.listTurns("usr_supersede", "dd_new", "sess_conflict");
      assert.equal(conflictTurns.length, 1);
      assert.equal(JSON.parse(conflictTurns[0].payload).text, "new conflict turn");
      assert.equal((await store.listSessionPrefsForDevice("usr_supersede", "dd_new")).length, 1);
      assert.equal((await store.listProjectPrefsForUser("usr_supersede")).find((pref) => pref.device_id === "dd_new")?.cwd, "/work/move");
      assert.equal((await store.getDeviceBinding("usr_supersede", "dd_new", "bd_1"))?.status, "active");
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports SQL history storage usage without double-counting batched blobs", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-history-usage-"));
    const databasePath = path.join(dir, "nexus.sqlite");
    const store = createSQLiteNexusStore({ databasePath });
    try {
      await store.upsertUser({
        user_id: "usr_history_usage",
        email: "history-usage@example.local",
        name: "History Usage User",
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
      });

      const inlinePayload = JSON.stringify({ text: "small" });
      const unicodeInlinePayload = JSON.stringify({ text: "你好" });
      const singleBlobPointer = JSON.stringify({
        pockly_payload_ref: "blob",
        key: "session-turns/usr_history_usage/dd_history/sess_a/000001.json.gz",
        bytes: 8192,
        encoded_bytes: 1024,
      });
      const batchBlobPointer = JSON.stringify({
        pockly_payload_ref: "blob_batch",
        key: "session-turn-batches/usr_history_usage/dd_history/sess_a/000002-000003.json.gz",
        bytes: 16384,
        encoded_bytes: 2048,
      });

      await store.upsertTurns([
        {
          user_id: "usr_history_usage",
          device_id: "dd_history",
          session_id: "sess_a",
          seq: 1,
          agent: "claude-code",
          kind: "user_message",
          timestamp: "2026-06-06T00:00:00Z",
          payload: inlinePayload,
          updated_at: "2026-06-06T00:00:00Z",
        },
        {
          user_id: "usr_history_usage",
          device_id: "dd_history",
          session_id: "sess_a",
          seq: 5,
          agent: "claude-code",
          kind: "user_message",
          timestamp: "2026-06-06T00:00:04Z",
          payload: unicodeInlinePayload,
          updated_at: "2026-06-06T00:00:04Z",
        },
        {
          user_id: "usr_history_usage",
          device_id: "dd_history",
          session_id: "sess_a",
          seq: 2,
          agent: "claude-code",
          kind: "assistant_text",
          timestamp: "2026-06-06T00:00:01Z",
          payload: singleBlobPointer,
          updated_at: "2026-06-06T00:00:01Z",
        },
        {
          user_id: "usr_history_usage",
          device_id: "dd_history",
          session_id: "sess_a",
          seq: 3,
          agent: "claude-code",
          kind: "assistant_text",
          timestamp: "2026-06-06T00:00:02Z",
          payload: batchBlobPointer,
          updated_at: "2026-06-06T00:00:02Z",
        },
        {
          user_id: "usr_history_usage",
          device_id: "dd_history",
          session_id: "sess_a",
          seq: 4,
          agent: "claude-code",
          kind: "assistant_text",
          timestamp: "2026-06-06T00:00:03Z",
          payload: batchBlobPointer,
          updated_at: "2026-06-06T00:00:03Z",
        },
      ]);

      const preparedSQL = [];
      const originalPrepare = store.db.prepare.bind(store.db);
      store.db.prepare = (sql) => {
        preparedSQL.push(sql);
        return originalPrepare(sql);
      };
      const usage = await store.getHistoryStorageUsage("usr_history_usage", {
        device_id: "dd_history",
        session_id: "sess_a",
      });
      assert.equal(usage.turn_count, 5);
      assert.equal(usage.inline_turn_count, 2);
      assert.equal(usage.blob_turn_count, 1);
      assert.equal(usage.blob_batch_turn_count, 2);
      assert.equal(usage.archived_payload_bytes, 8192 + 16384 + 16384);
      assert.equal(usage.archived_encoded_bytes, 1024 + 2048);
      assert.equal(usage.archived_object_count, 2);
      assert.equal(usage.primary_payload_bytes, Buffer.byteLength(inlinePayload) + Buffer.byteLength(unicodeInlinePayload) + Buffer.byteLength(singleBlobPointer) + (2 * Buffer.byteLength(batchBlobPointer)));
      assert.deepEqual(Object.keys(usage.sessions), ["sess_a"]);
      assert.equal(usage.sessions.sess_a.archived_object_count, 2);
      assert.equal(usage.sessions.sess_a.archived_encoded_bytes, 1024 + 2048);
      assert.ok(preparedSQL.some((sql) => sql.includes("COUNT(*) AS turn_count")));
      assert.ok(preparedSQL.some((sql) => sql.includes("payload LIKE")));
      assert.equal(preparedSQL.some((sql) => sql.includes("SELECT user_id, device_id, session_id, seq, payload")), false);
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("lists SQL turn payload pointers without loading full turn rows", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-payload-pointers-"));
    const databasePath = path.join(dir, "nexus.sqlite");
    const store = createSQLiteNexusStore({ databasePath });
    try {
      await store.upsertUser({
        user_id: "usr_payload_pointers",
        email: "payload-pointers@example.local",
        name: "Payload Pointers User",
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
      });
      await store.upsertTurns([
        {
          user_id: "usr_payload_pointers",
          device_id: "dd_payload_pointers",
          session_id: "sess_a",
          seq: 1,
          agent: "claude-code",
          kind: "assistant_text",
          timestamp: "2026-06-06T00:00:01Z",
          payload: JSON.stringify({ text: "a" }),
          updated_at: "2026-06-06T00:00:01Z",
        },
        {
          user_id: "usr_payload_pointers",
          device_id: "dd_payload_pointers",
          session_id: "sess_b",
          seq: 1,
          agent: "claude-code",
          kind: "assistant_text",
          timestamp: "2026-06-06T00:00:02Z",
          payload: JSON.stringify({ text: "b" }),
          updated_at: "2026-06-06T00:00:02Z",
        },
      ]);

      const pointers = await store.listTurnPayloadPointers("usr_payload_pointers", "dd_payload_pointers", ["sess_b"]);
      assert.deepEqual(pointers, [{
        session_id: "sess_b",
        seq: 1,
        agent: "claude-code",
        kind: "assistant_text",
        timestamp: "2026-06-06T00:00:02Z",
        payload: JSON.stringify({ text: "b" }),
      }]);
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("prunes SQL hot turn cache by session, user, and inactivity TTL", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-hot-cache-"));
    const databasePath = path.join(dir, "nexus.sqlite");
    const store = createSQLiteNexusStore({ databasePath });
    try {
      const userID = "usr_hot_cache";
      const deviceID = "dd_hot_cache";
      await store.upsertUser({
        user_id: userID,
        email: "hot-cache@example.local",
        name: "Hot Cache User",
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
      });
      await store.upsertDevice({
        device_id: deviceID,
        user_id: userID,
        device_type: "daemon",
        device_name: "daemon",
        public_key: "pub",
        status: "active",
        remote_access_enabled: true,
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
        last_seen_at: "2026-06-06T00:00:00Z",
      });
      await upsertSQLSession(store, userID, deviceID, "sess_old", "2026-06-06T00:00:00Z", 5);
      await upsertSQLSession(store, userID, deviceID, "sess_new", "2026-06-06T00:10:00Z", 5);
      await store.upsertTurns([
        ...sqlTurns(userID, deviceID, "sess_old", 5, "2026-06-06T00:00"),
        ...sqlTurns(userID, deviceID, "sess_new", 5, "2026-06-06T00:10"),
      ]);

      const perSessionAffected = await store.pruneHotTurnCache({
        perSession: 3,
        perUser: 20,
        userIDs: [userID],
        sessionKeys: [`${userID}\x00${deviceID}\x00sess_old`],
      });
      assert.deepEqual(perSessionAffected.map((session) => session.session_id), ["sess_old"]);
      assert.deepEqual((await store.listTurns(userID, deviceID, "sess_old", { limit: 20 })).map((turn) => turn.seq), [3, 4, 5]);
      assert.deepEqual((await store.listTurns(userID, deviceID, "sess_new", { limit: 20 })).map((turn) => turn.seq), [1, 2, 3, 4, 5]);

      const perUserAffected = await store.pruneHotTurnCache({ perSession: 10, perUser: 4, userIDs: [userID] });
      assert.deepEqual(perUserAffected.map((session) => session.session_id).sort(), ["sess_new", "sess_old"]);
      assert.deepEqual((await store.listTurns(userID, deviceID, "sess_new", { limit: 20 })).map((turn) => turn.seq), [2, 3, 4, 5]);
      assert.deepEqual((await store.listTurns(userID, deviceID, "sess_old", { limit: 20 })), []);

      const inactiveAffected = await store.pruneHotTurnCache({ inactiveBefore: "2026-06-06T00:05:00Z", userIDs: [userID] });
      assert.deepEqual(inactiveAffected.map((session) => session.session_id), []);
      assert.deepEqual(await store.listTurns(userID, deviceID, "sess_old", { limit: 20 }), []);
      assert.equal((await store.getSession(userID, deviceID, "sess_old")).session_id, "sess_old");
      assert.deepEqual((await store.listTurns(userID, deviceID, "sess_new", { limit: 20 })).map((turn) => turn.seq), [2, 3, 4, 5]);
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("caps SQL session event cache to the newest 500 rows per session", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-events-cap-"));
    const databasePath = path.join(dir, "nexus.sqlite");
    const store = createSQLiteNexusStore({ databasePath });
    try {
      const userID = "usr_event_cap";
      await store.upsertUser({
        user_id: userID,
        email: "event-cap@example.local",
        name: "Event Cap User",
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
      });

      for (let index = 1; index <= 5005; index += 1) {
        await store.appendSessionEvent({
          event_id: `ev_${String(index).padStart(8, "0")}`,
          user_id: userID,
          device_id: "dd_event_cap",
          session_id: "sess_event_cap",
          request_id: "inj_event_cap",
          event_type: "inject_completed",
          payload: JSON.stringify({ index }),
          created_at: `2026-06-06T00:${String(index % 60).padStart(2, "0")}:00Z`,
        });
      }
      await store.pruneSessionEvents(userID);

      const firstPage = await store.listSessionEvents(userID, "dd_event_cap", "sess_event_cap", { limit: 10 });
      assert.equal(firstPage.length, 10);
      assert.equal(firstPage[0].event_id, "ev_00004506");
      assert.equal(firstPage.at(-1).event_id, "ev_00004515");

      const count = await store.db.prepare(`SELECT COUNT(*) AS count FROM session_events WHERE user_id = ?`).bind(userID).first();
      assert.equal(count.count, 500);
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("persists batched SQL session events through the SQLite adapter", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-events-batch-"));
    const databasePath = path.join(dir, "nexus.sqlite");
    const store = createSQLiteNexusStore({ databasePath });
    try {
      const userID = "usr_event_batch";
      await store.upsertUser({
        user_id: userID,
        email: "event-batch@example.local",
        name: "Event Batch User",
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
      });

      const saved = await store.appendSessionEvents([
        {
          event_id: "ev_batch_0002",
          user_id: userID,
          device_id: "dd_event_batch",
          session_id: "sess_event_batch",
          request_id: "inj_event_batch",
          event_type: "inject_delta",
          payload: { index: 2 },
          created_at: "2026-06-06T00:00:02Z",
        },
        {
          event_id: "ev_batch_0001",
          user_id: userID,
          device_id: "dd_event_batch",
          session_id: "sess_event_batch",
          request_id: "inj_event_batch",
          event_type: "inject_started",
          payload: JSON.stringify({ index: 1 }),
          created_at: "2026-06-06T00:00:01Z",
        },
      ]);

      assert.deepEqual(saved.map((event) => event.event_id), ["ev_batch_0002", "ev_batch_0001"]);
      assert.equal(saved[0].payload, JSON.stringify({ index: 2 }));
      const events = await store.listSessionEvents(userID, "dd_event_batch", "sess_event_batch", { limit: 10 });
      assert.deepEqual(events.map((event) => event.event_id), ["ev_batch_0001", "ev_batch_0002"]);
      assert.deepEqual(events.map((event) => JSON.parse(event.payload).index), [1, 2]);
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("caps SQL session event cache to the newest 5000 rows per user", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-events-user-cap-"));
    const databasePath = path.join(dir, "nexus.sqlite");
    const store = createSQLiteNexusStore({ databasePath });
    try {
      const userID = "usr_event_user_cap";
      await store.upsertUser({
        user_id: userID,
        email: "event-user-cap@example.local",
        name: "Event User Cap",
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
      });

      for (let sessionIndex = 1; sessionIndex <= 11; sessionIndex += 1) {
        const sessionID = `sess_event_user_cap_${String(sessionIndex).padStart(2, "0")}`;
        for (let index = 1; index <= 500; index += 1) {
          const globalIndex = (sessionIndex - 1) * 500 + index;
          await store.appendSessionEvent({
            event_id: `ev_${String(globalIndex).padStart(8, "0")}`,
            user_id: userID,
            device_id: "dd_event_user_cap",
            session_id: sessionID,
            request_id: `inj_event_user_cap_${sessionIndex}`,
            event_type: "inject_completed",
            payload: JSON.stringify({ globalIndex }),
            created_at: `2026-06-06T00:${String(globalIndex % 60).padStart(2, "0")}:00Z`,
          });
        }
      }
      await store.pruneSessionEvents(userID);

      const count = await store.db.prepare(`SELECT COUNT(*) AS count FROM session_events WHERE user_id = ?`).bind(userID).first();
      assert.equal(count.count, 5000);
      const oldest = await store.db.prepare(`SELECT MIN(event_id) AS event_id FROM session_events WHERE user_id = ?`).bind(userID).first();
      assert.equal(oldest.event_id, "ev_00000501");
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("uses bounded SQL windows for large session catalog and turn reads", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-large-window-"));
    const databasePath = path.join(dir, "nexus.sqlite");
    const store = createSQLiteNexusStore({ databasePath });
    const preparedSQL = [];
    try {
      const userID = "usr_large_window";
      const deviceID = "dd_large_window";
      await store.upsertUser({
        user_id: userID,
        email: "large-window@example.local",
        name: "Large Window User",
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
      });
      await store.upsertDevice({
        device_id: deviceID,
        user_id: userID,
        device_type: "daemon",
        device_name: "daemon",
        public_key: "pub",
        status: "active",
        remote_access_enabled: true,
        created_at: "2026-06-06T00:00:00Z",
        updated_at: "2026-06-06T00:00:00Z",
        last_seen_at: "2026-06-06T00:00:00Z",
      });
      for (let index = 0; index < 550; index += 1) {
        await upsertSQLSession(
          store,
          userID,
          deviceID,
          `sess_catalog_${String(index).padStart(3, "0")}`,
          `2026-06-06T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
          1,
        );
      }
      await upsertSQLSession(store, userID, deviceID, "sess_large_turns", "2026-06-07T00:00:00Z", 10_000);
      for (let start = 1; start <= 10_000; start += 250) {
        await store.upsertTurns(sqlTurnsRange(userID, deviceID, "sess_large_turns", start, Math.min(start + 249, 10_000), "2026-06-07T00"));
      }

      const originalPrepare = store.db.prepare.bind(store.db);
      store.db.prepare = (sql) => {
        preparedSQL.push(sql.replace(/\s+/g, " ").trim());
        return originalPrepare(sql);
      };

      const firstPage = await store.listSessionCatalogPage(userID, { limit: 101 });
      assert.equal(firstPage.length, 101);
      const tailWindow = await store.listTurns(userID, deviceID, "sess_large_turns", { limit: 20 });
      assert.deepEqual(tailWindow.map((turn) => turn.seq), Array.from({ length: 20 }, (_, index) => 9981 + index));
      const afterWindow = await store.listSessionTurnsAfter(userID, deviceID, "sess_large_turns", 9_990, 20);
      assert.deepEqual(afterWindow.map((turn) => turn.seq), Array.from({ length: 10 }, (_, index) => 9991 + index));

      assert.ok(preparedSQL.some((sql) => /FROM sessions WHERE user_id = \? ORDER BY updated_at DESC, device_id ASC, session_id ASC LIMIT \?/.test(sql)));
      assert.ok(preparedSQL.some((sql) => /ORDER BY seq DESC LIMIT \?/.test(sql)));
      assert.ok(preparedSQL.some((sql) => /session_id = \? AND seq > \? ORDER BY seq ASC LIMIT \?/.test(sql)));
      assert.equal(preparedSQL.some((sql) => /SELECT \* FROM session_turns WHERE user_id = \? AND device_id = \? AND session_id = \? ORDER BY seq ASC$/.test(sql)), false);
    } finally {
      store.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("serves local filesystem blobs through the object-store get/text contract", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-blobs-"));
    try {
      const blobs = createLocalBlobStore(dir);
      await blobs.put("pockly-daemon/latest/checksums.txt", "abc  pockly-daemon_v0.1.0_linux_amd64.tar.gz\n");
      const object = await blobs.get("pockly-daemon/latest/checksums.txt");
      assert.equal(await object.text(), "abc  pockly-daemon_v0.1.0_linux_amd64.tar.gz\n");
      await assert.rejects(() => blobs.put("../escape", "bad"), /invalid blob key/);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});

async function upsertSQLSession(store, userID, deviceID, sessionID, timestamp, turnCount) {
  await store.upsertSession({
    user_id: userID,
    computer_id: "cmp_hot_cache",
    device_id: deviceID,
    session_id: sessionID,
    agent: "claude-code",
    runner_alias: "",
    cwd: "/work/app",
    snippet: sessionID,
    first_message: "",
    title: "",
    last_seq: turnCount,
    last_timestamp: timestamp,
    channel_last_seen_at: timestamp,
    sync_state: "partial",
    turn_count: turnCount,
    last_sync_error: "",
    synced_turn_count: turnCount,
    synced_min_seq: 1,
    synced_max_seq: turnCount,
    has_older_turns: false,
    updated_at: timestamp,
  });
}

function sqlTurns(userID, deviceID, sessionID, count, minutePrefix) {
  return sqlTurnsRange(userID, deviceID, sessionID, 1, count, minutePrefix);
}

function sqlTurnsRange(userID, deviceID, sessionID, startSeq, endSeq, minutePrefix) {
  return Array.from({ length: endSeq - startSeq + 1 }, (_, index) => {
    const seq = startSeq + index;
    const timestamp = `${minutePrefix}:${String(index).padStart(2, "0")}Z`;
    return {
      user_id: userID,
      device_id: deviceID,
      session_id: sessionID,
      seq,
      agent: "claude-code",
      kind: "assistant_text",
      timestamp,
      payload: JSON.stringify({ text: `${sessionID} ${seq}` }),
      updated_at: timestamp,
    };
  });
}
