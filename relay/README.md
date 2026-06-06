# Pockly Relay

Worker-native relay runtime for Pockly.

This package implements the relay protocol used by `web` and `daemon` without
forking client behavior for a specific deployment platform. The long-term goal
is one worker-native relay architecture that can be adapted to Cloudflare,
workerd self-hosting, and other edge runtimes through platform bindings.

## Current Scope

Implemented in this scaffold:

- `GET /healthz`
- `GET /api/runtime`
- method-safe JSON error responses
- `UserRuntimeDO` placeholder for per-user/session state sharding.
- initial D1-compatible schema for account/session metadata.
- credential-free Node tests for the current contract surface

Not implemented yet:

- auth/session issuance
- daemon control WebSocket
- browser realtime
- encrypted turn sync
- push/STT/release object storage integration

`/api/runtime` only advertises capabilities that are explicitly enabled via
environment flags. The scaffold defaults realtime, terminal, Web Push, STT, and
release updates to `false` until those paths are implemented.

## Local Validation

```bash
cd cloudflare
npm test
```

For Wrangler development, copy `wrangler.toml.example` to `wrangler.toml` and
fill placeholders locally. Do not commit real account IDs, database IDs, bucket
names, or secrets.
