/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const nexusURL = process.env.POCKLY_NEXUS_URL || process.env.POCKLY_RELAY_URL || "http://127.0.0.1:8787";
const nexusWSURL = nexusURL.replace(/^http/, "ws");
const daemonURL = process.env.POCKLY_DAEMON_URL || "http://127.0.0.1:8948";

// During dev, Nexus is reachable at localhost:8787 by default. The `/api`
// and `/ws` proxies let `npm run dev` talk to a local Nexus without CORS
// gymnastics.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: nexusURL,
        ws: true,
      },
      "/ws": {
        target: nexusWSURL,
        ws: true,
      },
      "/daemon-api": {
        target: daemonURL,
        rewrite: (path) => path.replace(/^\/daemon-api/, "/api"),
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
});
