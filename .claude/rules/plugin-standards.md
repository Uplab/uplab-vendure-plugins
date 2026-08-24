---
paths:
  - 'packages/*/src/**'
  - 'packages/*/e2e/**'
---

# Vendure plugin standards

- Configuration only through the plugin's static `init(options)`; never read
  `process.env` in plugin code — the host application stays in control.
- `@vendure/*`, `@nestjs/*`, `typeorm` belong in `peerDependencies` (and
  `devDependencies` for local builds), never in `dependencies`.
- Keep `compatibility: '^3.7.0'` on `@VendurePlugin()` in sync with the peer range.
- Do not convert value imports of injected classes to `import type` — with
  `emitDecoratorMetadata` that erases `design:paramtypes` and breaks Nest DI.
- Every observable behaviour change needs: a unit or e2e test, a README update in
  the same package, and a changeset.
- e2e specs must mock the vendor HTTP client; no real network calls, ever.
