---
name: new-plugin
description: Scaffold a new Vendure plugin package in this monorepo following the repo's package contract (use when asked to create/add a new plugin).
---

Scaffold `@uplab/vendure-plugin-$ARGUMENTS` (ask for the name if none was given).
Reference implementation: `packages/vendure-plugin-turbosms`. Full contract:
`docs/PLUGIN-AUTHORING.md`.

1. Create `packages/vendure-plugin-<name>/` mirroring turbosms's shape:
   `package.json` (name `@uplab/vendure-plugin-<name>`, `version: 0.0.0`, MIT,
   `publishConfig.access: public`, `files: ["dist", "README.md", "CHANGELOG.md"]`,
   `main`/`types`/`exports` into `dist/`, `@vendure/core` in `peerDependencies`
   `^3.7.0`, repository URL with the package `directory`), `tsconfig.json`,
   `tsconfig.build.json`, `vitest.config.mts` (copy — it carries the SWC decorator
   setup), empty `CHANGELOG.md` with the package-name heading.
2. `src/`: `constants.ts` (options injection token), `types.ts` (options +
   resolved options), `<name>.plugin.ts` (`@VendurePlugin` with
   `compatibility: '^3.7.0'`, static `init(options)` — defaults resolved there,
   no `process.env` anywhere), `index.ts` re-exporting the public surface.
3. Tests: unit specs next to sources; `e2e/<name>.e2e-spec.ts` with
   `@vendure/testing` + sql.js proving the plugin boots, vendor HTTP client
   mocked (copy the axios mock pattern from turbosms's e2e spec).
4. Register the plugin in `packages/dev-server/src/vendure-config.ts` (add the
   workspace dep to dev-server's package.json) and add a row to the package table
   in the root `README.md`. Add env variables to `packages/dev-server/.env.example`
   with a dry-run default.
5. Write the package `README.md`: install, options table, usage snippet, GraphQL
   surface (if any), changelog link.
6. `pnpm install`, then run the full gate: `pnpm build && pnpm typecheck &&
pnpm lint && pnpm test`.
7. Add a changeset (`pnpm changeset` — minor, "Initial release: …").
8. Remind the user: before the first automated release, the package must be
   published by hand once and its npm trusted publisher configured — see
   `docs/RELEASING.md`.
