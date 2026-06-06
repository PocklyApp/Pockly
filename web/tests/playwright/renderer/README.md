# Renderer specs (R1-R10)

E2E coverage for the R1–R10 renderer series, driven by the dev-only
fixture mode at `/test/renderer?fixture=<name>`.

## Why a separate directory

These specs cover rendering. They mount synthetic SessionTurn lists via the
fixture mode and assert the resulting DOM. They do not require the relay,
daemon, Docker, or model provider credentials.

## Running locally

Run a Vite dev server and then Playwright:

```bash
# Terminal 1
npm run dev

# Terminal 2
npx playwright test tests/playwright/renderer/

# Run one spec
npx playwright test tests/playwright/renderer/r3-bash.spec.ts
```

If you run Vite on a non-default port:

```bash
POCKLY_WEB_URL=http://127.0.0.1:5173 npx playwright test tests/playwright/renderer/
```

The fixture page is gated by `import.meta.env.DEV` in
`src/main.tsx` — production builds short-circuit the route to the
normal SPA.

## Adding a new fixture

1. Drop a JSON file in `src/test-fixtures/<name>.json` with shape:
   ```json
   {
     "name": "<name>",
     "session": { "session_id": "...", "device_id": "...", "agent": "claude-code" },
     "turns": [/* SessionTurn[] */]
   }
   ```
2. Import + register in `src/renderer-fixture.tsx`'s `FIXTURES` map.
3. Reference from a spec via `await page.goto("/test/renderer?fixture=<name>")`.

The catalog in `FIXTURES` is the source of truth; an unregistered
name renders a visible `.fixture-error`.

## What's NOT covered here

- L1 unit tests (`npm test`) own pure helpers — `tokenUsageTier`,
  `parseReaderPreferences`, `hasMathSyntax`, `summarizePendingPermissions`,
  every `ToolSpec.display`. Specs in this directory only assert what L1
  cannot (rendered DOM, click gestures, lazy-chunk network behavior).
- The real inject/wrapper path. Specs that need it (R5-5 effort prefix
  interceptor) `page.route("**/inject", …)` the request — they don't
  send a real message through the relay.
- Full relay/daemon E2E. Those tests should be added back once the
  worker-native relay local stack is implemented in this monorepo.
