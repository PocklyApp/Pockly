# Pockly Nexus

Secure connection layer for Pockly.

This package implements the Nexus Contract used by `web` and `daemon` without
forking client behavior for a specific deployment platform. Nexus handles
browser and daemon auth, setup, sessions, history sync, permissions,
terminal streams, release metadata, and optional push/STT/telemetry providers.

The old `relay` name survives only as a fallback for `POCKLY_RELAY_*`
environment variables. Request paths are `/api/*` only; there are no legacy
`/api/relay/*` routes.

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
- `contract_version`
- realtime and control: `realtime`, `browser_realtime`,
  `browser_realtime_control`, `control_streaming`
- terminal: `terminal`, `terminal_streaming`
- optional providers: `web_push`, `stt`, `release_update`

It only advertises capabilities that are explicitly enabled via environment
flags and matching runtime bindings. HTTP catalog sync and session reads are
available even when realtime is disabled.

`nexus/test/public-boundary.test.js` fails the build if a capability key is added
without documenting it here and in `docs/deployment.md`.

Hosting runbooks and infrastructure details belong to whoever runs the
deployment and are not tracked here. The Nexus Contract and client UI depend only
on the neutral runtime capabilities above.

## Local Validation

`test` and `validate` are the same command; use either.

```bash
npm test
```

## Self-Hosted Node Runtime

Default self-hosted Nexus runs on Node.js 20 with SQLite, local release blob
storage, and an in-process WebSocket control hub. Run it from a checkout of this
monorepo:

```bash
npm --workspace nexus exec -- pockly-nexus serve \
  --host 127.0.0.1 --port 8787 --data-dir ~/.pockly/nexus
```

`@pockly/nexus` is not published to npm yet, so `npx @pockly/nexus` does not
resolve. Every example below uses the workspace form.

`--host` defaults to `127.0.0.1` and `--data-dir` defaults to `~/.pockly/nexus`.
Binding to `0.0.0.0` exposes a runtime that ships without TLS, rate limiting, or
origin checks; read [../docs/self-hosting.md](../docs/self-hosting.md) before
doing that.

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
  npm --workspace nexus exec -- pockly-nexus serve --port 8787
```

Equivalent CLI flags:

```bash
npm --workspace nexus exec -- pockly-nexus serve \
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
  npm --workspace nexus exec -- pockly-nexus serve --port 8787
```

Equivalent CLI flags:

```bash
npm --workspace nexus exec -- pockly-nexus serve \
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
  npm --workspace nexus exec -- pockly-nexus serve --port 8787
```

Equivalent CLI flags are available for non-secret values:

```bash
npm --workspace nexus exec -- pockly-nexus serve \
  --s3-bucket example-release-bucket \
  --s3-endpoint https://s3.example.com \
  --s3-region auto \
  --s3-prefix releases
```

## CLI Environment Variables

Every `serve` flag has an environment-variable equivalent. Flags win when both
are set.

| Variable | Flag | Default |
| --- | --- | --- |
| `POCKLY_NEXUS_HOST` | `--host` | `127.0.0.1` |
| `POCKLY_NEXUS_PORT` | `--port` | `8787` |
| `POCKLY_NEXUS_DATA_DIR` | `--data-dir` | `~/.pockly/nexus` |
| `POCKLY_NEXUS_SQLITE_PATH` | `--sqlite-path` | `<data-dir>/nexus.sqlite` |
| `POCKLY_NEXUS_DATABASE_URL` | `--database-url` | unset (use SQLite) |
| `POCKLY_NEXUS_POSTGRES_SSL` | `--postgres-ssl` | unset |
| `POCKLY_NEXUS_POSTGRES_MAX_CONNECTIONS` | none | `10` |
| `POCKLY_NEXUS_REDIS_URL` | `--redis-url` | unset (in-process hub) |
| `POCKLY_NEXUS_REDIS_PREFIX` | `--redis-prefix` | `pockly:nexus` |
| `POCKLY_NEXUS_S3_BUCKET` | `--s3-bucket` | unset (local files) |
| `POCKLY_NEXUS_S3_ENDPOINT` | `--s3-endpoint` | unset |
| `POCKLY_NEXUS_S3_REGION` | `--s3-region` | unset |
| `POCKLY_NEXUS_S3_PREFIX` | `--s3-prefix` | unset |
| `POCKLY_NEXUS_S3_FORCE_PATH_STYLE` | `--s3-force-path-style` | unset |
| `POCKLY_NEXUS_S3_ACCESS_KEY_ID` | none | unset |
| `POCKLY_NEXUS_S3_SECRET_ACCESS_KEY` | none | unset |
| `POCKLY_NEXUS_S3_SESSION_TOKEN` | none | unset |
| `POCKLY_NEXUS_RUNTIME` | none | `self_hosted` |
| `POCKLY_NEXUS_ENVIRONMENT` | none | `self_hosted` |
| `POCKLY_NEXUS_DEV_LOGIN_ENABLED` | none | off |

Unprefixed `DATABASE_URL`, `REDIS_URL`, `S3_BUCKET`, `S3_ENDPOINT`,
`S3_FORCE_PATH_STYLE`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` are also honored as fallbacks.
Ambient AWS credentials in the environment therefore take effect without being
named in a Pockly-specific variable.

Feature flags and provider configuration are documented in
[../docs/self-hosting.md](../docs/self-hosting.md).

Do not commit real account IDs, database IDs, bucket names, production domains,
or secrets. See [../CONTRIBUTING.md](../CONTRIBUTING.md).
