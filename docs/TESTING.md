# Testing

Vitest across the workspace: the root `vitest.config.mts` runs every
`packages/vendure-plugin-*` as a project, so `pnpm test` (or `pnpm test:coverage`)
at the root runs everything with one merged coverage report.

## Layers

| Layer | Where               | What it proves                                                                            |
| ----- | ------------------- | ----------------------------------------------------------------------------------------- |
| Unit  | `src/**/*.spec.ts`  | Pure logic: option resolution, message building, error mapping                            |
| e2e   | `e2e/*.e2e-spec.ts` | The plugin actually boots inside a real Vendure server and its services behave through DI |

e2e coverage is **required** for anything that touches plugin wiring, API
extensions or Vendure config.

## e2e mechanics

- `@vendure/testing` + `SqljsInitializer` — an in-memory SQLite database, nothing
  to provision. The populated database is cached in `e2e/__sqlite-data__/`
  (gitignored); delete it when the initial data changes.
- First boot generates the fixture and is slow — timeouts are raised in each
  package's `vitest.config.mts`. `E2E_DEBUG=1` extends them further for
  breakpoint debugging.
- **No real network calls, ever.** Mock the vendor HTTP client at module level —
  see the axios mock in `packages/vendure-plugin-turbosms/e2e/turbo-sms.e2e-spec.ts`:
  every axios instance the plugin creates is the stub, so an accidental real call
  fails the test.

## Decorators & SWC

Vendure plugins rely on Nest decorators, which esbuild (vitest's default) does not
emit metadata for. Every package's vitest config therefore uses `unplugin-swc`
with `useDefineForClassFields: false` (refs: vitest#708, vendure#2099). Copy the
existing config for new packages; don't reinvent it.

Related: never convert a value import of an injected class to `import type` — it
erases `design:paramtypes` and breaks constructor injection at runtime.

## Coverage

- `pnpm test:coverage` enforces the thresholds in the root `vitest.config.mts`;
  CI uploads the merged lcov to Codecov (per-package components, patch coverage on
  PRs is informational).
- Coverage counts `packages/*/src` only — e2e fixtures, specs and the dev-server
  are excluded.
- Raise the thresholds as real coverage grows; never lower them to make a PR pass.
