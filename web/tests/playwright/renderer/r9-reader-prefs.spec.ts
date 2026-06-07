/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from "@playwright/test";

// Reader preferences (autoExpandTools / showThinking / showRawParameters).
//
// Post-design-port: narrative-foldable tool calls live inside a
// ToolNarrativeGroup (.ws-narr). The narrative pill is the
// collapsible chrome; individual tool cards
// (details.tool-card-oneliner) only mount in the DOM while the
// narrative is open. Thinking renders as a .thinking-block inside
// the surrounding MessageGroup body and is gated by showThinking.

const STORAGE_KEY = "pockly:prefs:reader:v1";

async function setPrefs(page: import("@playwright/test").Page, prefs: Record<string, boolean>) {
  await page.evaluate(
    ([key, value]) => {
      window.localStorage.setItem(key as string, JSON.stringify(value));
    },
    [STORAGE_KEY, prefs] as const,
  );
}

test.describe("reader preferences", () => {
  test("defaults: narrative pill collapsed, thinking hidden", async ({ page }) => {
    await page.goto("/test/renderer?fixture=r9-mix");
    await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_KEY);
    await page.reload();
    // The narrative pill for the notion mcp call is present and not open.
    const narr = page.locator(".ws-narr").first();
    await expect(narr).toBeVisible();
    const isOpen = await narr.evaluate((n) => n.classList.contains("is-open"));
    expect(isOpen).toBe(false);
    // The body is now always mounted so the expand/collapse can animate
    // (grid-template-rows 0fr↔1fr); a collapsed narrative marks its body
    // aria-hidden and clips it to zero height rather than unmounting it.
    await expect(page.locator(".ws-narr-body-wrap").first()).toHaveAttribute("aria-hidden", "true");
    // Thinking is hidden by default — matches Codex/Claude UX where
    // thinking is a transient in-progress state, not a persistent
    // transcript item. Power users can opt in via showThinking.
    await expect(page.locator(".thinking-block")).toHaveCount(0);
  });

  test("autoExpandTools opens narrative and every nested tool card", async ({ page }) => {
    await page.goto("/test/renderer?fixture=r9-mix");
    await setPrefs(page, { autoExpandTools: true, showThinking: true, showRawParameters: true });
    await page.reload();
    const narr = page.locator(".ws-narr").first();
    await expect(narr).toBeVisible();
    const isOpen = await narr.evaluate((n) => n.classList.contains("is-open"));
    expect(isOpen).toBe(true);
    const detailsCount = await page.locator("details.tool-card-oneliner").count();
    expect(detailsCount).toBeGreaterThanOrEqual(1);
    const openCount = await page.locator("details.tool-card-oneliner[open]").count();
    expect(openCount).toBe(detailsCount);
  });

  test("showThinking=false removes the thinking block but other turns remain", async ({ page }) => {
    await page.goto("/test/renderer?fixture=r9-mix");
    await setPrefs(page, { autoExpandTools: false, showThinking: false, showRawParameters: true });
    await page.reload();
    // Thinking is gone (filtered at the MessageGroup level).
    await expect(page.locator(".thinking-block")).toHaveCount(0);
    // The narrative pill for the tool call still renders.
    await expect(page.locator(".ws-narr")).toHaveCount(1);
    // Assistant "Done." text still renders in the group body.
    await expect(page.locator(".markdown-block")).toContainText("Done.");
  });

  test("showRawParameters=false hides input dump but not result", async ({ page }) => {
    await page.goto("/test/renderer?fixture=r9-mix");
    await setPrefs(page, { autoExpandTools: true, showThinking: true, showRawParameters: false });
    await page.reload();
    // With autoExpandTools the narrative + tool details are open.
    const toolBody = page.locator("details.tool-card-oneliner[open]").first();
    await expect(toolBody).toBeVisible();
    // Default would show 2 .tool-raw-block (input + result). With
    // showRawParameters off, only the result remains.
    const blocks = await toolBody.locator(".tool-raw-block").count();
    expect(blocks).toBe(1);
    await expect(toolBody.locator(".tool-raw-block")).toContainText("page created");
  });

  test("corrupt localStorage falls back to defaults without app-level error", async ({ page }) => {
    const appErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      // Filter network resource 404s that come from optional assets
      // (favicon, fonts not on this dev host). The assertion is about
      // app-level errors — React render errors, JSON parse throws,
      // not "couldn't fetch favicon".
      if (text.includes("Failed to load resource")) return;
      appErrors.push(text);
    });
    await page.goto("/test/renderer?fixture=r9-mix");
    await page.evaluate((key) => window.localStorage.setItem(key, "not json"), STORAGE_KEY);
    await page.reload();
    const narr = page.locator(".ws-narr").first();
    const isOpen = await narr.evaluate((n) => n.classList.contains("is-open"));
    expect(isOpen).toBe(false);
    // Defaults applied: thinking hidden, no app-level errors.
    await expect(page.locator(".thinking-block")).toHaveCount(0);
    expect(appErrors).toHaveLength(0);
  });
});
