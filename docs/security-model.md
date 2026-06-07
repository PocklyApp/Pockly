# Security Model

This document describes the public open-source model.

## What Runs Where

- Agents run on the connected computer.
- The daemon runs on the connected computer and makes outbound requests to
  Nexus.
- The browser talks to Nexus over HTTP/WebSocket APIs.
- Nexus stores account metadata, connected-computer metadata, browser access
  records, session catalog entries, and synced session turns.

## Session History

Nexus stores the session history it needs to serve authenticated browser
clients. Treat Nexus storage, database backups, and object storage as sensitive
application data.

The daemon still keeps the original agent logs locally. Nexus only sees data the
daemon syncs.

## Browser Access

The browser generates and stores a local Ed25519 signing key. Nexus uses that
key with a challenge/verify flow to issue browser access tokens. This prevents a
stale cookie alone from being the only browser credential.

Browser access is an authentication mechanism. It is not a user-visible
"computer" in the connected-computer list and not a separate history secrecy
boundary.

## Account Authentication

The public self-hosted Nexus runtime includes local password accounts so a clean
checkout can run without external account infrastructure. It does not include outbound
email delivery or a full public-signup abuse prevention system by default.
Operators exposing Nexus to untrusted users should add their own account
verification, rate limiting, and abuse controls.

## Connected Computers

The user-visible device concept is a connected computer running the Pockly
daemon. Browser access records may exist internally, but the main product
surface should not present browsers as managed computers.

## Native Agent Permissions

Pockly does not maintain a private allowlist or permission engine. Claude Code
and Codex define the actual permission semantics. Pockly forwards native
permission requests to the web UI and sends the user's decision back to the
agent.

If Pockly cannot safely map a native prompt to a remote decision, it should show
that the agent is waiting for local confirmation instead of guessing.

## Diagnostics

Open-source web and daemon telemetry are disabled by default. Operators may
explicitly configure and enable a self-hosted diagnostics provider. Diagnostic
events must not include prompts, session payloads, tool results, access tokens,
passwords, verification codes, or provider API keys.

## Secrets

Never commit:

- `.env` files;
- provider API keys;
- browser or daemon access tokens;
- session logs containing private prompts;
- operator-specific domains, account IDs, bucket IDs, or deployment runbooks.
