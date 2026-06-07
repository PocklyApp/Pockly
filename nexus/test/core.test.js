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
      clock,
    });

    assert.equal(requireNexusProvider(bundle, "store"), store);
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
      terminal: true,
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
});
