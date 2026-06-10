/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Long unbroken tokens (inline code spans, URLs, file paths) must never widen
// the conversation into a page-level horizontal scrollbar. <pre> blocks keep
// their own internal scroll, which is fine — the assertion is on the document.

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

const T = (seq: number, text: string): SessionTurn => ({
  session_id: "fx",
  device_id: "d",
  agent: "codex",
  seq,
  kind: "assistant_text",
  timestamp: "2026-06-10T00:00:10Z",
  payload: { text },
});

const LONG_INLINE = "`" + "/Users/liuzheng/very/deep/path/".repeat(8) + "file.ts`";
const LONG_URL = "https://example.com/very/long/path/" + "segment/".repeat(30) + "end";

test("inline code and long URLs wrap instead of forcing a horizontal scrollbar", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/test/renderer?fixture=r3-bash");
  await page.waitForFunction(() => Boolean((window as unknown as {
    __rendererFixture?: { setTurns: (next: unknown[]) => void };
  }).__rendererFixture?.setTurns));
  await page.evaluate((turns) => {
    (window as unknown as {
      __rendererFixture: { setTurns: (next: unknown[]) => void };
    }).__rendererFixture.setTurns(turns);
  }, [
    T(1, "数据部署为本机 " + LONG_INLINE + " 不暴露。"),
    T(2, "链接 " + LONG_URL + " 在这。"),
  ]);
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});
