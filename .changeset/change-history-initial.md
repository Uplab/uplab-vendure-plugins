---
'@uplab/vendure-plugin-change-history': minor
---

Initial release of the change history plugin: entities, options with validation, automatic capture of product and variant changes (created / updated with before → after values / deleted, option groups, manual stock adjustments, derived changes of a product save, actors incl. API keys), the `ChangeHistoryService` facade (`capture`, `recordAction`, `recordRun`, `runBatch`), the before-state and archive storage strategies, the `changeHistoryEntries` Admin API query behind the new `ReadChangeHistory` permission, and a dashboard feed with a `./dashboard` entry for host registrations.
