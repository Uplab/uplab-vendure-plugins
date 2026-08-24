# Uplab Vendure plugins

[![CI](https://github.com/Uplab/uplab-vendure-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/Uplab/uplab-vendure-plugins/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Uplab/uplab-vendure-plugins/branch/main/graph/badge.svg)](https://codecov.io/gh/Uplab/uplab-vendure-plugins)

A monorepo of open-source [Vendure](https://www.vendure.io/) plugins maintained by
[Uplab](https://uplab.io), focused on the Ukrainian market: SMS, delivery, payments,
fiscalization and exchange rates.

All packages are published to npm under the `@uplab` scope and target **Vendure 3.7**.

## Packages

| Package                                                                | npm                                                                                                                                     | Description                                                     | Vendure  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------- |
| [`@uplab/vendure-plugin-turbosms`](./packages/vendure-plugin-turbosms) | [![npm](https://img.shields.io/npm/v/@uplab/vendure-plugin-turbosms.svg)](https://www.npmjs.com/package/@uplab/vendure-plugin-turbosms) | Send transactional SMS through [TurboSMS](https://turbosms.ua/) | `^3.7.0` |

Planned, in extraction order: Nova Poshta, Monobank exchange rates, WayForPay,
Checkbox fiscalization, Monobank acquiring.

## Requirements

- Node.js 22 LTS (see `.nvmrc`; CI also runs 24)
- pnpm 11 (`corepack enable`)

## Development

```bash
pnpm install
pnpm build          # tsc build of every package — run FIRST (typecheck needs dist/)
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test           # unit + e2e (sql.js, no external database needed)
pnpm test:coverage  # same, with merged coverage + thresholds
pnpm knip           # unused files/exports/dependencies
pnpm check:packages # publint + attw against the packed tarballs
```

More detail: [docs/TESTING.md](./docs/TESTING.md) ·
[docs/PLUGIN-AUTHORING.md](./docs/PLUGIN-AUTHORING.md) ·
[docs/RELEASING.md](./docs/RELEASING.md). Agent-readable repo guide:
[AGENTS.md](./AGENTS.md).

### Dev server

`packages/dev-server` is a private workspace package that boots a real Vendure server
with **every plugin in this repo** registered, backed by SQLite so there is nothing to
provision. It also carries the Vite config for the React dashboard, so dashboard
extensions contributed by any plugin are compiled and served.

```bash
pnpm dev                    # Vendure server on http://localhost:3000
pnpm --filter dev-server dashboard   # dashboard dev server on http://localhost:5173
```

Superadmin credentials are `superadmin` / `superadmin`.

Copy `packages/dev-server/.env.example` to `packages/dev-server/.env` and fill in real
credentials when you want to exercise a plugin against a live vendor API. Without a
`.env` the plugins run in their dry-run / stub mode.

## Repository layout

```
packages/
  dev-server/                  # private: Vendure config + dashboard Vite config
  vendure-plugin-<name>/       # one publishable package per plugin
    src/                       # server code, compiled to dist/ by tsc
    dashboard/                 # optional React dashboard extension
    e2e/                       # @vendure/testing e2e specs (sql.js)
    README.md CHANGELOG.md
docs/                          # releasing, testing, plugin authoring
```

The package contract every plugin follows lives in
[docs/PLUGIN-AUTHORING.md](./docs/PLUGIN-AUTHORING.md).

## Releasing

Fully automated: a changeset per PR → merging to `main` opens a version PR →
merging that publishes to npm (trusted publishing / OIDC, no tokens), pushes tags
and creates GitHub Releases. Details, one-time setup and the new-package bootstrap:
[docs/RELEASING.md](./docs/RELEASING.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Every PR gets installable preview builds
via [pkg.pr.new](https://pkg.pr.new).

## License

[MIT](./LICENSE) © Uplab
