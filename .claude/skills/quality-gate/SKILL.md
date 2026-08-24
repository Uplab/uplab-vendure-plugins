---
name: quality-gate
description: Run the full local quality gate for this repo (build, typecheck, lint, format, tests with coverage, knip, package tarball checks, release dry-run) and fix what fails.
---

Run the complete quality gate from the repo root, in this order (build must come
first — dev-server resolves workspace types from dist/):

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:coverage
pnpm knip
pnpm check:packages
node scripts/release.mjs --dry-run
```

Rules:

- Stop at the first failing step, fix the cause, then re-run that step before
  continuing. Prefer `pnpm lint:fix` / `pnpm format` for mechanical fixes.
- Coverage thresholds live in the root `vitest.config.mts`. If coverage dropped,
  add tests — do not lower thresholds without being asked.
- `pnpm knip` findings: remove genuinely dead code/deps; if something is a false
  positive, add a targeted exception in `knip.json` with a comment.
- Finish with a short report: every step green, or exactly what failed and why.
