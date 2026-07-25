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

// Catch-all for uncaught render/runtime errors. Open-source builds do not send
// network diagnostics by default; reportWebTelemetry only posts when runtime
// config explicitly enables a same-origin self-hosted provider.
//
// These handlers deliberately do NOT forward the error message, filename, or
// stack. An uncaught error is the least predictable string in the app: it can
// carry a URL with a query string, a bundled source path, or a value from an
// upstream API. We report the shape of the failure and nothing else — see
// docs/security-model.md.
function pageErrorCode(kind: "error" | "rejection", value: unknown) {
  if (value instanceof TypeError) return `${kind}_type_error`;
  if (value instanceof RangeError) return `${kind}_range_error`;
  if (value instanceof SyntaxError) return `${kind}_syntax_error`;
  if (value instanceof Error) return `${kind}_${(value.name || "error").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  return `${kind}_nonerror`;
}

window.addEventListener("error", (event) => {
  reportWebTelemetry({
    name: "web_page_error",
    errorCode: pageErrorCode("error", event.error),
  });
});
window.addEventListener("unhandledrejection", (event) => {
  reportWebTelemetry({
    name: "web_page_error",
    errorCode: pageErrorCode("rejection", event.reason),
  });
});

// Renderer fixture mode (dev-only). Visiting `/test/renderer?fixture=...`
// on the vite dev server mounts a minimal synthetic session instead of
// the full App, so Playwright specs can assert rendering without going
// through auth, wrapper, or Nexus.
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
