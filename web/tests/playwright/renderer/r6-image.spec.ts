/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from "@playwright/test";

// R6 — image content + in-page lightbox.
// Cases R6-1 (300x300 thumbnail + data: URL), R6-2 (lightbox open),
// R6-3 (ESC / backdrop / close button all dismiss).

test.describe("R6 image lightbox", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/test/renderer?fixture=r6-image-base64");
    await expect(page.locator(".image-turn-card")).toBeVisible();
  });

  test("R6-1 renders a 300x300 thumbnail with data: URL src", async ({ page }) => {
    const card = page.locator(".image-turn-card").first();
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    // 300x300 ±10px tolerance for borders / padding
    expect(box!.width).toBeGreaterThanOrEqual(290);
    expect(box!.width).toBeLessThanOrEqual(310);
    expect(box!.height).toBeGreaterThanOrEqual(290);
    expect(box!.height).toBeLessThanOrEqual(310);
    const src = await card.locator("img").getAttribute("src");
    expect(src).toMatch(/^data:image\/png;base64,/);
  });

  test("R6-2 click opens the lightbox and locks body scroll", async ({ page }) => {
    await page.locator(".image-turn-card").first().click();
    await expect(page.locator(".image-lightbox-backdrop[role='dialog']")).toBeVisible();
    await expect(page.locator(".image-lightbox-image")).toBeVisible();
    const overflow = await page.evaluate(() => document.body.style.overflow);
    expect(overflow).toBe("hidden");
  });

  test("R6-3a ESC key closes the lightbox + restores body scroll", async ({ page }) => {
    await page.locator(".image-turn-card").first().click();
    await expect(page.locator(".image-lightbox-backdrop")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".image-lightbox-backdrop")).toHaveCount(0);
    const overflow = await page.evaluate(() => document.body.style.overflow);
    expect(overflow).not.toBe("hidden");
  });

  test("R6-3b backdrop click closes the lightbox", async ({ page }) => {
    await page.locator(".image-turn-card").first().click();
    const backdrop = page.locator(".image-lightbox-backdrop");
    await expect(backdrop).toBeVisible();
    // Click the backdrop (not the centered image which stopPropagation()s).
    // Click the top-left corner where only the backdrop sits.
    await backdrop.click({ position: { x: 10, y: 10 } });
    await expect(backdrop).toHaveCount(0);
  });

  test("R6-3c close button dismisses the lightbox", async ({ page }) => {
    await page.locator(".image-turn-card").first().click();
    await page.locator(".image-lightbox-close").click();
    await expect(page.locator(".image-lightbox-backdrop")).toHaveCount(0);
  });
});
