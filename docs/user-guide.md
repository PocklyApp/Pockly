# Pockly User Guide

<!-- Generated from web/src/content/docs.ts (the former in-app guide). Edit here; keep in sync with product behavior. -->

## What is Pockly?

Pockly is a remote control for the coding agents that run on your computer. Claude Code and Codex keep running locally — on your machine, with your files and your API keys — and Pockly mirrors each session to your phone so you can watch what the agent is doing, steer it mid-run, approve tool actions, and stop or redirect it, all from your phone without having to be at your computer.

### The three pieces

- **Daemon (your computer)** — A small background program you install once. It watches your local Claude Code / Codex sessions and keeps an outbound connection to Pockly Nexus. Nothing inbound is exposed.
- **Pockly Nexus (the connection layer)** — The message hub. It forwards session events between your computer and your phone, and serves the web app. It never sees your model API keys.
- **Web app (your phone or any browser)** — A mobile-first web app you open in a browser or add to your home screen. This is where you watch and steer.

### How a message travels

When you send a prompt from your phone, it goes web → Pockly Nexus → your computer's daemon → the agent. The agent's output (text, thinking, tool calls, file edits, test results) streams back the same way and renders live on your phone.

> Pockly supports both Claude Code and Codex. The agent always runs on your machine — Pockly never moves your runtime or keys to the cloud.

## Before you start

- A computer running macOS, Linux, or Windows with Claude Code and/or Codex already installed and signed in.
- Your agent's own credentials (e.g. your Anthropic or OpenAI auth). Pockly uses whatever the agent already uses — you don't enter any keys into Pockly.
- A phone (or any device) with a modern browser: Safari 16.4+, Chrome, or Firefox.
- The computer stays awake with the daemon running. If the machine sleeps or the daemon stops, sessions become read-only until it's back.

## 1 · Install the daemon

Pockly ships as a single binary. Pick the line for your operating system and run it — the installer downloads the daemon, installs a background service that starts on login and restarts itself if it stops, then opens your browser to finish setup.

### macOS / Linux

```bash
curl -fsSL https://your-nexus.example/install.sh | bash
```

### Windows (PowerShell)

```bash
irm https://your-nexus.example/install.ps1 | iex
```

### What gets installed

- **macOS** — A LaunchAgent (com.pockly.daemon) that runs at login and is kept alive. Logs go to ~/Library/Logs/pockly-daemon.log.
- **Linux** — A systemd user service (pockly-daemon.service) with Restart=always, started for your user session.
- **Windows** — A Scheduled Task (PocklyDaemon) that runs at logon, with no run-time limit so it stays up.

> You only install once per computer. After that the daemon comes back on its own every time you log in.

## 2 · Connect this computer

Connecting links this computer to your Pockly account. It happens in the browser on the computer itself — there's no phone pairing for this step.

1. The installer opens your Pockly web app in your default browser.
2. Sign in to (or create) your Pockly account.
3. Confirm "Connect this computer?" and authorize. Pockly binds the daemon to your account right there on the computer.
4. The daemon connects to Pockly Nexus and a success page shows a QR code for joining on your phone.

### Headless or SSH machines

If the machine has no browser (a server over SSH, for example), the setup also prints an authorization URL, a short user code, and a QR code in the terminal. Approve the request in the terminal and the daemon is connected the same way.

You can re-run setup at any time:

```bash
pockly-daemon setup
```

## 3 · Open Pockly on your phone

1. Scan the QR code shown after setup (or open Connected computers in the workspace and tap "Add a phone" to show a fresh one).
2. The link opens the workspace on your phone and joins your account — no password to type. The QR is one-time and short-lived.
3. Add Pockly to your home screen so it launches fullscreen and can show notifications even when closed.

> The phone QR only creates a web login — it can never hand out a daemon token, so scanning it can't connect a new computer.

## The workspace

The workspace is a single screen that always keeps a header (which computer, online status) and a composer (the input bar) in place. You pick a conversation to take control of; the body in between switches without ever leaving the workspace.

Conversations are grouped by computer and by project — Pockly derives the project from the agent's working directory, so sessions from different repos stay separate and don't cross-mix.

- Active sessions show a green "live" marker; recent ones show how long ago they ran.
- Open a conversation to see its full timeline and continue it from the composer.
- "Load earlier context" at the top of the timeline pages older history in on demand.

## Watching a run

The agent's terminal mirrors to your phone in real time. As the agent works, you see exactly what it does:

- **Tool calls** — Each Read, Edit, Write, Grep, Bash, web fetch, or sub-task renders as its own card with a status badge (e.g. done, hit count, +added −removed).
- **Thinking** — Extended reasoning folds into a collapsible block you can expand when you want the detail.
- **Code & diffs** — File reads and edits are syntax-highlighted. The Diffs pill above the composer opens a drawer summarizing every file the run changed, with a per-file unified diff.

## Steering mid-run

Type into the composer and send to slip a prompt into a session that's already running — correct a refactor, add a constraint, or line up the next task. If the agent is mid-turn, your message is queued and delivered as soon as it's safe, so you never break its loop.

While the agent is streaming, the send button becomes a stop control — tap it to halt the current turn.

### When can you steer?

Whether a conversation is writable depends on how Pockly is connected to it right now:

- **Live-attached** — A wrapped terminal session is running on your computer. The phone and the terminal mirror each other — both can type.
- **Headless resume** — No terminal is attached, but the daemon is online. On your first message Pockly resumes the session headlessly on the computer and streams it back. This is the common mobile-only case.
- **Read-only** — The computer is offline, or the conversation lives on a different computer. You can read history but not send until that computer is back online.

## Approving tool actions

When the agent wants to run something that needs your approval, a permission card appears above the composer with the exact command or action. Tap Allow or Deny right from your phone.

> Pockly only forwards the prompt and your decision. The agent (Claude Code / Codex) still owns the permission decision and runs the command itself — Pockly never executes anything on your machine.

How often you're asked depends on the permission mode in Run config (below).

## Run config

The Run config pill in the composer opens a panel with three controls. They apply to the conversation you're in and are remembered for the next message.

- **Model** — Which model the agent uses for the next turn. The available options come from your agent and setup.
- **Thinking effort** — How much reasoning budget the agent spends: default, low, medium, high, xhigh, or max.
- **Permission mode** — Ask permissions (prompt for each action), Accept edits (auto-approve file edits), Plan mode (plan first, don't act), or Auto mode.

> Available permission modes come from the connected agent and runtime. Pockly forwards the selected native mode; it does not create a separate approval policy.

## Multiple computers

Connect up to 8 computers to one account — a work laptop, a home box, a dev VM. Each one keeps its own session list; nothing cross-mixes. Switch between them from the computer menu in the workspace header, and the conversation list updates to that computer.

## Notifications

Turn on browser notifications in Settings to get pinged when a run needs you — typically when a task finishes, a run fails, or the agent is waiting on a permission decision. Notifications are delivered by web push, so they work even when the app is closed (best when installed to your home screen).

Web push works on iOS Safari 16.4+ and Android Chrome. Pockly sends a lightweight summary; the full conversation loads when you open the app.

## Security & privacy

- Your agent runtime and API keys never leave your computer. Pockly Nexus never sees them — it only forwards session events.
- Traffic is protected by TLS in transit (HTTPS / secure WebSockets).
- Session history is stored on Nexus so you can pick up a conversation in any signed-in browser.
- Each browser keeps its own local access key. Use "Sign this browser out" to remove access from one browser, and revoke a computer from Connected computers to cut that computer off entirely.

> Pockly never asks you to enter passwords, API keys, or card details into the agent. Those stay with your agent and your computer.

## Troubleshooting

- **"This computer is offline"** — The daemon isn't reaching Pockly Nexus. It should auto-run, but you can check it on the computer with the status command below, then refresh the page.
- **"Still connecting"** — The daemon is reaching Pockly Nexus — give it a few seconds. Sessions become writable once it's fully online.
- **Can't load a conversation / access not ready** — This browser isn't authorized yet. Sign in again on this browser, or open Pockly in a browser that already has access.
- **A conversation is read-only** — The computer is offline or the conversation lives on a different computer. Bring that computer back online to steer again.

### Check the daemon

```bash
pockly-daemon status
```

### Update the daemon

```bash
pockly-daemon update
```

## Daemon command reference

You rarely need these — the daemon runs in the background on its own — but they're handy when something needs a nudge.

- **pockly-daemon setup** — Connect this computer and (re)install the background service.
- **pockly-daemon serve** — Run the daemon in the foreground (watch sessions, connect to Pockly Nexus).
- **pockly-daemon login** — Log this daemon into a Pockly account.
- **pockly-daemon status** — Print daemon health.
- **pockly-daemon update** — Check for and install a newer daemon (alias: upgrade).
- **pockly-daemon remote** — Enable or disable Remote Access for same-account mobile connect.

## Uninstalling

Stop and remove the background service, then delete the binary. The exact steps depend on your OS:

### macOS

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.pockly.daemon.plist
rm ~/Library/LaunchAgents/com.pockly.daemon.plist
```

### Linux

```bash
systemctl --user disable --now pockly-daemon.service
rm ~/.config/systemd/user/pockly-daemon.service
```

### Windows (PowerShell)

```bash
schtasks /Delete /TN PocklyDaemon /F
```

Then remove the daemon binary, and revoke the computer from Connected computers in the workspace if you want to cut its access immediately.


