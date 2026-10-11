# Testing the change history

Two e2e suites, both in `e2e/`:

| Suite                                 | Database | Runs                                                                   |
| ------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `change-history.e2e-spec.ts`          | sql.js   | always, with `pnpm test` at the repo root (port 3057)                  |
| `change-history-postgres.e2e-spec.ts` | Postgres | only when `CHANGE_HISTORY_E2E_PG_URL` is set; skipped otherwise (3058) |

The Postgres suite covers what needs a real second connection: the committed-row before-state and the
savepoint that keeps a failed history write from aborting the caller's transaction. CI runs it in the
`e2e-postgres` job against a `postgres:15` service.

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
