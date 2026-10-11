# @uplab/vendure-plugin-change-history

[![npm](https://img.shields.io/npm/v/@uplab/vendure-plugin-change-history.svg)](https://www.npmjs.com/package/@uplab/vendure-plugin-change-history)
[![Vendure](https://img.shields.io/badge/Vendure-%5E3.7.0-17c9ff.svg)](https://www.vendure.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/Uplab/uplab-vendure-plugins/blob/main/LICENSE)

Who changed what in your Vendure catalogue, and when. The change history records changes to products,
variants, collections, facets, assets and promotions with their before → after values, groups bulk
operations into batches, records the runs of external syncs (an ERP, a PIM, a price feed) with one row per
changed value, and shows it all in the dashboard — in English and Ukrainian.

> **Pre-release.** This version ships the plugin's foundation: the entities, the options, the
> `ChangeHistoryService` facade with `recordAction`, `recordRun` and `runBatch`, the before-state and archive
> strategies, the `changeHistoryEntries` query, the dashboard feed and the dashboard registration entry.
> Automatic capture of Vendure's catalogue events, the entity history blocks and tiered retention follow
> before 0.1.0; `capture()` resolves without recording and `compact()` / `purge()` reject until then.

## Contents

[Install](#install) · [Options](#options) · [Recording from your own code](#recording-from-your-own-code) ·
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

## Recording from your own code

Inject `ChangeHistoryService` (add `ChangeHistoryPlugin` to your plugin's `imports`). Its write methods never
reject because of a history failure — the failure is logged with a `[ChangeHistory]` prefix — and write in
the caller's transaction through a savepoint, so an entry commits or rolls back with the change it describes.

```ts
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
plugin logs a warning at startup. The tables use `simple-json`, plain indexes and no foreign keys to core
tables, so the generated migration is portable.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
