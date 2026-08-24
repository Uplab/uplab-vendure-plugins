# Uplab Vendure plugins

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
pnpm build        # tsc build of every publishable package
pnpm typecheck
pnpm test         # unit + e2e (sql.js, no external database needed)
pnpm lint
pnpm format
```

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
    dashboard/                 # optional React dashboard extension, copied to dist/dashboard
    e2e/                       # @vendure/testing e2e specs (sql.js)
    README.md CHANGELOG.md
```

### Anatomy of a plugin package

Every publishable package follows the same contract:

- `name: @uplab/vendure-plugin-<x>`, `license: MIT`, `publishConfig.access: public`
- `files: ["dist", "README.md", "CHANGELOG.md"]` — nothing else ends up in the tarball
- `main` / `types` / `exports` point into `dist`
- `peerDependencies: { "@vendure/core": "^3.7.0" }` (plus `@vendure/dashboard` when the
  package ships a dashboard extension) — Vendure packages are never direct dependencies
- `compatibility: '^3.7.0'` on the `@VendurePlugin()` decorator
- `build` = `tsc -p tsconfig.build.json`. A package that ships a dashboard extension adds
  a `copyfiles` step that copies `dashboard/**` into `dist/dashboard`, so the plugin's
  `dashboard: './dashboard/index.tsx'` path resolves from the published `dist`. The
  dashboard source is shipped as `.tsx` on purpose: the host application's Vite plugin
  compiles it.
- unit tests with vitest next to the source, e2e tests in `e2e/` using `@vendure/testing`
  with the sql.js initializer

## Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets) with
independent versions per package.

1. Add a changeset in the PR that makes the change: `pnpm changeset`
2. Merging to `main` makes the release workflow open (or update) a
   `chore(release): version packages` PR
3. Merging that PR publishes the changed packages to npm

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC, `--provenance`) — there is no `NPM_TOKEN` secret. Each package must have a
trusted publisher configured on npmjs.com pointing at `Uplab/vendure-plugins` and the
`release.yml` workflow before its first automated publish.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © Uplab
