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

The client never sends prompts, session payloads, browser or daemon access
tokens, passwords, or verification codes as diagnostic attributes. API request
and response bodies are not collected.

## Layout

    src/main.tsx     entry
    src/App.tsx      workspace application shell
    src/styles.css   global styles

## Conventions

- React 19, Vite 6, TypeScript strict (with `exactOptionalPropertyTypes` etc).
- No CSS framework. Hand-written CSS.
- Streaming markdown blocks must NOT go through React state — use refs + direct DOM mutation per delta. Only the block list goes through state.
- Markdown via `marked` + `highlight.js` (matches the spike).
