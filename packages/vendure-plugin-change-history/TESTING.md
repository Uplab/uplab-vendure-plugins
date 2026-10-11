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
savepoint that keeps a failed history write from aborting the mutation, a host rollback that takes the entry
with it, handler order against a fan-out plugin (`e2e/fixtures/fan-out-plugin.ts`) with derived entries, the
API-key actor and batches. For the other catalogue entities: a collection's changed fields with its filters
labelled, a move (parent and position only), contents changed through a facet-value filter including the first
change after the startup snapshot, a deleted collection and its descendant from their committed rows, a facet
update and a value rename recorded once on the value, a force-deleted facet with its values' usage, an asset's
name / tags / focal point, a promotion's conditions as JSON before → after without `priorityScore`, and
`capture()` after a raw write. CI runs it in the `e2e-postgres` job against a `postgres:15` service.

Both suites run the same retention scenarios (`e2e/retention-scenarios.ts`) on their database, with
`FileSystemArchiveStorage` in a temporary directory. The rows are written directly or through `recordRun` and
backdated (`createdAt` set 100 / 400 days back), so nothing else in the suite is old enough to be touched:
preview and dry run change nothing; a failing `put` and an `exists` that answers `false` leave every row as it was;
compaction archives first (the objects are read back and decoded), then strips long values, deletes derived,
member and run rows with their detail rows and keeps the counts (`derivedCount`, `batchCounts`); a second run
compacts nothing; `restore` brings the deleted rows back without the next compaction touching them (R3-9); purge
deletes only compacted rows; `archive: 'none'` compacts with a warning; a run of 5,001 rows stores 5,000 (detail
`createdAt` equal to the entry's in the database), pages them, groups them per product / variant and compacts
them; a run recorded in a host transaction that rolls back leaves no row. Unit specs cover the retention rules,
the pure compaction, the archive lines and keys, and the scheduled tasks.

Both suites also run the Admin API scenarios (`e2e/api-scenarios.ts`), after the retention ones. The feed:
newest first, derived entries left out unless the filter names `derivedFromId`, and every filter the dashboard
uses (actor, actor type, period, entity type, action, source, label incl. a SKU in any case, batch, collapsed
batches); `derivedCount` / `batchCounts` live and from a compaction snapshot; one entry with its derived
entries and paged batch members. Timelines through real mutations: a product shows its own entries, its
variants', its collection contents and one item per run with only its variants' rows (sorted by SKU, then
location); a variant shows its own entries and its rows of each run; a just-saved change is the first item at
once; a collection shows its rules batch (members collapsed) and its child collection; a facet shows its values'
changes. Run details are labelled, sorted and paged; `entityDeleted` marks a deleted product's entries; filter
options include new values at once. Five entries written in one transaction are paged two at a time without a
gap — on Postgres they share one timestamp to the microsecond, the R5-2 regression. Every query is refused
without `ReadChangeHistory` and allowed with it alone. Unit specs cover the cursor, the batch loader and the
primary-database read.

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
