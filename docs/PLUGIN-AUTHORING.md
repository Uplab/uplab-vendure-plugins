# Plugin authoring

Every publishable package follows the same contract. Reference implementation:
[`packages/vendure-plugin-turbosms`](../packages/vendure-plugin-turbosms). With
Claude Code, `/new-plugin <name>` scaffolds all of this.

## Package contract

- `name: @uplab/vendure-plugin-<x>`, `license: MIT`, `publishConfig.access: public`
- `files: ["dist", "README.md", "CHANGELOG.md"]` — nothing else ends up in the
  tarball (CI verifies the packed tarball with publint + attw)
- `main` / `types` / `exports` point into `dist`
- `peerDependencies: { "@vendure/core": "^3.7.0" }` (plus `@vendure/dashboard`
  when the package ships a dashboard extension) — Vendure packages are never
  direct dependencies
- `repository` includes the package `directory`; the URL must match the GitHub
  repo exactly (provenance verification compares them)
- `compatibility: '^3.7.0'` on the `@VendurePlugin()` decorator, kept in sync
  with the peer range

## Code conventions

- All configuration through a static `init(options)`; defaults are resolved there
  into a `Resolved…Options` type provided via an injection token. **No
  `process.env` in plugin code** — the host application stays in control.
- Public surface (plugin class, option types, exported services) re-exported from
  `src/index.ts` with JSDoc (`@description`, `@example`) — Vendure Hub expects
  documented public APIs.
- A published plugin exposes provider capability, not application copy: message
  text, localization and audience rules belong to the host application. Keep the
  surface to what is genuinely specific to the vendor.

## Build

`build` = `rimraf dist && tsc -p tsconfig.build.json`. A package that ships a
React dashboard extension adds a `copyfiles` step copying `dashboard/**` into
`dist/dashboard` (shipped as `.tsx` on purpose — the host's Vite compiles it) and
declares `@vendure/dashboard` as a peer.

## Checklist for a new plugin

1. Copy the shape of `vendure-plugin-turbosms` (including its `vitest.config.mts`
   — it carries the SWC decorator setup).
2. Unit tests next to sources; an `e2e/*.e2e-spec.ts` with `@vendure/testing`
   (sql.js) proving the plugin boots — vendor HTTP mocked, no real network calls.
3. Register in `packages/dev-server/src/vendure-config.ts`, add env vars with
   dry-run defaults to `packages/dev-server/.env.example`.
4. Add the package to the table in the root `README.md`.
5. Package `README.md`: install, options table, usage, GraphQL surface, changelog
   link. The README changes in the same PR as any behaviour change.
6. Add a changeset (`pnpm changeset`).
7. Before the first automated release: publish v1 by hand once and configure the
   npm trusted publisher — see [RELEASING.md](./RELEASING.md#bootstrapping-a-new-package).
