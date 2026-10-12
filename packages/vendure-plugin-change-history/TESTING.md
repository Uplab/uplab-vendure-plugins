# Testing the change history

Two e2e suites, both in `e2e/`:

| Suite                                 | Database | Runs                                                                   |
| ------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `change-history.e2e-spec.ts`          | sql.js   | always, with `pnpm test` at the repo root (port 3057)                  |
| `change-history-postgres.e2e-spec.ts` | Postgres | only when `CHANGE_HISTORY_E2E_PG_URL` is set; skipped otherwise (3058) |

The sql.js suite pins the behaviour without a before-state: every update is recorded with
`meta.noBefore = "unsupported"`, created and deleted entities with their values, stock adjustments, cascades and
the diff against an earlier save in the same transaction. It also covers everything that needs no before-state:
collection contents through the filters job (one `collection_rules` batch per collection and run, nothing for a
run that changed nothing), the snapshot recorded at startup and the first change after it, re-recording on
request, a collection deleted with its descendants (derived, with their member counts), a facet value rename
recorded on the value only, a force-deleted facet with its values, an asset's upload / edit / deletion, a
promotion, channel assignments and `capture()` of a collection.

The Postgres suite covers what needs a real second connection: exact before → after values of products and
variants (translations, custom fields, facet values, prices), no entry for a save that changes nothing, the
savepoint that keeps a failed history write from aborting the mutation (the failure is injected by a trigger
of the suite that rejects an entry labelled `[fail]`), a host rollback that takes the entry with it, a rolled-back
inner savepoint that leaves no phantom before-state and no derived link to its entries, a batch whose first
transaction rolled back getting its head again, over-long host values clipped to their columns, handler order
against a fan-out plugin (`e2e/fixtures/fan-out-plugin.ts`) with derived entries, the API-key actor and
batches. For the other catalogue entities: a collection's changed fields with its filters labelled, a move
(parent and position only), contents changed through a facet-value filter including the first change after the
startup snapshot, a deleted collection and its descendant from their committed rows, a facet update and a value
rename recorded once on the value, a force-deleted facet with its values' usage, an asset's name / tags / focal
point, a promotion's conditions as JSON before → after without `priorityScore`, and `capture()` after a raw
write. Core's concurrent handlers on one transaction: three assets deleted in one call, several assets assigned
to a channel in one call and two collections removed from a channel in one call all succeed and record their
entries (before the per-transaction lock they aborted the transaction). CI runs it in the `e2e-postgres` job
against a `postgres:15` service.

Both suites run the same retention scenarios (`e2e/retention-scenarios.ts`) on their database, with
`FileSystemArchiveStorage` in a temporary directory. The rows are written directly or through `recordRun` and
backdated (`createdAt` set 100 / 400 days back), so nothing else in the suite is old enough to be touched:
preview and dry run change nothing; a failing `put` and an `exists` that answers `false` leave every row as it was;
compaction archives first (the objects are read back and decoded), then strips long values, deletes derived,
member and run rows with their detail rows and keeps the counts (`batchCounts`, and `derivedCount` of the
deleted derived rows only — the kept cascaded deletion is still counted live); a second run
compacts nothing; `restore` brings the deleted rows back without the next compaction touching them (R3-9); purge
deletes only compacted rows; `archive: 'none'` compacts with a warning; a run of 5,001 rows stores 5,000 (detail
`createdAt` equal to the entry's in the database), pages them, groups them per product / variant and compacts
them; a run recorded in a host transaction that rolls back leaves no row; runs of 4, 4, 1, 9 and 2 rows under a
cap of 6 detail rows compact in four batches (the 9-row run alone); a cause, three derived rows and a kept
deletion that share one timestamp, compacted in batches of two that end between them (and a run stopped by
`maxBatches`), keep `derivedCount` at 4 throughout — and after the later batches are restored. Unit specs cover the retention rules, the
pure compaction, the archive lines (streamed through gzip) and keys, and the scheduled tasks.

Both suites also run the Admin API scenarios (`e2e/api-scenarios.ts`), after the retention ones. The feed:
newest first, derived entries left out unless the filter names `derivedFromId`, and every filter the dashboard
uses (actor, actor type, period, entity type, action, source, label incl. a SKU in any case, batch, collapsed
batches); `derivedCount` / `batchCounts` live and from a compaction snapshot; one entry with its derived
entries and paged batch members. Timelines through real mutations: a product shows its own entries, its
variants', its collection contents and one item per run with only its variants' rows (sorted by SKU, then
location); a variant shows its own entries and its rows of each run; a just-saved change is the first item at
once; a collection shows its rules batch (members collapsed) and its child collection; a facet shows its values'
changes. A run of 60 rows gives a timeline item its first 50 with `detailsTotal` and `detailsEntityCount`.
Run details are labelled, sorted and paged; `entityDeleted` marks a deleted product's entries, whose
`meta.lastStateFields` carry the kinds and facet value labels; `parentDeleted` is true for a batch head whose
collection is gone and false for a host parent type; filter options include new values at once. Five entries written in one transaction are paged two at a time without a
gap — on Postgres they share one timestamp to the microsecond, the R5-2 regression. Every query is refused
without `ReadChangeHistory` and allowed with it alone; an administrator holding it in one channel only sees
that channel's entries in the feed, one entry, a timeline, run details and filter options, while a SuperAdmin
sees all. Unit specs cover the cursor, the batch loader, the primary-database read and the channel scope.

Unit specs of the capture side cover the per-transaction lock (one piece of work after another on one
transaction, nested work at once, nothing held back outside a transaction), the savepoint journal of the
transaction state (a rollback undoes, a release hands over to the parent), the eviction mark and the column
clipping.

The collection filters run in Vendure's job queue: the specs wait for it (`settleJobs`) and then poll for the
entries the history writes after the job (`waitFor`).

## Running the Postgres suite locally

The suite **resets the schema of the database in the URL** — point it at a database of its own:

```bash
docker run -d --name change-history-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=change_history_e2e \
  -p 5433:5432 postgres:15

CHANGE_HISTORY_E2E_PG_URL=postgres://postgres:postgres@localhost:5433/change_history_e2e \
  pnpm --filter @uplab/vendure-plugin-change-history test:e2e:pg
```

`test:e2e:pg` fails when the variable is missing, so the CI job cannot pass by skipping.

## Dev server on Postgres

The dev server uses SQLite, where the change history has no before → after values. To look at real diffs,
start it with `DEV_DB=postgres` and `DEV_DB_URL` (see `packages/dev-server/.env.example`).
