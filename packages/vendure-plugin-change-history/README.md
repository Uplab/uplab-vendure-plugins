<p align="center">
  <img src="https://raw.githubusercontent.com/Uplab/uplab-vendure-plugins/main/packages/vendure-plugin-change-history/assets/icon.svg" alt="" width="96" height="96">
</p>

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
> window, a history block on seven detail pages, an Insights widget and the registration entry for your labels
> and renderers.

## Contents

[Install](#install) · [Options](#options) · [What is recorded](#what-is-recorded) ·
[Recording from your own code](#recording-from-your-own-code) ·
[Retention](#retention) · [Dashboard](#dashboard) · [GraphQL API](#graphql-api) ·
[Permissions and channels](#permissions-and-channels) · [Database](#database) ·
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
**ReadChangeHistory** permission to the roles that may read the history. It is per channel, like Vendure's own
permissions, and it adds to them rather than replacing them: a role sees the entries written in the channels it
holds the permission in, and there only those of the entity types it may read anyway — products with
`ReadCatalog` or `ReadProduct`, promotions with `ReadPromotion`, and so on (see
[Permissions and channels](#permissions-and-channels)).

## Options

Everything is configured through `ChangeHistoryPlugin.init(options)`; the plugin never reads environment
variables. Invalid options throw at startup with a message naming the option.

| Option                        | Default                                          | Description                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                     | `true`                                           | Kill switch. With `false` nothing is recorded; `runBatch` still runs its callback. See [Switching capture off](#switching-capture-off).                                                   |
| `entities`                    | `{}`                                             | Per core entity: `ignoreFields`, `includeReadonlyCustomFields`, `fieldKinds`, `label`.                                                                                                    |
| `fieldExtractors`             | `[]`                                             | Extra fields of an entity's history view, e.g. a value your plugin keeps in its own table.                                                                                                |
| `actorResolvers`              | `[]`                                             | Your resolvers for who made a change (service accounts, SSO), tried before the built-in session resolver.                                                                                 |
| `handlerOrder`                | `{}`                                             | `{ Product: { before: 'other-handler-id' } }` — ordering of the history's event handlers relative to another plugin's, keyed as `CHANGE_HISTORY_HANDLER_IDS`.                             |
| `readPermissions`             | `CHANGE_HISTORY_READ_PERMISSIONS`                | What a reader needs besides `ReadChangeHistory` per entity type, e.g. `{ ProductOrder: ['ReadCatalog'] }` for a type of yours. See [Permissions and channels](#permissions-and-channels). |
| `beforeState`                 | `'auto'`                                         | How the "was" value is read. `auto`: a committed read on a second connection on Postgres / MySQL / MariaDB, none on SQLite. Or a strategy instance.                                       |
| `maxValueBytes`               | `16384`                                          | Cap per side of a stored value.                                                                                                                                                           |
| `retention.archive`           | **required**                                     | Where compaction puts the full record first: an archive storage, or `'none'` to opt out explicitly.                                                                                       |
| `retention.archiveKeyPrefix`  | `'change-history-archive'`                       | Key prefix of archive objects.                                                                                                                                                            |
| `retention.detailDays`        | `90`                                             | Days full detail is kept.                                                                                                                                                                 |
| `retention.summaryDays`       | `365`                                            | Days compacted entries are kept. Must be at least `detailDays` and `runLineDays`.                                                                                                         |
| `retention.runLineDays`       | `detailDays`                                     | Days external-run entries are kept (deleted at compaction once older; purge removes compacted ones).                                                                                      |
| `retention.compactValueBytes` | `1024`                                           | Text values longer than this are reduced to their length at compaction.                                                                                                                   |
| `retention.schedule`          | `{ compact: '45 4 * * *', purge: '15 5 * * *' }` | Cron expressions of the built-in retention tasks, or `false` to run `ChangeHistoryRetentionService` from your own scheduler.                                                              |
| `retention.batchSize`         | `2000` / `5000`                                  | Rows per compaction / purge batch.                                                                                                                                                        |
| `retention.maxBatches`        | `20`                                             | Batches per run.                                                                                                                                                                          |

## What is recorded

Every change is recorded **inside the transaction that makes it** (a blocking event handler, in a savepoint):
an entry commits or rolls back with its change, and a failing history write never fails your mutation — it is
logged under the `ChangeHistory` logger context (`[ChangeHistory]` in Vendure's default logger).

The plugin's work on one transaction runs one piece at a time, even when core runs several blocking handlers
of one transaction concurrently (it publishes some events inside `Promise.all`: deleting several assets,
assigning assets to a channel, removing collections from a channel) — two savepoints opened at once on one
connection would abort your transaction. What the plugin remembers about a transaction (the last state of each
saved entity, the entries that later ones derive from, a batch's head) follows its savepoints: a savepoint you
roll back takes it along, so a later save never diffs against a state that was rolled back. A transaction
remembers the last state of up to 500 entities; an entity saved again after its state was dropped is recorded
without values (`meta.noBefore = "evicted"`) rather than with a diff that would repeat the earlier change.

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
  `meta.lastState`, and in `meta.lastStateFields` the kind of each non-text value with the labels of the ids
  in it (`{ facetValues: { kind: 'refs', labels: { '3': 'Color: Red' } } }`), so the dashboard renders it like a
  change. Deleting a product records its variants' deletions too.
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
  row for, so the first change after you install it is recorded too. After a period with capture switched off
  the plugin brings these rows up to date by itself (see [Switching capture off](#switching-capture-off)).
- **`moved`**: a collection moved under another parent or to another position, with `parent` and `position`
  before → after. The siblings Vendure renumbers are not recorded.
- **Cascades.** Deleting a collection records its descendants' deletions too, derived from it, each with its
  last state and `meta.memberCount`. Deleting a facet records its values' deletions, derived from it. A deleted
  facet value keeps how many products and variants used it (`meta.usedByProducts` / `meta.usedByVariants`).
- **`channel_assigned` / `channel_removed`**: a product, variant or asset assigned to or removed from a
  channel, with the channel in `meta` (`channelId`, `channelCode`). One operation is one row: core announces a
  product's variants and images before the product, so inside a transaction these entries wait for its commit
  and are then written together — the product, with its variants and images derived from it (an image of a
  variant whose product is not in the operation, from that variant). When more than one entry is left at the
  top (several products in one call, as the dashboard's bulk action sends them, or several variants assigned on
  their own), they form one batch of kind `channel_assigned` / `channel_removed`, its head carrying the channel
  in `meta` too — unless your own `runBatch` around the operation batches them already. Removing an asset from
  its last channel is part of deleting it and is left to its `deleted` entry.
- **Custom fields** are recorded by key (`customFields.<name>`, `customFields.<name>.<language>` for
  translatable ones). Fields declared `readonly` or `internal` are written by code and left out, unless you list
  them in `entities.<Type>.includeReadonlyCustomFields`. Relation fields are stored as ids with the target's
  name as a label. `entities.<Type>.ignoreFields` drops noisy keys, `entities.<Type>.fieldKinds` tells the
  dashboard how to show a value (`{ 'customFields.price': 'money' }`, `{ 'customFields.erpId': 'id' }` for an
  identifier shown as stored, `5950013` rather than `5 950 013`; a key named `id` or ending in `Id` reads so
  without it).
- References (facet values, assets, options, tax category, relation custom fields) are compared **by id**; the
  names are stored as labels for display. Renaming a facet value is therefore not a change of every product
  that uses it.
- A value longer than `maxValueBytes` is stored shortened, its head and tail kept (`truncated: true`).

**Who.** The actor is resolved once per request: a `runBatch` actor first, then your `actorResolvers`, then the
session's administrator (`admin`) or the owner of the API key the request authenticated with (`api_key`, recorded
under the owner's name: `actorType` says it was a key, and the dashboard marks it), and otherwise `system`: with source `collection_rules` for a change of a collection's contents made by Vendure's
filters job, else `unknown_system` (its `meta` says which API and process). An entry's `source` is the actor's.

**Derived changes.** An entry gets `derivedFromId` when, in the same transaction, its parent already has an
entry (a variant after its product) or the entity itself was created earlier in it. A plugin that rewrites the
variants from a product handler (a price fan-out) therefore shows as one product change with derived variant
changes. That needs the history handler to run first: declare `after: CHANGE_HISTORY_HANDLER_IDS.Product` on
your own handler, or use the `handlerOrder` option for a handler you cannot edit. `handlerOrder` takes every
handler of `CHANGE_HISTORY_HANDLER_IDS`, the collection contents, option groups, stock adjustments and channel
assignments included.

### Switching capture off

`enabled: false` is read once per process: nothing is recorded, and the read side keeps working. The contents
of the collections are the one thing the plugin keeps track of between changes, so a boot with capture off
leaves a marker row in `change_history_collection_members`. The next boot with capture on finds it, records the
current contents of every collection again (without entries) and removes it. Changes of contents made while
capture was off are therefore not recorded, and they do not turn up later inside the first change of each
collection. Several instances may boot at once in either mode: the marker is inserted and removed by key, and
the contents re-recorded by two of them are the same. During a rolling deploy an instance that still boots with
capture off sets the marker again; the next boot with capture on re-records the contents once more.

## Recording from your own code

Inject `ChangeHistoryService` (add `ChangeHistoryPlugin` to your plugin's `imports`). Its write methods never
reject because of a history failure — the failure is logged under the `ChangeHistory` context — and write in
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
  // Optional: what the run was about, shown as its object in the dashboard and found by the feed's search.
  subject: { type: 'Order', id: order.id, label: order.code },
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
transaction, the run commits or rolls back with it. A run's `subject` is kept in `meta.subject`
(`{ label, type?, id? }`, the id as a string) and its label in the entry's `subjectLabel`, which the feed's
search matches next to `entityLabel` (search `SO-1042`, find the run); the dashboard shows it as the run's
object, linked when its type has a page (`Order`, `Customer`, a core catalogue type, or a type you registered with a `route`).

`runBatch` groups what is written inside its callback, following the callback's async context rather than the
`RequestContext`: two batches started at once on one context (`Promise.all`) stay two batches, and work on the same
context outside the callback is not batched. Give a batch a `label` (in your shop's language) or register a label
for its `kind` in the dashboard: the head of a batch without a label stores its kind, and the Admin API returns its
`entityLabel` as `null` so that clients name it by `meta.kind`.

`entityType`, `action`, `source` and batch `kind` are free strings; give yours labels in the dashboard. They
must fit their columns: `entityType`, `parentType`, `action`, `source` and a detail row's `kind` at most 32
characters, `entityId` and `parentId` 36 (a run's `entityId` defaults to its `source`), and a detail row's
`scope` 64. A longer value is clipped to its column with a `… clipped …` warning, so the entry or run is still
recorded.

## Retention

The history is kept in tiers (all windows are options, in days):

| Tier      | What                                                                                                                                                                                 | Kept                             | Then                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ---------------------------------------- |
| Detail    | long values (rich text, other values longer than `compactValueBytes`), derived rows (a variant changed by its product's save), collection-rules member rows, the detail rows of runs | `detailDays` (90)                | archived, then compacted                 |
| Summary   | every entry: who, what, when, which fields, short values, JSON diffs (filters, conditions), references, stock, batch heads, cascaded deletions with their last state                 | `summaryDays` (365)              | deleted                                  |
| Run lines | the `Run` entries of external syncs: counts and duration                                                                                                                             | `runLineDays` (= `detailDays`)   | deleted at compaction, after the archive |
| Archive   | the full record of every entry and its detail rows, as it was before compaction                                                                                                      | as long as your storage keeps it | —                                        |

**Compaction** (`compact`, nightly) takes the oldest entries older than the detail window that are not
compacted yet, in batches (`batchSize` entries, and no more than 50,000 detail rows of runs together — a run
over that on its own is a batch by itself; `maxDetailRows` per call), and for each batch:

1. writes every entry and its detail rows as gzipped JSON Lines to the archive storage
   (`<archiveKeyPrefix>/<yyyy>/<mm>/change-history_<stamp>_<maxId>_<uuid>.jsonl.gz`, one object per batch), then
   requires `exists(key)` to confirm it — **nothing is stripped or deleted before that**;
2. in one transaction: snapshots the counts that are about to disappear (`meta.derivedCount` on the cause: the
   derived rows it deletes, added to what an earlier batch kept when a batch ends between a cause and its derived
   rows; `meta.batchCounts` on a batch head), deletes detail rows, derived rows (except
   cascaded deletions), collection-rules member rows and run lines older than `runLineDays`, replaces long values by
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
they are older than the summary window. A derived row inserted again is counted live again, so its cause's
`meta.derivedCount` gives it back. Restoring the same object twice changes nothing more. For a one-off
look without touching the live tables, read the lines with `decodeChangeHistoryArchive` (or `gunzip` the
object) instead.

## Dashboard

Everything needs the **ReadChangeHistory** permission, and each page shows only the entries the user may read
(see [Permissions and channels](#permissions-and-channels)). The dashboard is in English and Ukrainian.

- **Feed** — **System → Change history** (`/change-history`). One row per change: time, who, type, object
  (a link to it, «deleted» when it is gone; for a run, its subject or label), action and what changed. Search by
  name, SKU or a run's subject (an order code), filter by type,
  action, source and who, pick a period, and two switches: **Collapse bulk operations** (on: a batch is one
  row) and **Hide system changes** (off: collection rules and external runs are listed too). Filters, switches,
  period and the open entry are in the URL, so a view is a link you can send. Clicking a row opens the entry.
- **Entry window** — who, when, from where, a link to the entity, and for a derived entry its cause («Caused
  by: Product «Tee» · assigned to channel», opening the cause's entry); the changed fields as _field · was · became_;
  the derived entries (variant prices a product save rewrote), a batch's members and a run's rows, each paged;
  for a deleted entity its last state, rendered like a change (rich text as text, money formatted, references
  by name), and **Full history**, the entity's timeline in the same window.
- **History block** — at the bottom of the product, variant, collection, facet, facet value, asset and
  promotion pages: the entity's history newest first, each item reading what happened, then who and when
  («Updated · Jane Doe · 4 hours ago»), 20 at a time with **Show more**, the changes of its children (variants, facet
  values, child collections) marked with their name, derived entries folded under their cause (and on the page
  of a derived entry's own entity, a line naming the cause that opens its entry), collection
  rules batches with their counts and members (the first 50 inline, **show all** for the rest), and each external run as one collapsed item with its count
  line («Variants: 3 · Rows: 4») that unfolds into this entity's rows — the first 50, with **show all (240)**
  opening the whole run in the entry window. On a page whose entity a run touched alone (a variant), the rows
  show directly.
- **Insights widget «Recent changes»** — the last 10 rows of the feed's default view in the Insights date
  range (who, the object's type and name, what changed); a click on a line, or Enter on its time, opens the
  entry, and **All changes →** opens the feed for the same period.

A request that fails shows a translated message with **Retry** in the feed, the entry window, the history
block and the widget — never the «no changes» text; when the feed's filter options fail to load, the feed says
so above the table and the filters offer the types your extension registered. A link to a page past the end
opens the last page. Changes made with an API key show the owner's name with
an «API key» marker in the dashboard's language. A batch without a label of its own is titled by its kind's
registered label (`registerChangeHistoryBatchKind`), else «Bulk operation» — never by the raw kind. In the
feed such a batch's action is what its members had done to them when they share one («updated») and its
object their type («Products»); a channel operation's object is its channel.

Values are drawn by their `kind`: `text`, `enum` (core enums and custom field options by their labels),
`bool`, `date`, `money` (the channel's currency), `prices`, `ref` / `refs` (labels; a set change lists what
was removed «−» and added «+»), `assets` (thumbnails, added and removed outlined, «order changed» when it
did), `richtext` (plain text, the words around each change marked, «show in full»), `json` (side by side,
changed lines highlighted, facet value ids shown by name; collection filters and promotion conditions and
actions read as their descriptions with `argument: value` lines, money formatted), `stock` (with the delta),
and a compacted value as «changed (3,412 → 3,587 characters)». An object of plain values (stock thresholds
per location, a focal point; each side such an object, empty or no value) is drawn key by key across both value
columns, in the entry window and the timeline alike: every key of either side on its own row, so a key that only one
side holds (a sparse map) reads «Kyiv: — | Kyiv: 13», «—» where a side has no value (no key, `null` or `''`). The
keys are sorted by name in the dashboard's language, numbers in names by value («Store 2» before «Store 10»), not
in stored order, which differs between the two sides. The rows that changed carry the red / green marks of any
changed value, the unchanged ones are dimmed; of more than eight keys only the changed show, the rest behind
«+N unchanged». Values are formatted by the field's kind like any value: digits grouped, `money` in its currency,
yes / no, a number under a key named `id` or ending in `Id` as stored. When both sides of such a change (not of kind
`json`) hold a single key between them, the row names the key with the field and shows plain values instead:
«Min. stock · Kyiv | — | 13». A deleted entity's last state lists the keys the same way, sorted and formatted.
In a one-line summary (the feed, the widget, a batch's member rows) a change of one names only the keys that changed:
«Min. stock: Kyiv: 0 → 13».

This applies to every kind but `bool`, `assets`, `richtext` and `refs` — your own kind (a field extractor's
`stock_threshold`) and a change recorded without a kind included — as long as you register **neither** a value
renderer **nor** a value text for the kind: an object of plain values of an unregistered kind is never shown as raw
JSON. To rely on it instead of a renderer of your own, record the value (in your field extractor, or through
`fieldKinds`) as a flat object, `{ "<key>": <string | number | boolean | null>, … }`, keyed by what the reader
should see (a location's name, not its id), and register nothing for its kind; at most a field label
(`registerChangeHistoryFieldLabels`) is all it needs. A value text of your own for the kind replaces all of it,
the one-key form and the summary's changed keys included; a value renderer replaces the entry window's and the
timeline's cells, one side at a time. A number
of kind `id`, or under a key named `id` or ending in `Id`, is shown as stored, without digit grouping. A host action with `meta.counts` shows them with
the count labels, the `total` last: «moved: 3 (total: 48)». Action, batch kind and count labels read best in
lowercase, like the built-in ones: the dashboard capitalizes them where they start a title or a badge. The feed's navigation `order` is `CHANGE_HISTORY_NAV_ORDER`; give an
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
  registerChangeHistoryValueText,
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

// The one-line text of a value of your kind: the feed's «What changed», the widget, batch member rows and a
// created entity's values. `change` holds both sides, so it can say only what differs; `undefined` falls back.
registerChangeHistoryValueText('color', (value) => (typeof value === 'string' ? value.toUpperCase() : undefined));

// Rows of an external run of your kind: `dialog` (a page of the whole run), `timeline` (this entity's rows),
// `summary` (the inline count line of the collapsed item — your own plural forms go here).
// In a timeline `rows` are the first 50: count from `entry.detailsTotal`.
function StockRows({ rows, entry, mode }: ChangeHistoryDetailRendererProps) {
  if (mode === 'summary') return <span>{entry.detailsTotal ?? rows.length} rows</span>;
  return <table>{/* … */}</table>;
}
registerChangeHistoryDetailRenderer('stock', StockRows);

defineDashboardExtension({});
```

Without a renderer of its own, a run's rows use the package's table: _SKU / ID · name · location · was · became
(±delta)_ (the location is the row's `scopeLabel`, else its `scope`), sorted by SKU, with the count line «Variants: 3 · Rows: 4». A field nobody labelled shows its key in
words (`customFields.fullPrice` → «Full price»), a source nobody registered its value in words. A registration
the dashboard cannot use (an empty key, a missing label, an unknown tone) is reported with `console.error` and
skipped — it never throws, so a mistake in your extension cannot leave the dashboard blank.

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
  entityLabel: String # null for a batch without a label: name it by meta.kind
  subjectLabel: String # a run's subject (meta.subject.label), searchable; null otherwise
  parentType: String
  parentId: String
  action: String!
  source: String!
  actorType: String!
  actorId: ID
  actorLabel: String # the administrator's name, also for api_key
  batchId: String
  channelId: ID
  derivedFromId: ID
  derivedFrom: ChangeHistoryEntry # the cause; null when gone or not readable
  changes: JSON
  meta: JSON!
  summary: String! # an English machine summary, not display text
  compactedAt: DateTime
  isCompacted: Boolean!
  derivedCount: Int!
  batchCounts: [ChangeHistoryBatchCount!] # batch heads only: the members batchMembers lists
  entityDeleted: Boolean!
  parentDeleted: Boolean! # the parent (a rules batch's or membership row's collection) is gone
  details: [ChangeHistoryDetail!] # run items of a timeline only: the first 50 rows
  detailsTotal: Int # run items of a timeline only: all rows of the entity
  detailsEntityCount: Int # run items of a timeline only: entities those rows touch
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
  | search               | `_or: [{ entityLabel: { contains } }, { subjectLabel: { contains } }]`  |
  | one batch            | `batchId: { eq }`                                                       |
  | collapse batches     | `_or: [{ batchId: { isNull: true } }, { entityType: { eq: "Batch" } }]` |

  `derivedCount`, `batchCounts`, `entityDeleted`, `parentDeleted` and `isCompacted` are computed, so they
  cannot be filtered or sorted on. Whatever the sort, `id` breaks its ties (in the direction of the last key):
  the entries of one transaction share `createdAt`, and offset pages over them neither skip nor repeat one.

- **`changeHistoryEntry`** is one entry. `derivedEntries` and `batchMembers` page with the same list options
  (`skip`, `take`, `sort`, `filter`) and say how many there are in `totalItems`, so a client reaches every member
  of a large batch. The feed reaches them too: `filter: { batchId: { eq }, entityType: { notEq: "Batch" } }`.
- **`changeHistoryEntityTimeline`** is one entity's history, newest first, paged with `first` (1–100) and
  `after` (the previous page's `endCursor`). `entityId` is the database id, as stored in
  `ChangeHistoryEntry.entityId`. It includes the entity's own entries, and with `includeChildren` (the default)
  its children's non-derived entries: a product's variants, a facet's values, a collection's child
  collections and its rules batches (the products that entered or left are collapsed into the batch). Each
  external run that changed the entity, or one of its children, is a single item whose `details` hold only
  those rows — the first 50, with `detailsTotal` and `detailsEntityCount` counting them all (page the rest with
  `changeHistoryRunDetails`). The timeline is read from the primary database, so a change shows right after its save, even
  with read replicas.
- **`changeHistoryRunDetails`** returns a run's rows with the current name (and a variant's SKU), sorted by
  SKU or name, then name, then scope. `take` is at most 500. The order needs every row's current name, so it is
  worked out once per run and language and kept for a minute; each further page loads and names its own rows
  only.
- **`changeHistoryFilterOptions`** lists the actors (an API key under its owner's id with `type: "api_key"`),
  sources, actions and entity types of the last `summaryDays` that the user may read, for filter dropdowns. It is
  cached for 60 seconds per process and read scope; values the process writes in the meantime are added to the
  cached lists at once.
- **`summary`** is a short English description for logs and exports («3 fields: name, slug, enabled»), not
  display text: a client renders an entry from `changes` and `meta`.
- `derivedCount` counts every derived entry, the ones compaction deleted included (their count is kept on the
  cause); `derivedEntries` lists those still stored, such as cascaded deletions. `batchCounts` counts the members
  `batchMembers` lists — an entry derived from a member counts on that member's `derivedCount`, not as a member
  of its own (an archived product's variant). After compaction `batchCounts` come from the counts the compaction
  kept. `derivedFrom` is a derived entry's cause, loaded in one query per page; it is `null` when the cause is no
  longer stored or the user may not read it (its channel or type), even though `derivedFromId` names it.

### Permissions and channels

`ReadChangeHistory` opens the history, it does not widen what a role may see. Every entry stores the channel of
the request that wrote it (`channelId`), and a user reads an entry when, in that channel, they hold
`ReadChangeHistory` **and** the read permission of the entry's type:

| Entity type                    | Needs (any one of)                          |
| ------------------------------ | ------------------------------------------- |
| `Product`, `ProductVariant`    | `ReadCatalog`, `ReadProduct`                |
| `Collection`                   | `ReadCatalog`, `ReadCollection`             |
| `Facet`, `FacetValue`          | `ReadCatalog`, `ReadProduct`, `ReadFacet`   |
| `Asset`                        | `ReadCatalog`, `ReadAsset`                  |
| `Promotion`                    | `ReadPromotion`                             |
| `Batch`, `Run`, your own types | nothing more, unless `readPermissions` says |

These are the permissions of Vendure's own queries of each type (`CHANGE_HISTORY_READ_PERMISSIONS`). Give your
own entity types theirs, or change a core type's, with the `readPermissions` option:

```ts
ChangeHistoryPlugin.init({
  retention: { archive },
  readPermissions: { ProductOrder: ['ReadCatalog'], StockThreshold: 'ReadProduct', Run: ['ReadCatalog'] },
});
```

The rule holds in every query: the feed, one entry (`null` when unreadable), its derived entries and batch
members, `derivedCount` and `batchCounts` (the members of other types are not counted), timelines, the rows of a
run (each row is checked by its own entity type, in the run's channel) and the filter options. A SuperAdmin
reads everything, and so do calls from your own code with a context that has no user (a job, a scheduled task).
The `ChangeHistoryService` read helpers follow the same rule for the context they are given.

## Database

Postgres first. Before → after values need a second database connection that still sees the last committed
row while a save is in progress: that works on Postgres and, in principle, on MySQL / MariaDB (untested).
On SQLite every change is still recorded, without the "was" values (`meta.noBefore = "unsupported"`), and the
plugin logs a warning at startup. On Postgres an entry is recorded without values only when the before-state
could not be read: the save ran outside a transaction (`no_transaction`, logged once per entity type), the pool
had no free connection within 500 ms (`pool`; the save does not wait for one), the read failed (`error`), or
the entity was saved earlier in the same transaction and its state has since been dropped (`evicted`, see
[What is recorded](#what-is-recorded)). The tables use `simple-json`, plain indexes and no foreign keys to core
tables, so the generated migration is portable.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
