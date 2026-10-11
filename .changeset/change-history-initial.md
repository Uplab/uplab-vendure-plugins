---
'@uplab/vendure-plugin-change-history': minor
---

Initial release of the change history plugin: entities, options with validation, automatic capture of the catalogue (products, variants, collections incl. moves and their contents per product with one collection-rules batch per run, facets, facet values, assets, promotions and channel assignments — created / updated with before → after values / deleted, cascaded deletions derived from their cause, option groups, manual stock adjustments, derived changes of a product save, actors incl. API keys and the collection rules), the `ChangeHistoryService` facade (`capture` for every core catalogue type, `recordAction`, `recordRun`, `runBatch`, `reseedCollectionMembership`), the before-state and archive storage strategies, the `changeHistoryEntries` Admin API query behind the new `ReadChangeHistory` permission, and a dashboard feed with a `./dashboard` entry for host registrations.
