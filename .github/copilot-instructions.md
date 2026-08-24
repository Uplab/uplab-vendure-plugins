This repository's agent instructions live in [AGENTS.md](../AGENTS.md) — commands,
layout, the plugin contract, testing rules and gotchas. Follow them exactly; the
key points:

- Always use pnpm; run `pnpm build` before `pnpm typecheck`.
- Plugin code never reads `process.env`; configuration comes through `init(options)`.
- `@vendure/*` belongs in `peerDependencies`, never `dependencies`.
- Tests never make real network calls — mock the vendor HTTP client.
- Never hand-edit `CHANGELOG.md` or `pnpm-lock.yaml`; user-visible changes need a
  changeset (`pnpm changeset`).
