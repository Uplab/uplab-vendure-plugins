@AGENTS.md

## Claude Code specifics

- Project skills: `/quality-gate` (full local gate), `/new-plugin <name>` (scaffold a
  new plugin package), `/release-status` (pending changesets + publish dry-run).
- Hooks auto-format edited files with prettier and block manual edits to generated
  files (`CHANGELOG.md`, `pnpm-lock.yaml`) — add a changeset instead.
- Path-scoped rules in `.claude/rules/` load when you edit plugin sources or
  changesets.
