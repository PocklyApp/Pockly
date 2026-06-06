/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || "Pockly update";
  const options = {
    body: payload.summary || "Open Pockly to view the latest status.",
    tag: payload.session_id ? `pockly:${payload.device_id || ""}:${payload.session_id}` : "pockly:update",
    data: {
      url: sameOriginPath(payload.url || "/sessions"),
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Take control of already-open clients as soon as this SW activates. The SW is
// registered lazily (only when the user enables push), so without claim() the
// tab that registered it stays uncontrolled — and WindowClient.navigate()
// rejects on an uncontrolled client, which used to dead-end notificationclick.
// Safe here because this SW has no fetch handler, so claiming intercepts nothing.
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetURL = new URL(event.notification.data?.url || "/sessions", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        try {
          await client.navigate(targetURL);
          return await client.focus();
        } catch {
          // navigate() rejects when this SW doesn't control the client (e.g. a
          // tab opened before the lazily-registered SW activated). Don't
          // dead-end — break out and open a fresh window at the target below.
          // Previously the un-caught rejection skipped the openWindow fallback
          // entirely, so clicking the notification did nothing until a reload.
          break;
        }
      }
    }
    return clients.openWindow(targetURL);
  })());
});

function sameOriginPath(value) {
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin) return "/sessions";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/sessions";
  }
}
