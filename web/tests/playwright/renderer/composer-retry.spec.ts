/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Verifies PR #12: the composer run-config pills (ClaudeCodePillsRow) self-heal
// a stale "daemon offline" error. The component's agent-settings fetch, on
// failure, sets the error AND schedules a 4s retry (retryTick in the effect
// deps). Once the backend recovers, the retry re-runs the effect, clears the
// error, and re-fetches — so the stale label disappears instead of sticking
// forever.
//
// This drives the REAL component (mounted via the dev-only `pills-retry`
// fixture) in a real browser, controlling the wire with page.route. The only
// thing that re-runs the fetch after the first failure is the component's own
// 4s timer — nothing in the test triggers a re-render — so a cleared error is
// proof the retry fired.

import { test, expect } from "@playwright/test";

type Phase = "fail" | "ok";

const SNAPSHOT = {
  current: { model: "sonnet", permission_mode: "default", effort: "none" },
  available_models: ["sonnet", "opus"],
  available_permission_modes: ["default", "plan", "acceptEdits"],
  available_efforts: ["none"],
};

async function installRoutes(
  page: import("@playwright/test").Page,
  getPhase: () => Phase,
) {
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    // The one phase-controlled endpoint: the daemon-backed run config.
    if (url.includes("/agent-settings")) {
      if (getPhase() === "fail") return json({ error: "daemon offline" }, 503);
      return json(SNAPSHOT, 200);
    }
    // Browser-device handshake (always succeeds): register → challenge →
    // verify → token. The token is cached in-memory after the first pass,
    // so the retry re-uses it and only re-hits /agent-settings.
    if (url.includes("/devices/register-browser")) {
      return json({ status: "registered", browser_device_id: "fx-browser", device_access_token: "tok" });
    }
    if (url.includes("/device-challenge/verify")) {
      return json({ verified: true, device_access_token: "tok" });
    }
    if (url.includes("/device-challenge")) {
      return json({ challenge_id: "c1", device_id: "fx-browser", audience: "browser-ws", nonce: "n1" });
    }
    // Any other /api call the page makes during boot: empty success.
    return json({});
  });
}

test.describe("composer run-config pills — stale daemon-offline self-heal", () => {
  test("error surfaces on failure, then clears within the 4s retry once it recovers", async ({ page }) => {
    let phase: Phase = "fail";
    await installRoutes(page, () => phase);

    await page.goto("/test/renderer?fixture=pills-retry");

    // 1. Fetch fails → the daemon-offline error surfaces under the pills.
    const errorLabel = page.locator(".composer-pills-error");
    await expect(errorLabel).toBeVisible({ timeout: 8000 });
    await expect(errorLabel).toHaveText(/daemon offline/i);

    // 2. Backend recovers. We change ONLY the server response — no remount,
    //    no prop change. The next fetch is driven solely by the component's
    //    own 4s retry timer.
    phase = "ok";

    // 3. The 4s retry re-runs the effect, clears the error, re-fetches OK.
    await expect(errorLabel).toBeHidden({ timeout: 8000 });

    // 4. Positive evidence the recovered snapshot rendered: the run-config
    //    pill now shows the model from the recovered fetch, not just the
    //    error gone. (.composer-pill-config is the single combined pill.)
    await expect(page.locator(".composer-pill-config")).toContainText(/sonnet/i, { timeout: 4000 });
  });

  test("probe: while the backend stays down, the retry re-sets the error (doesn't go silently blank)", async ({ page }) => {
    const phase: Phase = "fail"; // stays "fail" for this probe — never recovers
    await installRoutes(page, () => phase);

    await page.goto("/test/renderer?fixture=pills-retry");

    const errorLabel = page.locator(".composer-pills-error");
    await expect(errorLabel).toBeVisible({ timeout: 8000 });

    // Wait past one full retry cycle (>4s). A failed retry clears then
    // re-sets the error; sampling after the cycle must still show it —
    // i.e. the failure keeps being surfaced, not swallowed.
    await page.waitForTimeout(5000);
    await expect(errorLabel).toBeVisible();
    await expect(errorLabel).toHaveText(/daemon offline/i);
  });
});
