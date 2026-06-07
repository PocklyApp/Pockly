# Security Policy

## Reporting A Vulnerability

Please do not report vulnerabilities in public issues.

Use GitHub private vulnerability reporting for this repository when available.
If that is not available, contact the maintainers through the security contact
listed on the project profile.

Include:

- Affected component: `web`, `daemon`, `nexus`, installer, or documentation.
- Version or commit.
- Reproduction steps.
- Impact and affected data.
- Whether credentials, local files, session history, or browser access state are
  exposed.

## Security Model Summary

- The daemon runs on the user's computer and connects outbound to Nexus.
- Nexus stores account, connected-computer, browser-access metadata, and synced
  session history.
- Browser access uses a local Ed25519 signing key and short-lived access tokens.
- Pockly forwards native agent permission requests; it is not a permission
  engine.
- Open-source telemetry is disabled by default.

See [docs/security-model.md](./docs/security-model.md) for the full public
security model.

## Supported Versions

This repository is pre-1.0. Security fixes target the active `main` branch
unless a release branch is explicitly marked as supported.
