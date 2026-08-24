# Contributing

Thanks for helping out. A few house rules keep this repo predictable.

## Commits

[Conventional commits](https://www.conventionalcommits.org/), scoped by package where it
helps:

```
feat(turbosms): allow a custom API endpoint
fix(nova-poshta): retry warehouse lookup on 429
docs: describe the release flow
```

## Every PR

- **One changeset per user-visible change.** Run `pnpm changeset`, pick the affected
  packages and a bump level, and commit the generated `.changeset/*.md`. Chore-only PRs
  (CI, docs, refactors with no published effect) do not need one.
- **One `README.md` per package**, kept current: install, options, usage, GraphQL
  surface, and a link to the changelog. If your PR changes options or behaviour, the
  README changes in the same PR.
- **e2e coverage is required** for anything that touches plugin wiring, API extensions
  or the Vendure config. Unit tests cover pure logic; an `e2e/*.e2e-spec.ts` using
  `@vendure/testing` (sql.js) proves the plugin actually boots. Tests must never make a
  real network call — mock the vendor HTTP client.
- Run `pnpm lint && pnpm typecheck && pnpm build && pnpm test` before pushing.

## Adding a new plugin package

1. Copy the shape of `packages/vendure-plugin-turbosms`.
2. Name it `@uplab/vendure-plugin-<x>`, MIT, `publishConfig.access: public`,
   `files: ["dist", "README.md", "CHANGELOG.md"]`.
3. Keep `@vendure/*` in `peerDependencies`, never in `dependencies`.
4. Set `compatibility: '^3.7.0'` on the `@VendurePlugin()` decorator.
5. Register it in `packages/dev-server/src/vendure-config.ts` and in the package table
   in the root `README.md`.
6. Before its first release, configure the npm trusted publisher for the package.

## Code style

Prettier and ESLint are the arbiters — `pnpm format` and `pnpm lint:fix`. No plugin code
may read `process.env` directly; everything comes in through the plugin's `init()`
options so the host application stays in control.
