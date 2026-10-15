# @uplab/vendure-plugin-change-history

## 0.1.2

### Patch Changes

- [#43](https://github.com/Uplab/uplab-vendure-plugins/pull/43) [`c1a7435`](https://github.com/Uplab/uplab-vendure-plugins/commit/c1a7435d95b0835a24ee51ff2ff529c5153afc9c) Thanks [@brmk](https://github.com/brmk)! - Keep the grey badges grey on the Vendure 3.8 dashboard. Its Badge no longer has a `secondary` variant and shows such a badge as plain text. That hit the «System change» badge in the change history, and the «Disabled» and «Fetched rate» badges on the exchange-rate pages. They look the same as before on 3.7.

- [#43](https://github.com/Uplab/uplab-vendure-plugins/pull/43) [`c7d7775`](https://github.com/Uplab/uplab-vendure-plugins/commit/c7d777541307cf7be3a80b07f9e3438e9c03c2f1) Thanks [@brmk](https://github.com/brmk)! - Install alongside Vendure 3.8: the `@nestjs/common` and `@nestjs/core` peers now accept `^11 || ^12`, and `@nestjs/graphql` accepts `^13 || ^14`. Vendure 3.8 moved to NestJS 12, so `npm install` failed with `ERESOLVE` against the old `^11` / `^13` ranges. Nothing changes on Vendure 3.7.

## 0.1.1

### Patch Changes

- [#41](https://github.com/Uplab/uplab-vendure-plugins/pull/41) [`31d5deb`](https://github.com/Uplab/uplab-vendure-plugins/commit/31d5deba10edce2aef108da53358fafbb5ff7fae) Thanks [@brmk](https://github.com/brmk)! - Ship the LICENSE file in the package.

## 0.1.0

### Minor Changes

- [#37](https://github.com/Uplab/uplab-vendure-plugins/pull/37) [`c674b55`](https://github.com/Uplab/uplab-vendure-plugins/commit/c674b55d7ed5088592d1a290bbae0162c199d109) Thanks [@brmk](https://github.com/brmk)! - Initial release of the change history plugin.

  - **Capture.** Records the catalogue from Vendure's events inside the transaction that makes the change:
    products, variants, collections (moves and contents included), facets, facet values, assets, promotions and
    channel assignments, with before → after values. Cascaded deletions are derived from their cause, and so are
    the variants and images that go to a channel with their product: one operation is one row, several products
    at once one batch. Option groups and manual stock adjustments are recorded too. Actors: administrators, API
    keys (under the owner's name), the collection rules and your own resolvers.
  - **Service.** `ChangeHistoryService`: `capture` after a raw write, `recordAction`, `recordRun` for external
    syncs (detail rows grouped under their product, an optional searchable `subject`), `runBatch` (batches follow the
    callback's async context) and `reseedCollectionMembership`, plus unstable read helpers.
  - **Kill switch.** `enabled: false` records nothing; the next boot with capture on brings the collection
    contents up to date by itself.
  - **Retention.** `ChangeHistoryRetentionService` archives to your storage and verifies it before it compacts
    or deletes anything; `purge`, `preview` and `restore`; two built-in scheduled tasks, or your own scheduler.
  - **Admin API.** The feed, one entry, entity timelines, run details and filter options, behind the new
    per-channel `ReadChangeHistory` permission. A reader sees only the entity types they may read anyway
    (`ReadCatalog`, `ReadPromotion`, …); `readPermissions` sets them for your own types.
  - **Dashboard.** A change history feed, the entry window, a history block on the detail pages, the «Recent
    changes» Insights widget, English and Ukrainian labels, and a `./dashboard` entry to register your own
    labels, sources, actions, batch kinds, entity types, renderers and value texts.
