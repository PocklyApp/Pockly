/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import { initObservability, telemetryNetworkEnabled, trackEvent } from "./observability";

type TestWindow = {
  POCKLY_CONFIG?: Record<string, unknown>;
  __POCKLY_RUNTIME_CONFIG__?: Record<string, unknown>;
};

function withWindow(config: TestWindow, fn: () => void) {
  const globals = globalThis as unknown as { window: TestWindow | undefined };
  const originalWindow = globals.window;
  globals.window = config;
  try {
    fn();
  } finally {
    globals.window = originalWindow;
    initObservability();
  }
}

test("observability defaults to local-only no-op behavior", () => {
  const originalDebug = console.debug;
  let debugCalled = false;
  console.debug = (() => {
    debugCalled = true;
  }) as typeof console.debug;
  try {
    withWindow({ POCKLY_CONFIG: {} }, () => {
      initObservability();
      assert.equal(telemetryNetworkEnabled(), false);
      trackEvent("web_bootstrap", { status: "ok" });
      assert.equal(debugCalled, false);
    });
  } finally {
    console.debug = originalDebug;
  }
});

test("telemetryDebug writes sanitized local logs without enabling network telemetry", () => {
  const originalDebug = console.debug;
  const calls: unknown[][] = [];
  console.debug = ((...args: unknown[]) => {
    calls.push(args);
  }) as typeof console.debug;
  try {
    withWindow({ __POCKLY_RUNTIME_CONFIG__: { telemetryDebug: "true" } }, () => {
      initObservability();
      assert.equal(telemetryNetworkEnabled(), false);
      trackEvent("inject_request_failed", {
        status: "error",
        token: "secret-token",
        prompt: "private prompt",
        count: 2,
      });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], [
        "[pockly:event]",
        "inject_request_failed",
        { status: "error", count: "2" },
      ]);
    });
  } finally {
    console.debug = originalDebug;
  }
});

test("network telemetry requires explicit runtime opt-in", () => {
  withWindow({ POCKLY_CONFIG: { telemetryEnabled: "1" } }, () => {
    assert.equal(telemetryNetworkEnabled(), true);
  });
  withWindow({ POCKLY_CONFIG: { telemetryEnabled: "false" } }, () => {
    assert.equal(telemetryNetworkEnabled(), false);
  });
});
