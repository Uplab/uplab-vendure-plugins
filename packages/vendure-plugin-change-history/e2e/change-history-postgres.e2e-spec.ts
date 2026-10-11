import { Logger, Product, ProductService, TaxCategory, TransactionalConnection, mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, testConfig } from '@vendure/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ChangeHistoryDetail,
  ChangeHistoryEntry,
  ChangeHistoryPlugin,
  ChangeHistoryService,
  CommittedRowBeforeStateStrategy,
  ResolvedActor,
} from '../src';
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
  ADD_OPTION_GROUP,
  CHANGE_HISTORY_ENTRIES,
  CREATE_API_KEY,
  CREATE_OPTION_GROUP,
  CREATE_FACET,
  CREATE_PRODUCT_WITH,
  CREATE_VARIANTS,
  DELETE_PRODUCT,
  DELETE_VARIANT,
  ROLES,
  UPDATE_PRODUCT,
  UPDATE_VARIANTS,
} from './graphql';
import { decode, entriesWhere, superadminCtx, systemCtx } from './helpers';

/**
 * The Postgres suite: everything that needs a real second connection — exact before → after values, no-op
 * suppression, savepoint isolation, handler ordering. Skipped unless CHANGE_HISTORY_E2E_PG_URL points at a
 * database it may reset, e.g. postgres://postgres:postgres@localhost:5432/change_history_e2e (TESTING.md).
 */
const url = process.env.CHANGE_HISTORY_E2E_PG_URL;
const PORT = 3058;

registerInitializer('postgres', new DedicatedPostgresInitializer());

/** Set to make the next history write fail inside a real mutation (its `source` does not fit the column). */
const failNextWrite = { on: false };
const failingResolver = {
  name: 'test-failing-write',
  resolve: (): ResolvedActor | undefined => {
    if (!failNextWrite.on) {
      return undefined;
    }
    failNextWrite.on = false;
    return { actorType: 'system', source: 'x'.repeat(40) };
  },
};

describe.skipIf(!url)('ChangeHistoryPlugin on Postgres', () => {
  const warn = vi.spyOn(Logger, 'warn');
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
    },
    plugins: [
      FanOutTestPlugin,
      ChangeHistoryPlugin.init({
        retention: { archive: 'none' },
        actorResolvers: [failingResolver],
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

      failNextWrite.on = true;
      await updateProduct({ id: productId, translations: [{ languageCode: 'en', name: 'Leather belt' }] });

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('[ChangeHistory] write failed in updated Product: value too long'),
        'ChangeHistory',
        expect.any(String),
      );
      const product = await connection()
        .rawConnection.getRepository(Product)
        .findOneOrFail({ where: { id: decode(productId) }, relations: ['translations'] });
      expect(product.translations[0].name).toBe('Leather belt');
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
        // varchar(32): Postgres rejects the statement, which would abort the whole transaction without a savepoint.
        await history().recordAction(tctx, {
          entityType: 'X'.repeat(40),
          entityId: 1,
          entityLabel: 'Bad',
          action: 'x',
        });
        await history().recordAction(tctx, { entityType: 'Facet', entityId: 1, entityLabel: 'Good', action: 'x' });
      });

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('value too long'),
        'ChangeHistory',
        expect.any(String),
      );
      expect((await entriesWhere(server.app, { entityLabel: 'Good' })).length).toBe(1);
      expect(await entriesWhere(server.app, { entityLabel: 'Bad' })).toEqual([]);
      error.mockRestore();
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
