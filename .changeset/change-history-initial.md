---
'@uplab/vendure-plugin-change-history': minor
---

Initial release of the change history plugin.

- **Capture.** Records the catalogue from Vendure's events inside the transaction that makes the change:
  products, variants, collections (moves and contents included), facets, facet values, assets, promotions and
  channel assignments, with before → after values. Cascaded deletions are derived from their cause; option
  groups and manual stock adjustments are recorded too. Actors: administrators, API keys (under the owner's
  name), the collection rules and your own resolvers.
- **Service.** `ChangeHistoryService`: `capture` after a raw write, `recordAction`, `recordRun` for external
  syncs (detail rows grouped under their product, an optional `subject`), `runBatch` (batches follow the
  callback's async context) and `reseedCollectionMembership`, plus unstable read helpers.
- **Kill switch.** `enabled: false` records nothing; the next boot with capture on brings the collection
  contents up to date by itself.
- **Retention.** `ChangeHistoryRetentionService` archives to your storage and verifies it before it compacts
  or deletes anything; `purge`, `preview` and `restore`; two built-in scheduled tasks, or your own scheduler.
- **Admin API.** The feed, one entry, entity timelines, run details and filter options, behind the new
  per-channel `ReadChangeHistory` permission. A reader sees only the entity types they may read anyway
  (`ReadCatalog`, `ReadPromotion`, …); `readPermissions` sets them for your own types. Offset pages are stable.
- **Dashboard.** A change history feed, the entry window, a history block on the detail pages, the «Recent
  changes» Insights widget, English and Ukrainian labels, and a `./dashboard` entry to register your own
  labels, sources, actions, batch kinds, entity types and renderers.
