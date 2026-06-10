/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from "@playwright/test";

type SessionTurn = {
  session_id: string;
  device_id: string;
  seq: number;
  agent: string;
  kind: string;
  timestamp: string;
  payload: Record<string, unknown>;
};

const BASE: Omit<SessionTurn, "seq" | "payload"> = {
  session_id: "fx",
  device_id: "fx",
  agent: "claude-code",
  kind: "attachment",
  timestamp: "2026-01-01T08:00:00Z",
};

async function loadFixtureAndSetTurns(
  page: import("@playwright/test").Page,
  turns: SessionTurn[],
) {
  await page.goto("/test/renderer?fixture=r8-three-pending");
  await page.waitForFunction(() => Boolean((window as unknown as {
    __rendererFixture?: { setTurns: (next: unknown[]) => void };
  }).__rendererFixture?.setTurns));
  await page.evaluate((t) => {
    const hooks = (window as unknown as {
      __rendererFixture: { setTurns: (next: unknown[]) => void };
    }).__rendererFixture;
    hooks.setTurns(t);
  }, turns);
}

test.describe("permission panel", () => {
  test("pending request renders above the composer area, not in the transcript", async ({ page }) => {
    await loadFixtureAndSetTurns(page, [
      {
        ...BASE,
        seq: 1,
        payload: {
          attachment_type: "permission_request",
          permission_request_id: "req-1",
          permission_daemon_device_id: "fx",
          permission_tool_name: "Bash",
          permission_input_preview: JSON.stringify({
            command: "pwd",
            description: "Print working directory",
          }),
          permission_decision: "pending",
        },
      },
    ]);

    const panel = page.locator(".permission-panel");
    await expect(panel).toBeVisible();
    const card = panel.locator(".permission-card");
    await expect(card.locator(".permission-card-title")).toHaveText(
      "Allow agent to run Print working directory?",
    );
    await expect(card.locator(".permission-card-desc")).toHaveText("Print working directory");
    await expect(card.locator(".permission-card-cmd")).toHaveText("pwd");
    await expect(card.locator(".permission-card-dot")).toHaveClass(/is-pending/);
    await expect(card.locator(".permission-card-btn")).toHaveText([
      "Deny",
      "Allow",
    ]);

    await expect(page.locator(".fixture-turns .permission-card")).toHaveCount(0);
    await expect(page.locator(".fixture-turns", { hasText: "Allow agent to run" })).toHaveCount(0);
  });

  test("resolved allow/deny permission events stay hidden", async ({ page }) => {
    await loadFixtureAndSetTurns(page, [
      {
        ...BASE,
        seq: 1,
        payload: {
          attachment_type: "permission_request",
          permission_request_id: "req-allow",
          permission_daemon_device_id: "fx",
          permission_tool_name: "Bash",
          permission_input_preview: JSON.stringify({
            command: "whoami",
            description: "Show current user",
          }),
          permission_decision: "allow",
        },
      },
      {
        ...BASE,
        seq: 2,
        payload: {
          attachment_type: "permission_request",
          permission_request_id: "req-deny",
          permission_daemon_device_id: "fx",
          permission_tool_name: "Read",
          permission_input_preview: JSON.stringify({
            file_path: "/etc/shadow",
          }),
          permission_decision: "deny",
        },
      },
    ]);

    await expect(page.locator(".permission-panel")).toHaveCount(0);
    await expect(page.getByText("Allowed agent to run Show current user")).toHaveCount(0);
    await expect(page.getByText("Denied agent to run Read")).toHaveCount(0);
  });

  test("local confirmation notice is read-only and not rendered in transcript", async ({ page }) => {
    await loadFixtureAndSetTurns(page, [
      {
        ...BASE,
        seq: 1,
        payload: {
          attachment_type: "permission_request",
          permission_tool_name: "Claude",
          permission_input_preview: JSON.stringify({
            prompt: "Do you want to continue with this operation?",
          }),
          permission_decision: "local_confirmation",
          permission_reason: "Claude is waiting for confirmation in the local terminal",
        },
      },
    ]);

    const card = page.locator(".permission-panel .permission-card");
    await expect(card).toBeVisible();
    // Matches locales/en.ts permissions copy ("The agent is…", agent-neutral
    // since codex shares this card). The spec predated that wording.
    await expect(card.locator(".permission-card-title")).toHaveText("The agent is waiting on the computer");
    await expect(card.getByText("Approve or cancel it on the connected computer.")).toBeVisible();
    await expect(card.getByRole("button")).toHaveCount(0);
    await expect(page.locator(".fixture-turns .permission-card")).toHaveCount(0);
  });

  test("duplicate pending permission events render one panel card", async ({ page }) => {
    const payload = {
      attachment_type: "permission_request",
      permission_request_id: "req-dupe",
      permission_daemon_device_id: "fx",
      permission_tool_name: "Bash",
      permission_input_preview: JSON.stringify({
        command: "rm file.txt",
        description: "Delete file",
      }),
      permission_decision: "pending",
    };
    await loadFixtureAndSetTurns(page, [
      { ...BASE, seq: 1, payload },
      { ...BASE, seq: 2, payload },
    ]);

    await expect(page.locator(".permission-panel .permission-card")).toHaveCount(1);
  });

  test("approve hides the pending card immediately after accepted ack", async ({ page }) => {
    await page.route("**/api/devices/register-browser", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "registered",
          browser_device_id: "bd_fixture",
          device_access_token: "fixture-token",
        }),
      });
    });
    await page.route("**/api/device-challenge", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          challenge_id: "ch_fixture",
          device_id: "bd_fixture",
          audience: "browser-ws",
          nonce: "nonce",
        }),
      });
    });
    await page.route("**/api/device-challenge/verify", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ verified: true, device_access_token: "fixture-token" }),
      });
    });
    await page.route("**/api/permission-requests/req-hide/decide", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "accepted" }),
      });
    });
    await loadFixtureAndSetTurns(page, [
      {
        ...BASE,
        seq: 1,
        payload: {
          attachment_type: "permission_request",
          permission_request_id: "req-hide",
          permission_daemon_device_id: "fx",
          permission_tool_name: "Bash",
          permission_input_preview: JSON.stringify({
            command: "pwd",
            description: "Print working directory",
          }),
          permission_decision: "pending",
        },
      },
    ]);

    await expect(page.locator(".permission-panel .permission-card")).toBeVisible();
    await page.getByRole("button", { name: "Allow" }).click();
    await expect(page.locator(".permission-panel")).toHaveCount(0);
  });
});
