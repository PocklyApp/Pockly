/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Ambient type declarations for the Vite SPA.
//
// R10: Side-effect CSS imports (e.g. `import "katex/dist/katex.min.css"`)
// need a module shim under TS's "bundler" moduleResolution — Vite
// handles them at build time, but tsc needs to know the import is
// well-typed (as `void` / no exports). This wildcard covers any CSS
// module path, relative or non-relative.
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
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
