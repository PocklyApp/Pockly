/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from "@playwright/test";

// KaTeX math lazy loading.

test.describe("KaTeX math rendering", () => {
  test("block + inline math render via KaTeX", async ({ page }) => {
    const katexRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("katex")) katexRequests.push(req.url());
    });
    await page.goto("/test/renderer?fixture=r10-block-math");
    // KaTeX is dynamic-imported; wait for the network to settle so
    // the katex chunk has time to land.
    await page.waitForLoadState("networkidle");
    // Block math
    const display = page.locator(".markdown-block .math-display").first();
    await expect(display).toBeVisible();
    await expect(display.locator(".katex")).toBeVisible();
    // Inline math sits in the line box
    const inline = page.locator(".markdown-block .math-inline").first();
    await expect(inline).toBeVisible();
    await expect(inline.locator(".katex")).toBeVisible();
    // Both chunks (JS + CSS) requested
    expect(katexRequests.length).toBeGreaterThanOrEqual(1);
  });

  test("currency-only content does not trigger katex lazy-load", async ({ page }) => {
    const katexRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("katex")) katexRequests.push(req.url());
    });
    await page.goto("/test/renderer?fixture=r10-currency-only");
    await page.waitForLoadState("networkidle");
    // The text is visible
    await expect(page.locator(".markdown-block")).toContainText("$5");
    await expect(page.locator(".markdown-block")).toContainText("$100");
    // But no math sentinels and no katex chunk loaded
    await expect(page.locator(".markdown-block [data-tex]")).toHaveCount(0);
    await expect(page.locator(".markdown-block .katex")).toHaveCount(0);
    expect(katexRequests).toHaveLength(0);
  });
});
