# Contributing To Pockly

Thank you for contributing. This repository is intended to be usable from a
clean public checkout without private deployment context.

## Before You Start

1. Read [README.md](./README.md) for the product model.
2. Read [docs/security-model.md](./docs/security-model.md) before changing
   auth, browser access, session sync, permissions, or telemetry.
3. Read [docs/development.md](./docs/development.md) for local setup.
4. Check existing issues before opening a duplicate.

## Development Setup

```bash
npm install
cd daemon && make build && cd ..
```

Then use three terminals for a local stack:

```bash
# Terminal 1
npm --workspace nexus exec -- pockly-nexus serve --host 127.0.0.1 --port 8787 --data-dir ./.local/nexus

# Terminal 2
npm --workspace web run dev

# Terminal 3
./daemon/bin/pockly-daemon setup --nexus-url http://127.0.0.1:8787 --install-service=false
./daemon/bin/pockly-daemon serve --connect-nexus --nexus-url http://127.0.0.1:8787
```

## Test Expectations

Run the smallest relevant tests while iterating, then run the broader checks
before opening a PR:

```bash
npm test
npm run web:lint
npm run web:typecheck
npm run web:build
cd daemon && go test ./...
```

Real Claude Code or Codex tests are optional. They must be clearly marked as
credential-required and skipped by default.

## Pull Request Guidelines

- Keep public terminology consistent: use **Pockly Nexus** for the connection
  layer. Use `relay` only for explicit legacy compatibility.
- Do not add private SaaS domains, cloud-provider implementation details,
  account IDs, bucket names, or secrets to public files.
- Do not claim a browser-only secrecy boundary for session history. Nexus
  stores synced history for the account.
- Treat browsers as authenticated access clients, not user-visible computers.
- Do not implement a Pockly-specific permission policy. Pockly forwards native
  agent permission requests.
- Include tests for protocol, storage, auth, permission, or sync changes.
- Update docs when public behavior or setup commands change.

## Code Style

- Go code must be formatted with `gofmt`.
- TypeScript should pass `npm run web:lint` and `npm run web:typecheck`.
- Prefer comments that explain security, protocol, concurrency, or compatibility
  decisions. Remove stale implementation-history comments.
- Do not commit generated artifacts, local databases, logs, `.env` files, or
  `node_modules`.

## Security Issues

Do not open public issues for vulnerabilities. Follow [SECURITY.md](./SECURITY.md).
