/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Ambient type declarations for the Vite SPA.
//
// Side-effect CSS imports (e.g. `import "katex/dist/katex.min.css"`) need a
// module shim under TS's "bundler" moduleResolution. Vite handles them at build
// time, but tsc needs to know the import is well-typed. This wildcard covers any
// CSS module path, relative or non-relative.
declare module "*.css";

// Renderer fixture mode (src/renderer-fixture.tsx) reads
// `import.meta.env.DEV` to skip mounting in production builds.
// Without this shim, tsc rejects `import.meta.env` under our
// "bundler" moduleResolution. Mirrors the relevant subset of Vite's
// own client.d.ts; we don't pull the full vite/client triple-slash
// directive because the project hasn't needed any other env vars
// elsewhere.
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly VITE_POCKLY_NEXUS_URL?: string;
  readonly VITE_POCKLY_RELAY_URL?: string;
  readonly VITE_POCKLY_INSTALL_SH_URL?: string;
  readonly VITE_POCKLY_INSTALL_PS1_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  readonly POCKLY_CONFIG?: {
    readonly nexusUrl?: string;
    readonly relayUrl?: string;
    readonly installShUrl?: string;
    readonly installPs1Url?: string;
    readonly installUnixCommand?: string;
    readonly installWindowsCommand?: string;
    readonly authHostLabel?: string;
    readonly telemetryEnabled?: string | boolean;
    readonly telemetryDebug?: string | boolean;
    readonly releaseSha?: string;
    readonly environment?: string;
  };
  readonly __POCKLY_RUNTIME_CONFIG__?: Window["POCKLY_CONFIG"];
}
