/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import { configuredInstallUnixCommand, configuredInstallWindowsCommand } from "./runtime-config";

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
  }
}

test("install command fallbacks use safe public placeholders", () => {
  withWindow({ POCKLY_CONFIG: {} }, () => {
    assert.equal(configuredInstallUnixCommand(), "curl -fsSL https://your-nexus.example/install.sh | bash");
    assert.equal(configuredInstallWindowsCommand(), "irm https://your-nexus.example/install.ps1 | iex");
  });
});

test("runtime install commands override public placeholders", () => {
  withWindow({
    __POCKLY_RUNTIME_CONFIG__: {
      installUnixCommand: "curl -fsSL https://nexus.example/install.sh | bash",
      installWindowsCommand: "irm https://nexus.example/install.ps1 | iex",
    },
  }, () => {
    assert.equal(configuredInstallUnixCommand(), "curl -fsSL https://nexus.example/install.sh | bash");
    assert.equal(configuredInstallWindowsCommand(), "irm https://nexus.example/install.ps1 | iex");
  });
});
