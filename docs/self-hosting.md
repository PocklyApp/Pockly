# Self-Hosting Pockly Nexus

This guide covers the public self-hosted Nexus runtime only.

## Default Profile

The default profile is suitable for local development and small single-instance
self-hosting:

- Node.js 20.
- SQLite metadata.
- Local filesystem release/object storage.
- In-process WebSocket/control hub.
- Diagnostics disabled unless explicitly configured.

```bash
npm --workspace nexus exec -- pockly-nexus serve \
  --host 0.0.0.0 \
  --port 8787 \
  --data-dir ~/.pockly/nexus
```

The data directory contains the SQLite database and local release/object files.
Back it up before upgrades.

## Authentication

The public self-hosted runtime includes password-based local accounts. With the
default profile, creating an account in the web UI signs the user in
immediately. Nexus does not send outbound email by default.

For a public multi-user deployment, add your own account policy and verification
layer before exposing registration broadly. Keep provider-specific email,
identity, and anti-abuse runbooks outside this public repository.

The development login endpoint is off by default. Do not set
`POCKLY_NEXUS_DEV_LOGIN_ENABLED=1` on public deployments.

## Docker

```bash
docker build -f nexus/Dockerfile -t pockly-nexus .
docker run --rm -p 8787:8787 \
  -v pockly-nexus-data:/var/lib/pockly-nexus \
  pockly-nexus
```

## Postgres Metadata

Use Postgres when you need managed backups, larger datasets, or multiple Nexus
instances:

```bash
POCKLY_NEXUS_DATABASE_URL="postgres://pockly:REPLACE_ME@db.example:5432/pockly" \
  npm --workspace nexus exec -- pockly-nexus serve --host 0.0.0.0 --port 8787
```

Use `--postgres-ssl true` for public production databases. Use
`--postgres-ssl no-verify` only on private test networks.

## Redis Distributed Control

Use Redis when more than one Nexus instance must route daemon/browser control
messages:

```bash
POCKLY_NEXUS_REDIS_URL="redis://redis.example:6379" \
  npm --workspace nexus exec -- pockly-nexus serve --host 0.0.0.0 --port 8787
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
  npm --workspace nexus exec -- pockly-nexus serve --host 0.0.0.0 --port 8787
```

Do not commit real keys or bucket names.

## Backups And Upgrades

- Stop Nexus or take an application-consistent snapshot before backing up
  SQLite files.
- Back up the whole `--data-dir` when using the default profile.
- For Postgres, use your database's normal dump or snapshot process.
- For S3-compatible storage, keep immutable versioned release objects and short
  TTLs for mutable `latest/*` objects.
- Review release notes before changing schema-affecting versions.

## Public Boundary

Self-hosted docs must not contain operator-specific deployment internals,
provider names, domains, account IDs, bucket IDs, or routing details.
