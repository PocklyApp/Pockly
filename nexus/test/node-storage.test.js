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

      const usage = await store.getHistoryStorageUsage("usr_history_usage", {
        device_id: "dd_history",
        session_id: "sess_a",
      });
      assert.equal(usage.turn_count, 4);
      assert.equal(usage.inline_turn_count, 1);
      assert.equal(usage.blob_turn_count, 1);
      assert.equal(usage.blob_batch_turn_count, 2);
      assert.equal(usage.archived_payload_bytes, 8192 + 16384 + 16384);
      assert.equal(usage.archived_encoded_bytes, 1024 + 2048);
      assert.equal(usage.archived_object_count, 2);
      assert.equal(usage.primary_payload_bytes, Buffer.byteLength(inlinePayload) + Buffer.byteLength(singleBlobPointer) + (2 * Buffer.byteLength(batchBlobPointer)));
      assert.deepEqual(Object.keys(usage.sessions), ["sess_a"]);
      assert.equal(usage.sessions.sess_a.archived_object_count, 2);
      assert.equal(usage.sessions.sess_a.archived_encoded_bytes, 1024 + 2048);
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
