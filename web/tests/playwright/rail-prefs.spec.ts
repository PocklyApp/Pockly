/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Sidebar project/session action menus (pin / rename / archive / remove),
// driven against the REAL app boot with the whole API mocked via page.route.
// Verifies the menus render, mutations POST the right bodies to the prefs
// endpoints, and the rail re-renders (pin mark, hidden rows, renamed titles).

import { test, expect } from "@playwright/test";

const DEVICE = { device_id: "dd_test", device_name: "Test Mac", device_type: "daemon", status: "active", remote_access_enabled: true };

function session(id: string, cwd: string, ts: string) {
  return {
    session_id: id, device_id: "dd_test", agent: "codex", cwd,
    snippet: `snippet ${id}`, title: "", last_seq: 3, turn_count: 3,
    last_timestamp: ts, updated_at: ts, sync_state: "ready", writable: true,
    connection_mode: "sdk_headless", online: true,
  };
}

test.use({ locale: "zh-CN" });

test.describe("sidebar project/session menus", () => {
  test("pin → POST + pin mark; archive project → hidden; rename session → POST + title", async ({ page }) => {
    const prefPosts: { url: string; body: Record<string, unknown> }[] = [];
    // Server-side prefs state the mock accumulates, so the GET after a POST
    // reflects the mutation (mirrors the COALESCE semantics).
    const projectPrefs = new Map<string, Record<string, unknown>>();
    const sessionPrefs = new Map<string, Record<string, unknown>>();

    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (url.includes("/api/auth/session")) return json({ authenticated: true, user: { user_id: "u1", email: "t@example.local", name: "T" } });
      if (url.includes("/devices/register-browser")) return json({ status: "registered", browser_device_id: "bw1", device_access_token: "tok" });
      if (url.includes("/device-challenge/verify")) return json({ verified: true, device_access_token: "tok" });
      if (url.includes("/device-challenge")) return json({ challenge_id: "c1", device_id: "bw1", audience: "browser-ws", nonce: "n1" });
      if (url.includes("/api/devices")) return json({ devices: [DEVICE] });
      if (url.includes("/api/hosts/online")) return json({ hosts: [{ device_id: "dd_test", device_name: "Test Mac", status: "active", presence_status: "online", connected: true }] });
      if (url.includes("/api/sessions") && !url.includes("/prefs") && method === "GET") {
        return json({ sessions: [
          session("sess-a", "/Users/me/aqua", "2026-06-10T01:00:00Z"),
          session("sess-b", "/Users/me/aqua", "2026-06-10T02:00:00Z"),
          session("sess-c", "/Users/me/hicode", "2026-06-10T03:00:00Z"),
        ] });
      }
      if (url.includes("/api/prefs")) {
        return json({ session_prefs: [...sessionPrefs.values()], project_prefs: [...projectPrefs.values()] });
      }
      const sessDelete = url.match(/\/api\/sessions\/([^/]+)\/delete/);
      if (sessDelete && method === "POST") {
        prefPosts.push({ url, body: { deleted: decodeURIComponent(sessDelete[1]) } });
        return json({ status: "ok", deleted: ["/fake/path.jsonl"] });
      }
      if (url.includes("/api/projects/prefs") && method === "POST") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        prefPosts.push({ url, body });
        const key = `${body.device_id}:${body.cwd}`;
        const prev = projectPrefs.get(key) ?? { device_id: body.device_id, cwd: body.cwd, pinned: false, archived: false, removed: false, custom_label: "" };
        const next = { ...prev, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
        projectPrefs.set(key, next);
        return json(next);
      }
      const sessPref = url.match(/\/api\/sessions\/([^/]+)\/prefs/);
      if (sessPref && method === "POST") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        prefPosts.push({ url, body });
        const sid = decodeURIComponent(sessPref[1]);
        const key = `${body.device_id}:${sid}`;
        const prev = sessionPrefs.get(key) ?? { device_id: body.device_id, session_id: sid, pinned: false, archived: false, custom_title: "" };
        const next = { ...prev, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
        if (body.custom_title !== undefined) next.custom_title = body.custom_title;
        sessionPrefs.set(key, next);
        return json(next);
      }
      return json({});
    });

    await page.goto("/");
    // The rail renders the two projects from the mocked catalog.
    const aquaProject = page.locator(".drawer-project", { hasText: "aqua" });
    await expect(aquaProject).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".drawer-project", { hasText: "hicode" })).toBeVisible();

    // ── Project ⋯ menu: pin ──────────────────────────────────────────────
    await aquaProject.locator(".rail-menu > button").click();
    const menu = page.locator(".rail-menu-pop");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".rail-menu-item")).toHaveText(["置顶", "在 Finder 中显示", "重命名项目", "归档对话", "移除"]);
    await menu.getByText("置顶", { exact: true }).click();
    await expect.poll(() => prefPosts.length).toBeGreaterThan(0);
    expect(prefPosts[0].body).toMatchObject({ device_id: "dd_test", cwd: "/Users/me/aqua", pinned: true });
    // Pin mark renders + pinned project sorts first.
    await expect(aquaProject.locator(".drawer-pin-mark")).toBeVisible();
    await expect(page.locator(".drawer-project").first()).toContainText("aqua");

    // ── Session ⋯ menu: rename via prompt ───────────────────────────────
    const sessionRow = aquaProject.locator(".drawer-session-mini-row", { hasText: "snippet sess-b" }).first();
    await expect(sessionRow).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept("改名后的会话"));
    await sessionRow.locator(".rail-menu > button").click();
    await page.locator(".rail-menu-pop").getByText("重命名", { exact: true }).click();
    await expect.poll(() => prefPosts.some((p) => /sess-b\/prefs/.test(p.url) && p.body.custom_title === "改名后的会话")).toBe(true);
    // The renamed title overrides the snippet-derived label app-wide.
    await expect(aquaProject).toContainText("改名后的会话");

    // ── Project archive: the project disappears from the rail ───────────
    const hicode = page.locator(".drawer-project", { hasText: "hicode" });
    await hicode.locator(".rail-menu > button").click();
    await page.locator(".rail-menu-pop").getByText("归档对话", { exact: true }).click();
    await expect(hicode).toBeHidden();
    expect(prefPosts.some((p) => p.body.cwd === "/Users/me/hicode" && p.body.archived === true)).toBe(true);

    // ── Session delete: ⋯ → 删除 → confirm modal → POST → row gone ──────
    const target = aquaProject.locator(".drawer-session-mini-row", { hasText: "snippet sess-a" }).first();
    await expect(target).toBeVisible();
    await target.locator(".rail-menu > button").click();
    await page.locator(".rail-menu-pop").getByText("删除", { exact: true }).click();
    // The confirm modal spells out the permanent local-file deletion.
    const modal = page.locator(".ws-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("永久删除");
    // Cancel first — nothing happens, the row stays.
    await modal.getByText("取消", { exact: true }).click();
    await expect(modal).toBeHidden();
    await expect(target).toBeVisible();
    expect(prefPosts.some((p) => String(p.body.deleted ?? "") === "sess-a")).toBe(false);
    // Now actually delete.
    await target.locator(".rail-menu > button").click();
    await page.locator(".rail-menu-pop").getByText("删除", { exact: true }).click();
    await page.locator(".ws-modal").getByText("永久删除", { exact: true }).click();
    await expect.poll(() => prefPosts.some((p) => String(p.body.deleted ?? "") === "sess-a")).toBe(true);
    await expect(page.locator(".ws-modal")).toBeHidden();
    await expect(aquaProject.locator(".drawer-session-mini-row", { hasText: "snippet sess-a" })).toBeHidden();
  });
});
