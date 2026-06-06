/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { ThemeProvider } from "./theme";
import { initObservability } from "./observability";
import { reportWebTelemetry } from "./api";
import "./i18n";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root");

initObservability();

// v0.1.37: catch-all for uncaught render/runtime errors. Until this hook
// existed, a JS exception thrown deep inside React's render would white-
// screen the user AND leave us blind cloud-side — there was no telemetry
// path from "web crashed at customer X" to our dashboards unless they had
// Faro enabled in runtime config. Now we POST one event to our own relay
// so the dashboard sees it regardless of Faro's status. Truncate the
// message + stack so a chatty stack trace can't blow the 80-char limit.
window.addEventListener("error", (event) => {
  reportWebTelemetry({
    name: "web_page_error",
    errorCode: `${event.message ?? "uncaught"}@${event.filename ?? ""}:${event.lineno ?? 0}`.slice(0, 80),
  });
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error
    ? event.reason.message
    : typeof event.reason === "string" ? event.reason : "unhandled_rejection";
  reportWebTelemetry({
    name: "web_page_error",
    errorCode: `rejection:${reason}`.slice(0, 80),
  });
});

// Renderer fixture mode (dev-only). Visiting `/test/renderer?fixture=…`
// on the vite dev server mounts a minimal synthetic session instead of
// the full App, so Playwright L3 specs can assert against deterministic
// R1–R10 rendering without going through auth / wrapper / relay.
// `import.meta.env.DEV` is statically false in production builds, so
// the dynamic import + the entire renderer-fixture module + its JSON
// dependencies all tree-shake out of the prod bundle.
if (import.meta.env.DEV && window.location.pathname === "/test/renderer") {
  void import("./renderer-fixture").then(({ mountRendererFixture }) => {
    mountRendererFixture(rootEl);
  });
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>,
  );
}
