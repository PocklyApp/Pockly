/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from "@playwright/test";

// Repro for "SDK session doesn't render the WebSearch tool call like PTY".
// The fixture carries a WebSearch tool_call + a separate tool_result turn
// (exactly the shape Nexus stores for SDK sessions), so this asserts
// the renderer surfaces it as a narrative card just like Bash.
test("WebSearch tool_call renders as a narrative card", async ({ page }) => {
  await page.goto("/test/renderer?fixture=websearch");
  // The narrative pill exists (collapsed by default).
  const narr = page.locator(".ws-narr .ws-narr-row").first();
  await expect(narr).toBeVisible({ timeout: 10_000 });
  // Its phrase should reflect WebSearch (verb map: "Searched … the web").
  await expect(narr).toContainText(/Search/i);
  // Expand → the nested tool card shows the WebSearch tool name + query.
  await narr.click();
  const card = page.locator("details.tool-card-oneliner").first();
  await expect(card).toBeVisible();
  await expect(card).toContainText(/WebSearch/);
});
