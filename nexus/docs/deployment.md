# Nexus Contract Boundary

[../../docs/self-hosting.md](../../docs/self-hosting.md) is the canonical
self-hosting guide: storage backends, feature flags, environment variables, and
the security work a public deployment needs. This document covers only the rule
that keeps the Nexus Contract deployment-neutral.

Deployment runbooks, routing, provider choices, domains, bucket names, account
IDs, and purge procedures belong to whoever runs the deployment and are not
tracked in this repository.

## Runtime Response

`GET /api/runtime` exposes exactly these keys:

- `runtime`
- `contract_version`
- `realtime`
- `browser_realtime`
- `browser_realtime_control`
- `control_streaming`
- `terminal`
- `terminal_streaming`
- `web_push`
- `stt`
- `release_update`

Each is a boolean capability flag or a neutral identifier. Adding a key without
listing it here fails `nexus/test/public-boundary.test.js`.

## What Must Stay Out

Do not add provider names, region names, database names, object-store names, or
cluster names to the public runtime response, web UI, daemon wire behavior, or
Nexus Contract docs. Clients must branch on capability flags, never on which
backend or host a deployment happens to use.

The same test enforces this repository-wide: it rejects deployment-specific
domains, cloud resource identifiers, credential material, contributor home
paths, and routable IP addresses in any tracked file.

## Release Assets

Release storage keeps immutable versioned objects under `releases/<version>/`.
Mutable `latest/*` objects and installer scripts should use short cache TTLs and
be purged after each release.
