/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Scenario C regression: ONE assistant reply stored multiple times (live SDK
// bridge copy with the app-server item uuid + uuid-less jsonl sync copy +
// optimistic live ghost) must RENDER once. Endemic to codex — its rollouts
// persist no per-message ids, so dedupeTurnsByUuid can't fold the pair and,
// before dedupeAssistantTextEchoes, the same sentence rendered twice.
//
// Drives the real renderer via the dev-only fixture page and asserts on the
// actual DOM text.

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

const BASE: Omit<SessionTurn, "seq" | "kind" | "timestamp" | "payload"> = {
  session_id: "fx-r3-bash",
  device_id: "fx-device",
  agent: "codex",
};

function turn(
  seq: number,
  kind: string,
  payload: Record<string, unknown>,
  ts = "2026-06-10T00:00:10Z",
): SessionTurn {
  return { ...BASE, seq, kind, timestamp: ts, payload };
}

async function setFixtureTurns(page: import("@playwright/test").Page, turns: SessionTurn[]) {
  await page.goto("/test/renderer?fixture=r3-bash");
  await page.waitForFunction(() => Boolean((window as unknown as {
    __rendererFixture?: { setTurns: (next: unknown[]) => void };
  }).__rendererFixture?.setTurns));
  await page.evaluate((t) => {
    (window as unknown as {
      __rendererFixture: { setTurns: (next: unknown[]) => void };
    }).__rendererFixture.setTurns(t);
  }, turns);
}

test.describe("assistant reply stored twice renders once", () => {
  test("bridge(uuid) + sync(no-uuid) + optimistic ghost → the sentence appears exactly once", async ({ page }) => {
    await setFixtureTurns(page, [
      turn(1, "user_message", { text: "What's 6 times 7?" }, "2026-06-10T00:00:01Z"),
      // live SDK bridge copy (Nexus-stored, app-server item uuid)
      turn(5, "assistant_text", { text: "The answer is **42**.", uuid: "item-1" }, "2026-06-10T00:00:10Z"),
      // jsonl history sync copy (codex rollouts carry no per-message id → no uuid)
      turn(7, "assistant_text", { text: "The answer is **42**." }, "2026-06-10T00:00:11Z"),
      // optimistic live ghost (synthetic seq)
      turn(1_000_000_002, "assistant_text", { text: "The answer is **42**." }, "2026-06-10T00:00:09Z"),
    ]);

    const fixtureBody = page.locator(".fixture-turns");
    await expect(fixtureBody).toContainText("The answer is 42.", { timeout: 5000 });
    // The whole conversation body contains the sentence EXACTLY once.
    const body = (await fixtureBody.innerText()).replace(/\s+/g, " ");
    const occurrences = body.split("The answer is").length - 1;
    expect(occurrences).toBe(1);
  });

  test("genuine repeats (two distinct uuids) still render twice", async ({ page }) => {
    await setFixtureTurns(page, [
      turn(1, "user_message", { text: "Say Done twice." }, "2026-06-10T00:00:01Z"),
      turn(5, "assistant_text", { text: "Done.", uuid: "item-a" }, "2026-06-10T00:00:10Z"),
      turn(6, "tool_call", { tool: "Bash", input: { command: "true", description: "noop" }, id: "call-1" }, "2026-06-10T00:00:20Z"),
      turn(9, "assistant_text", { text: "Done.", uuid: "item-b" }, "2026-06-10T00:00:40Z"),
    ]);

    const fixtureBody = page.locator(".fixture-turns");
    await expect(fixtureBody).toContainText("Done.", { timeout: 5000 });
    const body = (await fixtureBody.innerText()).replace(/\s+/g, " ");
    const occurrences = body.split("Done.").length - 1;
    expect(occurrences).toBe(2);
  });
});
