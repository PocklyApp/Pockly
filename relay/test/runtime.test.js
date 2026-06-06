/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ErrorCode, managedRuntimeCapabilities } from "../src/contract.js";
import { handleRequest } from "../src/app.js";

const base = "https://managed-runtime.test";

describe("managed runtime contract", () => {
  it("returns neutral managed runtime capabilities", async () => {
    const res = await handleRequest(new Request(`${base}/api/runtime`), {
      STT_ENABLED: "0",
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await res.json(), {
      runtime: "managed",
      realtime: false,
      terminal: false,
      web_push: false,
      stt: false,
      release_update: false,
      contract_version: "1",
    });
  });

  it("only advertises implemented capabilities when enabled", () => {
    assert.deepEqual(managedRuntimeCapabilities({}), {
      runtime: "managed",
      realtime: false,
      terminal: false,
      web_push: false,
      stt: false,
      release_update: false,
      contract_version: "1",
    });
    assert.deepEqual(
      managedRuntimeCapabilities({
        REALTIME_ENABLED: "1",
        TERMINAL_ENABLED: "true",
        WEB_PUSH_ENABLED: "1",
        STT_ENABLED: "1",
        RELEASE_UPDATE_ENABLED: "true",
      }),
      {
        runtime: "managed",
        realtime: true,
        terminal: true,
        web_push: true,
        stt: true,
        release_update: true,
        contract_version: "1",
      },
    );
  });

  it("reports STT only when explicitly enabled", () => {
    assert.equal(managedRuntimeCapabilities({ STT_ENABLED: "0" }).stt, false);
    assert.equal(managedRuntimeCapabilities({ STT_ENABLED: "1" }).stt, true);
    assert.equal(managedRuntimeCapabilities({ STT_ENABLED: "true" }).stt, true);
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
      service: "pockly-managed-runtime",
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
