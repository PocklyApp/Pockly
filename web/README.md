# Pockly Web

React + Vite + TypeScript SPA for Pockly.

Run `npm run dev` against a local Nexus. Vite proxies `/api` and `/ws` to
`127.0.0.1:8787` by default. Override with `POCKLY_NEXUS_URL` when needed.

**Status**: active Pockly web app. The SPA supports account login, local daemon setup, mobile join, workspace session catalog, agent session reading, prompt sending, connected-computer management, and short voice prompt transcription.

## Run

    npm install
    npm run dev    # dev server on :5173, expects Nexus on :8787
    npm run build  # produces dist/

## Diagnostics

The open-source web client does not send network telemetry by default. Runtime
config may opt in to same-origin diagnostic events with `telemetryEnabled` only
after your self-hosted Nexus has a diagnostics provider. `telemetryDebug` only
writes sanitized event names to the local browser console.

Diagnostic events carry an enumerated event name, a path, a status, a duration,
a session id, and an error code. API request and response bodies are not
collected.

The error code field is the one that could plausibly leak, so it fails closed:
`safeTelemetryErrorCode` in `src/api.ts` replaces anything that is not an enum
token (lowercase words, digits, `_ . : -`) with `unspecified_error`. A caller that
forwards a raw exception message gets the placeholder, not a truncated message.
The uncaught-error handlers in `src/main.tsx` report only the error constructor
name for the same reason. See
[../docs/security-model.md](../docs/security-model.md).

## Layout

    src/main.tsx           entry
    src/App.tsx            workspace application shell
    src/api.ts             Nexus HTTP/SSE client
    src/crypto.ts          browser Ed25519 device identity
    src/observability.ts   opt-in diagnostics with attribute allowlisting
    src/runtime-config.ts  reads window.POCKLY_CONFIG
    src/components/        shared components, including components/ui primitives
    src/lib/               small helpers (cn, formatting)
    src/content/           static page copy
    src/locales/, i18n.ts  i18next translation catalogs
    src/theme.tsx          theme provider
    src/styles.css         Tailwind entry plus hand-written global styles

## Conventions

- React 19, Vite 6, TypeScript strict (with `exactOptionalPropertyTypes` etc).
- Tailwind CSS 4 via `@tailwindcss/vite`, imported from `src/styles.css`.
  Application-specific styling is still largely hand-written CSS in that file;
  `src/components/ui` holds a small set of Tailwind-based primitives composed
  with `class-variance-authority`, `clsx`, and `tailwind-merge` (see
  `src/lib/cn.ts`).
- Streaming markdown blocks must NOT go through React state — use refs + direct DOM mutation per delta. Only the block list goes through state.
- Markdown via `marked` + `highlight.js`, math via `katex`. All rendered HTML is
  sanitized with `dompurify` before it reaches the DOM.
