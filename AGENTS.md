# Agent guide

Monorepo of open-source Vendure plugins published to npm under the `@uplab` scope,
focused on the Ukrainian market. pnpm 11 workspace, Node 22+, TypeScript strict,
Vendure 3.7.

## Commands

Run from the repo root. **Order matters: `build` must run before `typecheck`** —
`dev-server` resolves the workspace plugins' types from their `dist/` output.

```bash
pnpm install
pnpm build            # tsc build of every package (run FIRST on a fresh checkout)
pnpm typecheck
pnpm lint             # eslint; `pnpm lint:fix` to autofix
pnpm format:check     # prettier; `pnpm format` to write
pnpm test             # all unit + e2e tests (root vitest, projects mode)
pnpm test:coverage    # same, with merged coverage + thresholds
pnpm knip             # unused files/exports/dependencies
pnpm check:packages   # publint + attw against the packed tarballs (needs build)
node scripts/release.mjs --dry-run   # what would be published to npm
pnpm dev              # Vendure dev server on :3000 (SQLite, superadmin/superadmin)
```

Run a single package's tests: `pnpm --filter @uplab/vendure-plugin-turbosms test`.

## Layout

```
packages/
  dev-server/                  # private: real Vendure server with every plugin registered
  vendure-plugin-<name>/       # one publishable package per plugin
    src/                       # server code → dist/ (tsc)
    e2e/                       # @vendure/testing specs (sql.js), *.e2e-spec.ts
    README.md CHANGELOG.md
docs/                          # RELEASING, TESTING, PLUGIN-AUTHORING
scripts/                       # release + package checks
```

## Plugin contract (every publishable package)

- `name: @uplab/vendure-plugin-<x>`, MIT, `publishConfig.access: public`,
  `files: ["dist", "README.md", "CHANGELOG.md"]`.
- `@vendure/*` only in `peerDependencies` (`^3.7.0`), never `dependencies`.
- `compatibility: '^3.7.0'` on the `@VendurePlugin()` decorator.
- All configuration through a static `init(options)` — **plugin code never reads
  `process.env`**; the host application stays in control.
- Register new plugins in `packages/dev-server/src/vendure-config.ts` and the
  package table in the root `README.md`.
- Full checklist: `docs/PLUGIN-AUTHORING.md`.

## Testing rules

- Unit tests (`src/**/*.spec.ts`) for pure logic; e2e (`e2e/*.e2e-spec.ts`) boots a
  real Vendure server via `@vendure/testing` + sql.js — required for anything that
  touches plugin wiring, API extensions or Vendure config.
- **Never make a real network call** — mock the vendor HTTP client (see
  `packages/vendure-plugin-turbosms/e2e/turbo-sms.e2e-spec.ts` for the axios mock).
- The sql.js fixture is cached in `e2e/__sqlite-data__/`; delete it if initial data
  changes.
- Coverage thresholds live in the root `vitest.config.mts` and fail the build.

## Gotchas

- Vitest needs SWC for Nest decorators (`unplugin-swc` in each package's vitest
  config, `useDefineForClassFields: false`).
- Do **not** convert value imports of injected classes to `import type` — with
  `emitDecoratorMetadata` that erases `design:paramtypes` and silently breaks
  Nest constructor injection (that's why `consistent-type-imports` is off).
- `CHANGELOG.md` files and `pnpm-lock.yaml` are generated (changesets / pnpm) —
  never edit them by hand.

## Changes & releases

- Conventional commit messages, scoped by package: `feat(turbosms): …`.
- Every user-visible change needs a changeset in the same PR: `pnpm changeset`
  (chore-only PRs don't). Releases are fully automated from there — see
  `docs/RELEASING.md`.
