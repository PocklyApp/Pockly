/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from "@playwright/test";

// Bash terminal-styled card + command copy.

test.describe("Bash tool card", () => {
  test("renders .tool-command with $ prompt + command text", async ({ page }) => {
    await page.goto("/test/renderer?fixture=r3-bash");
    // Expand the collapsed <details> so the body is in the layout.
    // Bash is a narrative tool — folded into a ToolNarrativeGroup
    // pill. Open the narrative first so the inner <details> mounts.
    await page.locator(".ws-narr .ws-narr-row").first().click();
    await page.locator("details.tool-card-oneliner").first().evaluate((d) => {
      (d as HTMLDetailsElement).open = true;
    });
    await expect(page.locator(".tool-command-prompt").first()).toHaveText("$");
    await expect(page.locator(".tool-command-text").first()).toHaveText("ls -la /tmp");
    // No result yet — no output block.
    await expect(page.locator(".tool-command-output")).toHaveCount(0);
  });

  test("copy button writes the command to the clipboard", async ({ page, context }) => {
    // Grant clipboard perms BEFORE navigate so the page can write to it.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/test/renderer?fixture=r3-bash");
    // Bash is a narrative tool — folded into a ToolNarrativeGroup
    // pill. Open the narrative first so the inner <details> mounts.
    await page.locator(".ws-narr .ws-narr-row").first().click();
    await page.locator("details.tool-card-oneliner").first().evaluate((d) => {
      (d as HTMLDetailsElement).open = true;
    });
    const copyBtn = page.locator(".tool-command-copy").first();
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toBe("ls -la /tmp");
  });

  test("paired result renders below the command in the same terminal block", async ({ page }) => {
    await page.goto("/test/renderer?fixture=r3-bash-with-result");
    // Bash is a narrative tool — folded into a ToolNarrativeGroup
    // pill. Open the narrative first so the inner <details> mounts.
    await page.locator(".ws-narr .ws-narr-row").first().click();
    await page.locator("details.tool-card-oneliner").first().evaluate((d) => {
      (d as HTMLDetailsElement).open = true;
    });
    // command line still there
    await expect(page.locator(".tool-command-text").first()).toHaveText("ls -la /tmp");
    // result block appears
    const out = page.locator(".tool-command-output").first();
    await expect(out).toBeVisible();
    await expect(out).toContainText("drwxrwxrwt");
  });
});
