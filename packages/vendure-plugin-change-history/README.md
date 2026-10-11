# @uplab/vendure-plugin-change-history

[![npm](https://img.shields.io/npm/v/@uplab/vendure-plugin-change-history.svg)](https://www.npmjs.com/package/@uplab/vendure-plugin-change-history)
[![Vendure](https://img.shields.io/badge/Vendure-%5E3.7.0-17c9ff.svg)](https://www.vendure.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/Uplab/uplab-vendure-plugins/blob/main/LICENSE)

Who changed what in your Vendure catalogue, and when. The change history records changes to products,
variants, collections, facets, assets and promotions with their before → after values, groups bulk
operations into batches, records the runs of external syncs (an ERP, a PIM, a price feed) with one row per
changed value, and shows it all in the dashboard — in English and Ukrainian.

> **Pre-release.** This version records the catalogue automatically (Vendure's events: products, variants,
> collections and their contents, facets, facet values, assets, promotions, channel assignments), records
> external runs with their detail rows, runs tiered retention with an archive, and ships the
> `ChangeHistoryService` facade, the before-state and archive strategies, the Admin API read queries (feed,
> entry, entity timeline, run details, filter options) and the dashboard: the change history feed, the entry
> window, a history block on five detail pages, an Insights widget and the registration entry for your labels
> and renderers.

## Contents

[Install](#install) · [Options](#options) · [What is recorded](#what-is-recorded) ·
[Recording from your own code](#recording-from-your-own-code) ·
[Retention](#retention) · [Dashboard](#dashboard) · [GraphQL API](#graphql-api) · [Database](#database) ·
[Changelog](#changelog)

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
| `retention.runLineDays`       | `detailDays`                                     | Days external-run entries are kept (deleted at compaction once older; purge removes compacted ones).                                                |
| `retention.compactValueBytes` | `1024`                                           | Text values longer than this are reduced to their length at compaction.                                                                             |
| `retention.schedule`          | `{ compact: '45 4 * * *', purge: '15 5 * * *' }` | Cron expressions of the built-in retention tasks, or `false` to run `ChangeHistoryRetentionService` from your own scheduler.                        |
| `retention.batchSize`         | `2000` / `5000`                                  | Rows per compaction / purge batch.                                                                                                                  |
| `retention.maxBatches`        | `20`                                             | Batches per run.                                                                                                                                    |

## What is recorded

Every change is recorded **inside the transaction that makes it** (a blocking event handler, in a savepoint):
an entry commits or rolls back with its change, and a failing history write never fails your mutation — it is
logged with a `[ChangeHistory]` prefix.

| Entity         | Actions                                                                                                                              | Fields                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product        | `created`, `updated`, `deleted`, `option_group_added`, `option_group_removed`, `collection_added`, `collection_removed`, `channel_*` | `enabled`, `name` / `slug` / `description` per language, `featuredAsset`, `assets` (order kept), `facetValues`, `optionGroups`, custom fields                                                                                          |
| ProductVariant | `created`, `updated`, `deleted`, `stock_adjusted`, `channel_*`                                                                       | `sku`, `enabled`, `name` per language, `prices` (per channel and currency), `taxCategory`, `trackInventory`, `outOfStockThreshold`, `useGlobalOutOfStockThreshold`, `options`, `facetValues`, `featuredAsset`, `assets`, custom fields |
| Collection     | `created`, `updated`, `moved`, `deleted`                                                                                             | `name` / `slug` / `description` per language, `isPrivate`, `inheritFilters`, `parent`, `filters` (JSON, facet values labelled), `featuredAsset`, `assets`, custom fields; `position` on a move only                                    |
| Facet          | `created`, `updated`, `deleted`                                                                                                      | `name` per language, `code`, `isPrivate`, custom fields                                                                                                                                                                                |
| FacetValue     | `created`, `updated`, `deleted`                                                                                                      | `name` per language, `code`, custom fields; under its facet, labelled "Facet: Value"                                                                                                                                                   |
| Asset          | `created`, `updated`, `deleted`, `channel_*`                                                                                         | `name` per language, `type`, `mimeType`, `fileSize`, `width`, `height`, `focalPoint`, `tags`, custom fields                                                                                                                            |
| Promotion      | `created`, `updated`, `deleted`                                                                                                      | `name` / `description` per language, `enabled`, `startsAt`, `endsAt`, `couponCode`, `perCustomerUsageLimit`, `usageLimit`, `conditions` / `actions` (JSON, facet values labelled), custom fields — not the computed `priorityScore`    |

- **`updated`** lists only the fields that changed, with the value from before the save and after it. A save
  that changes nothing writes nothing.
- **`created`** lists every value the entity was created with; **`deleted`** keeps the last state in
  `meta.lastState`. Deleting a product records its variants' deletions too.
- **`stock_adjusted`**: a manual stock change (an `ADJUSTMENT` movement), with the location and stock on hand
  before → after. Sales and allocations are not recorded, nor is the initial stock of a new variant.
- **Collection contents.** A product is in a collection when one of its variants is. Every change of a
  collection's products — the filters job after a filter, product or variant change, or a change inside a
  request — writes one `collection_added` / `collection_removed` entry per product (on the Product, with the
  collection as its parent, so it shows on both), grouped under one batch per collection and run: its head
  (`entityType = 'Batch'`, `meta.kind = 'collection_rules'`, parent = the collection) says
  `+3 / −1` and carries `meta.counts = { added, removed }`. A product that left because it was deleted gets no
  entry (its own `deleted` entry says it). The plugin keeps the last known products of each collection in
  `change_history_collection_members`; at every startup it records the contents of each collection it has no
  row for, so the first change after you install it is recorded too. After running with `enabled: false`, call
  `ChangeHistoryService.reseedCollectionMembership(ctx)` before re-enabling, or the first change of each
  collection records everything that changed meanwhile.
- **`moved`**: a collection moved under another parent or to another position, with `parent` and `position`
  before → after. The siblings Vendure renumbers are not recorded.
- **Cascades.** Deleting a collection records its descendants' deletions too, derived from it, each with its
  last state and `meta.memberCount`. Deleting a facet records its values' deletions, derived from it. A deleted
  facet value keeps how many products and variants used it (`meta.usedByProducts` / `meta.usedByVariants`).
- **`channel_assigned` / `channel_removed`**: a product, variant or asset assigned to or removed from a
  channel, with the channel in `meta` (`channelId`, `channelCode`). Removing an asset from its last channel is
  part of deleting it and is left to its `deleted` entry.
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
otherwise `system`: with source `collection_rules` for a change of a collection's contents made by Vendure's
filters job, else `unknown_system` (its `meta` says which API and process). An entry's `source` is the actor's.

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

`capture()` diffs any core type: `Product`, `ProductVariant`, `Collection`, `Facet`, `FacetValue`, `Promotion`
and `Asset`. Use `recordAction` for anything else.

For `ProductVariant` and `FacetValue` detail rows the plugin resolves the parent Product / Facet itself, so a
product finds the rows of its variants. A run stores its `counts`, `durationMs` and `detailCount` in `meta`,
writes its rows in chunks of 500 and keeps at most 5,000 rows (a larger run stores the first 5,000 and counts
the rest in `meta.detailsOmitted`). A run with no rows and only zero counts writes nothing. Called inside your
transaction, the run commits or rolls back with it.

`entityType`, `action`, `source` and batch `kind` are free strings; give yours labels in the dashboard.

## Retention

The history is kept in tiers (all windows are options, in days):

| Tier      | What                                                                                                                                                                                 | Kept                             | Then                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ---------------------------------------- |
| Detail    | long values (rich text, other values longer than `compactValueBytes`), derived rows (a variant changed by its product's save), collection-rules member rows, the detail rows of runs | `detailDays` (90)                | archived, then compacted                 |
| Summary   | every entry: who, what, when, which fields, short values, JSON diffs (filters, conditions), references, stock, batch heads, cascaded deletions with their last state                 | `summaryDays` (365)              | deleted                                  |
| Run lines | the `Run` entries of external syncs: counts and duration                                                                                                                             | `runLineDays` (= `detailDays`)   | deleted at compaction, after the archive |
| Archive   | the full record of every entry and its detail rows, as it was before compaction                                                                                                      | as long as your storage keeps it | —                                        |

**Compaction** (`compact`, nightly) takes the oldest entries older than the detail window that are not
compacted yet, in batches, and for each batch:

1. writes every entry and its detail rows as gzipped JSON Lines to the archive storage
   (`<archiveKeyPrefix>/<yyyy>/<mm>/change-history_<stamp>_<maxId>_<uuid>.jsonl.gz`, one object per batch), then
   requires `exists(key)` to confirm it — **nothing is stripped or deleted before that**;
2. in one transaction: snapshots the counts that are about to disappear (`meta.derivedCount` on the cause,
   `meta.batchCounts` on a batch head), deletes detail rows, derived rows (except cascaded deletions),
   collection-rules member rows and run lines older than `runLineDays`, replaces long values by
   `{ kind, stripped: true, fromLength, toLength }` (in `meta.lastState`: `{ stripped: true, length }`) and sets
   `compactedAt`.

`json`, `refs`, `prices`, `assets` and `stock` values are never stripped. A compacted entry is never
compacted again. A failed upload or verification rejects the run and leaves the failing batch untouched;
the next run retries it (an object may then be written twice — harmless on restore).

**Purge** (`purge`, nightly) deletes compacted entries older than the summary window (and compacted run lines
older than `runLineDays`). An entry that was never compacted is never purged, whatever the window, so nothing
leaves the database before its full record reached the archive.

With `retention.archive: 'none'` compaction runs without an archive copy and logs a warning every run.

### Scheduling

By default the plugin registers two Vendure scheduled tasks, `change-history-compact` (`45 4 * * *`) and
`change-history-purge` (`15 5 * * *`), with a 30-minute timeout and no overlap. They need a scheduler in your
config — `DefaultSchedulerPlugin` or another `SchedulerStrategy`; without one the plugin logs a warning at
startup. To drive retention from your own scheduler, set `retention.schedule: false` and call the service:

```ts
const retention = injector.get(ChangeHistoryRetentionService);
await retention.preview(ctx, { compactOlderThanDays: 90, purgeOlderThanDays: 365 }); // { compactable, purgeable }
await retention.compact(ctx, { olderThanDays: 90, batchSize: 2000, maxBatches: 20, onProgress: (n) => log(n) });
await retention.purge(ctx, { olderThanDays: 365, dryRun: true });
```

`compact` returns `{ scanned, archived, archiveKeys, stripped, derivedDeleted, membersDeleted, runsDeleted,
detailsDeleted, batches, drained }`, `purge` `{ scanned, deleted, batches, drained }`; `drained: false` means
`maxBatches` stopped a backlog. `dryRun` reports the same counts and changes nothing.

### Archive storage

Pass any object with `put` and `exists` (Vendure's `InjectableStrategy`; the plugin calls its `init(injector)`
on startup and `destroy()` on shutdown, so it can inject your services):

```ts
export class BucketArchiveStorage implements ChangeHistoryArchiveStorage {
  private bucket: BucketService;
  init(injector: Injector) {
    this.bucket = injector.get(BucketService);
  }
  /** Write the object; reject on failure. */
  put(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.bucket.upload(key, body, contentType);
  }
  /** Confirm the object exists (a HEAD request): compaction strips nothing until this resolves `true`. */
  exists(key: string): Promise<boolean> {
    return this.bucket.has(key);
  }
}
```

Keys are relative paths under `retention.archiveKeyPrefix` (default `change-history-archive`); bodies are
gzipped JSON Lines (`application/gzip`), one `{ "table": "change_history_entry" | "change_history_detail",
"row": { … } }` per line, with the columns as stored (timestamps in the database's own text form, JSON
columns parsed). `FileSystemArchiveStorage({ dir })` writes them as files — for development and tests.

### Restoring from the archive

1. Fetch the objects of the period you need from your archive storage (the key carries year and month).
2. Load them with a script that boots your Vendure config (e.g. `bootstrapWorker`) and calls the service:

```ts
import { readFile } from 'node:fs/promises';
import { bootstrapWorker, RequestContextService } from '@vendure/core';
import { ChangeHistoryRetentionService, decodeChangeHistoryArchive } from '@uplab/vendure-plugin-change-history';

const { app } = await bootstrapWorker(config);
const ctx = await app.get(RequestContextService).create({ apiType: 'admin' });
for (const file of process.argv.slice(2)) {
  const lines = decodeChangeHistoryArchive(await readFile(file));
  console.log(file, await app.get(ChangeHistoryRetentionService).restore(ctx, lines));
}
await app.close();
```

`restore` gives an entry that still exists its archived `changes` and `meta` back and **keeps its
`compactedAt`**; rows compaction deleted (derived, member and run entries, detail rows) are inserted again
under their archived ids, entries with `compactedAt` set. That way the next compaction leaves the restored
rows alone instead of archiving and deleting them again; the next purge removes them with the rest once
they are older than the summary window. Restoring the same object twice changes nothing more. For a one-off
look without touching the live tables, read the lines with `decodeChangeHistoryArchive` (or `gunzip` the
object) instead.

## Dashboard

Everything needs the **ReadChangeHistory** permission. The dashboard is in English and Ukrainian.

- **Feed** — **System → Change history** (`/change-history`). One row per change: time, who, type, object
  (a link to it, «deleted» when it is gone), action and what changed. Search by name or SKU, filter by type,
  action, source and who, pick a period, and two switches: **Collapse bulk operations** (on: a batch is one
  row) and **Hide system changes** (off: collection rules and external runs are listed too). Filters, switches,
  period and the open entry are in the URL, so a view is a link you can send. Clicking a row opens the entry.
- **Entry window** — who, when, from where, a link to the entity; the changed fields as _field · was · became_;
  the derived entries (variant prices a product save rewrote), a batch's members and a run's rows, each paged;
  for a deleted entity its last state and **Full history**, the entity's timeline in the same window.
- **History block** — at the bottom of the product, variant, collection, facet and promotion pages: the
  entity's history newest first, 20 at a time with **Show more**, the changes of its children (variants, facet
  values, child collections) marked with their name, derived entries folded under their cause, collection
  rules batches with their counts and members, and each external run as one collapsed item with its count
  line («Variants: 3 · Rows: 4») that unfolds into this entity's rows. On a page whose entity a run touched
  alone (a variant), the rows show directly.
- **Insights widget «Recent changes»** — the last 10 rows of the feed's default view in the Insights date
  range, with **All changes →** opening the feed for the same period.

Values are drawn by their `kind`: `text`, `enum`, `bool`, `date`, `money` (the channel's currency), `prices`,
`ref` / `refs` (labels, removed on the left and added on the right), `assets` (thumbnails, added and removed
outlined, «order changed»), `richtext` (plain text, collapsed, «show in full»), `json` (side by side, changed
lines highlighted, facet value ids shown by name), `stock` (with the delta), and a compacted value as
«changed (3,412 → 3,587 characters)». The feed's navigation `order` is `CHANGE_HISTORY_NAV_ORDER`; give an
item of your own `order: CHANGE_HISTORY_NAV_ORDER + 1` to place it right after.

### Your labels, sources and renderers

Your own dashboard extension registers what the package cannot know through the `./dashboard` entry. A label
is a Lingui message descriptor (``msg`…` ``, translated by your catalogs) or a plain string. Registrations run
when your extension loads; the package reads them when it renders, so the order of the extensions does not
matter, and yours win over the built-in ones.

```tsx
import { msg } from '@lingui/core/macro';
import { defineDashboardExtension } from '@vendure/dashboard';
import { CalendarClock, Plug } from 'lucide-react';
import {
  registerChangeHistoryAction,
  registerChangeHistoryBatchKind,
  registerChangeHistoryDetailRenderer,
  registerChangeHistoryEntityType,
  registerChangeHistoryFieldLabels,
  registerChangeHistorySource,
  registerChangeHistoryValueRenderer,
  type ChangeHistoryDetailRendererProps,
  type ChangeHistoryValueRendererProps,
} from '@uplab/vendure-plugin-change-history/dashboard';

// Field names, keyed as in `changes` without the language suffix ("(uk)" is added for you).
registerChangeHistoryFieldLabels('Product', {
  'customFields.price': msg`Price`,
  'customFields.discountStartAt': msg`Discount from`,
});

// A source of yours: label, tone (human / system / scheduled), icon, and labels for its runs' count keys.
registerChangeHistorySource('erp_stock_sync', {
  label: msg`ERP: stock sync`,
  tone: 'system',
  icon: Plug,
  countLabels: { updated: msg`updated`, zeroed: msg`zeroed`, created: msg`added`, failed: msg`failed` },
});
registerChangeHistorySource('scheduled_action', {
  label: msg`Scheduled action`,
  tone: 'scheduled',
  icon: CalendarClock,
});

registerChangeHistoryAction('archived', { label: msg`archived` });
registerChangeHistoryBatchKind('bulk_edit', { label: msg`Bulk edit` });
registerChangeHistoryEntityType('ProductOrder', { label: msg`Product order`, route: () => '/product-order/global' });

// One side of a value of your kind (`entities.<Type>.fieldKinds` or a field extractor names the kind).
function Swatch({ change, side }: ChangeHistoryValueRendererProps) {
  const color = change[side];
  return typeof color === 'string' ? (
    <span style={{ background: color }} className="inline-block h-4 w-4 rounded" />
  ) : null;
}
registerChangeHistoryValueRenderer('color', Swatch);

// Rows of an external run of your kind: `dialog` (a page of the whole run), `timeline` (this entity's rows),
// `summary` (the inline count line of the collapsed item — your own plural forms go here).
function StockRows({ rows, mode }: ChangeHistoryDetailRendererProps) {
  if (mode === 'summary') return <span>{rows.length} rows</span>;
  return <table>{/* … */}</table>;
}
registerChangeHistoryDetailRenderer('stock', StockRows);

defineDashboardExtension({});
```

Without a renderer of its own, a run's rows use the package's table: _SKU / ID · name · scope · was · became
(±delta)_, sorted by SKU, with the count line «Variants: 3 · Rows: 4». A field nobody labelled shows its key in
words (`customFields.fullPrice` → «Full price»), a source nobody registered its value in words.

Exclude the package from Vite's dependency pre-bundling in your dashboard's `vite.config`, so the entry is
compiled like the rest of your extension (the registry lives on `globalThis`, so a second copy would still
share it):

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
  isCompacted: Boolean!
  derivedCount: Int!
  batchCounts: [ChangeHistoryBatchCount!] # batch heads only
  entityDeleted: Boolean!
  details: [ChangeHistoryDetail!] # run items of a timeline only
  derivedEntries(options: ChangeHistoryEntryListOptions): ChangeHistoryEntryList!
  batchMembers(options: ChangeHistoryEntryListOptions): ChangeHistoryEntryList!
}

type ChangeHistoryBatchCount {
  entityType: String!
  action: String!
  count: Int!
}
type ChangeHistoryDetail {
  id: ID!
  entryId: ID!
  entityType: String!
  entityId: String!
  entityLabel: String
  sku: String
  parentType: String
  parentId: String
  kind: String!
  scope: String
  scopeLabel: String
  from: JSON
  to: JSON
}
type ChangeHistoryDetailList {
  items: [ChangeHistoryDetail!]!
  totalItems: Int!
}
type ChangeHistoryEntityTimeline {
  items: [ChangeHistoryEntry!]!
  endCursor: String
  hasMore: Boolean!
}
type ChangeHistoryActor {
  id: ID!
  type: String!
  label: String!
}
type ChangeHistoryFilterOptions {
  actors: [ChangeHistoryActor!]!
  sources: [String!]!
  actions: [String!]!
  entityTypes: [String!]!
}

extend type Query {
  changeHistoryEntries(options: ChangeHistoryEntryListOptions): ChangeHistoryEntryList!
  changeHistoryEntry(id: ID!): ChangeHistoryEntry
  changeHistoryEntityTimeline(
    entityType: String!
    entityId: String!
    includeChildren: Boolean = true
    first: Int = 20
    after: String
  ): ChangeHistoryEntityTimeline!
  changeHistoryRunDetails(entryId: ID!, skip: Int = 0, take: Int = 100): ChangeHistoryDetailList!
  changeHistoryFilterOptions: ChangeHistoryFilterOptions!
}
```

- **`changeHistoryEntries`** is the feed. It takes Vendure's list options and lists newest first by default.
  Derived entries (a variant price rewritten by a product save) are left out unless the filter names
  `derivedFromId`; their cause carries `derivedCount`. The filters a feed needs:

  | Filter               | Option                                                                  |
  | -------------------- | ----------------------------------------------------------------------- |
  | who                  | `actorId: { eq }` (with `actorType` to tell an API key from its owner)  |
  | hide system          | `actorType: { in: ["admin", "api_key"] }`                               |
  | period               | `createdAt: { between: { start, end } }`                                |
  | type, action, source | `entityType` / `action` / `source`: `{ in: [...] }`                     |
  | search               | `entityLabel: { contains }` (a variant's label holds its SKU)           |
  | one batch            | `batchId: { eq }`                                                       |
  | collapse batches     | `_or: [{ batchId: { isNull: true } }, { entityType: { eq: "Batch" } }]` |

  `derivedCount`, `batchCounts`, `entityDeleted` and `isCompacted` are computed, so they cannot be filtered or
  sorted on.

- **`changeHistoryEntry`** is one entry. `derivedEntries` and `batchMembers` page with the same list options.
- **`changeHistoryEntityTimeline`** is one entity's history, newest first, paged with `first` (1–100) and
  `after` (the previous page's `endCursor`). `entityId` is the database id, as stored in
  `ChangeHistoryEntry.entityId`. It includes the entity's own entries, and with `includeChildren` (the default)
  its children's non-derived entries: a product's variants, a facet's values, a collection's child
  collections and its rules batches (the products that entered or left are collapsed into the batch). Each
  external run that changed the entity, or one of its children, is a single item whose `details` hold only
  those rows. The timeline is read from the primary database, so a change shows right after its save, even
  with read replicas.
- **`changeHistoryRunDetails`** returns a run's rows with the current name (and a variant's SKU), sorted by
  SKU or name, then name, then scope. `take` is at most 500.
- **`changeHistoryFilterOptions`** lists the actors (an API key under its owner's id with `type: "api_key"`),
  sources, actions and entity types of the last `summaryDays`, for filter dropdowns. It is cached for 60
  seconds per process.
- After compaction, `derivedCount` and `batchCounts` come from the counts the compaction kept.

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
