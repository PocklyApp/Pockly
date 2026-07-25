# Testing

## Tier 1: Unit And Contract Tests

No credentials required. This is the gate every change must pass.

```bash
npm test                    # nexus tests, then web tests
npm run web:lint
npm run web:typecheck
npm run web:build
cd daemon && go test ./...
```

`npm test` already runs both workspaces. `npm run nexus:test`,
`npm --workspace nexus run validate`, and `npm --workspace web test` are the
individual pieces, useful when iterating on one package. In the `nexus`
workspace, `test` and `validate` are the same command.

## Tier 2: Local Self-Hosted Stack

No model provider credentials required unless you send real prompts to an agent.

```bash
npm --workspace nexus exec -- pockly-nexus serve --host 127.0.0.1 --port 8787 --data-dir ./.local/nexus
npm --workspace web run dev
./daemon/bin/pockly-daemon setup --nexus-url http://127.0.0.1:8787 --install-service=false
./daemon/bin/pockly-daemon serve --connect-nexus --nexus-url http://127.0.0.1:8787
```

`./.local/nexus` keeps throwaway state inside the checkout, where `.gitignore`
already covers it. Delete the directory to reset. Production defaults differ; see
[self-hosting.md](./self-hosting.md).

Use this tier to verify auth, setup, catalog sync, device presence, and basic UI
flows.

## Renderer End-To-End Tests

Playwright specs in `web/tests/playwright/` render synthetic session fixtures.
They need a Vite dev server but no Nexus, daemon, Docker, or provider
credentials.

```bash
npm --workspace web run dev      # terminal 1
npm run web:test:e2e             # terminal 2
```

First run needs browsers: `npx playwright install chromium`. Override the target
with `POCKLY_WEB_URL`.

## Tier 3: Real Agent Tests

Credential-required and optional. Every one of these skips itself when its
environment variables are unset, so Tier 1 stays credential-free.

| Environment variable | Enables |
| --- | --- |
| `POCKLY_LIVE_MODEL_TEST=1` | Model lineup checks against the real `claude` CLI |
| `POCKLY_CLAUDE_BIN` | Claude Code CLI model discovery against that binary |
| `POCKLY_CODEX_BIN` (plus `POCKLY_CODEX_CWD`) | Codex app-server sandbox integration |
| `POCKLY_CODEX_BIN`, `POCKLY_CODEX_ROLLOUT`, `POCKLY_CODEX_THREAD`, `POCKLY_CODEX_CWD` | Codex session resume integration |

Use this tier only when you need to verify actual Claude Code or Codex behavior:

- model switching;
- native permission prompts;
- tool execution rendering;
- app-server or PTY behavior;
- provider-specific error handling.

Never commit real API keys or local agent logs.

## Boundary Tests

`nexus/test/public-boundary.test.js` runs as part of `npm test` and fails the
build on two classes of mistake that are easy to miss in review.

Leak checks, across every git-tracked file:

- deployment-specific domains and per-account edge hostnames;
- cloud resource identifiers (account, zone, database, namespace IDs);
- credential material (provider keys, tokens, private keys, JWTs);
- contributor home directory paths and personal email addresses;
- routable IP addresses;
- secret-bearing files such as `.env`, `wrangler.toml`, `*.pem`, or database
  files entering version control.

Documentation-accuracy checks:

- every `/api/runtime` capability key is documented in `nexus/README.md` and
  `nexus/docs/deployment.md`;
- every `POCKLY_NEXUS_*` variable the CLI reads is documented;
- the overrides that weaken security controls are documented;
- the dev login route stays behind its flag;
- every relative Markdown link resolves;
- `docs/security-model.md` does not claim an absolute diagnostics guarantee the
  redaction code cannot deliver.

When a documented fact legitimately changes, update the documentation and the
expectation in that test in the same commit. If a check produces a false
positive, narrow the allowlist rather than deleting the check.

## Time-Dependent Tests

Tests that assert on retention, TTL, or pruning must pin the relevant window
(for example `POCKLY_HOT_TURN_TTL_DAYS`) rather than relying on the default. A
test with fixed fixture timestamps and a default TTL passes until wall-clock time
crosses the window, then fails for reasons unrelated to the change that triggered
it.
