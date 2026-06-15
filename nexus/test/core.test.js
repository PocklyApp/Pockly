/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleRequest } from "../src/app.js";
import { InMemoryControlHub } from "../src/control.js";
import { createNexusProviderBundle, requireNexusProvider } from "../src/core/providers.js";
import { InMemoryNexusStore } from "../src/store.js";

describe("Nexus core provider bundle", () => {
  it("keeps platform dependencies injected and immutable", () => {
    const store = { kind: "memory" };
    const clock = { now: () => new Date("2026-06-06T00:00:00Z"), isoNow: () => "2026-06-06T00:00:00.000Z" };
    const bundle = createNexusProviderBundle({
      store,
      controlHub: { kind: "in-process" },
      blobStore: { kind: "local-fs" },
      historyBlobStore: { kind: "history-fs" },
      clock,
    });

    assert.equal(requireNexusProvider(bundle, "store"), store);
    assert.equal(bundle.historyBlobStore.kind, "history-fs");
    assert.equal(bundle.clock.isoNow(), "2026-06-06T00:00:00.000Z");
    assert.equal(bundle.sttProvider, null);
    assert.throws(() => {
      bundle.store = null;
    }, /Cannot assign to read only property|read only/);
  });

  it("fails explicitly when a required provider is missing", () => {
    const bundle = createNexusProviderBundle();
    assert.throws(() => requireNexusProvider(bundle, "store"), /nexus provider required: store/);
  });

  it("lets the app core run from injected providers instead of platform env bindings", async () => {
    const store = new InMemoryNexusStore();
    const controlHub = new InMemoryControlHub();
    const blobStore = { get: async () => null };
    const providers = createNexusProviderBundle({ store, controlHub, blobStore });

    const runtime = await handleRequest(new Request("https://nexus.test/api/runtime"), {
      REALTIME_ENABLED: "1",
      TERMINAL_ENABLED: "1",
      RELEASE_UPDATE_ENABLED: "1",
    }, { providers });
    assert.deepEqual(await runtime.json(), {
      runtime: "self_hosted",
      realtime: true,
      browser_realtime: true,
      browser_realtime_control: false,
      control_streaming: true,
      terminal: true,
      terminal_streaming: true,
      web_push: false,
      stt: false,
      release_update: true,
      contract_version: "1",
    });

    const login = await handleRequest(new Request("https://nexus.test/api/dev/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "provider@example.local", name: "Provider User" }),
    }), { POCKLY_NEXUS_DEV_LOGIN_ENABLED: "1" }, { providers });
    assert.equal(login.status, 200);
    assert.equal((await store.getUserByEmail("provider@example.local")).name, "Provider User");
  });

  it("caps in-memory session events per session and per user", async () => {
    const store = new InMemoryNexusStore();
    const userID = "usr_memory_events";
    for (let sessionIndex = 1; sessionIndex <= 11; sessionIndex += 1) {
      const sessionID = `sess_memory_${String(sessionIndex).padStart(2, "0")}`;
      for (let index = 1; index <= 501; index += 1) {
        const globalIndex = (sessionIndex - 1) * 501 + index;
        await store.appendSessionEvent({
          event_id: `ev_${String(globalIndex).padStart(8, "0")}`,
          user_id: userID,
          device_id: "dd_memory_events",
          session_id: sessionID,
          request_id: `inj_memory_${sessionIndex}`,
          event_type: "inject_completed",
          payload: JSON.stringify({ globalIndex }),
          created_at: "2026-06-06T00:00:00Z",
        });
      }
    }

    assert.equal(store.sessionEvents.filter((event) => event.user_id === userID).length, 5000);
    const firstSession = await store.listSessionEvents(userID, "dd_memory_events", "sess_memory_01", { limit: 600 });
    assert.equal(firstSession.length, 0);
    const lastSession = await store.listSessionEvents(userID, "dd_memory_events", "sess_memory_11", { limit: 600 });
    assert.equal(lastSession.length, 500);
    assert.equal(lastSession[0].event_id, "ev_00005012");
  });
});
