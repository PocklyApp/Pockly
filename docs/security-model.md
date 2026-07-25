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
clients. Be specific about what that means: a synced turn payload can contain
the full message text, tool inputs and tool results, base64 image data, and file
edit diffs. It is the session content, not a summary of it.

Treat Nexus storage, database backups, and object storage as sensitive
application data, at least as sensitive as the working directories the agent
touched.

Nexus keeps a bounded hot window rather than everything: by default 100 turns per
session, 5,000 turns per user, and a 30-day TTL. Older history stays on the
connected computer and is backfilled on demand. The daemon never moves or deletes
the original agent logs; it reads them in place.

## Browser Access

The browser generates a local Ed25519 signing key. Nexus uses that key with a
challenge/verify flow to issue short-lived browser access tokens, so a stale
session cookie alone is not sufficient to act as the browser.

Know the storage tradeoff. The key pair lives in `localStorage` under
`pockly.browser_device`, unencrypted, alongside the access and refresh tokens.
The browser has no place to keep a non-extractable secret that also survives a
reload, so this is a deliberate choice, not an oversight. The consequence is that
any script running on the page origin, including a malicious browser extension
with page access, can take the entire browser credential set. Treat XSS on the
web origin as full browser-access compromise, and prefer serving the web app
from an origin you control with a strict Content Security Policy.

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

Web and daemon telemetry are disabled by default. A self-hosted diagnostics
provider must be configured and enabled explicitly before anything is sent.

The intent is that diagnostic events carry no prompts, session payloads, tool
results, access tokens, passwords, verification codes, or provider API keys. Be
clear about how strongly that is enforced:

- The wire format is the primary control. Daemon events carry a fixed set of
  scalar fields with no free-text payload, and web events pass through an
  attribute allowlist that drops keys matching token, password, prompt, text,
  payload, cipher, or code.
- Error strings are normalized, not forwarded. The daemon maps error text onto a
  fixed vocabulary and emits `redacted_error` when it sees token, password, or
  secret substrings. Web call sites map failures to enumerated codes.
- Both layers clamp field lengths.

That combination is a best-effort control, not a proof. Allowlists and
substring matching can miss a value that a future call site forwards verbatim.
When adding a diagnostic event, send an enumerated code rather than an error
message, and never pass a value straight from an API response or exception into
an event field.

## Overrides That Weaken Controls

These environment variables exist for automated testing and constrained
environments. Each one removes a defense. None should be set on a shared or
multi-user machine.

| Variable | Effect |
| --- | --- |
| `POCKLY_AUTO_CONFIRM_PAIR=1` | Skips the local `[y/N]` confirmation during daemon pairing. That prompt is what stops a remote party from talking a user through approving a pairing they did not initiate. |
| `POCKLY_ALLOW_PLAINTEXT_KEY=1` | Stores the daemon Ed25519 private key as cleartext in `device.json` instead of the OS keyring. Anyone who can read that file can impersonate the connected computer. |
| `POCKLY_FORCE_LOCAL_INSTALL=1`, `POCKLY_FORCE_REMOTE_INSTALL=1` | Override the heuristic that decides whether setup is running locally or over a remote shell, and therefore whether the confirmation prompt is shown at all. |
| `POCKLY_NEXUS_DEV_LOGIN_ENABLED=1` | Enables `/api/dev/login` on Nexus, which issues a session for an arbitrary user id with no credential. This is an authentication bypass. Local tests only. |

## Secrets

Never commit:

- `.env` files;
- provider API keys;
- browser or daemon access tokens;
- session logs containing private prompts;
- deployment-specific domains, account IDs, bucket IDs, or runbooks.

`nexus/test/public-boundary.test.js` enforces the last item mechanically and runs
as part of `npm test`.
