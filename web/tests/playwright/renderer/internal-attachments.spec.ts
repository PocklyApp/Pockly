/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from "@playwright/test";

test.describe("internal Claude Code attachments", () => {
  test("hides every context attachment (including file); real turns + permission cards still render", async ({ page }) => {
    await page.goto("/test/renderer?fixture=internal-attachments");

    // Real conversation content still renders.
    await expect(page.getByText("Visible assistant reply.")).toBeVisible();
    // The permission card renders via its own dedicated path (scanned
    // separately), NOT as a generic attachment card.
    await expect(page.locator("[data-permission-request-id='req-visible']")).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
    await expect(page.locator(".permission-card-title", { hasText: /Allow Claude to run/ })).toBeVisible();

    // Attachments are session-context plumbing and are ALL hidden now —
    // including `file` (the type set is open-ended; chasing each one leaked the
    // next, so they're hidden by default). No generic "附件" cards render.
    await expect(page.locator(".attachment-card")).toHaveCount(0);
    await expect(page.getByText("VISIBLE_FILE_ATTACHMENT.md")).toHaveCount(0);

    await expect(page.getByText("SHOULD_NOT_RENDER_SKILL")).toHaveCount(0);
    await expect(page.getByText("SHOULD_NOT_RENDER_AGENT")).toHaveCount(0);
    await expect(page.getByText("SHOULD_NOT_RENDER_TOOL")).toHaveCount(0);
    await expect(page.getByText("SHOULD_NOT_RENDER_PERMISSION_LIST")).toHaveCount(0);
    await expect(page.getByText("SHOULD_NOT_RENDER_TASK_REMINDER")).toHaveCount(0);
    // task_reminder is an internal nudge → no "附件 · task_reminder" card.
    await expect(page.locator(".attachment-card", { hasText: "task_reminder" })).toHaveCount(0);
    // mcp_instructions_delta + any *_delta context push are internal — hidden
    // by the suffix catch-all even when not explicitly enumerated.
    await expect(page.getByText("SHOULD_NOT_RENDER_MCP_INSTRUCTIONS")).toHaveCount(0);
    await expect(page.getByText("SHOULD_NOT_RENDER_UNKNOWN_DELTA")).toHaveCount(0);
  });
});
