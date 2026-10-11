import path from 'path';
import { tmpdir } from 'node:os';
import { LanguageCode, Logger, ProductVariantService, TransactionalConnection, mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ChangeHistoryDetail,
  ChangeHistoryPlugin,
  ChangeHistoryRetentionService,
  ChangeHistoryService,
  FileSystemArchiveStorage,
  NoBeforeStateStrategy,
} from '../src';
import { ChangeHistoryStrategies } from '../src/services/change-history-strategies.service';
import { initialData } from './fixtures/initial-data';
import {
  CHANGE_HISTORY_ENTRIES,
  CREATE_VARIANTS,
  DELETE_PRODUCT,
  DELETE_VARIANT,
  UPDATE_PRODUCT,
  UPDATE_VARIANTS,
} from './graphql';
import { createProduct, decode, entriesWhere, superadminCtx, systemCtx } from './helpers';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__sqlite-data__')));

describe('ChangeHistoryPlugin on sql.js', () => {
  const warn = vi.spyOn(Logger, 'warn');
  const { server, adminClient } = createTestEnvironment(
    mergeConfig(testConfig, {
      // Its own port: vitest runs every e2e file of the repo in parallel.
      apiOptions: { port: 3057 },
      plugins: [
        ChangeHistoryPlugin.init({
          retention: {
            archive: new FileSystemArchiveStorage({ dir: path.join(tmpdir(), 'change-history-e2e-archive') }),
          },
        }),
      ],
    }),
  );
  const history = () => server.app.get(ChangeHistoryService);
  const query = async (options: Record<string, unknown> = {}) =>
    (await adminClient.query(CHANGE_HISTORY_ENTRIES, { options })).changeHistoryEntries;

  beforeAll(async () => {
    await server.init({ initialData, customerCount: 0 });
    await adminClient.asSuperAdmin();
  }, 120_000);

  afterAll(async () => {
    await server.destroy();
  });

  it('boots without a before-state on SQLite and says so', () => {
    expect(server.app.get(ChangeHistoryStrategies).beforeState).toBeInstanceOf(NoBeforeStateStrategy);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Before-state unavailable on "sqljs"/), 'ChangeHistory');
  });

  it('records an action of the superadmin and lists it in the Admin API', async () => {
    const ctx = await superadminCtx(server.app);
    await history().recordAction(ctx, {
      entityType: 'ProductOrder',
      entityId: 'global',
      entityLabel: 'Global product order',
      action: 'products_reordered',
      meta: { counts: { moved: 2 } },
    });

    const { items, totalItems } = await query({ filter: { entityType: { eq: 'ProductOrder' } } });
    expect(totalItems).toBe(1);
    expect(items[0]).toMatchObject({
      entityType: 'ProductOrder',
      entityId: 'global',
      entityLabel: 'Global product order',
      action: 'products_reordered',
      source: 'admin',
      actorType: 'admin',
      // An ID field: encoded by the id strategy like every other id of the Admin API.
      actorId: 'T_1',
      actorLabel: 'Super Admin',
      batchId: null,
      changes: null,
      derivedFromId: null,
      summary: 'products_reordered',
      compactedAt: null,
      meta: { counts: { moved: 2 }, correlationId: expect.any(String) },
    });
    expect(items[0].channelId).toBeTruthy();
  });

  it('lists newest first and filters by plain columns', async () => {
    const ctx = await systemCtx(server.app);
    for (const id of ['a', 'b']) {
      await history().recordAction(ctx, {
        entityType: 'Collection',
        entityId: id,
        entityLabel: `Collection ${id}`,
        action: 'assets_set',
        parent: { type: 'Collection', id: 'root' },
        summary: `assets of ${id}`,
      });
    }
    const { items } = await query({ filter: { action: { eq: 'assets_set' } } });
    expect(items.map((e: { entityId: string }) => e.entityId)).toEqual(['b', 'a']);
    expect(items[0]).toMatchObject({
      actorType: 'system',
      source: 'unknown_system',
      actorLabel: null,
      parentType: 'Collection',
      parentId: 'root',
      summary: 'assets of b',
    });
    expect((await query({ filter: { entityLabel: { contains: 'Collection a' } } })).totalItems).toBe(1);
  });

  it('needs ReadChangeHistory to read the history', async () => {
    await adminClient.asAnonymousUser();
    try {
      await expect(query()).rejects.toThrow(/not currently authorized/);
    } finally {
      await adminClient.asSuperAdmin();
    }
  });

  it('groups a batch under one head written with its first member, under the batch actor', async () => {
    const ctx = await superadminCtx(server.app);
    const actor = { actorType: 'admin' as const, actorId: 42, actorLabel: 'Scheduler', source: 'scheduled_action' };

    const result = await history().runBatch(ctx, { kind: 'bulk_edit', label: 'Bulk edit', actor }, async (bctx) => {
      await history().runBatch(bctx, { kind: 'inner' }, async (ictx) => {
        await history().recordAction(ictx, {
          entityType: 'Product',
          entityId: 1,
          entityLabel: 'One',
          action: 'archived',
        });
      });
      await history().recordAction(bctx, {
        entityType: 'Product',
        entityId: 2,
        entityLabel: 'Two',
        action: 'archived',
      });
      return 'done';
    });
    await history().runBatch(ctx, { kind: 'empty' }, async () => undefined);

    expect(result).toBe('done');
    const [head, ...members] = await entriesWhere(server.app, { source: 'scheduled_action' });
    expect(head).toMatchObject({
      entityType: 'Batch',
      entityLabel: 'Bulk edit',
      action: 'batch',
      actorId: '42',
      actorLabel: 'Scheduler',
      meta: expect.objectContaining({ kind: 'bulk_edit', label: 'Bulk edit' }),
    });
    expect(head.batchId).toBe(`bulk_edit:${head.entityId}`);
    expect(members.map((e) => [e.entityId, e.batchId])).toEqual([
      ['1', head.batchId],
      ['2', head.batchId],
    ]);
    expect(await entriesWhere(server.app, { entityType: 'Batch', entityLabel: 'empty' })).toEqual([]);
  });

  it('rejects a batch kind that does not fit the batch id', async () => {
    const ctx = await systemCtx(server.app);
    const fn = vi.fn();
    await expect(history().runBatch(ctx, { kind: 'x'.repeat(28) }, fn)).rejects.toThrow(/kind/);
    await expect(history().runBatch(ctx, { kind: 'with space' }, fn)).rejects.toThrow(/kind/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("rethrows the batch callback's own error and clears the batch", async () => {
    const ctx = await systemCtx(server.app);
    await expect(
      history().runBatch(ctx, { kind: 'failing' }, () => Promise.reject(new Error('host failure'))),
    ).rejects.toThrow('host failure');
    await history().recordAction(ctx, { entityType: 'Facet', entityId: 9, entityLabel: 'After', action: 'updated' });
    expect((await entriesWhere(server.app, { entityLabel: 'After' }))[0].batchId).toBeNull();
  });

  it('records an external run with its detail rows and resolves the variants’ products', async () => {
    const one = await createProduct(adminClient, 'run-one', ['RUN-1']);
    const two = await createProduct(adminClient, 'run-two', ['RUN-2']);
    const first = { productId: decode(one.productId), variantIds: one.variantIds.map(decode) };
    const second = { productId: decode(two.productId), variantIds: two.variantIds.map(decode) };
    const ctx = await systemCtx(server.app);

    await history().recordRun(ctx, {
      source: 'erp_stock_sync',
      label: 'ERP stock sync',
      counts: { updated: 2, zeroed: 1, failed: 0 },
      durationMs: 1200,
      details: [
        {
          entityType: 'ProductVariant',
          entityId: first.variantIds[0],
          kind: 'stock',
          scope: '1',
          scopeLabel: 'Main',
          from: 5,
          to: 7,
        },
        {
          entityType: 'ProductVariant',
          entityId: first.variantIds[0],
          kind: 'stock',
          scope: '2',
          scopeLabel: 'Kyiv',
          from: 1,
          to: 0,
        },
        { entityType: 'ProductVariant', entityId: second.variantIds[0], kind: 'stock', from: 0, to: 3 },
        {
          entityType: 'Warehouse',
          entityId: 'w1',
          parent: { type: 'Site', id: 's1' },
          kind: 'stock',
          from: null,
          to: 1,
        },
      ],
    });

    const [run] = await entriesWhere(server.app, { entityType: 'Run' });
    expect(run).toMatchObject({
      entityId: 'erp_stock_sync',
      entityLabel: 'ERP stock sync',
      action: 'run',
      source: 'erp_stock_sync',
      actorType: 'system',
      summary: 'updated 2, zeroed 1',
      meta: expect.objectContaining({ counts: { updated: 2, zeroed: 1, failed: 0 }, durationMs: 1200, detailCount: 4 }),
    });
    const details = await server.app
      .get(TransactionalConnection)
      .rawConnection.getRepository(ChangeHistoryDetail)
      .find({ where: { entryId: run.id }, order: { id: 'ASC' } });
    expect(details.map((d) => [d.entityId, d.parentType, d.parentId, d.scopeLabel, d.fromValue, d.toValue])).toEqual([
      [String(first.variantIds[0]), 'Product', String(first.productId), 'Main', 5, 7],
      [String(first.variantIds[0]), 'Product', String(first.productId), 'Kyiv', 1, 0],
      [String(second.variantIds[0]), 'Product', String(second.productId), null, 0, 3],
      ['w1', 'Site', 's1', null, null, 1],
    ]);
    expect(details.every((d) => d.createdAt.getTime() === run.createdAt.getTime())).toBe(true);
  });

  it('writes no run when nothing changed', async () => {
    const ctx = await systemCtx(server.app);
    await history().recordRun(ctx, { source: 'idle_sync', label: 'Idle', counts: { updated: 0 }, details: [] });
    expect(await entriesWhere(server.app, { source: 'idle_sync' })).toEqual([]);
  });

  it('rolls an entry back with the transaction that wrote it', async () => {
    const ctx = await systemCtx(server.app);
    await expect(
      server.app.get(TransactionalConnection).withTransaction(ctx, async (tctx) => {
        await history().recordAction(tctx, {
          entityType: 'Facet',
          entityId: 1,
          entityLabel: 'Rolled back',
          action: 'x',
        });
        throw new Error('host rollback');
      }),
    ).rejects.toThrow('host rollback');
    expect(await entriesWhere(server.app, { entityLabel: 'Rolled back' })).toEqual([]);
  });

  it('never rejects because of a history failure', async () => {
    const error = vi.spyOn(Logger, 'error');
    const ctx = await systemCtx(server.app);
    await expect(
      history().recordAction(ctx, {
        // NOT NULL column: the insert fails.
        entityType: null as unknown as string,
        entityId: 1,
        entityLabel: 'Broken',
        action: 'broken',
      }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[ChangeHistory] write failed in recordAction'),
      'ChangeHistory',
      expect.any(String),
    );
    error.mockRestore();
  });

  describe('capture without a before-state', () => {
    it('records a created product with all its values', async () => {
      const { productId } = await createProduct(adminClient, 'sqlite-shirt', []);
      const [entry] = await entriesWhere(server.app, { entityType: 'Product', entityId: decode(productId) });
      expect(entry).toMatchObject({
        action: 'created',
        entityLabel: 'sqlite-shirt',
        source: 'admin',
        summary: 'created',
      });
      expect(entry.changes).toEqual({
        enabled: { kind: 'bool', from: null, to: true },
        'name.en': { kind: 'text', from: null, to: 'sqlite-shirt' },
        'slug.en': { kind: 'text', from: null, to: 'sqlite-shirt' },
        'description.en': { kind: 'richtext', from: null, to: '' },
      });
    });

    it('records every update, without values: the change cannot be diffed on SQLite', async () => {
      const { productId } = await createProduct(adminClient, 'sqlite-update', []);
      await adminClient.query(UPDATE_PRODUCT, { input: { id: productId, enabled: false } });
      await adminClient.query(UPDATE_PRODUCT, { input: { id: productId, enabled: false } });

      const updates = await entriesWhere(server.app, {
        entityType: 'Product',
        entityId: decode(productId),
        action: 'updated',
      });
      expect(updates).toHaveLength(2);
      expect(updates[0]).toMatchObject({
        changes: null,
        summary: 'updated (details unavailable)',
        meta: expect.objectContaining({ noBefore: 'unsupported' }),
      });
    });

    it('diffs against what the same transaction saved before', async () => {
      const { productId } = await createProduct(adminClient, 'sqlite-fan-out', []);
      const ctx = await superadminCtx(server.app);
      const variants = server.app.get(ProductVariantService);

      const variantId = await server.app.get(TransactionalConnection).withTransaction(ctx, async (tctx) => {
        const [variant] = await variants.create(tctx, [
          {
            productId: Number(decode(productId)),
            sku: 'FAN-1',
            price: 100,
            optionIds: [],
            translations: [{ languageCode: LanguageCode.en, name: 'Fan' }],
          },
        ]);
        await variants.update(tctx, [{ id: variant.id, price: 250 }]);
        return String(variant.id);
      });

      const [created, updated] = await entriesWhere(server.app, { entityType: 'ProductVariant', entityId: variantId });
      expect(created).toMatchObject({ action: 'created', parentType: 'Product', parentId: decode(productId) });
      expect(updated).toMatchObject({ action: 'updated', derivedFromId: created.id });
      expect(updated.changes).toEqual({
        prices: expect.objectContaining({
          kind: 'prices',
          from: [expect.objectContaining({ price: 100 })],
          to: [expect.objectContaining({ price: 250 })],
        }),
      });
    });

    it('records a manual stock adjustment, but not the initial stock of a new variant', async () => {
      const { productId } = await createProduct(adminClient, 'sqlite-stock', []);
      const { createProductVariants } = await adminClient.query(CREATE_VARIANTS, {
        input: [
          {
            productId,
            sku: 'STOCK-1',
            price: 100,
            stockOnHand: 3,
            optionIds: [],
            translations: [{ languageCode: 'en', name: 'Stock' }],
          },
        ],
      });
      const variantId = createProductVariants[0].id;
      await adminClient.query(UPDATE_VARIANTS, { input: [{ id: variantId, stockOnHand: 1 }] });

      const entries = await entriesWhere(server.app, { entityType: 'ProductVariant', entityId: decode(variantId) });
      expect(entries.map((e) => e.action)).toEqual(['created', 'stock_adjusted', 'updated']);
      expect(entries[1]).toMatchObject({
        entityLabel: 'Stock (STOCK-1)',
        summary: 'stock Default Stock Location: 3 → 1',
        changes: { stock: { kind: 'stock', from: 3, to: 1, delta: -2, location: 'Default Stock Location' } },
      });
    });

    it('records a deleted product and its variants, linked to the product entry', async () => {
      const { productId, variantIds } = await createProduct(adminClient, 'sqlite-delete', ['DEL-1']);
      await adminClient.query(DELETE_PRODUCT, { id: productId });

      const [product] = await entriesWhere(server.app, {
        entityType: 'Product',
        entityId: decode(productId),
        action: 'deleted',
      });
      expect(product).toMatchObject({
        entityLabel: 'sqlite-delete',
        changes: null,
        meta: expect.objectContaining({
          noBefore: 'unsupported',
          lastState: expect.objectContaining({ 'name.en': 'sqlite-delete' }),
        }),
      });
      const [variant] = await entriesWhere(server.app, {
        entityType: 'ProductVariant',
        entityId: decode(variantIds[0]),
        action: 'deleted',
      });
      expect(variant).toMatchObject({ derivedFromId: product.id, parentId: decode(productId) });
    });

    it('does not record the same variant as deleted twice', async () => {
      const { productId, variantIds } = await createProduct(adminClient, 'sqlite-redelete', ['REDEL-1']);
      await adminClient.query(DELETE_VARIANT, { id: variantIds[0] });
      await adminClient.query(DELETE_PRODUCT, { id: productId });

      expect(
        await entriesWhere(server.app, {
          entityType: 'ProductVariant',
          entityId: decode(variantIds[0]),
          action: 'deleted',
        }),
      ).toHaveLength(1);
    });

    it('captures what a host wrote around the events, and warns once for a type it cannot capture yet', async () => {
      const { productId } = await createProduct(adminClient, 'sqlite-capture', []);
      const ctx = await superadminCtx(server.app);
      warn.mockClear();

      await history().capture(ctx, 'Product', [decode(productId)], { action: 'archived', meta: { reason: 'test' } });
      await history().capture(ctx, 'Collection', [1], { action: 'assets_set' });
      await history().capture(ctx, 'Collection', [1], { action: 'assets_set' });

      expect(
        await entriesWhere(server.app, { entityType: 'Product', entityId: decode(productId), action: 'archived' }),
      ).toEqual([
        expect.objectContaining({
          changes: null,
          meta: expect.objectContaining({ reason: 'test', noBefore: 'no_transaction' }),
        }),
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not support Collection'), 'ChangeHistory');
      expect(warn.mock.calls.filter(([message]) => String(message).includes('Collection'))).toHaveLength(1);
    });
  });

  it('previews retention and does not compact or purge yet', async () => {
    const ctx = await systemCtx(server.app);
    const retention = server.app.get(ChangeHistoryRetentionService);
    expect(await retention.preview(ctx)).toEqual({ compactable: 0, purgeable: 0 });
    const { totalItems } = await query();
    expect(await retention.preview(ctx, { compactOlderThanDays: 0 })).toEqual({
      compactable: totalItems,
      purgeable: 0,
    });
    await expect(retention.preview(ctx, { purgeOlderThanDays: -1 })).rejects.toThrow(/non-negative/);
    await expect(retention.compact(ctx, { olderThanDays: 90 })).rejects.toThrow(/not implemented/);
    await expect(retention.purge(ctx, { olderThanDays: 365 })).rejects.toThrow(/not implemented/);
  });
});
