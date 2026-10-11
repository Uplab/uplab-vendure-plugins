import path from 'path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { LanguageCode, Logger, ProductVariantService, TransactionalConnection, mergeConfig } from '@vendure/core';
import { In } from 'typeorm';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ChangeHistoryCollectionMembers,
  ChangeHistoryDetail,
  ChangeHistoryPlugin,
  ChangeHistoryRetentionService,
  ChangeHistoryService,
  FileSystemArchiveStorage,
  NoBeforeStateStrategy,
} from '../src';
import { CollectionCapture } from '../src/capture/collection-capture';
import { ChangeHistoryStrategies } from '../src/services/change-history-strategies.service';
import { initialData } from './fixtures/initial-data';
import {
  ACTIVE_CHANNEL_ZONES,
  ASSIGN_PRODUCTS_TO_CHANNEL,
  CHANGE_HISTORY_ENTRIES,
  CREATE_ASSETS,
  CREATE_CHANNEL,
  CREATE_COLLECTION,
  CREATE_FACET,
  CREATE_PROMOTION,
  CREATE_VARIANTS,
  DELETE_ASSET,
  DELETE_COLLECTION,
  DELETE_FACET,
  DELETE_PRODUCT,
  DELETE_PROMOTION,
  DELETE_VARIANT,
  MOVE_COLLECTION,
  UPDATE_ASSET,
  UPDATE_COLLECTION,
  UPDATE_FACET,
  UPDATE_FACET_VALUES,
  UPDATE_PRODUCT,
  UPDATE_PROMOTION,
  UPDATE_VARIANTS,
} from './graphql';
import {
  createProduct,
  decode,
  entriesWhere,
  facetFilter,
  pngFile,
  settleJobs,
  superadminCtx,
  systemCtx,
  waitFor,
} from './helpers';
import { apiScenarios } from './api-scenarios';
import { retentionScenarios } from './retention-scenarios';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__sqlite-data__')));

describe('ChangeHistoryPlugin on sql.js', () => {
  const warn = vi.spyOn(Logger, 'warn');
  const archiveDir = mkdtempSync(path.join(tmpdir(), 'change-history-e2e-archive-'));
  const archive = new FileSystemArchiveStorage({ dir: archiveDir });
  const { server, adminClient } = createTestEnvironment(
    mergeConfig(testConfig, {
      // Its own port: vitest runs every e2e file of the repo in parallel.
      apiOptions: { port: 3057 },
      plugins: [
        ChangeHistoryPlugin.init({
          retention: { archive },
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
    rmSync(archiveDir, { recursive: true, force: true });
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

    it('captures what a host wrote around the events, and warns once for a type it cannot capture', async () => {
      const { productId } = await createProduct(adminClient, 'sqlite-capture', []);
      const ctx = await superadminCtx(server.app);
      warn.mockClear();

      await history().capture(ctx, 'Product', [decode(productId)], { action: 'archived', meta: { reason: 'test' } });
      await history().capture(ctx, 'Order' as never, [1], { action: 'assets_set' });
      await history().capture(ctx, 'Order' as never, [1], { action: 'assets_set' });

      expect(
        await entriesWhere(server.app, { entityType: 'Product', entityId: decode(productId), action: 'archived' }),
      ).toEqual([
        expect.objectContaining({
          changes: null,
          meta: expect.objectContaining({ reason: 'test', noBefore: 'no_transaction' }),
        }),
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not support Order'), 'ChangeHistory');
      expect(warn.mock.calls.filter(([message]) => String(message).includes('support Order'))).toHaveLength(1);
    });
  });

  describe('collections, facets, assets, promotions without a before-state', () => {
    const members = () =>
      server.app.get(TransactionalConnection).rawConnection.getRepository(ChangeHistoryCollectionMembers);
    let red: string;
    let blue: string;
    let redProduct: string;
    let blueProduct: string;

    const collection = async (name: string, input: Record<string, unknown> = {}) =>
      (
        await adminClient.query(CREATE_COLLECTION, {
          input: { translations: [{ languageCode: 'en', name, slug: name, description: '' }], filters: [], ...input },
        })
      ).createCollection.id as string;
    /** The entries under a collection (its membership rows and batch heads), oldest first. */
    const under = (collectionId: string) =>
      entriesWhere(server.app, { parentType: 'Collection', parentId: decode(collectionId) });

    beforeAll(async () => {
      const { createFacet } = await adminClient.query(CREATE_FACET, {
        input: {
          code: 'sq-colour',
          isPrivate: false,
          translations: [{ languageCode: 'en', name: 'Colour' }],
          values: [
            { code: 'sq-red', translations: [{ languageCode: 'en', name: 'Red' }] },
            { code: 'sq-blue', translations: [{ languageCode: 'en', name: 'Blue' }] },
          ],
        },
      });
      const values = createFacet.values as Array<{ id: string; code: string }>;
      red = values.find((v) => v.code === 'sq-red')!.id;
      blue = values.find((v) => v.code === 'sq-blue')!.id;
      redProduct = (await createProduct(adminClient, 'sq-red-shirt', ['SQ-RED'])).productId;
      blueProduct = (await createProduct(adminClient, 'sq-blue-shirt', ['SQ-BLUE'])).productId;
      await adminClient.query(UPDATE_PRODUCT, { input: { id: redProduct, facetValueIds: [red] } });
      await adminClient.query(UPDATE_PRODUCT, { input: { id: blueProduct, facetValueIds: [blue] } });
      await settleJobs(adminClient);
    });

    it('records products entering and leaving a collection, one collection-rules batch per run', async () => {
      const id = await collection('sq-reds', { filters: facetFilter([red]) });
      const [created] = await entriesWhere(server.app, { entityType: 'Collection', entityId: decode(id) });
      expect(created).toMatchObject({ action: 'created', entityLabel: 'sq-reds', source: 'admin' });
      expect(created.changes?.filters).toMatchObject({
        kind: 'json',
        to: [
          {
            code: 'facet-value-filter',
            args: expect.arrayContaining([{ name: 'facetValueIds', value: `[${decode(red)}]` }]),
          },
        ],
        labels: { [decode(red)]: 'Colour: Red' },
      });

      await settleJobs(adminClient);
      const [head, added] = await waitFor(
        () => under(id),
        (entries) => entries.length >= 2,
      );
      expect(head).toMatchObject({
        entityType: 'Batch',
        entityLabel: 'sq-reds',
        action: 'batch',
        summary: '+1 / −0',
        source: 'collection_rules',
        actorType: 'system',
        actorId: null,
        parentType: 'Collection',
        meta: expect.objectContaining({ kind: 'collection_rules', counts: { added: 1, removed: 0 } }),
      });
      expect(head.batchId).toBe(`collection_rules:${head.entityId}`);
      expect(added).toMatchObject({
        entityType: 'Product',
        entityId: decode(redProduct),
        entityLabel: 'sq-red-shirt',
        action: 'collection_added',
        summary: 'added to sq-reds',
        source: 'collection_rules',
        batchId: head.batchId,
        changes: null,
        meta: expect.objectContaining({ collectionLabel: 'sq-reds' }),
      });

      await adminClient.query(UPDATE_COLLECTION, { input: { id, filters: facetFilter([blue]) } });
      await settleJobs(adminClient);
      const entries = await waitFor(
        () => under(id),
        (all) => all.length >= 5,
      );
      const [secondHead, ...run] = entries.slice(2);
      expect(secondHead).toMatchObject({ entityType: 'Batch', summary: '+1 / −1' });
      expect(run.map((e) => [e.action, e.entityId, e.batchId])).toEqual([
        ['collection_added', decode(blueProduct), secondHead.batchId],
        ['collection_removed', decode(redProduct), secondHead.batchId],
      ]);
      expect(await members().findOneOrFail({ where: { collectionId: decode(id) } })).toMatchObject({
        productIds: [decode(blueProduct)],
      });

      // Saved again without a change of contents: nothing more.
      await adminClient.query(UPDATE_COLLECTION, { input: { id, filters: facetFilter([blue]) } });
      await settleJobs(adminClient);
      expect(await under(id)).toHaveLength(5);
    });

    it('records the first change after the contents were recorded at boot', async () => {
      const id = await collection('sq-seeded', { filters: facetFilter([red]) });
      await settleJobs(adminClient);
      await waitFor(
        () => under(id),
        (entries) => entries.length >= 2,
      );
      // The root collection, created with the first collection, has no event: recorded by the next boot.
      await server.app.get(CollectionCapture).seedMissing();
      // As after a deploy: no snapshot yet, then the boot records the current contents.
      await members().delete({ collectionId: decode(id) });
      expect(await server.app.get(CollectionCapture).seedMissing()).toBe(1);
      expect(await server.app.get(CollectionCapture).seedMissing()).toBe(0);
      expect(await members().findOneOrFail({ where: { collectionId: decode(id) } })).toMatchObject({
        productIds: [decode(redProduct)],
      });

      await adminClient.query(UPDATE_PRODUCT, { input: { id: blueProduct, facetValueIds: [blue, red] } });
      await settleJobs(adminClient);
      const entries = await waitFor(
        () => under(id),
        (all) => all.length >= 4,
      );
      expect(entries.slice(2).map((e) => [e.entityType, e.action, e.entityId])).toEqual([
        ['Batch', 'batch', expect.any(String)],
        ['Product', 'collection_added', decode(blueProduct)],
      ]);
      await adminClient.query(UPDATE_PRODUCT, { input: { id: blueProduct, facetValueIds: [blue] } });
      await settleJobs(adminClient);
    });

    it('re-records the contents of every collection on request (after capture was off)', async () => {
      const id = await collection('sq-reseeded', { filters: facetFilter([red]) });
      await settleJobs(adminClient);
      await members().update({ collectionId: decode(id) }, { productIds: ['999'] });

      const ctx = await superadminCtx(server.app);
      const { collections } = await history().reseedCollectionMembership(ctx);

      expect(collections).toBe(await members().count());
      expect(await members().findOneOrFail({ where: { collectionId: decode(id) } })).toMatchObject({
        productIds: [decode(redProduct)],
      });
    });

    it('stores the contents of a collection it did not know without recording them', async () => {
      // A new collection gets an empty snapshot, so the filters job's first fill is recorded. Wait for that
      // run to be written before forgetting the snapshot: deleting it earlier races the job, whose diff may
      // already have run (then the fill is recorded and no snapshot comes back).
      const id = await collection('sq-unknown', { filters: facetFilter([red]) });
      await settleJobs(adminClient);
      const recorded = await waitFor(
        () => under(id),
        (entries) => entries.length >= 2,
      );
      expect(recorded.map((e) => [e.entityType, e.action])).toEqual([
        ['Batch', 'batch'],
        ['Product', 'collection_added'],
      ]);

      // As if created while capture was off: no snapshot. The next run stores the contents without entries.
      await members().delete({ collectionId: decode(id) });
      await adminClient.query(UPDATE_COLLECTION, { input: { id, filters: facetFilter([blue]) } });
      await settleJobs(adminClient);
      const stored = await waitFor(
        () => members().findOne({ where: { collectionId: decode(id) } }),
        (row) => row !== null,
      );
      expect(stored).toMatchObject({ productIds: [decode(blueProduct)] });
      expect(await under(id)).toEqual(recorded);
    });

    it('records a move without values', async () => {
      const target = await collection('sq-target');
      const moved = await collection('sq-moved');
      await adminClient.query(MOVE_COLLECTION, { input: { collectionId: moved, parentId: target, index: 0 } });

      const [entry] = await entriesWhere(server.app, {
        entityType: 'Collection',
        entityId: decode(moved),
        action: 'moved',
      });
      expect(entry).toMatchObject({
        summary: 'moved (details unavailable)',
        changes: null,
        meta: expect.objectContaining({ noBefore: 'unsupported' }),
      });
    });

    it('records a deleted collection with its last state and the descendants deleted with it', async () => {
      const parent = await collection('sq-parent', { filters: facetFilter([red]) });
      const child = await collection('sq-child', { parentId: parent, inheritFilters: false });
      const grandchild = await collection('sq-grandchild', { parentId: child, inheritFilters: false });
      await settleJobs(adminClient);
      await waitFor(
        () => under(parent),
        (entries) => entries.some((e) => e.entityType === 'Batch'),
      );

      await adminClient.query(DELETE_COLLECTION, { id: parent });

      const deleted = await entriesWhere(server.app, { entityType: 'Collection', action: 'deleted' });
      expect(deleted.map((e) => e.entityId)).toEqual([parent, child, grandchild].map(decode));
      const [own, ...descendants] = deleted;
      expect(own).toMatchObject({
        entityLabel: 'sq-parent',
        parentType: null,
        derivedFromId: null,
        meta: expect.objectContaining({
          memberCount: 1,
          noBefore: 'unsupported',
          lastState: expect.objectContaining({ 'name.en': 'sq-parent', isPrivate: false }),
        }),
      });
      expect(descendants.map((e) => [e.derivedFromId, e.parentType, e.parentId, e.meta.memberCount])).toEqual([
        [own.id, 'Collection', decode(parent), 0],
        [own.id, 'Collection', decode(child), 0],
      ]);
      expect(await members().count({ where: { collectionId: In([parent, child, grandchild].map(decode)) } })).toBe(0);
      // The products did not leave a collection: it is gone.
      expect((await under(parent)).filter((e) => e.action === 'collection_removed')).toEqual([]);
    });

    it('records a facet value rename once, on the value', async () => {
      const before = await entriesWhere(server.app, { entityType: 'Product', entityId: decode(redProduct) });
      await adminClient.query(UPDATE_FACET_VALUES, {
        input: [{ id: red, translations: [{ languageCode: 'en', name: 'Crimson' }] }],
      });
      const [entry] = await entriesWhere(server.app, {
        entityType: 'FacetValue',
        entityId: decode(red),
        action: 'updated',
      });
      expect(entry).toMatchObject({
        action: 'updated',
        entityLabel: 'Colour: Crimson',
        parentType: 'Facet',
        summary: 'updated (details unavailable)',
      });
      expect(await entriesWhere(server.app, { entityType: 'Product', entityId: decode(redProduct) })).toHaveLength(
        before.length,
      );
    });

    it('records a force-deleted facet and its values, derived from it', async () => {
      const { createFacet } = await adminClient.query(CREATE_FACET, {
        input: {
          code: 'sq-size',
          isPrivate: false,
          translations: [{ languageCode: 'en', name: 'Size' }],
          values: [{ code: 'sq-xl', translations: [{ languageCode: 'en', name: 'XL' }] }],
        },
      });
      const xl = createFacet.values[0].id as string;
      await adminClient.query(UPDATE_FACET, { input: { id: createFacet.id, code: 'sq-size-2' } });
      await adminClient.query(UPDATE_PRODUCT, { input: { id: redProduct, facetValueIds: [red, xl] } });
      await adminClient.query(DELETE_FACET, { id: createFacet.id, force: true });

      const facet = await entriesWhere(server.app, { entityType: 'Facet', entityId: decode(createFacet.id) });
      expect(facet.map((e) => e.action)).toEqual(['created', 'updated', 'deleted']);
      expect(facet[2].meta).toMatchObject({
        noBefore: 'unsupported',
        lastState: expect.objectContaining({ code: 'sq-size-2', 'name.en': 'Size' }),
      });
      const value = await entriesWhere(server.app, { entityType: 'FacetValue', entityId: decode(xl) });
      expect(value.map((e) => e.action)).toEqual(['created', 'deleted']);
      expect(value[1]).toMatchObject({
        entityLabel: 'Size: XL',
        parentType: 'Facet',
        parentId: decode(createFacet.id),
        derivedFromId: facet[2].id,
        meta: expect.objectContaining({ lastState: expect.objectContaining({ code: 'sq-xl', 'name.en': 'XL' }) }),
      });
      await settleJobs(adminClient);
    });

    it('records an uploaded, edited and deleted asset, without a channel removal before its deletion', async () => {
      const { createAssets } = await adminClient.fileUploadMutation({
        mutation: CREATE_ASSETS,
        filePaths: [pngFile('sq-pixel')],
        mapVariables: () => ({ input: [{ file: null, tags: ['hero'] }] }),
      });
      const id = createAssets[0].id as string;
      await adminClient.query(UPDATE_ASSET, { input: { id, name: 'Pixel', tags: ['hero', 'sale'] } });
      await adminClient.query(DELETE_ASSET, { input: { assetId: id, force: true } });

      const entries = await entriesWhere(server.app, { entityType: 'Asset', entityId: decode(id) });
      expect(entries.map((e) => e.action)).toEqual(['created', 'updated', 'deleted']);
      expect(entries[0].changes).toMatchObject({
        'name.en': { to: 'change-history-sq-pixel.png' },
        mimeType: { to: 'image/png' },
        type: { to: 'IMAGE' },
        tags: { kind: 'refs', added: ['hero'], removed: [] },
      });
      expect(entries[2]).toMatchObject({
        entityLabel: 'Pixel',
        meta: expect.objectContaining({ lastState: expect.objectContaining({ 'name.en': 'Pixel' }) }),
      });
    });

    it('records a promotion with its conditions and actions', async () => {
      const { createPromotion } = await adminClient.query(CREATE_PROMOTION, {
        input: {
          enabled: true,
          couponCode: 'SQ-10',
          conditions: [],
          actions: [{ code: 'order_percentage_discount', arguments: [{ name: 'discount', value: '10' }] }],
          translations: [{ languageCode: 'en', name: 'Ten off', description: '' }],
        },
      });
      const id = createPromotion.id as string;
      await adminClient.query(UPDATE_PROMOTION, { input: { id, couponCode: 'SQ-20' } });
      await adminClient.query(DELETE_PROMOTION, { id });

      const entries = await entriesWhere(server.app, { entityType: 'Promotion', entityId: decode(id) });
      expect(entries.map((e) => e.action)).toEqual(['created', 'updated', 'deleted']);
      expect(entries[0].changes).toMatchObject({
        couponCode: { to: 'SQ-10' },
        actions: {
          kind: 'json',
          to: [{ code: 'order_percentage_discount', args: [{ name: 'discount', value: '10' }] }],
        },
        'name.en': { to: 'Ten off' },
      });
      expect(entries[0].changes).not.toHaveProperty('priorityScore');
      expect(entries[2].meta).toMatchObject({ lastState: expect.objectContaining({ couponCode: 'SQ-20' }) });
    });

    it('records products and variants assigned to another channel', async () => {
      const { activeChannel } = await adminClient.query(ACTIVE_CHANNEL_ZONES);
      const { createChannel } = await adminClient.query(CREATE_CHANNEL, {
        input: {
          code: 'sq-second',
          token: 'sq-second-token',
          defaultLanguageCode: 'en',
          pricesIncludeTax: false,
          defaultCurrencyCode: 'USD',
          defaultShippingZoneId: activeChannel.defaultShippingZone.id,
          defaultTaxZoneId: activeChannel.defaultTaxZone.id,
        },
      });
      const { productId, variantIds } = await createProduct(adminClient, 'sq-channel', ['SQ-CH']);
      await adminClient.query(ASSIGN_PRODUCTS_TO_CHANNEL, {
        input: { productIds: [productId], channelId: createChannel.id },
      });

      const [product] = await entriesWhere(server.app, {
        entityType: 'Product',
        entityId: decode(productId),
        action: 'channel_assigned',
      });
      expect(product).toMatchObject({
        summary: 'assigned to channel sq-second',
        changes: null,
        meta: expect.objectContaining({ channelId: decode(createChannel.id), channelCode: 'sq-second' }),
      });
      const [variant] = await entriesWhere(server.app, {
        entityType: 'ProductVariant',
        entityId: decode(variantIds[0]),
        action: 'channel_assigned',
      });
      // Core assigns the variants before it announces the product: no derived link.
      expect(variant).toMatchObject({
        parentType: 'Product',
        parentId: decode(productId),
        summary: 'assigned to channel sq-second',
      });
      await settleJobs(adminClient);
    });

    it('captures a collection a host changed around the events', async () => {
      const id = await collection('sq-captured');
      const ctx = await superadminCtx(server.app);
      await history().capture(ctx, 'Collection', [decode(id)], { action: 'assets_set' });
      const [entry] = await entriesWhere(server.app, {
        entityType: 'Collection',
        entityId: decode(id),
        action: 'assets_set',
      });
      expect(entry).toMatchObject({
        entityLabel: 'sq-captured',
        meta: expect.objectContaining({ noBefore: 'no_transaction' }),
      });
    });
  });

  it('previews retention with the configured and with given windows', async () => {
    const ctx = await systemCtx(server.app);
    const retention = server.app.get(ChangeHistoryRetentionService);
    expect(await retention.preview(ctx)).toEqual({ compactable: 0, purgeable: 0 });
    // Every entry, derived ones included (the feed leaves those out by default).
    const { totalItems } = await query({ filter: { derivedFromId: { isNull: false } } });
    const { totalItems: notDerived } = await query();
    expect(await retention.preview(ctx, { compactOlderThanDays: 0 })).toEqual({
      compactable: totalItems + notDerived,
      purgeable: 0,
    });
    await expect(retention.preview(ctx, { purgeOlderThanDays: -1 })).rejects.toThrow(/non-negative/);
  });

  retentionScenarios({ app: () => server.app, adminClient, archive, archiveDir });
  apiScenarios({ app: () => server.app, adminClient, postgres: false });
});
