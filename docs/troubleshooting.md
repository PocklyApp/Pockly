# Troubleshooting

## Web Cannot Reach Nexus

Symptoms:

- Login or session list fails.
- The UI reports "Nexus unavailable".

Checks:

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/api/runtime
```

Confirm Vite is proxying `/api` to the Nexus port you started.

## Account Creation Does Not Send Email

The default self-hosted Nexus runtime does not send outbound email. In a local
checkout, creating an account through the web UI should sign you in immediately.
If your deployment shows a verification step, confirm that your own
verification provider is configured and reachable.

## Daemon Does Not Appear Online

Check daemon status:

```bash
./daemon/bin/pockly-daemon serve --connect-nexus --nexus-url http://127.0.0.1:8787
```

Confirm:

- the daemon was set up against the same Nexus URL as the web app;
- the daemon can reach Nexus outbound;
- the local computer is awake;
- Claude Code or Codex CLI is installed if you are testing real agents.

## Session List Is Empty

Pockly can only show sessions the daemon can find in local agent history paths.
Create or open a Claude Code or Codex session locally, keep the daemon running,
and refresh the web app.

## Prompt Sending Fails

Common causes:

- daemon is offline;
- selected session was deleted locally;
- agent CLI is missing from `PATH`;
- agent is waiting for a native permission prompt;
- the selected working directory no longer exists.

Check daemon logs and the browser error message. Pockly does not automatically
retry prompt sends because duplicate sends can change agent behavior.

## Permission Prompt Does Not Show In Web

Pockly forwards native agent permission requests when it can identify them. If
the agent displays a prompt that cannot be safely answered remotely, Pockly
should show a local-confirmation notice. Approve or cancel it on the connected
computer.

## Install Script Needs Sudo

The default Unix installer may need permission to write to `/usr/local/bin`.
Use one of these paths:

```bash
sudo -v
curl -fsSL https://your-nexus.example/install.sh | \
  POCKLY_DAEMON_BASE_URL=https://your-nexus.example/pockly-daemon bash
```

or install into a user-writable directory:

```bash
curl -fsSL https://your-nexus.example/install.sh | \
  POCKLY_DAEMON_BASE_URL=https://your-nexus.example/pockly-daemon \
  POCKLY_DAEMON_INSTALL_DIR="$HOME/.local/bin" bash
```

## Reset Local State

For local development only, stop the stack and remove the local data directory
you passed to Nexus:

```bash
rm -rf ./.local/nexus
```

Do not remove production data directories unless you have a backup.
