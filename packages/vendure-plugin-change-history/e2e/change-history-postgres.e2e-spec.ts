import {
  Asset,
  Collection,
  LanguageCode,
  Logger,
  Product,
  ProductService,
  RequestContext,
  TaxCategory,
  TransactionalConnection,
  mergeConfig,
} from '@vendure/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { In } from 'typeorm';
import { createTestEnvironment, registerInitializer, testConfig } from '@vendure/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ChangeHistoryCollectionMembers,
  ChangeHistoryDetail,
  ChangeHistoryEntry,
  ChangeHistoryPlugin,
  ChangeHistoryService,
  CommittedRowBeforeStateStrategy,
  FileSystemArchiveStorage,
} from '../src';
import { CollectionCapture } from '../src/capture/collection-capture';
import { ChangeHistoryStrategies } from '../src/services/change-history-strategies.service';
import { DedicatedPostgresInitializer } from './dedicated-postgres-initializer';
import {
  FAN_OUT_HANDLER_ID,
  FanOutTestPlugin,
  ROLLBACK_NAME,
  VARIANT_FAN_OUT_HANDLER_ID,
} from './fixtures/fan-out-plugin';
import { initialData } from './fixtures/initial-data';
import {
  ACTIVE_CHANNEL_ZONES,
  ADD_OPTION_GROUP,
  ASSIGN_ASSETS_TO_CHANNEL,
  ASSIGN_COLLECTIONS_TO_CHANNEL,
  CHANGE_HISTORY_ENTRIES,
  CREATE_API_KEY,
  CREATE_ASSETS,
  CREATE_CHANNEL,
  CREATE_COLLECTION,
  CREATE_OPTION_GROUP,
  CREATE_FACET,
  CREATE_PRODUCT_WITH,
  CREATE_PROMOTION,
  CREATE_VARIANTS,
  DELETE_ASSET,
  DELETE_ASSETS,
  DELETE_COLLECTION,
  DELETE_FACET,
  DELETE_FACET_VALUES,
  DELETE_PRODUCT,
  DELETE_PROMOTION,
  DELETE_VARIANT,
  MOVE_COLLECTION,
  REMOVE_COLLECTIONS_FROM_CHANNEL,
  ROLES,
  UPDATE_ASSET,
  UPDATE_COLLECTION,
  UPDATE_FACET,
  UPDATE_FACET_VALUES,
  UPDATE_PRODUCT,
  UPDATE_PROMOTION,
  UPDATE_VARIANTS,
} from './graphql';
import { decode, entriesWhere, facetFilter, pngFile, settleJobs, superadminCtx, systemCtx, waitFor } from './helpers';
import { apiScenarios } from './api-scenarios';
import { retentionScenarios } from './retention-scenarios';

/**
 * The Postgres suite: everything that needs a real second connection — exact before → after values, no-op
 * suppression, savepoint isolation, handler ordering. Skipped unless CHANGE_HISTORY_E2E_PG_URL points at a
 * database it may reset, e.g. postgres://postgres:postgres@localhost:5432/change_history_e2e (TESTING.md).
 */
const url = process.env.CHANGE_HISTORY_E2E_PG_URL;
const PORT = 3058;

registerInitializer('postgres', new DedicatedPostgresInitializer());

/** An entry whose label contains this fails in the database (a trigger of the suite), inside a real mutation. */
const FAIL = '[fail]';

describe.skipIf(!url)('ChangeHistoryPlugin on Postgres', () => {
  const warn = vi.spyOn(Logger, 'warn');
  const archiveDir = mkdtempSync(path.join(tmpdir(), 'change-history-pg-archive-'));
  const archive = new FileSystemArchiveStorage({ dir: archiveDir });
  const config = mergeConfig(testConfig, {
    // Its own port: vitest runs every e2e file of the repo in parallel.
    apiOptions: { port: PORT },
    authOptions: { tokenMethod: ['bearer', 'api-key'] },
    customFields: {
      Product: [
        { name: 'subtitle', type: 'string' },
        { name: 'seoTitle', type: 'localeString' },
        { name: 'isHit', type: 'boolean' },
        { name: 'price', type: 'int' },
        { name: 'erpId', type: 'string', readonly: true },
        { name: 'viewCount', type: 'int', readonly: true },
        { name: 'defaultTaxCategory', type: 'relation', entity: TaxCategory },
      ],
      ProductVariant: [{ name: 'fullPrice', type: 'int' }],
      Collection: [{ name: 'banner', type: 'string' }],
    },
    plugins: [
      FanOutTestPlugin,
      ChangeHistoryPlugin.init({
        retention: { archive },
        entities: {
          Product: { includeReadonlyCustomFields: ['erpId'], fieldKinds: { 'customFields.price': 'money' } },
          ProductVariant: { fieldKinds: { 'customFields.fullPrice': 'money' } },
        },
        handlerOrder: {
          Product: { before: FAN_OUT_HANDLER_ID },
          ProductVariant: { before: VARIANT_FAN_OUT_HANDLER_ID },
        },
      }),
    ],
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
  /** Entries of one entity, oldest first. */
  const entriesOf = (entityType: string, id: string) => entriesWhere(server.app, { entityType, entityId: decode(id) });
  const lastOf = async (entityType: string, id: string) => (await entriesOf(entityType, id)).at(-1);

  const createProduct = async (input: Record<string, unknown>) =>
    (await adminClient.query(CREATE_PRODUCT_WITH, { input })).createProduct.id as string;
  const createVariants = async (productId: string, variants: Array<Record<string, unknown>>) =>
    (
      (
        await adminClient.query(CREATE_VARIANTS, {
          input: variants.map((v) => ({
            productId,
            optionIds: [],
            translations: [{ languageCode: 'en', name: v.sku }],
            ...v,
          })),
        })
      ).createProductVariants as Array<{ id: string }>
    ).map((v) => v.id);
  /** Option ids of a new option group attached to the product: products with several variants need options. */
  const sizesOf = async (productId: string, code: string, sizes: string[]) => {
    const { createProductOptionGroup } = await adminClient.query(CREATE_OPTION_GROUP, {
      input: {
        code,
        translations: [{ languageCode: 'en', name: 'Size' }],
        options: sizes.map((size) => ({ code: `${code}-${size}`, translations: [{ languageCode: 'en', name: size }] })),
      },
    });
    await adminClient.query(ADD_OPTION_GROUP, { productId, optionGroupId: createProductOptionGroup.id });
    return (createProductOptionGroup.options as Array<{ id: string }>).map((o) => o.id);
  };
  const updateProduct = (input: Record<string, unknown>) => adminClient.query(UPDATE_PRODUCT, { input });
  const updateVariants = (input: Array<Record<string, unknown>>) => adminClient.query(UPDATE_VARIANTS, { input });

  let defaultChannelId: string;
  let taxCategoryId: string;

  beforeAll(async () => {
    await server.init({ initialData, customerCount: 0 });
    await adminClient.asSuperAdmin();
    const ctx = await systemCtx(server.app);
    defaultChannelId = String(ctx.channelId);
    const [taxCategory] = await connection().rawConnection.getRepository(TaxCategory).find();
    taxCategoryId = String(taxCategory.id);
    const raw = connection().rawConnection;
    const table = raw.getMetadata(ChangeHistoryEntry).tablePath;
    await raw.query(`CREATE OR REPLACE FUNCTION change_history_e2e_fail() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityLabel" LIKE '%${FAIL}%' THEN RAISE EXCEPTION 'injected history failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await raw.query(`DROP TRIGGER IF EXISTS change_history_e2e_fail ON "${table}"`);
    await raw.query(
      `CREATE TRIGGER change_history_e2e_fail BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION change_history_e2e_fail()`,
    );
  }, 120_000);

  afterAll(async () => {
    await server.destroy();
    rmSync(archiveDir, { recursive: true, force: true });
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

  describe('products', () => {
    let productId: string;

    it('records a created product with every value it was created with', async () => {
      productId = await createProduct({
        translations: [{ languageCode: 'en', name: 'Shirt', slug: 'shirt', description: '<p>Soft</p>' }],
        customFields: { subtitle: 'Cotton', price: 1299, defaultTaxCategoryId: taxCategoryId },
      });

      const [entry] = await entriesOf('Product', productId);
      expect(entry).toMatchObject({
        action: 'created',
        entityLabel: 'Shirt',
        source: 'admin',
        actorType: 'admin',
        actorLabel: 'Super Admin',
        summary: 'created',
        parentType: null,
        derivedFromId: null,
      });
      expect(entry.changes).toEqual({
        enabled: { kind: 'bool', from: null, to: true },
        'name.en': { kind: 'text', from: null, to: 'Shirt' },
        'slug.en': { kind: 'text', from: null, to: 'shirt' },
        'description.en': { kind: 'richtext', from: null, to: '<p>Soft</p>' },
        'customFields.subtitle': { kind: 'text', from: null, to: 'Cotton' },
        'customFields.price': { kind: 'money', from: null, to: 1299 },
        'customFields.defaultTaxCategory': {
          kind: 'ref',
          from: null,
          to: taxCategoryId,
          labels: { [taxCategoryId]: 'Standard Tax' },
        },
      });
    });

    it('records exactly the changed fields of an update, with the values from before the save', async () => {
      await updateProduct({
        id: productId,
        enabled: false,
        translations: [{ languageCode: 'en', name: 'Shirt Oversize' }],
        customFields: { subtitle: 'Linen' },
      });

      const entry = await lastOf('Product', productId);
      expect(entry).toMatchObject({
        action: 'updated',
        entityLabel: 'Shirt Oversize',
        summary: '3 fields: customFields.subtitle, enabled, name.en',
        meta: { correlationId: expect.any(String) },
      });
      expect(entry?.changes).toEqual({
        enabled: { kind: 'bool', from: true, to: false },
        'name.en': { kind: 'text', from: 'Shirt', to: 'Shirt Oversize' },
        'customFields.subtitle': { kind: 'text', from: 'Cotton', to: 'Linen' },
      });
      expect(entry?.meta).not.toHaveProperty('noBefore');
    });

    it('writes nothing for a save that changes nothing', async () => {
      const before = (await entriesOf('Product', productId)).length;
      await updateProduct({
        id: productId,
        enabled: false,
        translations: [{ languageCode: 'en', name: 'Shirt Oversize' }],
        customFields: { subtitle: 'Linen' },
      });
      expect(await entriesOf('Product', productId)).toHaveLength(before);
    });

    it('records a new language per field, including translatable custom fields', async () => {
      await updateProduct({
        id: productId,
        translations: [
          {
            languageCode: 'uk',
            name: 'Сорочка',
            slug: 'sorochka',
            description: '',
            customFields: { seoTitle: 'Лляна сорочка' },
          },
        ],
      });

      expect((await lastOf('Product', productId))?.changes).toEqual({
        'name.uk': { kind: 'text', from: null, to: 'Сорочка' },
        'slug.uk': { kind: 'text', from: null, to: 'sorochka' },
        'description.uk': { kind: 'richtext', from: null, to: '' },
        'customFields.seoTitle.uk': { kind: 'text', from: null, to: 'Лляна сорочка' },
      });
    });

    it('records facet values as added / removed ids with labels', async () => {
      const { createFacet } = await adminClient.query(CREATE_FACET, {
        input: {
          code: 'color',
          isPrivate: false,
          translations: [{ languageCode: 'en', name: 'Color' }],
          values: [
            { code: 'black', translations: [{ languageCode: 'en', name: 'Black' }] },
            { code: 'white', translations: [{ languageCode: 'en', name: 'White' }] },
          ],
        },
      });
      const [black, white] = createFacet.values.map((v: { id: string }) => v.id);

      await updateProduct({ id: productId, facetValueIds: [white] });
      await updateProduct({ id: productId, facetValueIds: [black] });

      expect((await lastOf('Product', productId))?.changes).toEqual({
        facetValues: {
          kind: 'refs',
          added: [decode(black)],
          removed: [decode(white)],
          labels: { [decode(black)]: 'Color: Black', [decode(white)]: 'Color: White' },
        },
      });
    });

    it('records a readonly custom field written by code only when the host includes it', async () => {
      const ctx = await superadminCtx(server.app);
      const id = decode(productId);
      const count = (await entriesOf('Product', productId)).length;

      await connection().withTransaction(ctx, async (tctx) => {
        await connection()
          .getRepository(tctx, Product)
          .update(id, { customFields: { viewCount: 41 } });
        await history().capture(tctx, 'Product', [id], { action: 'counted' });
      });
      expect(await entriesOf('Product', productId)).toHaveLength(count);

      await connection().withTransaction(ctx, async (tctx) => {
        await connection()
          .getRepository(tctx, Product)
          .update(id, { customFields: { erpId: 'ERP-7' } });
        await history().capture(tctx, 'Product', [id], { action: 'erp_linked', meta: { job: 7 } });
      });
      expect(await lastOf('Product', productId)).toMatchObject({
        action: 'erp_linked',
        summary: '1 field: customFields.erpId',
        changes: { 'customFields.erpId': { kind: 'text', from: null, to: 'ERP-7' } },
        meta: { job: 7 },
      });
    });
  });

  describe('variants', () => {
    let productId: string;
    let variantId: string;

    beforeAll(async () => {
      productId = await createProduct({
        translations: [{ languageCode: 'en', name: 'Jeans', slug: 'jeans', description: '' }],
      });
      [variantId] = await createVariants(productId, [{ sku: 'JEANS-32', price: 1000, stockOnHand: 5 }]);
    });

    it('records a created variant under its product, without its initial stock as an adjustment', async () => {
      const entries = await entriesOf('ProductVariant', variantId);
      expect(entries.map((e) => e.action)).toEqual(['created']);
      expect(entries[0]).toMatchObject({
        entityLabel: 'JEANS-32 (JEANS-32)',
        parentType: 'Product',
        parentId: decode(productId),
        derivedFromId: null,
      });
      expect(entries[0].changes).toMatchObject({
        sku: { kind: 'text', from: null, to: 'JEANS-32' },
        prices: {
          kind: 'prices',
          from: null,
          to: [{ channelId: defaultChannelId, currencyCode: 'USD', price: 1000 }],
          labels: { [defaultChannelId]: '__default_channel__' },
        },
        taxCategory: { kind: 'ref', from: null, to: taxCategoryId, labels: { [taxCategoryId]: 'Standard Tax' } },
        trackInventory: { kind: 'enum', from: null, to: 'INHERIT' },
      });
    });

    it('records price, SKU, stock settings and custom fields of an update', async () => {
      await updateVariants([
        {
          id: variantId,
          sku: 'JEANS-32-BLUE',
          price: 1200,
          trackInventory: 'TRUE',
          outOfStockThreshold: 2,
          useGlobalOutOfStockThreshold: false,
          customFields: { fullPrice: 1500 },
        },
      ]);

      const entry = await lastOf('ProductVariant', variantId);
      expect(entry).toMatchObject({ action: 'updated', entityLabel: 'JEANS-32 (JEANS-32-BLUE)', derivedFromId: null });
      expect(entry?.changes).toEqual({
        sku: { kind: 'text', from: 'JEANS-32', to: 'JEANS-32-BLUE' },
        prices: {
          kind: 'prices',
          from: [{ channelId: defaultChannelId, currencyCode: 'USD', price: 1000 }],
          to: [{ channelId: defaultChannelId, currencyCode: 'USD', price: 1200 }],
          labels: { [defaultChannelId]: '__default_channel__' },
        },
        trackInventory: { kind: 'enum', from: 'INHERIT', to: 'TRUE' },
        outOfStockThreshold: { kind: 'text', from: 0, to: 2 },
        useGlobalOutOfStockThreshold: { kind: 'bool', from: true, to: false },
        'customFields.fullPrice': { kind: 'money', from: null, to: 1500 },
      });
    });

    it('records a manual stock change as a stock adjustment', async () => {
      await updateVariants([{ id: variantId, stockOnHand: 9 }]);

      const entries = await entriesOf('ProductVariant', variantId);
      expect(entries.at(-1)).toMatchObject({
        action: 'stock_adjusted',
        parentId: decode(productId),
        changes: { stock: { kind: 'stock', from: 5, to: 9, delta: 4, location: 'Default Stock Location' } },
      });
      // The stock level is not a field of the variant: no `updated` entry for the same save.
      expect(entries.filter((e) => e.action === 'updated')).toHaveLength(1);
    });

    it('records a deleted variant with its last state', async () => {
      const shorts = await createProduct({
        translations: [{ languageCode: 'en', name: 'Shorts', slug: 'shorts', description: '' }],
      });
      const [extra] = await createVariants(shorts, [{ sku: 'JEANS-34', price: 1000 }]);
      await adminClient.query(DELETE_VARIANT, { id: extra });

      expect(await lastOf('ProductVariant', extra)).toMatchObject({
        action: 'deleted',
        summary: 'deleted',
        changes: null,
        meta: { lastState: expect.objectContaining({ sku: 'JEANS-34', 'name.en': 'JEANS-34' }) },
      });
    });

    it('records a deleted product and its variants as derived deletions, skipping variants deleted earlier', async () => {
      const deletedEarlier = (await entriesWhere(server.app, { entityType: 'ProductVariant', action: 'deleted' }))
        .length;
      await adminClient.query(DELETE_PRODUCT, { id: productId });

      const product = await lastOf('Product', productId);
      expect(product).toMatchObject({
        action: 'deleted',
        entityLabel: 'Jeans',
        meta: { lastState: expect.objectContaining({ 'name.en': 'Jeans', enabled: true }) },
      });
      const variantDeletions = await entriesWhere(server.app, { entityType: 'ProductVariant', action: 'deleted' });
      expect(variantDeletions).toHaveLength(deletedEarlier + 1);
      expect(variantDeletions.at(-1)).toMatchObject({ entityId: decode(variantId), derivedFromId: product?.id });
    });
  });

  describe('handler order and derived changes', () => {
    it('runs before a host handler that fans a product price out to the variants', async () => {
      const productId = await createProduct({
        translations: [{ languageCode: 'en', name: 'Hoodie', slug: 'hoodie', description: '' }],
      });
      const [small, medium] = await sizesOf(productId, 'hoodie-size', ['S', 'M']);
      const variantIds = await createVariants(productId, [
        { sku: 'HOODIE-S', price: 2000, optionIds: [small] },
        { sku: 'HOODIE-M', price: 2000, optionIds: [medium] },
      ]);

      const [groupAdded] = await entriesWhere(server.app, {
        entityType: 'Product',
        entityId: decode(productId),
        action: 'option_group_added',
      });
      expect(groupAdded.changes).toEqual({
        optionGroups: { kind: 'refs', added: [expect.any(String)], removed: [], labels: expect.any(Object) },
      });
      expect(Object.values(groupAdded.changes?.optionGroups.labels ?? {})).toEqual(['Size']);

      await updateProduct({ id: productId, customFields: { price: 2500 } });

      const product = await lastOf('Product', productId);
      expect(product?.changes).toEqual({ 'customFields.price': { kind: 'money', from: null, to: 2500 } });
      for (const variantId of variantIds) {
        const variant = await lastOf('ProductVariant', variantId);
        expect(variant).toMatchObject({ action: 'updated', derivedFromId: product?.id, batchId: null });
        expect(Number(variant?.id)).toBeGreaterThan(Number(product?.id));
        expect(variant?.changes).toEqual({
          prices: expect.objectContaining({
            from: [{ channelId: defaultChannelId, currencyCode: 'USD', price: 2000 }],
            to: [{ channelId: defaultChannelId, currencyCode: 'USD', price: 2500 }],
          }),
        });
      }
    });

    it("records a new variant with the admin's price, then the host's rewrite as derived", async () => {
      const productId = await createProduct({
        translations: [{ languageCode: 'en', name: 'Cap', slug: 'cap', description: '' }],
        customFields: { price: 900 },
      });
      const [variantId] = await createVariants(productId, [{ sku: 'CAP-1', price: 700 }]);

      const [created, rewritten] = await entriesOf('ProductVariant', variantId);
      expect(created).toMatchObject({ action: 'created', derivedFromId: null });
      expect((created.changes?.prices as { to: unknown }).to).toEqual([
        { channelId: defaultChannelId, currencyCode: 'USD', price: 700 },
      ]);
      expect(rewritten).toMatchObject({ action: 'updated', derivedFromId: created.id });
      expect(rewritten.changes).toEqual({
        prices: expect.objectContaining({
          from: [{ channelId: defaultChannelId, currencyCode: 'USD', price: 700 }],
          to: [{ channelId: defaultChannelId, currencyCode: 'USD', price: 900 }],
        }),
      });
    });
  });

  describe('isolation', () => {
    it('keeps the host mutation when the history write fails (savepoint)', async () => {
      const error = vi.spyOn(Logger, 'error');
      const productId = await createProduct({
        translations: [{ languageCode: 'en', name: 'Belt', slug: 'belt', description: '' }],
      });
      const count = (await entriesOf('Product', productId)).length;

      await updateProduct({ id: productId, translations: [{ languageCode: 'en', name: `Leather belt ${FAIL}` }] });

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('[ChangeHistory] write failed in updated Product: injected history failure'),
        'ChangeHistory',
        expect.any(String),
      );
      const product = await connection()
        .rawConnection.getRepository(Product)
        .findOneOrFail({ where: { id: decode(productId) }, relations: ['translations'] });
      expect(product.translations[0].name).toBe(`Leather belt ${FAIL}`);
      expect(await entriesOf('Product', productId)).toHaveLength(count);
      error.mockRestore();
    });

    it('leaves no entry when the host rolls the mutation back after the history handler', async () => {
      const productId = await createProduct({
        translations: [{ languageCode: 'en', name: 'Scarf', slug: 'scarf', description: '' }],
      });
      const count = (await entriesOf('Product', productId)).length;

      await expect(
        updateProduct({ id: productId, translations: [{ languageCode: 'en', name: ROLLBACK_NAME }] }),
      ).rejects.toThrow(/host handler failed/);

      expect(await entriesOf('Product', productId)).toHaveLength(count);
    });

    it("isolates a failed history write in a savepoint: the caller's transaction still commits", async () => {
      const error = vi.spyOn(Logger, 'error');
      const ctx = await systemCtx(server.app);

      await connection().withTransaction(ctx, async (tctx) => {
        // Postgres rejects the statement, which would abort the whole transaction without a savepoint.
        await history().recordAction(tctx, {
          entityType: 'Facet',
          entityId: 1,
          entityLabel: `Bad ${FAIL}`,
          action: 'x',
        });
        await history().recordAction(tctx, { entityType: 'Facet', entityId: 1, entityLabel: 'Good', action: 'x' });
      });

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('injected history failure'),
        'ChangeHistory',
        expect.any(String),
      );
      expect((await entriesWhere(server.app, { entityLabel: 'Good' })).length).toBe(1);
      expect(await entriesWhere(server.app, { entityLabel: `Bad ${FAIL}` })).toEqual([]);
      error.mockRestore();
    });

    it('clips an over-long value from the host to its column instead of losing the entry or the run', async () => {
      const ctx = await systemCtx(server.app);
      warn.mockClear();
      await history().recordAction(ctx, {
        entityType: 'T'.repeat(40),
        entityId: 'i'.repeat(40),
        entityLabel: 'pg-clipped-action',
        action: 'a'.repeat(40),
        parent: { type: 'P'.repeat(40), id: 'p'.repeat(40) },
      });
      const source = 's'.repeat(40);
      await history().recordRun(ctx, {
        source,
        label: 'pg-clipped-run',
        counts: { updated: 1 },
        details: [
          {
            entityType: 'D'.repeat(40),
            entityId: 'd'.repeat(40),
            kind: 'k'.repeat(40),
            scope: 'c'.repeat(70),
            from: 1,
            to: 2,
          },
        ],
      });

      expect(await entriesWhere(server.app, { entityLabel: 'pg-clipped-action' })).toEqual([
        expect.objectContaining({
          entityType: 'T'.repeat(32),
          entityId: 'i'.repeat(36),
          action: 'a'.repeat(32),
          parentType: 'P'.repeat(32),
          parentId: 'p'.repeat(36),
        }),
      ]);
      const [run] = await entriesWhere(server.app, { entityLabel: 'pg-clipped-run' });
      // `entityId` defaults to the source.
      expect(run).toMatchObject({ source: source.slice(0, 32), entityId: source.slice(0, 36) });
      expect(
        await connection()
          .rawConnection.getRepository(ChangeHistoryDetail)
          .find({ where: { entryId: run.id } }),
      ).toEqual([
        expect.objectContaining({
          entityType: 'D'.repeat(32),
          entityId: 'd'.repeat(36),
          kind: 'k'.repeat(32),
          scope: 'c'.repeat(64),
        }),
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('recordAction: clipped action, entityId, entityType, parentId, parentType'),
        'ChangeHistory',
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('recordRun: clipped entityId, source'),
        'ChangeHistory',
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`recordRun "${source}" detail rows: clipped entityId, entityType, kind, scope`),
        'ChangeHistory',
      );
      // The suite's run test lists every run.
      await connection().rawConnection.getRepository(ChangeHistoryDetail).delete({ entryId: run.id });
      await connection().rawConnection.getRepository(ChangeHistoryEntry).delete({ id: run.id });
    });

    it('forgets what a rolled-back savepoint saw: no phantom before-state, no link to a rolled-back entry', async () => {
      const productId = await createProduct({
        translations: [{ languageCode: 'en', name: 'Cap', slug: 'cap', description: '' }],
      });
      const id = Number(decode(productId));
      const products = server.app.get(ProductService);
      const rollBack = new Error('inner savepoint rolls back');
      const ctx = await superadminCtx(server.app);

      await connection().withTransaction(ctx, async (tctx) => {
        await products.update(tctx, { id, translations: [{ languageCode: LanguageCode.en, name: 'Cap 1' }] });
        await expect(
          connection().withTransaction(tctx, async (inner) => {
            await products.update(inner, { id, translations: [{ languageCode: LanguageCode.en, name: 'Phantom' }] });
            await history().recordAction(inner, {
              entityType: 'Facet',
              entityId: 'pg-rolled-back',
              entityLabel: 'Rolled back',
              action: 'archived',
            });
            throw rollBack;
          }),
        ).rejects.toBe(rollBack);
        await products.update(tctx, { id, translations: [{ languageCode: LanguageCode.en, name: 'Cap 2' }] });
        await history().recordAction(tctx, {
          entityType: 'FacetValue',
          entityId: 'pg-kept',
          entityLabel: 'Kept',
          action: 'archived',
          parent: { type: 'Facet', id: 'pg-rolled-back' },
        });
      });

      const names = (await entriesOf('Product', productId)).slice(1).map((entry) => entry.changes?.['name.en']);
      expect(names).toEqual([
        { kind: 'text', from: 'Cap', to: 'Cap 1' },
        { kind: 'text', from: 'Cap 1', to: 'Cap 2' },
      ]);
      expect(await entriesWhere(server.app, { entityId: 'pg-rolled-back' })).toEqual([]);
      expect(await entriesWhere(server.app, { entityId: 'pg-kept' })).toEqual([
        expect.objectContaining({ derivedFromId: null }),
      ]);
    });

    it('writes the head of a batch again when the transaction that wrote it rolled back', async () => {
      const ctx = await superadminCtx(server.app);
      const rollBack = new Error('first transaction rolls back');
      const record = (tctx: RequestContext, entityId: string) =>
        history().recordAction(tctx, { entityType: 'Facet', entityId, entityLabel: entityId, action: 'archived' });

      await history().runBatch(ctx, { kind: 'pg_retry' }, async (bctx) => {
        await expect(
          connection().withTransaction(bctx, async (tctx) => {
            await record(tctx, 'pg-batch-1');
            throw rollBack;
          }),
        ).rejects.toBe(rollBack);
        await connection().withTransaction(bctx, async (tctx) => {
          await record(tctx, 'pg-batch-2');
          await record(tctx, 'pg-batch-3');
        });
      });

      expect(await entriesWhere(server.app, { entityId: 'pg-batch-1' })).toEqual([]);
      const [member] = await entriesWhere(server.app, { entityId: 'pg-batch-2' });
      expect(member.batchId).toMatch(/^pg_retry:/);
      expect(await entriesWhere(server.app, { batchId: member.batchId, entityType: 'Batch' })).toHaveLength(1);
      expect(await entriesWhere(server.app, { batchId: member.batchId })).toHaveLength(3);
    });

    it('records a save made outside a transaction without its before-state', async () => {
      const productId = await createProduct({
        translations: [{ languageCode: 'en', name: 'Sock', slug: 'sock', description: '' }],
      });
      const ctx = await superadminCtx(server.app);

      await server.app.get(ProductService).update(ctx, { id: Number(decode(productId)), enabled: false });

      expect(await lastOf('Product', productId)).toMatchObject({
        action: 'updated',
        changes: null,
        summary: 'updated (details unavailable)',
        meta: expect.objectContaining({ noBefore: 'no_transaction' }),
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('saved outside a transaction'), 'ChangeHistory');
    });
  });

  describe('actors and batches', () => {
    it('records the owner of an API key', async () => {
      const { roles } = await adminClient.query(ROLES);
      const superAdminRole = roles.items.find((r: { code: string }) => r.code === '__super_admin_role__');
      const { createApiKey } = await adminClient.query(CREATE_API_KEY, {
        input: { roleIds: [superAdminRole.id], translations: [{ languageCode: 'en', name: 'ERP' }] },
      });
      const productId = await createProduct({
        translations: [{ languageCode: 'en', name: 'Tie', slug: 'tie', description: '' }],
      });

      const response = await fetch(`http://localhost:${PORT}/admin-api`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'vendure-api-key': createApiKey.apiKey },
        body: JSON.stringify({
          query: 'mutation($input: UpdateProductInput!) { updateProduct(input: $input) { id } }',
          variables: { input: { id: productId, enabled: false } },
        }),
      });
      expect(((await response.json()) as { errors?: unknown }).errors).toBeUndefined();

      expect(await lastOf('Product', productId)).toMatchObject({
        actorType: 'api_key',
        source: 'api_key',
        actorLabel: 'Super Admin (API key)',
        changes: { enabled: { kind: 'bool', from: true, to: false } },
      });
    });

    it('groups the entries of a batch under one head, in one transaction', async () => {
      const ids = await Promise.all(
        ['Glove', 'Mitten'].map((name) =>
          createProduct({ translations: [{ languageCode: 'en', name, slug: name.toLowerCase(), description: '' }] }),
        ),
      );
      const ctx = await superadminCtx(server.app);

      await history().runBatch(ctx, { kind: 'bulk_edit', label: 'Bulk edit', meta: { fields: ['enabled'] } }, (bctx) =>
        connection().withTransaction(bctx, async (tctx) => {
          for (const id of ids) {
            await server.app.get(ProductService).update(tctx, { id: Number(decode(id)), enabled: false });
          }
        }),
      );

      const members = await Promise.all(ids.map((id) => lastOf('Product', id)));
      const batchId = members[0]?.batchId;
      expect(batchId).toMatch(/^bulk_edit:/);
      expect(members.map((m) => [m?.batchId, m?.derivedFromId, m?.changes])).toEqual(
        ids.map(() => [batchId, null, { enabled: { kind: 'bool', from: true, to: false } }]),
      );
      const [head] = await entriesWhere(server.app, { batchId, entityType: 'Batch' });
      expect(head).toMatchObject({
        action: 'batch',
        entityLabel: 'Bulk edit',
        meta: expect.objectContaining({ fields: ['enabled'] }),
      });
      expect(Number(head.id)).toBeLessThan(Number(members[0]?.id));
    });
  });

  describe('collections, facets, assets, promotions', () => {
    const members = () => connection().rawConnection.getRepository(ChangeHistoryCollectionMembers);
    const collections = () => server.app.get(CollectionCapture);
    let red: string;
    let blue: string;
    let redProduct: string;
    let blueProduct: string;

    const createCollection = async (name: string, input: Record<string, unknown> = {}) =>
      (
        await adminClient.query(CREATE_COLLECTION, {
          input: { translations: [{ languageCode: 'en', name, slug: name, description: '' }], filters: [], ...input },
        })
      ).createCollection.id as string;
    /** The entries under a collection (its contents and their batch heads), oldest first. */
    const under = (collectionId: string) =>
      entriesWhere(server.app, { parentType: 'Collection', parentId: decode(collectionId) });
    const product = async (name: string, facetValueIds: string[]) => {
      const id = await createProduct({
        translations: [{ languageCode: 'en', name, slug: name, description: '' }],
        facetValueIds,
      });
      await createVariants(id, [{ sku: name.toUpperCase(), price: 100 }]);
      return id;
    };

    beforeAll(async () => {
      const { createFacet } = await adminClient.query(CREATE_FACET, {
        input: {
          code: 'pg-colour',
          isPrivate: false,
          translations: [{ languageCode: 'en', name: 'Colour' }],
          values: [
            { code: 'pg-red', translations: [{ languageCode: 'en', name: 'Red' }] },
            { code: 'pg-blue', translations: [{ languageCode: 'en', name: 'Blue' }] },
          ],
        },
      });
      const values = createFacet.values as Array<{ id: string; code: string }>;
      red = values.find((v) => v.code === 'pg-red')!.id;
      blue = values.find((v) => v.code === 'pg-blue')!.id;
      redProduct = await product('pg-red-shirt', [red]);
      blueProduct = await product('pg-blue-shirt', [blue]);
      await settleJobs(adminClient);
    });

    it('records exactly the changed fields of a collection, its filters labelled', async () => {
      const id = await createCollection('pg-sale', { filters: facetFilter([red]), customFields: { banner: 'A' } });
      await adminClient.query(UPDATE_COLLECTION, {
        input: {
          id,
          isPrivate: true,
          filters: facetFilter([red, blue]),
          translations: [{ languageCode: 'en', name: 'PG Sale' }],
          customFields: { banner: 'B' },
        },
      });

      const entry = await lastOf('Collection', id);
      expect(entry).toMatchObject({
        action: 'updated',
        entityLabel: 'PG Sale',
        parentType: null,
        summary: '4 fields: customFields.banner, filters, isPrivate, name.en',
      });
      const filter = (ids: string[]) => [
        {
          code: 'facet-value-filter',
          args: [
            { name: 'facetValueIds', value: JSON.stringify(ids.map((v) => Number(decode(v)))) },
            { name: 'containsAny', value: 'true' },
          ],
        },
      ];
      expect(entry?.changes).toEqual({
        'name.en': { kind: 'text', from: 'pg-sale', to: 'PG Sale' },
        isPrivate: { kind: 'bool', from: false, to: true },
        'customFields.banner': { kind: 'text', from: 'A', to: 'B' },
        filters: {
          kind: 'json',
          from: filter([red]),
          to: filter([red, blue]),
          labels: { [decode(red)]: 'Colour: Red', [decode(blue)]: 'Colour: Blue' },
        },
      });
      await settleJobs(adminClient);
    });

    it('records a move: the parent and the position before and after, nothing else', async () => {
      const from = await createCollection('pg-from');
      const to = await createCollection('pg-to');
      await createCollection('pg-first', { parentId: from });
      const moved = await createCollection('pg-moved', { parentId: from });
      await createCollection('pg-sibling', { parentId: to });
      await adminClient.query(MOVE_COLLECTION, { input: { collectionId: moved, parentId: to, index: 0 } });

      const entry = await lastOf('Collection', moved);
      expect(entry).toMatchObject({
        action: 'moved',
        summary: '2 fields: parent, position',
        parentType: 'Collection',
        parentId: decode(to),
      });
      expect(entry?.changes?.parent).toEqual({
        kind: 'ref',
        from: decode(from),
        to: decode(to),
        labels: { [decode(from)]: 'pg-from', [decode(to)]: 'pg-to' },
      });
      expect(entry?.changes?.position.from).not.toEqual(entry?.changes?.position.to);
    });

    it('records products entering and leaving through a filter change, also first after the boot snapshot (R2-3)', async () => {
      const id = await createCollection('pg-reds', { filters: facetFilter([red]) });
      await settleJobs(adminClient);
      const [head, added] = await waitFor(
        () => under(id),
        (entries) => entries.length >= 2,
      );
      expect(head).toMatchObject({ entityType: 'Batch', summary: '+1 / −0', source: 'collection_rules' });
      expect(added).toMatchObject({ entityId: decode(redProduct), action: 'collection_added', batchId: head.batchId });

      // As after a deploy: no snapshot of this collection until the boot records its contents.
      await collections().seedMissing();
      await members().delete({ collectionId: decode(id) });
      expect(await collections().seedMissing()).toBe(1);

      await adminClient.query(UPDATE_COLLECTION, { input: { id, filters: facetFilter([blue]) } });
      await settleJobs(adminClient);
      const entries = await waitFor(
        () => under(id),
        (all) => all.length >= 5,
      );
      expect(entries.slice(2).map((e) => [e.entityType, e.action, e.entityId, e.actorType, e.source])).toEqual([
        ['Batch', 'batch', expect.any(String), 'system', 'collection_rules'],
        ['Product', 'collection_added', decode(blueProduct), 'system', 'collection_rules'],
        ['Product', 'collection_removed', decode(redProduct), 'system', 'collection_rules'],
      ]);
      expect(entries[2]).toMatchObject({
        summary: '+1 / −1',
        meta: expect.objectContaining({ counts: { added: 1, removed: 1 } }),
      });
      // On the product's own history too.
      expect((await entriesOf('Product', blueProduct)).at(-1)).toMatchObject({
        action: 'collection_added',
        parentId: decode(id),
        summary: 'added to pg-reds',
      });
    });

    it('records a deleted collection and its descendants from their committed rows', async () => {
      const parent = await createCollection('pg-parent', { filters: facetFilter([red]) });
      const child = await createCollection('pg-child', { parentId: parent, inheritFilters: false });
      await settleJobs(adminClient);
      await waitFor(
        () => under(parent),
        (entries) => entries.some((e) => e.entityType === 'Batch'),
      );

      await adminClient.query(DELETE_COLLECTION, { id: parent });

      const [own] = await entriesWhere(server.app, {
        entityType: 'Collection',
        entityId: decode(parent),
        action: 'deleted',
      });
      expect(own).toMatchObject({ entityLabel: 'pg-parent', parentType: null, derivedFromId: null, changes: null });
      expect(own.meta).toMatchObject({
        memberCount: 1,
        lastState: expect.objectContaining({ 'name.en': 'pg-parent', 'slug.en': 'pg-parent', isPrivate: false }),
      });
      expect(own.meta).not.toHaveProperty('noBefore');
      const [descendant] = await entriesWhere(server.app, {
        entityType: 'Collection',
        entityId: decode(child),
        action: 'deleted',
      });
      expect(descendant).toMatchObject({
        derivedFromId: own.id,
        parentType: 'Collection',
        parentId: decode(parent),
        meta: expect.objectContaining({
          memberCount: 0,
          lastState: expect.objectContaining({ 'name.en': 'pg-child' }),
        }),
      });
      expect(await members().count({ where: { collectionId: In([decode(parent), decode(child)]) } })).toBe(0);
    });

    it('records a facet update, and a value rename once, on the value', async () => {
      const { createFacet } = await adminClient.query(CREATE_FACET, {
        input: {
          code: 'pg-size',
          isPrivate: false,
          translations: [{ languageCode: 'en', name: 'Size' }],
          values: [{ code: 'pg-m', translations: [{ languageCode: 'en', name: 'M' }] }],
        },
      });
      const facetId = createFacet.id as string;
      const valueId = createFacet.values[0].id as string;
      const user = await product('pg-sized', [valueId]);
      const productEntries = (await entriesOf('Product', user)).length;

      await adminClient.query(UPDATE_FACET, {
        input: { id: facetId, code: 'pg-size-2', translations: [{ languageCode: 'en', name: 'Fit' }] },
      });
      await adminClient.query(UPDATE_FACET_VALUES, {
        input: [{ id: valueId, translations: [{ languageCode: 'en', name: 'Medium' }] }],
      });

      expect((await lastOf('Facet', facetId))?.changes).toEqual({
        code: { kind: 'text', from: 'pg-size', to: 'pg-size-2' },
        'name.en': { kind: 'text', from: 'Size', to: 'Fit' },
      });
      expect(await lastOf('FacetValue', valueId)).toMatchObject({
        action: 'updated',
        entityLabel: 'Fit: Medium',
        parentType: 'Facet',
        parentId: decode(facetId),
        changes: { 'name.en': { kind: 'text', from: 'M', to: 'Medium' } },
      });
      expect(await entriesOf('Product', user)).toHaveLength(productEntries);
      await settleJobs(adminClient);
    });

    it('records a force-deleted facet with its values derived from it, and how many products used them', async () => {
      const { createFacet } = await adminClient.query(CREATE_FACET, {
        input: {
          code: 'pg-material',
          isPrivate: false,
          translations: [{ languageCode: 'en', name: 'Material' }],
          values: [
            { code: 'pg-wool', translations: [{ languageCode: 'en', name: 'Wool' }] },
            { code: 'pg-silk', translations: [{ languageCode: 'en', name: 'Silk' }] },
          ],
        },
      });
      const values = createFacet.values as Array<{ id: string; code: string }>;
      const wool = values.find((v) => v.code === 'pg-wool')!.id;
      const silk = values.find((v) => v.code === 'pg-silk')!.id;
      await product('pg-woollen', [wool]);
      await adminClient.query(DELETE_FACET_VALUES, { ids: [silk], force: true });
      await adminClient.query(DELETE_FACET, { id: createFacet.id, force: true });

      expect(await lastOf('FacetValue', silk)).toMatchObject({
        action: 'deleted',
        derivedFromId: null,
        meta: expect.objectContaining({ usedByProducts: 0, usedByVariants: 0 }),
      });
      const facet = await lastOf('Facet', createFacet.id);
      expect(facet).toMatchObject({
        action: 'deleted',
        meta: expect.objectContaining({ lastState: expect.objectContaining({ code: 'pg-material' }) }),
      });
      expect(await lastOf('FacetValue', wool)).toMatchObject({
        action: 'deleted',
        entityLabel: 'Material: Wool',
        derivedFromId: facet?.id,
        meta: expect.objectContaining({
          usedByProducts: 1,
          usedByVariants: 0,
          lastState: expect.objectContaining({ code: 'pg-wool', 'name.en': 'Wool' }),
        }),
      });
      await settleJobs(adminClient);
    });

    it('records the changed name, tags and focal point of an asset, and its last state when deleted', async () => {
      const { createAssets } = await adminClient.fileUploadMutation({
        mutation: CREATE_ASSETS,
        filePaths: [pngFile('pg-pixel')],
        mapVariables: () => ({ input: [{ file: null, tags: ['hero'] }] }),
      });
      const id = createAssets[0].id as string;
      await adminClient.query(UPDATE_ASSET, {
        input: { id, name: 'Banner', tags: ['hero', 'sale'], focalPoint: { x: 0.5, y: 0.25 } },
      });
      await adminClient.query(UPDATE_ASSET, { input: { id, name: 'Banner' } });
      await adminClient.query(DELETE_ASSET, { input: { assetId: id, force: true } });

      const entries = await entriesOf('Asset', id);
      expect(entries.map((e) => e.action)).toEqual(['created', 'updated', 'deleted']);
      expect(entries[1].changes).toEqual({
        'name.en': { kind: 'text', from: 'change-history-pg-pixel.png', to: 'Banner' },
        tags: { kind: 'refs', added: ['sale'], removed: [] },
        focalPoint: { kind: 'json', from: null, to: { x: 0.5, y: 0.25 } },
      });
      expect(entries[2].meta).toMatchObject({
        lastState: expect.objectContaining({ 'name.en': 'Banner', tags: ['hero', 'sale'], mimeType: 'image/png' }),
      });
      expect(entries[2].meta).not.toHaveProperty('noBefore');
    });

    it("records a promotion's conditions and actions before and after, without the priority score", async () => {
      const minimum = (amount: number) => ({
        code: 'minimum_order_amount',
        arguments: [
          { name: 'amount', value: String(amount) },
          { name: 'taxInclusive', value: 'false' },
        ],
      });
      const discount = { code: 'order_percentage_discount', arguments: [{ name: 'discount', value: '10' }] };
      const { createPromotion } = await adminClient.query(CREATE_PROMOTION, {
        input: {
          enabled: true,
          couponCode: 'PG-10',
          conditions: [minimum(1000)],
          actions: [discount],
          translations: [{ languageCode: 'en', name: 'Ten off', description: '' }],
        },
      });
      const id = createPromotion.id as string;
      await adminClient.query(UPDATE_PROMOTION, {
        input: {
          id,
          enabled: false,
          usageLimit: 5,
          endsAt: '2027-01-01T00:00:00.000Z',
          conditions: [
            minimum(2000),
            {
              code: 'at_least_n_with_facets',
              arguments: [
                { name: 'minimum', value: '1' },
                { name: 'facets', value: JSON.stringify([red]) },
              ],
            },
          ],
          actions: [discount],
        },
      });
      await adminClient.query(DELETE_PROMOTION, { id });

      const [created, updated, deleted] = await entriesOf('Promotion', id);
      expect(created).toMatchObject({ action: 'created', entityLabel: 'Ten off' });
      expect(updated.summary).toBe('4 fields: conditions, enabled, endsAt, usageLimit');
      expect(updated.changes).toEqual({
        enabled: { kind: 'bool', from: true, to: false },
        usageLimit: { kind: 'text', from: null, to: 5 },
        endsAt: { kind: 'date', from: null, to: '2027-01-01T00:00:00.000Z' },
        conditions: {
          kind: 'json',
          from: [
            {
              code: 'minimum_order_amount',
              args: [
                { name: 'amount', value: '1000' },
                { name: 'taxInclusive', value: 'false' },
              ],
            },
          ],
          to: [
            {
              code: 'minimum_order_amount',
              args: [
                { name: 'amount', value: '2000' },
                { name: 'taxInclusive', value: 'false' },
              ],
            },
            {
              code: 'at_least_n_with_facets',
              args: [
                { name: 'minimum', value: '1' },
                { name: 'facets', value: JSON.stringify([Number(decode(red))]) },
              ],
            },
          ],
          labels: { [decode(red)]: 'Colour: Red' },
        },
      });
      expect(deleted).toMatchObject({
        action: 'deleted',
        meta: expect.objectContaining({ lastState: expect.objectContaining({ couponCode: 'PG-10', enabled: false }) }),
      });
    });

    it('captures a collection a host changed with a raw write, in its transaction', async () => {
      const id = await createCollection('pg-raw');
      const ctx = await superadminCtx(server.app);
      await connection().withTransaction(ctx, async (tctx) => {
        await connection().getRepository(tctx, Collection).update(decode(id), { isPrivate: true });
        await history().capture(tctx, 'Collection', [decode(id)], { action: 'visibility_set' });
      });
      expect(await lastOf('Collection', id)).toMatchObject({
        action: 'visibility_set',
        changes: { isPrivate: { kind: 'bool', from: false, to: true } },
      });
    });

    /**
     * Core publishes these events inside `Promise.all`: the blocking handlers start concurrently on one
     * transaction. Two savepoints opened at once used to abort the host's transaction.
     */
    describe('handlers core runs concurrently on one transaction', () => {
      let channelId: string;
      const uploadAssets = async (names: string[]) =>
        (
          (
            await adminClient.fileUploadMutation({
              mutation: CREATE_ASSETS,
              filePaths: names.map((name) => pngFile(name)),
              mapVariables: () => ({ input: names.map(() => ({ file: null })) }),
            })
          ).createAssets as Array<{ id: string }>
        ).map((asset) => asset.id);

      beforeAll(async () => {
        const { activeChannel } = await adminClient.query(ACTIVE_CHANNEL_ZONES);
        const { createChannel } = await adminClient.query(CREATE_CHANNEL, {
          input: {
            code: 'pg-concurrent',
            token: 'pg-concurrent-token',
            defaultLanguageCode: 'en',
            pricesIncludeTax: false,
            defaultCurrencyCode: 'USD',
            defaultShippingZoneId: activeChannel.defaultShippingZone.id,
            defaultTaxZoneId: activeChannel.defaultTaxZone.id,
          },
        });
        channelId = createChannel.id;
      });

      it('deletes three assets in one call and records each deletion', async () => {
        const ids = await uploadAssets(['pg-trio-1', 'pg-trio-2', 'pg-trio-3']);
        const { deleteAssets } = await adminClient.query(DELETE_ASSETS, { input: { assetIds: ids, force: true } });

        expect(deleteAssets.result).toBe('DELETED');
        expect(
          await connection()
            .rawConnection.getRepository(Asset)
            .count({ where: { id: In(ids.map(decode)) } }),
        ).toBe(0);
        for (const id of ids) {
          expect((await entriesOf('Asset', id)).map((entry) => entry.action)).toEqual(['created', 'deleted']);
        }
      });

      it('assigns several assets to a channel in one call and records each assignment', async () => {
        const ids = await uploadAssets(['pg-assign-1', 'pg-assign-2', 'pg-assign-3']);
        const { assignAssetsToChannel } = await adminClient.query(ASSIGN_ASSETS_TO_CHANNEL, {
          input: { assetIds: ids, channelId },
        });

        expect(assignAssetsToChannel).toHaveLength(3);
        for (const id of ids) {
          expect(await lastOf('Asset', id)).toMatchObject({
            action: 'channel_assigned',
            summary: 'assigned to channel pg-concurrent',
            meta: expect.objectContaining({ channelId: decode(channelId) }),
          });
        }
      });

      it('removes two collections from a channel in one call and records both contents changes', async () => {
        const ids = [
          await createCollection('pg-concurrent-a', { filters: facetFilter([red]) }),
          await createCollection('pg-concurrent-b', { filters: facetFilter([red]) }),
        ];
        await settleJobs(adminClient);
        await adminClient.query(ASSIGN_COLLECTIONS_TO_CHANNEL, { input: { collectionIds: ids, channelId } });
        await settleJobs(adminClient);
        // Out of date on purpose: each removal's membership event then writes a rules batch in its savepoint.
        await members().update({ collectionId: In(ids.map(decode)) }, { productIds: [] });
        const before = await Promise.all(ids.map((id) => under(id)));

        const { removeCollectionsFromChannel } = await adminClient.query(REMOVE_COLLECTIONS_FROM_CHANNEL, {
          input: { collectionIds: ids, channelId },
        });

        expect(removeCollectionsFromChannel).toHaveLength(2);
        for (const [index, id] of ids.entries()) {
          const written = (await under(id)).slice(before[index].length);
          expect(written.map((entry) => entry.entityType)).toContain('Batch');
          expect(written).toContainEqual(
            expect.objectContaining({
              entityType: 'Product',
              entityId: decode(redProduct),
              action: 'collection_added',
            }),
          );
        }
        await settleJobs(adminClient);
      });
    });
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

  retentionScenarios({ app: () => server.app, adminClient, archive, archiveDir });
  apiScenarios({ app: () => server.app, adminClient, postgres: true });
});
