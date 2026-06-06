# Pockly Relay

Worker-native relay runtime for Pockly.

This package implements the relay protocol used by `web` and `daemon` without
forking client behavior for a specific deployment platform. The long-term goal
is one worker-native relay architecture that can be adapted to Cloudflare,
workerd self-hosting, and other edge runtimes through platform bindings.

## Current Scope

Implemented:

- `GET /healthz`
- `GET /api/runtime`
- web auth/session basics: dev login, session lookup, logout
- browser device registration plus Ed25519 device challenge verification
- daemon login-code binding, daemon device auth, remote-access flag updates
- daemon catalog/turn sync for `claude-code` and `codex`
- session catalog, session turns, device list, and host presence reads
- D1-compatible schema for account, device, computer, session, and turn metadata
- in-memory store for credential-free contract tests and local development
- method-safe JSON error responses

Not implemented yet:

- daemon control WebSocket
- browser realtime
- push/STT/release object storage integration

`/api/runtime` only advertises capabilities that are explicitly enabled via
environment flags. The scaffold defaults realtime, terminal, Web Push, STT, and
release updates to `false` until those paths are implemented. HTTP catalog sync
and session reads are available even when realtime is disabled.

## Local Validation

```bash
npm test
```

For Wrangler development, copy `wrangler.toml.example` to `wrangler.toml` and
fill placeholders locally. Do not commit real account IDs, database IDs, bucket
names, or secrets.
