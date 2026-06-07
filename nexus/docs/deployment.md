# Nexus Self-Hosting Notes

This document covers the public self-hosted Nexus runtime only.
Operator-specific deployment runbooks, routing, provider choices, domains,
bucket names, account IDs, and purge procedures are configured outside this
repository.

## Default Runtime

Default self-hosted Nexus is:

- Node.js 20
- SQLite metadata
- local filesystem release blobs
- in-process WebSocket/control hub

Production self-hosted Nexus can use:

- Postgres metadata via `POCKLY_NEXUS_DATABASE_URL` or `--database-url`
- S3-compatible release storage via `POCKLY_NEXUS_S3_BUCKET` or `--s3-bucket`
- Redis distributed control via `POCKLY_NEXUS_REDIS_URL` or `--redis-url`

NATS distributed control is not implemented yet.

## Release Assets

Release storage keeps immutable versioned objects under `releases/<version>/`.
Mutable `latest/*` objects and installer scripts should use short cache TTLs and
be purged after each release.

## Contract Boundary

The public runtime endpoint only exposes:

- `runtime`
- `realtime`
- `terminal`
- `web_push`
- `stt`
- `release_update`
- `contract_version`

Do not add provider names, region names, database names, object-store names, or
cluster names to the public runtime response, web UI, daemon wire behavior, or
Nexus Contract docs.
