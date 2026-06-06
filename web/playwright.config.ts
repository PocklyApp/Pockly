/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig, devices } from "@playwright/test";

// Renderer tests run against a developer-managed Vite server. They do not
// require a relay, daemon, Docker stack, or model provider credentials.
export default defineConfig({
  testDir: "./tests/playwright",
  // CI-friendly defaults. The race we're guarding against in
  // splash-no-flash.spec is on the order of 100-400ms, so 30s per
  // test is plenty even on a cold cache.
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Keep tests serial so DOM fixture state remains deterministic.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: process.env.POCKLY_WEB_URL ?? "http://127.0.0.1:5173",
    // Trace + screenshot on first failure only — local runs stay fast,
    // CI gets enough breadcrumbs to debug without inflating artifacts.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // Match the dev environment's defaults so URL handling is
    // identical to a real user's browser.
    ignoreHTTPSErrors: false,
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
