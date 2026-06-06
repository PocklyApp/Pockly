/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from "@playwright/test";

// E §E — the "Diffs · N" pill + diff drawer. The codehl fixture has an Edit
// tool call, so the fixture page renders the pill; clicking it opens the
// bottom-sheet drawer, and tapping a file drills into its syntax-highlighted
// diff. The sheet portals to <body>, so the scrim covers the whole viewport.

test.describe("Diff drawer (Diffs pill → list → per-file diff)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/test/renderer?fixture=codehl");
    await page.waitForSelector('[data-fixture="codehl"]');
  });

  test("pill opens the drawer with a changed-file row", async ({ page }) => {
    const pill = page.locator(".composer-diff-pill");
    await expect(pill).toBeVisible();
    // Badge shows the changed-file count (codehl edits one file).
    await expect(pill.locator(".composer-diff-badge")).toHaveText("1");

    // Drawer is mounted but closed until the pill is clicked.
    await expect(page.locator(".diffsheet-layer.is-open")).toHaveCount(0);
    await pill.click();
    await expect(page.locator(".diffsheet-layer.is-open")).toBeVisible();

    // Header summary + exactly one file row.
    await expect(page.locator(".diffsheet-head .diffsheet-title strong")).toBeVisible();
    const rows = page.locator(".diffsheet-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("PairingService.ts");
    // Ratio bar + add/del stats present.
    await expect(rows.first().locator(".diffsheet-bar b")).toBeVisible();
  });

  test("tapping a file shows its syntax-highlighted diff, back returns to the list", async ({ page }) => {
    await page.locator(".composer-diff-pill").click();
    await page.locator(".diffsheet-row").first().click();

    // Detail view: file header + a real diff body.
    await expect(page.locator(".diffsheet-detail")).toBeVisible();
    await expect(page.locator(".diffsheet-detail-file")).toContainText("PairingService.ts");
    await expect(page.locator(".diffsheet-detail .tool-diff-line").first()).toBeVisible();
    // Per-line syntax highlighting is applied (lazy hljs).
    await expect(page.locator(".diffsheet-detail .tool-diff-text .hljs-keyword").first()).toBeVisible();

    // Back arrow returns to the file list.
    await page.locator(".diffsheet-back").click();
    await expect(page.locator(".diffsheet-list")).toBeVisible();
    await expect(page.locator(".diffsheet-detail")).toHaveCount(0);
  });

  test("close button dismisses the drawer", async ({ page }) => {
    await page.locator(".composer-diff-pill").click();
    await expect(page.locator(".diffsheet-layer.is-open")).toBeVisible();
    await page.locator(".diffsheet-x").click();
    await expect(page.locator(".diffsheet-layer.is-open")).toHaveCount(0);
  });

  test("the round close/back buttons are circular (not stretched by the global button reset)", async ({ page }) => {
    await page.locator(".composer-diff-pill").click();
    const box = await page.locator(".diffsheet-x").boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      // Square-ish (32x32 circle), NOT the 32x38 oval the base button rule caused.
      expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(2);
    }
  });
});
