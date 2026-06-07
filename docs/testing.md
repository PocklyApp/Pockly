# Testing

## Tier 1: Unit And Contract Tests

No credentials required.

```bash
npm test
npm run web:lint
npm run web:typecheck
npm run web:build
npm --workspace nexus run validate
npm --workspace web test
cd daemon && go test ./...
```

## Tier 2: Local Self-Hosted Stack

No model provider credentials required unless you send real prompts to an agent.

```bash
npm --workspace nexus exec -- pockly-nexus serve --host 127.0.0.1 --port 8787 --data-dir ./.local/nexus
npm --workspace web run dev
./daemon/bin/pockly-daemon setup --nexus-url http://127.0.0.1:8787 --install-service=false
./daemon/bin/pockly-daemon serve --connect-nexus --nexus-url http://127.0.0.1:8787
```

Use this tier to verify auth, setup, catalog sync, device presence, and basic UI
flows.

## Tier 3: Real Agent Tests

Credential-required and optional.

Use this tier only when you need to verify actual Claude Code or Codex behavior:

- model switching;
- native permission prompts;
- tool execution rendering;
- app-server or PTY behavior;
- provider-specific error handling.

Real-agent tests must skip by default when required CLIs or credentials are
missing. Never commit real API keys or local agent logs.

## Boundary Tests

The public repository includes tests that prevent private deployment details and
obsolete security claims from leaking into public docs and runtime contracts.
Keep those tests updated when public terminology changes.
