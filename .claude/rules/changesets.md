---
paths:
  - '.changeset/**'
---

# Changesets

- One changeset per user-visible change; chore-only work (CI, docs, refactors with
  no published effect) does not need one.
- The summary is the changelog entry users read — write it for plugin consumers
  (what changed and why it matters), not as a commit message.
- Bump levels: `patch` for fixes, `minor` for new options/features, `major` for
  breaking option or behaviour changes. While packages are 0.x, minor = breaking.
- Never edit `.changeset/config.json` casually — it drives versioning and publish.
