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

The install scripts run `setup` immediately after installing. Set
`POCKLY_DAEMON_NO_SETUP=1` to install without it and run setup later. Setup
targets `http://127.0.0.1:8787` unless `POCKLY_NEXUS_URL` says otherwise.

`POCKLY_DAEMON_BASE_URL` is required; the scripts fail with a usage message if it
is unset. There is no built-in download host.

## Build

`make build` produces two binaries: the daemon and `pockly-claude-wrapper`, a
shim the daemon launches to drive Claude Code's PTY flows.

    make build
    ./bin/pockly-daemon --version
    ./bin/pockly-daemon setup --nexus-url http://127.0.0.1:8787 --install-service=false
    ./bin/pockly-daemon serve --connect-nexus --nexus-url http://127.0.0.1:8787

Cross-compile both binaries for all six ship targets (darwin, linux, and windows
on arm64 and amd64), producing 12 files:

    make cross
    ls bin/

## Local API

Run:

    ./bin/pockly-daemon serve

Endpoints, all restricted to same-machine non-browser callers by a loopback
Host/Origin guard:

    GET /healthz
    GET /api/status
    GET /api/projects
    GET /api/sessions/<session_id>/blocks
    GET /api/sessions/<session_id>/blocks/stream

Registered only when the corresponding subsystem is active:

    /api/dev/terminal-sessions, /api/dev/terminal-sessions/<id>
    /api/dev/permission-requests, /api/dev/permission-requests/<id>

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

## Overrides That Weaken Security

These exist for automated testing and constrained environments. Each removes a
defense; do not set them on a shared machine. `docs/security-model.md` has the
full list.

| Variable | Effect |
| --- | --- |
| `POCKLY_AUTO_CONFIRM_PAIR=1` | Skips the local `[y/N]` pairing confirmation described above. That prompt is what stops someone remote from walking a user through approving a pairing they did not start. |
| `POCKLY_ALLOW_PLAINTEXT_KEY=1` | Writes the daemon Ed25519 private key as cleartext into `device.json` instead of using the OS keyring. |
| `POCKLY_FORCE_LOCAL_INSTALL=1` / `POCKLY_FORCE_REMOTE_INSTALL=1` | Override the local-vs-remote detection that decides whether the confirmation prompt is shown at all. |

## Diagnostics

The daemon does not send network telemetry by default. It writes local logs and
can optionally send minimal operational diagnostics to a self-hosted Nexus
telemetry provider that you configure yourself.

Diagnostic events carry a fixed set of scalar fields with no free-text payload,
and error text is mapped onto a fixed vocabulary before it is sent (unrecognized
errors become `redacted_error` or `path_error`). The intent is that prompts, cwd
paths, session content, tool results, and tokens never leave the machine; see
`docs/security-model.md` for how strongly that is enforced.

After your self-hosted Nexus has a diagnostics provider, enable daemon uploads
explicitly with:

    POCKLY_TELEMETRY=on pockly-daemon setup

Optionally override the self-hosted telemetry endpoint. The endpoint alone does
not enable uploads; keep `POCKLY_TELEMETRY=on` in the environment:

    POCKLY_TELEMETRY=on \
      POCKLY_TELEMETRY_ENDPOINT=https://your-nexus.example/api/telemetry/daemon \
      pockly-daemon setup

## Layout

    cmd/pockly-daemon/          entry point
    cmd/pockly-claude-wrapper/  PTY shim for Claude Code
    cmd/fake-claude/            test double used by Go tests
    cmd/gen-password-hash/      local E2E helper for seeding a Nexus password

    internal/agent/         shared block schema + per-agent parsers
    internal/agentexec/     agent process launch
    internal/agentsettings/ model and permission settings discovery
    internal/api/           local HTTP API
    internal/claudelauncher/ Claude Code launch paths
    internal/control/       Nexus control-channel request handling
    internal/device/        persisted daemon device identity
    internal/index/         warm session index
    internal/localsetup/    loopback setup callback server
    internal/pair/          Nexus setup client
    internal/permission/    native permission request relay
    internal/relay/         catalog and turn sync to Nexus
    internal/runner/        long-lived process supervision
    internal/telemetry/     opt-in diagnostics
    internal/terminal/      PTY session management
    internal/version/       semver + ldflags-injected commit/date

    bin/                    build output (gitignored)

## Conventions

- Go 1.23, stdlib-first. New deps only when there's a concrete reason — list rationale in PR.
- Module path: `github.com/PocklyApp/Pockly/daemon`
- Long-lived processes pass through context cancellation. Keep `os.Exit` at
  process boundaries: `main`, and the Windows restart and wrapper exit paths that
  must propagate a specific exit code.
