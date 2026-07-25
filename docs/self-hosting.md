# Self-Hosting Pockly Nexus

This guide covers the self-hosted Nexus runtime that ships in this repository.

## Read This First

The default runtime is built to make a clean checkout work, not to be safe on a
public IP. It ships with:

- **Open registration.** `POST /api/auth/register` creates an account and signs
  it in. There is no invite, allowlist, or email verification.
- **No rate limiting.** Login and registration accept unlimited attempts.
- **No CORS or origin allowlist.** Browser auth relies on a `SameSite=Lax`,
  `HttpOnly` cookie plus Ed25519 device tokens, which assumes the web app and
  Nexus are served from the same origin.
- **No TLS.** The session cookie is not marked `Secure`, so it will travel over
  plain HTTP if you let it.
- **Terminal control enabled.** The Node server turns on `REALTIME_ENABLED`,
  `TERMINAL_ENABLED`, and `RELEASE_UPDATE_ENABLED` by default, so a paired
  browser can open a PTY on the connected computer.

Binding to `127.0.0.1` is safe. Before binding to `0.0.0.0` or putting Nexus on a
public address, put it behind a reverse proxy that terminates TLS and adds rate
limiting, and decide how you want to restrict who can register. Nexus is a
control plane for shells on your machines; treat it accordingly.

## Default Profile

Suitable for local development and small single-instance self-hosting:

- Node.js 20.
- SQLite metadata.
- Local filesystem release/object storage.
- In-process WebSocket/control hub.
- Diagnostics disabled unless explicitly configured.

```bash
npm --workspace nexus exec -- pockly-nexus serve \
  --host 127.0.0.1 \
  --port 8787 \
  --data-dir ~/.pockly/nexus
```

`--host` defaults to `127.0.0.1`, `--port` to `8787`, and `--data-dir` to
`~/.pockly/nexus`. The data directory contains the SQLite database and local
release/object files. Back it up before upgrades.

Every flag has an environment-variable equivalent. See
[../nexus/README.md](../nexus/README.md) for the full table, including the
unprefixed `DATABASE_URL`, `REDIS_URL`, and `AWS_*` fallbacks that also take
effect if they happen to be in the environment.

## Authentication

Password accounts are local to your Nexus. Passwords are stored as
PBKDF2-HMAC-SHA256, 100,000 iterations, 16-byte salt, 256-bit output, compared in
constant time. Creating an account in the web UI signs the user in immediately.

Nexus does not send outbound email. No email transport is bundled, so password
reset and email verification are not available.

`/api/auth/register/verify` and `/api/auth/verification/resend` exist as
extension points and always answer `503 verification_not_configured`. The web
client keeps a matching verification-code screen so a deployment that supplies an
email provider can require verification without forking the client. With the
default runtime that screen is unreachable.

Token lifetimes are fixed in code, not configurable:

| Credential | TTL |
| --- | --- |
| Browser device access token | 15 minutes |
| Daemon device access token | 60 minutes |
| Web session cookie | 30 days |
| Device challenge | 5 minutes |

For a public multi-user deployment, add your own registration policy, abuse
controls, and verification in front of Nexus.

The development login endpoint is off by default. `POCKLY_NEXUS_DEV_LOGIN_ENABLED=1`
issues a session for an arbitrary user id with no credential, which is a complete
authentication bypass. Local tests only.

## Docker

```bash
docker build -f nexus/Dockerfile -t pockly-nexus .
docker run --rm -p 8787:8787 \
  -v pockly-nexus-data:/var/lib/pockly-nexus \
  pockly-nexus
```

The image stores SQLite metadata and local release files under
`/var/lib/pockly-nexus` and listens on `0.0.0.0:8787` inside the container. Keep
the published port behind a proxy rather than exposing it directly.

## Postgres Metadata

Use Postgres when you need managed backups, larger datasets, or multiple Nexus
instances:

```bash
POCKLY_NEXUS_DATABASE_URL="postgres://pockly:REPLACE_ME@db.example:5432/pockly" \
  npm --workspace nexus exec -- pockly-nexus serve --port 8787
```

Use `--postgres-ssl true` for public production databases. Use
`--postgres-ssl no-verify` only on private test networks.

`POCKLY_NEXUS_POSTGRES_MAX_CONNECTIONS` sets the pool size, default 10.

## Redis Distributed Control

Use Redis when more than one Nexus instance must route daemon/browser control
messages:

```bash
POCKLY_NEXUS_REDIS_URL="redis://redis.example:6379" \
  npm --workspace nexus exec -- pockly-nexus serve --port 8787
```

Without Redis, a single Nexus instance uses an in-process control hub. That is
the correct default for one process.

## S3-Compatible Release Storage

Use S3-compatible storage when release metadata and daemon artifacts should live
outside the local filesystem:

```bash
POCKLY_NEXUS_S3_BUCKET="example-release-bucket" \
POCKLY_NEXUS_S3_ENDPOINT="https://s3.example.com" \
POCKLY_NEXUS_S3_REGION="auto" \
POCKLY_NEXUS_S3_ACCESS_KEY_ID="REPLACE_ME" \
POCKLY_NEXUS_S3_SECRET_ACCESS_KEY="REPLACE_ME" \
  npm --workspace nexus exec -- pockly-nexus serve --port 8787
```

`POCKLY_NEXUS_S3_SESSION_TOKEN` is supported for temporary credentials, and
`--s3-force-path-style` for endpoints that require path-style addressing.

Do not commit real keys or bucket names.

### Maturity

Postgres, Redis, and S3 are fully implemented in this repository, not stubs. Be
aware that their tests run against in-process fakes rather than live servers, and
this repository has no integration environment for them. Validate your own
backend before depending on it.

## Optional Features

These are off unless both the flag and the required configuration are present.
`GET /api/runtime` reports what your deployment actually advertises.

| Feature | Enable | Also required |
| --- | --- | --- |
| Realtime browser/daemon fanout | `REALTIME_ENABLED` (on by default in the Node server) | a control hub |
| Browser realtime control | `BROWSER_REALTIME_ENABLED`, `BROWSER_REALTIME_CONTROL_ENABLED` | a control hub |
| Control streaming | `CONTROL_STREAMING_ENABLED` (on by default) | — |
| Terminal sessions | `TERMINAL_ENABLED` (on by default in the Node server), `TERMINAL_STREAMING_ENABLED` | a control hub |
| Web push | `WEB_PUSH_ENABLED` | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (defaults to a placeholder `mailto:` address) |
| Push TTL | `PUSH_TTL_SECONDS` | — |
| Voice transcription | `STT_ENABLED` | `VOICE_TRANSCRIPTION_ENDPOINT` |
| Daemon release updates | `RELEASE_UPDATE_ENABLED` (on by default in the Node server) | `DAEMON_RELEASE_BASE_URL` or S3 release storage |
| Diagnostics | an injected telemetry provider | without one, `/api/telemetry/*` accepts and drops events |

Terminal access means a paired browser can run commands on the connected
computer. If you do not want that, set `TERMINAL_ENABLED=0`.

## Schema Migrations

Migrations in `nexus/migrations/` run automatically at every startup, for both
SQLite and Postgres. There is no version table and no down migrations;
idempotency comes from `CREATE TABLE IF NOT EXISTS` plus tolerating duplicate
column errors on `ALTER TABLE ... ADD COLUMN`.

Practical consequences:

- Back up before upgrading. A rollback means restoring a backup, not reversing a
  migration.
- Do not point two Nexus versions at the same database.
- Review release notes before changing schema-affecting versions.

## Backups And Upgrades

- Stop Nexus or take an application-consistent snapshot before backing up
  SQLite files.
- Back up the whole `--data-dir` when using the default profile.
- For Postgres, use your database's normal dump or snapshot process.
- For S3-compatible storage, keep immutable versioned release objects and short
  TTLs for mutable `latest/*` objects.

## What Is Not In This Repository

Deployment-specific choices belong to you and are deliberately absent here:
hosting, DNS, TLS certificates, reverse proxy configuration, identity providers,
email delivery, registration policy, and release distribution.

Contributor rules for keeping such details out of the repository are in
[../CONTRIBUTING.md](../CONTRIBUTING.md) and enforced by
`nexus/test/public-boundary.test.js`.
