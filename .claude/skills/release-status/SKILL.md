---
name: release-status
description: Show what is queued for release — pending changesets, planned version bumps, and what a publish would do right now.
---

Report the release state of the repo:

1. `ls .changeset/*.md` (ignore README.md) — list pending changesets with their
   package + bump level + summary.
2. `pnpm changeset status --verbose` — planned releases. (Needs the base branch
   available; if it fails on a shallow checkout, say so instead of guessing.)
3. `pnpm build && node scripts/release.mjs --dry-run` — which package versions are
   not yet on npm and would be published.
4. If `gh` is available: `gh pr list --search "chore(release)" --state open` to
   check whether a version PR is currently open.

Summarize: what merges to main would trigger, what the version PR contains, and
anything blocking a release (missing changesets, red CI, unpublished first
versions without a trusted publisher).
