import { Logger, TransactionalConnection, mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, testConfig } from '@vendure/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ChangeHistoryDetail,
  ChangeHistoryEntry,
  ChangeHistoryPlugin,
  ChangeHistoryService,
  CommittedRowBeforeStateStrategy,
} from '../src';
import { ChangeHistoryStrategies } from '../src/services/change-history-strategies.service';
import { DedicatedPostgresInitializer } from './dedicated-postgres-initializer';
import { initialData } from './fixtures/initial-data';
import { CHANGE_HISTORY_ENTRIES } from './graphql';
import { entriesWhere, superadminCtx, systemCtx } from './helpers';

/**
 * The Postgres suite: what needs a real second connection. Skipped unless CHANGE_HISTORY_E2E_PG_URL
 * points at a database it may reset, e.g. postgres://postgres:postgres@localhost:5432/change_history_e2e
 * (see TESTING.md).
 */
const url = process.env.CHANGE_HISTORY_E2E_PG_URL;

registerInitializer('postgres', new DedicatedPostgresInitializer());

describe.skipIf(!url)('ChangeHistoryPlugin on Postgres', () => {
  const warn = vi.spyOn(Logger, 'warn');
  const config = mergeConfig(testConfig, {
    // Its own port: vitest runs every e2e file of the repo in parallel.
    apiOptions: { port: 3058 },
    plugins: [ChangeHistoryPlugin.init({ retention: { archive: 'none' } })],
  });
  if (url) {
    const db = new URL(url);
    // Replaced, not merged: the sql.js options of `testConfig` must not leak into the Postgres ones.
    config.dbConnectionOptions = {
      type: 'postgres',
      host: db.hostname,
      port: Number(db.port || 5432),
      username: decodeURIComponent(db.username),
      password: decodeURIComponent(db.password),
      database: db.pathname.slice(1),
      logging: false,
    };
  }
  const { server, adminClient } = createTestEnvironment(config);
  const history = () => server.app.get(ChangeHistoryService);
  const connection = () => server.app.get(TransactionalConnection);

  beforeAll(async () => {
    await server.init({ initialData, customerCount: 0 });
    await adminClient.asSuperAdmin();
  }, 120_000);

  afterAll(async () => {
    await server.destroy();
  });

  it('selects the committed-row before-state on Postgres', () => {
    expect(server.app.get(ChangeHistoryStrategies).beforeState).toBeInstanceOf(CommittedRowBeforeStateStrategy);
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/Before-state unavailable/), expect.anything());
  });

  it("reads only committed rows while the caller's transaction is open", async () => {
    const ctx = await systemCtx(server.app);
    const strategy = server.app.get(ChangeHistoryStrategies).beforeState;
    const where = { where: { entityLabel: 'Uncommitted' } };

    const inside = await connection().withTransaction(ctx, async (tctx) => {
      await history().recordAction(tctx, { entityType: 'Facet', entityId: 1, entityLabel: 'Uncommitted', action: 'x' });
      return {
        own: await connection().getRepository(tctx, ChangeHistoryEntry).count(where),
        committed: await strategy.withCommittedReader(tctx, (manager) => manager.count(ChangeHistoryEntry, where)),
      };
    });
    const after = await strategy.withCommittedReader(ctx, (manager) => manager.count(ChangeHistoryEntry, where));

    expect(inside).toEqual({ own: 1, committed: 0 });
    expect(after).toBe(1);
  });

  it("isolates a failed history write in a savepoint: the caller's transaction still commits", async () => {
    const error = vi.spyOn(Logger, 'error');
    const ctx = await systemCtx(server.app);

    await connection().withTransaction(ctx, async (tctx) => {
      // varchar(32): Postgres rejects the statement, which would abort the whole transaction without a savepoint.
      await history().recordAction(tctx, { entityType: 'X'.repeat(40), entityId: 1, entityLabel: 'Bad', action: 'x' });
      await history().recordAction(tctx, { entityType: 'Facet', entityId: 1, entityLabel: 'Good', action: 'x' });
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('value too long'), 'ChangeHistory', expect.any(String));
    expect((await entriesWhere(server.app, { entityLabel: 'Good' })).length).toBe(1);
    expect(await entriesWhere(server.app, { entityLabel: 'Bad' })).toEqual([]);
    error.mockRestore();
  });

  it('records a run with detail rows and serves entries through the Admin API', async () => {
    const ctx = await superadminCtx(server.app);
    await history().recordRun(ctx, {
      source: 'erp_stock_sync',
      label: 'ERP stock sync',
      counts: { updated: 1 },
      details: [{ entityType: 'Warehouse', entityId: 'w1', kind: 'stock', from: { qty: 1 }, to: { qty: 2 } }],
    });

    const { changeHistoryEntries } = await adminClient.query(CHANGE_HISTORY_ENTRIES, {
      options: { filter: { entityType: { eq: 'Run' } } },
    });
    expect(changeHistoryEntries.items).toEqual([
      expect.objectContaining({
        source: 'erp_stock_sync',
        actorType: 'admin',
        actorLabel: 'Super Admin',
        summary: 'updated 1',
        meta: expect.objectContaining({ counts: { updated: 1 }, detailCount: 1 }),
      }),
    ]);
    const [run] = await entriesWhere(server.app, { entityType: 'Run' });
    const details = await connection()
      .rawConnection.getRepository(ChangeHistoryDetail)
      .find({ where: { entryId: run.id } });
    expect(details).toEqual([expect.objectContaining({ entityId: 'w1', fromValue: { qty: 1 }, toValue: { qty: 2 } })]);
  });
});
