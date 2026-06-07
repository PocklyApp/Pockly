# Architecture

Pockly has three public components:

```text
browser web app  <-->  Pockly Nexus  <-->  local daemon  <-->  local agents
```

## Web

The web app is a React/Vite SPA. It authenticates to Nexus, lists connected
computers, opens session history, forwards prompts, displays native permission
requests, and renders live session events.

The browser stores local access state for this account. That state is used to
authenticate browser API calls to Nexus; it is not a user-visible device in the
main device-management product model.

## Daemon

The daemon runs on the user's computer. It:

- indexes Claude Code and Codex session files;
- connects outbound to Nexus;
- syncs session catalog and selected history windows;
- forwards prompts to local agents;
- mirrors native agent permission requests to the web UI;
- exposes local setup and diagnostic endpoints on loopback.

The daemon does not require inbound internet access.

## Nexus

Nexus is the connection layer. The open-source implementation is a Node.js
self-hosted runtime. It stores account/device metadata and synced session
history, authenticates browser and daemon requests, routes realtime control
messages, and exposes the public Nexus Contract.

## Agent Permissions

Pockly does not define a separate permission engine. Claude Code and Codex own
their permission models. Pockly only mirrors native approval requests and
returns the user's allow/deny response.

## Legacy `relay` Compatibility

Older code, state file names, and environment variables may still use `relay`.
Public product language should use **Pockly Nexus**. Keep new user-facing text
and documentation on Nexus terminology.
