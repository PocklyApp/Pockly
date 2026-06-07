/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildNewTaskRequestBody, reportWebTelemetry } from "./api";

test("new task request body carries codex effort and permission settings", () => {
  assert.deepEqual(
    buildNewTaskRequestBody({
      daemonDeviceId: "dd_test",
      agent: "codex",
      cwd: "/tmp/project",
      text: "hello",
      model: "gpt-5.1-codex",
      permissionMode: "auto",
      effort: "minimal",
    }),
    {
      daemon_device_id: "dd_test",
      agent: "codex",
      cwd: "/tmp/project",
      text: "hello",
      model: "gpt-5.1-codex",
      permission_mode: "auto",
      effort: "minimal",
    },
  );
});

test("web telemetry is network-disabled by default", () => {
  const globals = globalThis as unknown as {
    window: { POCKLY_CONFIG?: Record<string, unknown> } | undefined;
    fetch: typeof fetch | undefined;
  };
  const originalWindow = globals.window;
  const originalFetch = globals.fetch;
  let fetchCalled = false;
  globals.window = { POCKLY_CONFIG: {} };
  globals.fetch = (() => {
    fetchCalled = true;
    throw new Error("fetch should not be called");
  }) as typeof fetch;
  try {
    reportWebTelemetry({ name: "web_page_error", errorCode: "test" });
    assert.equal(fetchCalled, false);
  } finally {
    globals.window = originalWindow;
    globals.fetch = originalFetch;
  }
});
