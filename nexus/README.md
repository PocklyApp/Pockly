# Pockly Nexus

Secure connection layer for Pockly.

This package implements the Nexus Contract used by `web` and `daemon` without
forking client behavior for a specific deployment platform. Nexus handles
browser and daemon auth, setup, sessions, history sync, permissions,
terminal streams, release metadata, and optional push/STT/telemetry providers.

The old `relay` name remains only as a compatibility alias for legacy
environment variables and API paths during the migration window.

## Current Scope

Implemented:

- `GET /healthz`
- `GET /api/runtime`
- web auth/session basics: local password account creation, session lookup,
  logout, and opt-in dev login for tests
- browser access registration plus Ed25519 challenge verification
- daemon login-code binding, daemon auth, remote-access flag updates
- daemon authorization, setup grant, local claim, QR join, and pairing
  grant onboarding flows
- daemon catalog/turn sync for `claude-code` and `codex`
- session catalog, session turns, connected-computer list, and host presence reads
- in-process control hub abstraction with daemon control routing for
  agent settings, git diff, directory listing, permission decisions, task start,
  session inject, and lazy session sync
- minimal browser `/api/ws` subscription fanout for live `TURN` and `HOST_STATUS`
  events
- minimal terminal session control APIs: create, list, input, stop, open-local,
  and SSE stream
- terminal session/history persistence through injected storage
- Web Push subscription registration, revocation, VAPID delivery, and
  stale endpoint revocation
- voice transcription proxy to a configured provider endpoint
- optional self-hosted diagnostics provider hook for `/api/telemetry/web` and
  `/api/telemetry/daemon`; without an injected provider these routes accept and
  drop events, and Nexus does not store or forward telemetry
- daemon release metadata from configured release manifests or object storage
- metadata schema for account, daemon, computer, session, and turn metadata
- Node.js self-hosted server with SQLite metadata, local release blob storage,
  and an in-process browser/daemon WebSocket control hub
- optional Redis-backed distributed control hub for multi-instance self-hosted
  Node deployments
- in-memory store for credential-free contract tests and local development
- Docker image build for the self-hosted Node runtime
- method-safe JSON error responses

Not implemented yet:

- NATS-backed distributed control hub

`/api/runtime` reports neutral Nexus capabilities:

- `runtime`: `self_hosted`
- `realtime`, `terminal`, `web_push`, `stt`, `release_update`
- `contract_version`

It only advertises capabilities that are explicitly enabled via environment
flags and matching runtime bindings. HTTP catalog sync and session reads are
available even when realtime is disabled.

SaaS deployment runbooks and production infrastructure details live outside this
repository. The public Nexus Contract and client UI should only depend on the
neutral runtime capabilities above.

## Local Validation

```bash
npm test
npm run validate
```

## Self-Hosted Node Runtime

Default self-hosted Nexus runs on Node.js 20 with SQLite, local release blob
storage, and an in-process WebSocket control hub:

```bash
npx @pockly/nexus serve --host 0.0.0.0 --port 8787 --data-dir ~/.pockly/nexus
```

From this monorepo checkout:

```bash
npm --workspace nexus exec -- pockly-nexus serve --host 0.0.0.0 --port 8787
```

Docker:

```bash
docker build -f nexus/Dockerfile -t pockly-nexus .
docker run --rm -p 8787:8787 -v pockly-nexus-data:/var/lib/pockly-nexus pockly-nexus
```

The default Docker image stores SQLite metadata and local release files under
`/var/lib/pockly-nexus`.

The default self-hosted runtime includes password-based local accounts and does
not send outbound email. Creating an account through the web UI signs the user
in immediately. Public multi-user deployments should add their own registration
policy and verification layer before exposing open signup.

`/api/dev/login` is disabled by default. Set
`POCKLY_NEXUS_DEV_LOGIN_ENABLED=1` only for local tests or private development
fixtures.

Production self-hosted metadata can use Postgres:

```bash
POCKLY_NEXUS_DATABASE_URL="postgres://pockly:REPLACE_ME@db.example:5432/pockly" \
  npx @pockly/nexus serve --host 0.0.0.0 --port 8787
```

Equivalent CLI flags:

```bash
npx @pockly/nexus serve \
  --database-url "postgres://pockly:REPLACE_ME@db.example:5432/pockly" \
  --postgres-ssl true
```

`--postgres-ssl true` verifies the server certificate; `--postgres-ssl
no-verify` is available only for private test networks with self-signed
certificates. Do not use `no-verify` for public production endpoints.

Production self-hosted realtime/control can use Redis when running more than
one Node instance:

```bash
POCKLY_NEXUS_REDIS_URL="redis://redis.example:6379" \
  npx @pockly/nexus serve --host 0.0.0.0 --port 8787
```

Equivalent CLI flags:

```bash
npx @pockly/nexus serve \
  --redis-url redis://redis.example:6379 \
  --redis-prefix pockly:nexus
```

Without Redis, self-hosted Nexus intentionally uses an in-process control hub,
which is correct for a single instance. With Redis, daemon ownership, remote
request/response, inject/lazy-sync streams, host/turn browser fanout, and
terminal events are routed across Node instances.

Production self-hosted release metadata can use S3-compatible storage:

```bash
POCKLY_NEXUS_S3_BUCKET="example-release-bucket" \
POCKLY_NEXUS_S3_ENDPOINT="https://s3.example.com" \
POCKLY_NEXUS_S3_REGION="auto" \
POCKLY_NEXUS_S3_ACCESS_KEY_ID="..." \
POCKLY_NEXUS_S3_SECRET_ACCESS_KEY="..." \
  npx @pockly/nexus serve --host 0.0.0.0 --port 8787
```

Equivalent CLI flags are available for non-secret values:

```bash
npx @pockly/nexus serve \
  --s3-bucket example-release-bucket \
  --s3-endpoint https://s3.example.com \
  --s3-region auto \
  --s3-prefix releases
```

Do not commit real account IDs, database IDs, bucket names, production domains,
or secrets.
