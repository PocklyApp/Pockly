# pockly-daemon

Local agent for Pockly. Runs on the user's dev machine, watches Claude Code and
Codex session files, and connects outbound to Pockly Nexus so the user's browser can
read history and inject prompts.

**Status**: active Pockly daemon. The daemon parses Claude Code and Codex sessions, keeps a warm session index, connects outbound to Nexus, syncs session windows on demand, and supports account-level computer setup through `pockly-daemon setup`.

## Install

Install latest release on macOS/Linux:

    curl -fsSL https://your-nexus.example/install.sh | \
      POCKLY_DAEMON_BASE_URL=https://your-nexus.example/pockly-daemon bash

Install to a user-writable directory instead of `/usr/local/bin`:

    curl -fsSL https://your-nexus.example/install.sh | \
      POCKLY_DAEMON_BASE_URL=https://your-nexus.example/pockly-daemon \
      POCKLY_DAEMON_INSTALL_DIR="$HOME/.local/bin" bash

Install latest release on Windows PowerShell:

    $env:POCKLY_DAEMON_BASE_URL="https://your-nexus.example/pockly-daemon"; irm https://your-nexus.example/install.ps1 | iex

Install a specific tag:

    curl -fsSL https://your-nexus.example/install.sh | \
      POCKLY_DAEMON_BASE_URL=https://your-nexus.example/pockly-daemon \
      POCKLY_DAEMON_VERSION=v0.1.0 bash

## Build

Local platform:

    make build
    ./bin/pockly-daemon --version
    ./bin/pockly-daemon setup --nexus-url http://127.0.0.1:8787 --install-service=false
    ./bin/pockly-daemon serve --connect-nexus --nexus-url http://127.0.0.1:8787

All three target platforms × architectures:

    make cross
    ls bin/

## Local API

Run:

    ./bin/pockly-daemon serve

Endpoints:

    GET /healthz
    GET /api/projects
    GET /api/sessions/<session_id>/blocks

Flags:

    ./bin/pockly-daemon serve --listen 127.0.0.1:8947
    ./bin/pockly-daemon serve --claude-home ~/.claude/projects --codex-home ~/.codex
    ./bin/pockly-daemon serve --refresh-interval 5s

## Setup Flow

Run:

    pockly-daemon setup --nexus-url https://your-nexus.example

The setup command runs the current setup paths in parallel:

- On a desktop machine, it tries to open the Pockly local setup page in the default browser. After sign-in, the web app claims the daemon and posts the token package back to the daemon through a one-time loopback callback.
- In the terminal, it also prints the standard computer authorization URL, user code, and QR code. This is the fallback for remote/headless machines or failed browser auto-open.
- The first completed path wins and the other path is canceled.

For remote/headless installs, use the terminal authorization URL or QR code. The daemon prints the mobile claim details and requires a local `[y/N]` confirmation before receiving daemon tokens.

The local loopback callback URL is an internal implementation detail and should not be copied as a user-facing setup URL.

## Diagnostics

The open-source daemon does not send network telemetry by default. It writes
local logs and can optionally send minimal operational diagnostics to a
self-hosted Nexus telemetry provider that you configure yourself. Diagnostics
never include prompts, cwd paths, session content, tool results, or tokens.

After your self-hosted Nexus has a diagnostics provider, enable daemon uploads
explicitly with:

    POCKLY_TELEMETRY=on pockly-daemon setup

Optionally override the self-hosted telemetry endpoint. The endpoint alone does
not enable uploads; keep `POCKLY_TELEMETRY=on` in the environment:

    POCKLY_TELEMETRY=on \
      POCKLY_TELEMETRY_ENDPOINT=https://your-nexus.example/api/telemetry/daemon \
      pockly-daemon setup

## Layout

    cmd/pockly-daemon/   entry point
    internal/api/        local HTTP API
    internal/agent/      shared block schema + per-agent parsers
    internal/device/     persisted daemon device identity
    internal/pair/       Nexus setup client
    internal/version/    semver + ldflags-injected commit/date
    bin/                 build output (gitignored)

## Conventions

- Go 1.23, stdlib-first. New deps only when there's a concrete reason — list rationale in PR.
- Module path: `github.com/PocklyApp/Pockly/daemon`
- All long-lived processes pass through context cancellation; no `os.Exit` outside `main`.
