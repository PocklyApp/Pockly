/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from "@playwright/test";

// R1 — Markdown GFM + code-block language label.
// Cases R1-1, R1-2, R1-3 from docs/r1-r10-e2e-test-plan.md.

test.describe("R1 markdown rendering", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/test/renderer?fixture=r1-gfm");
    await expect(page.locator("[data-fixture='r1-gfm']")).toBeVisible();
  });

  test("R1-1 GFM table renders as semantic <table>", async ({ page }) => {
    const table = page.locator(".markdown-block table").first();
    await expect(table).toBeVisible();
    // 3 header cells per the fixture markdown
    await expect(table.locator("thead th")).toHaveCount(3);
    // first body cell is "1A"
    await expect(table.locator("tbody tr").first().locator("td").first()).toHaveText("1A");
  });

  test("R1-2 task-list checkboxes render as .task-check spans, no <input>", async ({ page }) => {
    const taskItems = page.locator(".markdown-block li.task-item");
    await expect(taskItems).toHaveCount(2);
    // exactly one of them is checked
    await expect(page.locator(".markdown-block .task-check.is-checked")).toHaveCount(1);
    // DOMPurify must keep stripping <input> — none should be in the
    // markdown block even though marked v14's default would emit one.
    await expect(page.locator(".markdown-block input")).toHaveCount(0);
  });

  test("R1-3 fenced code block carries data-lang and renders the label via CSS", async ({ page }) => {
    const pre = page.locator("pre[data-lang='typescript']").first();
    await expect(pre).toBeVisible();
    // CSS-driven language label: pre[data-lang]::before should resolve
    // to a non-empty content. Walk the pseudo via getComputedStyle.
    const labelContent = await pre.evaluate((el) =>
      window.getComputedStyle(el, "::before").getPropertyValue("content"),
    );
    expect(labelContent).not.toBe("none");
    expect(labelContent).not.toBe("");
    // The label content should mention "typescript" (or "ts") — exact
    // form depends on the CSS rule but it MUST be non-empty + non-"none".
  });
});
