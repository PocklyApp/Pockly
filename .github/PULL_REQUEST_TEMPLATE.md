## Summary

Describe the change and the user/developer problem it solves.

## Scope

- [ ] Web
- [ ] Daemon
- [ ] Nexus
- [ ] Docs
- [ ] Installer or packaging

## Public Boundary Checklist

- [ ] Uses **Pockly Nexus** terminology; `relay` appears only for legacy compatibility.
- [ ] Does not add deployment-specific domains, provider details, account IDs, bucket names, or secrets. (`nexus/test/public-boundary.test.js` checks this.)
- [ ] Documentation updated in the same commit if a documented default, flag, command, or env var changed.
- [ ] Does not claim a browser-only secrecy boundary for synced session history.
- [ ] Keeps browser access separate from user-visible connected-computer management.
- [ ] Keeps agent permissions native to Claude Code/Codex; Pockly only forwards decisions.

## Tests

List commands run:

```text
npm test
npm run web:lint
npm run web:typecheck
npm run web:build
cd daemon && go test ./...
```

If real-agent tests were skipped, explain why and confirm they are optional.

## Screenshots

Add screenshots or recordings for UI changes.
