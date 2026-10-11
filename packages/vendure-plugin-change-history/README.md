# @uplab/vendure-plugin-change-history

[![npm](https://img.shields.io/npm/v/@uplab/vendure-plugin-change-history.svg)](https://www.npmjs.com/package/@uplab/vendure-plugin-change-history)
[![Vendure](https://img.shields.io/badge/Vendure-%5E3.7.0-17c9ff.svg)](https://www.vendure.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/Uplab/uplab-vendure-plugins/blob/main/LICENSE)

Who changed what in your Vendure catalogue, and when. The change history records changes to products,
variants, collections, facets, assets and promotions with their before → after values, groups bulk
operations into batches, records the runs of external syncs (an ERP, a PIM, a price feed) with one row per
changed value, and shows it all in the dashboard — in English and Ukrainian.

> **Pre-release.** This version records products and variants automatically (Vendure's catalogue events)
> and ships the `ChangeHistoryService` facade, the before-state and archive strategies, the
> `changeHistoryEntries` query, the dashboard feed and the dashboard registration entry. Collections, facets,
> assets, promotions, collection membership, the entity history blocks and tiered retention follow before
> 0.1.0; until then `capture()` records only `Product` / `ProductVariant`, and `compact()` / `purge()` reject.

## Contents

[Install](#install) · [Options](#options) · [What is recorded](#what-is-recorded) ·
[Recording from your own code](#recording-from-your-own-code) ·
[Dashboard](#dashboard) · [GraphQL API](#graphql-api) · [Database](#database) · [Changelog](#changelog)

## Install

```bash
npm install @uplab/vendure-plugin-change-history
# or
pnpm add @uplab/vendure-plugin-change-history
```

```ts
import { VendureConfig } from '@vendure/core';
import { ChangeHistoryPlugin, FileSystemArchiveStorage } from '@uplab/vendure-plugin-change-history';

export const config: VendureConfig = {
  // ...
  plugins: [
    ChangeHistoryPlugin.init({
      retention: { archive: new FileSystemArchiveStorage({ dir: './change-history-archive' }) },
    }),
  ],
};
```

The plugin adds three tables (`change_history_entry`, `change_history_detail`,
`change_history_collection_members`); generate a migration for them as for any plugin entity. Grant the new
**ReadChangeHistory** permission to the roles that may read the history.

## Options

Everything is configured through `ChangeHistoryPlugin.init(options)`; the plugin never reads environment
variables. Invalid options throw at startup with a message naming the option.

| Option                        | Default                                          | Description                                                                                                                                         |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                     | `true`                                           | Kill switch. With `false` nothing is recorded; `runBatch` still runs its callback.                                                                  |
| `entities`                    | `{}`                                             | Per core entity: `ignoreFields`, `includeReadonlyCustomFields`, `fieldKinds`, `label`.                                                              |
| `fieldExtractors`             | `[]`                                             | Extra fields of an entity's history view, e.g. a value your plugin keeps in its own table.                                                          |
| `actorResolvers`              | `[]`                                             | Your resolvers for who made a change (service accounts, SSO), tried before the built-in session resolver.                                           |
| `handlerOrder`                | `{}`                                             | `{ Product: { before: 'other-handler-id' } }` — ordering of the history's event handlers relative to another plugin's.                              |
| `beforeState`                 | `'auto'`                                         | How the "was" value is read. `auto`: a committed read on a second connection on Postgres / MySQL / MariaDB, none on SQLite. Or a strategy instance. |
| `maxValueBytes`               | `16384`                                          | Cap per side of a stored value.                                                                                                                     |
| `retention.archive`           | **required**                                     | Where compaction puts the full record first: an archive storage, or `'none'` to opt out explicitly.                                                 |
| `retention.archiveKeyPrefix`  | `'change-history-archive'`                       | Key prefix of archive objects.                                                                                                                      |
| `retention.detailDays`        | `90`                                             | Days full detail is kept.                                                                                                                           |
| `retention.summaryDays`       | `365`                                            | Days compacted entries are kept. Must be at least `detailDays` and `runLineDays`.                                                                   |
| `retention.runLineDays`       | `detailDays`                                     | Days external-run entries are kept.                                                                                                                 |
| `retention.compactValueBytes` | `1024`                                           | Text values longer than this are reduced to their length at compaction.                                                                             |
| `retention.schedule`          | `{ compact: '45 4 * * *', purge: '15 5 * * *' }` | Cron expressions of the built-in retention tasks, or `false` to run `ChangeHistoryRetentionService` from your own scheduler.                        |
| `retention.batchSize`         | `2000` / `5000`                                  | Rows per compaction / purge batch.                                                                                                                  |
| `retention.maxBatches`        | `20`                                             | Batches per run.                                                                                                                                    |

## What is recorded

Every change is recorded **inside the transaction that makes it** (a blocking event handler, in a savepoint):
an entry commits or rolls back with its change, and a failing history write never fails your mutation — it is
logged with a `[ChangeHistory]` prefix.

| Entity         | Actions                                                                       | Fields                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product        | `created`, `updated`, `deleted`, `option_group_added`, `option_group_removed` | `enabled`, `name` / `slug` / `description` per language, `featuredAsset`, `assets` (order kept), `facetValues`, `optionGroups`, custom fields                                                                                          |
| ProductVariant | `created`, `updated`, `deleted`, `stock_adjusted`                             | `sku`, `enabled`, `name` per language, `prices` (per channel and currency), `taxCategory`, `trackInventory`, `outOfStockThreshold`, `useGlobalOutOfStockThreshold`, `options`, `facetValues`, `featuredAsset`, `assets`, custom fields |

- **`updated`** lists only the fields that changed, with the value from before the save and after it. A save
  that changes nothing writes nothing.
- **`created`** lists every value the entity was created with; **`deleted`** keeps the last state in
  `meta.lastState`. Deleting a product records its variants' deletions too.
- **`stock_adjusted`**: a manual stock change (an `ADJUSTMENT` movement), with the location and stock on hand
  before → after. Sales and allocations are not recorded, nor is the initial stock of a new variant.
- **Custom fields** are recorded by key (`customFields.<name>`, `customFields.<name>.<language>` for
  translatable ones). Fields declared `readonly` or `internal` are written by code and left out, unless you list
  them in `entities.<Type>.includeReadonlyCustomFields`. Relation fields are stored as ids with the target's
  name as a label. `entities.<Type>.ignoreFields` drops noisy keys, `entities.<Type>.fieldKinds` tells the
  dashboard how to show a value (`{ 'customFields.price': 'money' }`).
- References (facet values, assets, options, tax category, relation custom fields) are compared **by id**; the
  names are stored as labels for display. Renaming a facet value is therefore not a change of every product
  that uses it.
- A value longer than `maxValueBytes` is stored shortened, its head and tail kept (`truncated: true`).

**Who.** The actor is resolved once per request: a `runBatch` actor first, then your `actorResolvers`, then the
session's administrator (`admin`) or the owner of the API key the request authenticated with (`api_key`), and
otherwise `system` with source `unknown_system` (its `meta` says which API and process). An entry's `source` is
the actor's.

**Derived changes.** An entry gets `derivedFromId` when, in the same transaction, its parent already has an
entry (a variant after its product) or the entity itself was created earlier in it. A plugin that rewrites the
variants from a product handler (a price fan-out) therefore shows as one product change with derived variant
changes. That needs the history handler to run first: declare `after: CHANGE_HISTORY_HANDLER_IDS.Product` on
your own handler, or use the `handlerOrder` option for a handler you cannot edit.

## Recording from your own code

Inject `ChangeHistoryService` (add `ChangeHistoryPlugin` to your plugin's `imports`). Its write methods never
reject because of a history failure — the failure is logged with a `[ChangeHistory]` prefix — and write in
the caller's transaction through a savepoint, so an entry commits or rolls back with the change it describes.

```ts
// After a write that bypassed Vendure's events (raw SQL, a repository update), in the same transaction:
await this.connection.getRepository(ctx, Product).update(ids, { customFields: { isArchived: true } });
await this.changeHistory.capture(ctx, 'Product', ids, { action: 'archived' });

// An entry without a diff, e.g. for an entity of your own:
await this.changeHistory.recordAction(ctx, {
  entityType: 'ProductOrder',
  entityId: 'global',
  entityLabel: 'Global product order',
  action: 'products_reordered',
  meta: { counts: { moved: 3 } },
});

// A sync that changed values outside Vendure's events: one entry plus one row per value.
await this.changeHistory.recordRun(ctx, {
  source: 'erp_stock_sync',
  label: 'ERP stock sync',
  counts: { updated: 37, failed: 0 },
  details: [{ entityType: 'ProductVariant', entityId: 12, kind: 'stock', scope: '1', from: 10, to: 14 }],
});

// Everything recorded inside the callback is grouped under one batch (and, optionally, another actor).
await this.changeHistory.runBatch(ctx, { kind: 'bulk_edit', label: 'Bulk edit' }, async (ctx) => {
  await this.saveAll(ctx, input);
});
```

For `ProductVariant` and `FacetValue` detail rows the plugin resolves the parent Product / Facet itself.
`entityType`, `action`, `source` and batch `kind` are free strings; give yours labels in the dashboard.

## Dashboard

The feed is under **System → Change history** (`/change-history`, permission `ReadChangeHistory`). Its
navigation `order` is exported as `CHANGE_HISTORY_NAV_ORDER`; give an item of your own
`order: CHANGE_HISTORY_NAV_ORDER + 1` to place it right after.

Your own dashboard extension labels your values through the `./dashboard` entry:

```ts
import { msg } from '@lingui/core/macro';
import { defineDashboardExtension } from '@vendure/dashboard';
import {
  registerChangeHistoryAction,
  registerChangeHistoryFieldLabels,
  registerChangeHistorySource,
} from '@uplab/vendure-plugin-change-history/dashboard';

registerChangeHistoryFieldLabels('Product', { 'customFields.subtitle': msg`Subtitle` });
registerChangeHistorySource('erp_stock_sync', { label: msg`ERP stock sync`, tone: 'system' });
registerChangeHistoryAction('products_reordered', { label: msg`reordered products` });

defineDashboardExtension({});
```

Also available: `registerChangeHistoryValueRenderer`, `registerChangeHistoryDetailRenderer`,
`registerChangeHistoryBatchKind`, `registerChangeHistoryEntityType`. Exclude the package from Vite's
dependency pre-bundling in your dashboard's `vite.config`, so the entry is compiled like the rest of your
extension:

```ts
optimizeDeps: { exclude: ['@uplab/vendure-plugin-change-history'] },
```

Install the package from a registry or a packed tarball. A symlinked install (`npm link`, a `file:` directory)
hides its dashboard extension from Vendure's dashboard discovery.

## GraphQL API

Admin API, every query behind `ReadChangeHistory`:

```graphql
type ChangeHistoryEntry implements Node {
  id: ID!
  createdAt: DateTime!
  entityType: String!
  entityId: String!
  entityLabel: String
  parentType: String
  parentId: String
  action: String!
  source: String!
  actorType: String!
  actorId: ID
  actorLabel: String
  batchId: String
  channelId: ID
  derivedFromId: ID
  changes: JSON
  meta: JSON!
  summary: String!
  compactedAt: DateTime
}

extend type Query {
  changeHistoryEntries(options: ChangeHistoryEntryListOptions): ChangeHistoryEntryList!
}
```

`changeHistoryEntries` takes Vendure's list options (filter, sort, paging) and lists newest first by default.

## Database

Postgres first. Before → after values need a second database connection that still sees the last committed
row while a save is in progress: that works on Postgres and, in principle, on MySQL / MariaDB (untested).
On SQLite every change is still recorded, without the "was" values (`meta.noBefore = "unsupported"`), and the
plugin logs a warning at startup. On Postgres an entry is recorded without values only when the before-state
could not be read: the save ran outside a transaction (`no_transaction`, logged once per entity type), the pool
had no free connection within 500 ms (`pool`; the save does not wait for one) or the read failed (`error`). The tables use `simple-json`, plain indexes and no foreign keys to core
tables, so the generated migration is portable.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
