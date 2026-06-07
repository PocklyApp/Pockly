# Pockly

Pockly is an open-source remote workspace for local agent sessions. It lets you
open a browser UI, connect a daemon running on your own computer, and continue
Claude Code or Codex sessions through Pockly Nexus.

Pockly does not run your agent for you. Claude Code, Codex, model providers,
API keys, tools, and working directories stay on the connected computer. Nexus
is the connection layer that authenticates browsers and daemons, stores synced
session metadata/history, forwards prompts and native agent permission requests,
and streams status.

## What Is In This Repository

```text
web/       React + Vite web app.
daemon/    Local daemon that indexes Claude Code and Codex sessions.
nexus/     Self-hosted Pockly Nexus Node.js runtime.
docs/      Architecture, development, self-hosting, testing, and troubleshooting.
```

This repository contains the open-source product code and self-hosted Nexus runtime.
Operator-specific hosting, routing, account policy, billing, and release
distribution setups are configured separately by each deployment.

## Supported Agents

- Claude Code: session indexing, history sync, prompt forwarding, run settings,
  native permission prompt forwarding, and terminal/PTY-backed flows.
- Codex: session indexing and app-server based runtime support when the local
  Codex CLI exposes the required app-server capability.

Real-agent tests require the corresponding local CLI and provider credentials.
They are optional and must stay skipped by default.

## Security Model In Plain Terms

- The daemon runs locally and connects outbound to Nexus. You do not need to
  open inbound ports on your computer.
- Nexus stores account, connected-computer, browser-access metadata, and synced
  session history so browser clients can list and reopen sessions. Treat Nexus
  storage as sensitive application data.
- The browser keeps a local Ed25519 signing key to authenticate browser access
  to Nexus. This is browser access state, not a separate session-history
  secrecy layer.
- Pockly does not implement its own tool permission policy. It forwards native
  Claude Code or Codex approval requests to the web UI and sends your decision
  back to the agent.
- Open-source telemetry is off by default. Optional diagnostics require a
  self-hosted provider that you configure and enable explicitly.

See [docs/security-model.md](./docs/security-model.md) for details.

## Prerequisites

- Node.js 20 or newer.
- npm 10 or newer.
- Go 1.23 or newer.
- Git.
- Optional: Docker for the self-hosted Nexus container.
- Optional: Claude Code and/or Codex CLI for real agent sessions.

## Quick Start From A Clean Checkout

Install JavaScript dependencies once from the repository root:

```bash
npm install
```

Build the daemon:

```bash
cd daemon
make build
cd ..
```

Start Nexus in terminal 1:

```bash
npm --workspace nexus exec -- pockly-nexus serve \
  --host 127.0.0.1 \
  --port 8787 \
  --data-dir ./.local/nexus
```

Start the web app in terminal 2:

```bash
npm --workspace web run dev
```

Start the daemon in terminal 3:

```bash
./daemon/bin/pockly-daemon setup --nexus-url http://127.0.0.1:8787 --install-service=false
./daemon/bin/pockly-daemon serve --connect-nexus --nexus-url http://127.0.0.1:8787
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Create an account through
the web UI, then connect the daemon through the setup flow. The default
self-hosted Nexus runtime provides password-based local accounts and signs in
after account creation; it does not bundle outbound email delivery.

More detail: [docs/development.md](./docs/development.md).

## Self-Hosting Nexus

The default self-hosted Nexus profile is intentionally small:

- SQLite metadata.
- Local filesystem release/object storage.
- In-process daemon/browser control hub.
- No network telemetry unless you explicitly configure and enable a self-hosted
  diagnostics provider.

Run it directly:

```bash
npm --workspace nexus exec -- pockly-nexus serve \
  --host 0.0.0.0 \
  --port 8787 \
  --data-dir ~/.pockly/nexus
```

Run it with Docker:

```bash
docker build -f nexus/Dockerfile -t pockly-nexus .
docker run --rm -p 8787:8787 -v pockly-nexus-data:/var/lib/pockly-nexus pockly-nexus
```

Production self-hosting can add Postgres, Redis, and S3-compatible release
storage. See [docs/self-hosting.md](./docs/self-hosting.md).

## Development Commands

```bash
npm test                         # Nexus + web tests
npm run web:lint                 # Web lint
npm run web:typecheck            # TypeScript checks
npm run web:build                # Production web build
npm run nexus:test               # Nexus contract/runtime tests
cd daemon && go test ./...       # Daemon tests
```

Testing levels and credential requirements are documented in
[docs/testing.md](./docs/testing.md).

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR. Use the issue
templates for bug reports, feature requests, and documentation problems. Report
security issues through [SECURITY.md](./SECURITY.md), not public issues.

## Troubleshooting

Common setup, daemon, Nexus, and browser problems are covered in
[docs/troubleshooting.md](./docs/troubleshooting.md).

## License

Apache License 2.0. See [LICENSE](./LICENSE).
