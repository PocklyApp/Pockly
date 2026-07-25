# Development

## Prerequisites

- Node.js 20 or newer (enforced by `engines`).
- npm 10 or newer, which ships with Node 20.
- Go 1.23 or newer.
- Docker, optional for containerized Nexus.
- Claude Code or Codex CLI, optional for real-agent testing.

## Install Dependencies

From the repository root:

```bash
npm install
```

## Build The Daemon

```bash
cd daemon
make build
cd ..
```

## Run A Local Stack

Use three terminals.

Terminal 1, Nexus:

```bash
npm --workspace nexus exec -- pockly-nexus serve \
  --host 127.0.0.1 \
  --port 8787 \
  --data-dir ./.local/nexus
```

Terminal 2, web:

```bash
npm --workspace web run dev
```

Terminal 3, daemon:

```bash
./daemon/bin/pockly-daemon setup --nexus-url http://127.0.0.1:8787 --install-service=false
./daemon/bin/pockly-daemon serve --connect-nexus --nexus-url http://127.0.0.1:8787
```

`./.local/nexus` keeps development state inside the checkout, where `.gitignore`
already covers it. Delete the directory to start over. The production default is
`~/.pockly/nexus`; see [self-hosting.md](./self-hosting.md).

Open [http://127.0.0.1:5173](http://127.0.0.1:5173).

Create a local account in the web UI. The default self-hosted Nexus runtime
uses password-based accounts and signs you in after account creation. It does
not send outbound email, so there is no email verification or password reset.

## Common Checks

These are what CI runs:

```bash
npm test
npm run web:lint
npm run web:typecheck
npm run web:build
cd daemon && go test ./...
```

Renderer end-to-end tests need a running dev server and are not part of CI:

```bash
npm run web:test:e2e
```

## Working With Agents

Real Claude Code and Codex flows use the CLIs installed on your computer and
your provider credentials. Do not commit API keys, tokens, local session logs,
or `.env` files.

Credential-required tests should be opt-in and skipped by default.
