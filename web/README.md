# Pockly Web

React + Vite + TypeScript SPA for Pockly.

Run `npm run dev` against a local relay. Vite proxies `/api` and `/ws` to
`127.0.0.1:8080` by default.

**Status**: active Pockly web app. The SPA supports account login, local daemon setup, mobile join, workspace session catalog, Agent Conversation reading, prompt sending, device management, and short voice prompt transcription.

## Run

    npm install
    npm run dev    # dev server on :5173, expects a relay on :8080
    npm run build  # produces dist/

## Observability

Production builds can initialize browser telemetry from runtime config generated
by the deployment environment:

- `GRAFANA_FARO_URL`
- `GRAFANA_FARO_APP_KEY` (optional if the endpoint does not require it)

The client never sends prompts, session payloads, device tokens, passwords, or
verification codes to Faro. API request and response bodies are not collected.

## Layout

    src/main.tsx     entry
    src/App.tsx      root component (placeholder)
    src/styles.css   global styles

## Conventions

- React 19, Vite 6, TypeScript strict (with `exactOptionalPropertyTypes` etc).
- No CSS framework. Hand-written CSS, port spike styles in P2.
- Streaming markdown blocks must NOT go through React state — use refs + direct DOM mutation per delta. Only the block list goes through state.
- Markdown via `marked` + `highlight.js` (matches the spike).
