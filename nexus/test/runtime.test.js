/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ErrorCode, nexusRuntimeCapabilities } from "../src/contract.js";
import { handleRequest } from "../src/app.js";

const base = "https://nexus-runtime.test";

describe("Nexus runtime contract", () => {
  it("returns neutral self-hosted runtime capabilities", async () => {
    const res = await handleRequest(new Request(`${base}/api/runtime`), {
      STT_ENABLED: "0",
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await res.json(), {
      runtime: "self_hosted",
      realtime: false,
      browser_realtime: false,
      control_streaming: true,
      terminal: false,
      terminal_streaming: false,
      web_push: false,
      stt: false,
      release_update: false,
      contract_version: "1",
    });
  });

  it("only advertises implemented capabilities when enabled", () => {
    assert.deepEqual(nexusRuntimeCapabilities({}), {
      runtime: "self_hosted",
      realtime: false,
      browser_realtime: false,
      control_streaming: true,
      terminal: false,
      terminal_streaming: false,
      web_push: false,
      stt: false,
      release_update: false,
      contract_version: "1",
    });
    assert.equal(nexusRuntimeCapabilities({ REALTIME_ENABLED: "1" }).realtime, false);
    assert.equal(nexusRuntimeCapabilities({ TERMINAL_ENABLED: "1" }).terminal, false);
    assert.equal(nexusRuntimeCapabilities({ POCKLY_CONTROL_HUB: {}, REALTIME_ENABLED: "1" }).realtime, true);
    assert.equal(nexusRuntimeCapabilities({ POCKLY_CONTROL_HUB: {}, TERMINAL_ENABLED: "1" }).terminal, true);
    assert.equal(nexusRuntimeCapabilities({ WEB_PUSH_ENABLED: "1", VAPID_PUBLIC_KEY: "B".repeat(88) }).web_push, false);
    assert.deepEqual(
      nexusRuntimeCapabilities({
        POCKLY_CONTROL_HUB: {},
        REALTIME_ENABLED: "1",
        TERMINAL_ENABLED: "true",
        WEB_PUSH_ENABLED: "1",
        VAPID_PUBLIC_KEY: "B".repeat(88),
        VAPID_PRIVATE_KEY: "C".repeat(43),
        STT_ENABLED: "1",
        VOICE_TRANSCRIPTION_ENDPOINT: "https://voice.example/transcribe",
        RELEASE_UPDATE_ENABLED: "true",
        RELEASES: {},
      }),
      {
        runtime: "self_hosted",
        realtime: true,
        browser_realtime: true,
        control_streaming: true,
        terminal: true,
        terminal_streaming: true,
        web_push: true,
        stt: true,
        release_update: true,
        contract_version: "1",
      },
    );
  });

  it("reports STT only when explicitly enabled", () => {
    assert.equal(nexusRuntimeCapabilities({ STT_ENABLED: "0" }).stt, false);
    assert.equal(nexusRuntimeCapabilities({ STT_ENABLED: "1" }).stt, false);
    assert.equal(nexusRuntimeCapabilities({ STT_ENABLED: "true", POCKLY_STT_PROVIDER: {} }).stt, true);
    assert.equal(nexusRuntimeCapabilities({ STT_ENABLED: "true", VOICE_TRANSCRIPTION_ENDPOINT: "https://voice.example/transcribe" }).stt, true);
  });

  it("accepts telemetry as a self-hosted provider hook and drops it by default", async () => {
    const res = await handleRequest(new Request(`${base}/api/telemetry/web`, {
      method: "POST",
      body: JSON.stringify({
        events: [{ name: "web_sse_disconnected", prompt: "must-not-store" }],
      }),
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const calls = [];
    const withProvider = await handleRequest(new Request(`${base}/api/telemetry/daemon`, {
      method: "POST",
      body: JSON.stringify({
        install_id: "pti_test",
        events: [{ name: "sync_failed", status: "error" }],
      }),
    }), {}, {
      providers: {
        telemetryProvider: {
          record: async ({ text, request }) => calls.push({ text, pathname: new URL(request.url).pathname }),
        },
      },
    });
    assert.equal(withProvider.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, "/api/telemetry/daemon");
  });

  it("does not treat environment variables as telemetry provider wiring", async () => {
    const calls = [];
    const res = await handleRequest(new Request(`${base}/api/telemetry/web`, {
      method: "POST",
      body: JSON.stringify({ events: [{ name: "web_bootstrap" }] }),
    }), {
      UNUSED_TELEMETRY_PROVIDER: {
        record: async () => calls.push("legacy-env-provider"),
      },
      POCKLY_NEXUS_PROVIDERS: {
        telemetryProvider: {
          record: async () => calls.push("env-provider-bundle"),
        },
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(calls, []);
  });

  it("reports provider-backed Web Push only when a public key and sender are available", () => {
    assert.equal(nexusRuntimeCapabilities({ WEB_PUSH_ENABLED: "1", POCKLY_PUSH_PROVIDER: { publicKey: "provider-public-key" } }).web_push, false);
    assert.equal(nexusRuntimeCapabilities({ WEB_PUSH_ENABLED: "1", POCKLY_PUSH_PROVIDER: { send: async () => ({ ok: true }) } }).web_push, false);
    assert.equal(nexusRuntimeCapabilities({
      WEB_PUSH_ENABLED: "1",
      POCKLY_PUSH_PROVIDER: {
        publicKey: "provider-public-key",
        send: async () => ({ ok: true }),
      },
    }).web_push, true);
  });

  it("ignores deployment environment names in the public runtime contract", () => {
    assert.deepEqual(nexusRuntimeCapabilities({}, { runtime: "self_hosted" }), {
      runtime: "self_hosted",
      realtime: false,
      browser_realtime: false,
      control_streaming: true,
      terminal: false,
      terminal_streaming: false,
      web_push: false,
      stt: false,
      release_update: false,
      contract_version: "1",
    });
    assert.deepEqual(nexusRuntimeCapabilities({ POCKLY_RELAY_ENVIRONMENT: "legacy-a", POCKLY_NEXUS_ENVIRONMENT: "legacy-b" }), {
      runtime: "self_hosted",
      realtime: false,
      browser_realtime: false,
      control_streaming: true,
      terminal: false,
      terminal_streaming: false,
      web_push: false,
      stt: false,
      release_update: false,
      contract_version: "1",
    });
  });

  it("rejects unsupported runtime methods with shared error code", async () => {
    const res = await handleRequest(new Request(`${base}/api/runtime`, { method: "POST" }));
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET");
    assert.deepEqual(await res.json(), {
      error: "method not allowed",
      code: ErrorCode.MethodNotAllowed,
    });
  });

  it("serves healthz", async () => {
    const res = await handleRequest(new Request(`${base}/healthz`));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      service: "pockly-nexus",
    });
  });

  it("returns shared not_found shape for unknown api paths", async () => {
    const res = await handleRequest(new Request(`${base}/api/unknown`));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {
      error: "not found",
      code: ErrorCode.NotFound,
    });
  });
});
