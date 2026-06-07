/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from "@playwright/test";

// AskUserQuestion interactive picker.
//
// The picker dispatches a window CustomEvent "pockly:answer-question".
// In the workspace, App.tsx listens for it and forwards to
// sendPromptForSession. In the fixture page, nobody listens by
// default — the spec installs its own listener via init script to
// capture the dispatched detail.

// IMPORTANT: addInitScript injects raw JS into the page — no TS type
// assertions allowed. CustomEvent.detail is read directly.
const installAnswerCapture = `
  window.__captured = [];
  window.addEventListener("pockly:answer-question", function (e) {
    window.__captured.push(e.detail);
  });
`;

test.describe("AskUserQuestion picker", () => {
  test("single-select question renders one button per option", async ({ page }) => {
    await page.goto("/test/renderer?fixture=r5-question-single");
    await page.locator("details.tool-card-oneliner").first().evaluate((d) => {
      (d as HTMLDetailsElement).open = true;
    });
    await expect(page.locator(".tool-question-option.is-interactive")).toHaveCount(3);
    // Single-select has no aggregated Send button — clicks dispatch.
    await expect(page.locator(".tool-question-send")).toHaveCount(0);
  });

  test("single-select click dispatches the event and disables buttons", async ({ page }) => {
    await page.addInitScript(installAnswerCapture);
    await page.goto("/test/renderer?fixture=r5-question-single");
    await page.locator("details.tool-card-oneliner").first().evaluate((d) => {
      (d as HTMLDetailsElement).open = true;
    });
    // Click the "Green" option
    await page.getByRole("button", { name: /Green/ }).first().click();
    // The card transitions to a sent state
    await expect(page.locator(".tool-question-sent")).toBeVisible();
    // After send, options re-render as static divs (interactive=false),
    // so the interactive-button count drops to zero.
    await expect(page.locator(".tool-question-option.is-interactive")).toHaveCount(0);
    // The captured detail.text contains "Green"
    const captured = await page.evaluate(() => (window as unknown as { __captured: { text: string }[] }).__captured);
    expect(captured.length).toBe(1);
    expect(captured[0].text).toContain("Green");
  });

  test("multi-select staging shows .is-picked + enables Send N", async ({ page }) => {
    await page.goto("/test/renderer?fixture=r5-question-multi");
    await page.locator("details.tool-card-oneliner").first().evaluate((d) => {
      (d as HTMLDetailsElement).open = true;
    });
    await page.getByRole("button", { name: /Alpha/ }).first().click();
    await page.getByRole("button", { name: /Gamma/ }).first().click();
    // Staged labels carry the .is-picked modifier on the still-
    // interactive button (not .is-selected — that's never emitted).
    await expect(page.locator(".tool-question-option.is-picked")).toHaveCount(2);
    const send = page.locator(".tool-question-send");
    await expect(send).toBeEnabled();
    await expect(send).toContainText(/2/); // "Send 2"
  });

  test("multi-select Send dispatches a single concatenated answer", async ({ page }) => {
    await page.addInitScript(installAnswerCapture);
    await page.goto("/test/renderer?fixture=r5-question-multi");
    await page.locator("details.tool-card-oneliner").first().evaluate((d) => {
      (d as HTMLDetailsElement).open = true;
    });
    await page.getByRole("button", { name: /Alpha/ }).first().click();
    await page.getByRole("button", { name: /Delta/ }).first().click();
    await page.locator(".tool-question-send").click();
    const captured = await page.evaluate(() => (window as unknown as { __captured: { text: string }[] }).__captured);
    expect(captured.length).toBe(1);
    // Both labels in the dispatched text, in selection order.
    expect(captured[0].text).toContain("Alpha");
    expect(captured[0].text).toContain("Delta");
    // After send, card flips to .tool-question-sent
    await expect(page.locator(".tool-question-sent")).toBeVisible();
  });
});
