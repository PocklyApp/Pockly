/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from "@playwright/test";

// R7 — TokenUsagePie context-window indicator.
// The fixture page now mounts the REAL TokenUsagePie exported from
// App.tsx (not a stripped copy), so these specs also catch regressions
// in the SVG arc, the role="img" + localized aria-label, and the
// tooltip placement — surface that a tier-class-only copy would miss.

test.describe("R7 token usage pie", () => {
  test("R7-3 warn tier (~65%) → .token-usage-pie-warn + svg arc + tooltip", async ({ page }) => {
    await page.goto("/test/renderer?fixture=r7-usage-65pct");
    const pie = page.locator(".token-usage-pie").first();
    await expect(pie).toBeVisible();
    await expect(pie).toHaveClass(/token-usage-pie-warn/);
    // Real component renders an SVG arc.
    await expect(pie.locator("svg")).toHaveCount(1);
    await expect(pie.locator("svg circle")).toHaveCount(2); // track + arc
    // role="img" + aria-label + title tooltip carry the localized
    // count/total/pct triple. Asserts the workspace.tokenUsageTooltip
    // i18n key landed in the rendered DOM, not just the class.
    await expect(pie).toHaveAttribute("role", "img");
    const tooltip = await pie.getAttribute("title");
    expect(tooltip).not.toBeNull();
    expect(tooltip!).toContain("130,000");
    expect(tooltip!).toContain("200,000");
    expect(tooltip!).toContain("65");
    // Percent text shows 65%
    await expect(pie.locator(".token-usage-pct")).toContainText("65%");
  });

  test("R7-4 codex danger tier uses 272k denominator, semibold red %", async ({ page }) => {
    await page.goto("/test/renderer?fixture=r7-usage-codex");
    const pie = page.locator(".token-usage-pie").first();
    await expect(pie).toHaveClass(/token-usage-pie-danger/);
    // 245000 / 272000 ≈ 90%
    await expect(pie.locator(".token-usage-pct")).toContainText("90%");
    // The pie's own tooltip is the source of truth for the agent-aware
    // denominator — fixture-meta is a display convenience, not the SUT.
    const tooltip = await pie.getAttribute("title");
    expect(tooltip).not.toBeNull();
    expect(tooltip!).toContain("272,000"); // Codex window, not 200k
    expect(tooltip!).toContain("245,000");
    // Semibold % text in danger tier
    const weight = await pie.locator(".token-usage-pct").evaluate((el) =>
      parseInt(window.getComputedStyle(el).fontWeight, 10),
    );
    expect(weight).toBeGreaterThanOrEqual(600);
  });
});
