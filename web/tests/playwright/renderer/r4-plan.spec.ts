/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from "@playwright/test";

// R4 — ExitPlanMode interactive plan panel.
// Cases R4-1 (plan markdown), R4-2 (pending footer), R4-3 (resolved
// drops footer — post-review-fix regression).

test.describe("R4 ExitPlanMode plan card", () => {
  test("R4-1 plan markdown renders inside .tool-plan-body", async ({ page }) => {
    await page.goto("/test/renderer?fixture=r4-plan-pending");
    await page.locator("details.tool-card-oneliner").first().evaluate((d) => {
      (d as HTMLDetailsElement).open = true;
    });
    const body = page.locator(".tool-plan-body .markdown-block").first();
    await expect(body).toBeVisible();
    await expect(body.locator("h2")).toHaveCount(2);
    await expect(body.locator("h2").first()).toHaveText("Step 1");
  });

  test("R4-2 pending plan shows the pulsing footer", async ({ page }) => {
    await page.goto("/test/renderer?fixture=r4-plan-pending");
    await page.locator("details.tool-card-oneliner").first().evaluate((d) => {
      (d as HTMLDetailsElement).open = true;
    });
    const footer = page.locator(".tool-plan-footer").first();
    await expect(footer).toBeVisible();
    // Localized en text matches workspace.planAwaitingApproval; zh-CN
    // contributors with browser lang=zh-CN should still see the
    // footer node (text differs, presence does not).
    await expect(footer).toContainText(/Awaiting|批准/);
    // Pulsing dot animation: assert the dot has a non-"none" animation.
    const dot = footer.locator(".tool-plan-footer-dot");
    const animationName = await dot.evaluate((el) =>
      window.getComputedStyle(el).animationName,
    );
    expect(animationName).not.toBe("none");
  });

  test("R4-3 resolved plan drops the footer and shows 'done' state (post-fix regression)", async ({ page }) => {
    await page.goto("/test/renderer?fixture=r4-plan-resolved");
    await page.locator("details.tool-card-oneliner").first().evaluate((d) => {
      (d as HTMLDetailsElement).open = true;
    });
    // Body still renders the plan markdown
    await expect(page.locator(".tool-plan-body .markdown-block h2")).toHaveCount(1);
    // Footer is gone — this is the post-fix behavior
    await expect(page.locator(".tool-plan-footer")).toHaveCount(0);
    // Header state label flipped to "done"
    await expect(page.locator(".tool-card-state").first()).toContainText("done");
  });
});
