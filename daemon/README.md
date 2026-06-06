# pockly-daemon

Local agent for Pockly. Runs on the user's dev machine, watches Claude Code and
Codex session files, and connects outbound to a relay so the user's browser can
read history and inject prompts.

**Status**: active Pockly daemon. The daemon parses Claude Code and Codex sessions, keeps a warm session index, connects outbound to the relay, syncs encrypted Agent Conversation windows on demand, and supports account-level computer setup through `pockly-daemon setup`.

## Install

Install latest release on macOS/Linux:

    curl -fsSL https://cdn.pocklyapp.com/install.sh | bash

Install to a user-writable directory instead of `/usr/local/bin`:

    curl -fsSL https://cdn.pocklyapp.com/install.sh | POCKLY_DAEMON_INSTALL_DIR="$HOME/.local/bin" bash

Install latest release on Windows PowerShell:

    irm https://cdn.pocklyapp.com/install.ps1 | iex

Install a specific tag:

    curl -fsSL https://cdn.pocklyapp.com/install.sh | POCKLY_DAEMON_VERSION=v0.1.0 bash

## Build

Local platform:

    make build
    ./bin/pockly-daemon --version
    ./bin/pockly-daemon setup --relay-url http://127.0.0.1:8080
    ./bin/pockly-daemon serve

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

    pockly-daemon setup

The setup command runs the current setup paths in parallel:

- On a desktop machine, it tries to open the Pockly local setup page in the default browser. After sign-in, the web app claims the daemon and posts the token package back to the daemon through a one-time loopback callback.
- In the terminal, it also prints the standard device authorization URL, user code, and QR code. This is the fallback for remote/headless machines or failed browser auto-open.
- The first completed path wins and the other path is canceled.

For remote/headless installs, use the terminal authorization URL or QR code. The daemon prints the mobile claim details and requires a local `[y/N]` confirmation before receiving daemon tokens.

The local loopback callback URL is an internal implementation detail and should not be copied as a user-facing setup URL.

## Telemetry

The daemon sends minimal operational telemetry to the relay by default so
install, login, setup, sync, and remote control failures can be diagnosed.
Telemetry goes to `https://pocklyapp.com/api/telemetry/daemon` or the current
`--relay-url`; it never sends prompts, cwd paths, session content, tool results,
tokens, or E2E payloads.

Disable it with:

    POCKLY_TELEMETRY=off pockly-daemon setup

Override the relay proxy endpoint with:

    POCKLY_TELEMETRY_ENDPOINT=https://pocklyapp.com/api/telemetry/daemon

## Layout

    cmd/pockly-daemon/   entry point
    internal/api/        local HTTP API
    internal/agent/      shared block schema + per-agent parsers
    internal/device/     persisted daemon device identity
    internal/pair/       relay setup client
    internal/version/    semver + ldflags-injected commit/date
    bin/                 build output (gitignored)

## Conventions

- Go 1.23, stdlib-first. New deps only when there's a concrete reason — list rationale in PR.
- Module path: `github.com/PocklyApp/Pockly/daemon`
- All long-lived processes pass through context cancellation; no `os.Exit` outside `main`.
