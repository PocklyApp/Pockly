# Pockly

Pockly is an open-source remote workspace for local agent sessions. It brings
the browser UI, local daemon, and worker-native relay runtime into one
repository so contributors can develop against the same public protocol.

## Repository Layout

```text
web/      React + Vite web app.
daemon/   Local daemon that indexes agent sessions and connects to a relay.
relay/    Worker-native relay runtime.
```

Deployment infrastructure, Helm charts, production CI pipelines, and
environment-specific Cloudflare or China-region operations are intentionally
kept outside this repository.

## Runtime Model

Pockly uses a contract-first relay architecture:

- `web` talks to a relay through HTTP and realtime APIs.
- `daemon` connects outbound to the relay and never requires inbound ports.
- `relay` is a worker-native runtime so hosted and self-hosted deployments can
  share the same protocol surface.

The current `relay/` package already implements the HTTP foundation for auth,
device registration, daemon session sync, session reads, and host presence.
Realtime daemon/browser control remains a separate capability and is not
advertised by `/api/runtime` until implemented.

## Development

### Web

```bash
cd web
npm install
npm run dev
```

### Daemon

```bash
cd daemon
make build
./bin/pockly-daemon --version
```

### Relay

```bash
cd relay
npm test
```

## License

Apache License 2.0. See [LICENSE](./LICENSE).
