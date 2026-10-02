import path from 'path';
import {
  CollectionTranslation,
  type ID,
  LanguageCode,
  mergeConfig,
  ProductTranslation,
  TransactionalConnection,
} from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSlugBackfill, type BackfillUnifiedSlugsOptions, UnifiedSlugPlugin } from '../src';
import { initialData } from './fixtures/initial-data';
import {
  COLLECTION_SLUGS,
  CREATE_COLLECTION,
  CREATE_PRODUCT,
  DELETE_PRODUCT,
  PRODUCT_SLUGS,
  slugsByLanguage,
  type TranslationRow,
} from './graphql';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__sqlite-data__')));

/** Rows as a pre-plugin database could hold them, seeded behind the plugin's back. */
describe('runSlugBackfill', () => {
  const { server, adminClient } = createTestEnvironment(
    mergeConfig(testConfig, {
      apiOptions: { port: 3054 },
      plugins: [UnifiedSlugPlugin.init()],
    }),
  );

  const ids: Record<string, string> = {};

  const setSlugs = async (
    translationEntity: typeof ProductTranslation | typeof CollectionTranslation,
    id: ID,
    slugs: Record<string, string>,
  ) => {
    const repo = server.app.get(TransactionalConnection).rawConnection.getRepository(translationEntity);
    for (const [languageCode, slug] of Object.entries(slugs)) {
      await repo.update(
        { base: { id: String(id).replace(/^T_/, '') }, languageCode: languageCode as LanguageCode },
        { slug },
      );
    }
  };
  const seedProduct = async (key: string, names: Record<string, string>, slugs: Record<string, string>) => {
    const translations = Object.entries(names).map(([languageCode, name]) => ({
      languageCode,
      name,
      slug: `seed-${key}`,
      description: '',
    }));
    const { createProduct } = await adminClient.query<{ createProduct: { id: string } }>(CREATE_PRODUCT, {
      input: { translations },
    });
    ids[key] = createProduct.id;
    await setSlugs(ProductTranslation, createProduct.id, slugs);
  };
  const productSlugs = async (key: string) =>
    slugsByLanguage(
      (await adminClient.query<{ product: { translations: TranslationRow[] } }>(PRODUCT_SLUGS, { id: ids[key] }))
        .product.translations,
    );
  /** The database id: the Admin API hands out encoded ones (`T_1`). */
  const dbId = (key: string) => ids[key].replace(/^T_/, '');
  let printed: string[] = [];
  const backfill = (options: Omit<BackfillUnifiedSlugsOptions, 'logger'>) => {
    printed = [];
    return runSlugBackfill(server.app, { ...options, logger: (line) => printed.push(line) });
  };

  beforeAll(async () => {
    await server.init({ initialData, customerCount: 0 });
    await adminClient.asSuperAdmin();

    await seedProduct('unified', { en: 'Gloves', uk: 'Рукавички' }, { en: 'gloves', uk: 'gloves' });
    await seedProduct('filled', { en: 'Scarf', uk: 'Шарф' }, { en: 'scarf', uk: '' });
    await seedProduct('rewritten', { en: 'Coat', uk: 'Пальто' }, { en: 'coat', uk: 'palto' });
    await seedProduct('generated', { uk: 'Сорочка', en: 'Linen shirt' }, { en: '', uk: '' });
    await seedProduct('noSlug', { en: '***', uk: '***' }, { en: '', uk: '' });
    // 'belt' in uk stays with `keeper`, so `conflict` cannot take it.
    await seedProduct('conflict', { en: 'Belt', uk: 'Ремінь' }, { en: 'belt', uk: '' });
    await seedProduct('keeper', { uk: 'Пасок' }, { uk: 'belt' });
    // 'cap' in uk belongs to `owner` only until the run rewrites it, so `freed` can take it.
    await seedProduct('freed', { en: 'Cap', uk: 'Кепка' }, { en: 'cap', uk: '' });
    await seedProduct('owner', { en: 'Strap', uk: 'Ремінець' }, { en: 'cap-strap', uk: 'cap' });
    await seedProduct('deleted', { en: 'Old', uk: 'Старе' }, { en: 'old', uk: '' });
    await adminClient.query(DELETE_PRODUCT, { id: ids.deleted });

    const { createCollection } = await adminClient.query<{ createCollection: { id: string } }>(CREATE_COLLECTION, {
      input: {
        filters: [],
        translations: [
          { languageCode: 'en', name: 'Hats', slug: 'hats', description: '' },
          { languageCode: 'uk', name: 'Капелюхи', slug: 'hats', description: '' },
        ],
      },
    });
    ids.collection = createCollection.id;
    await setSlugs(CollectionTranslation, createCollection.id, { uk: '' });
  }, 120_000);

  afterAll(async () => {
    await server.destroy();
  });

  it('dry run: reports every entity off one slug and writes nothing', async () => {
    const report = await backfill({ dryRun: true });

    expect(report).toMatchObject({
      dryRun: true,
      scanned: 10, // 9 live products + 1 collection; the deleted product and the root collection are skipped
      filled: 3,
      rewritten: 2,
      generated: 1,
      conflicts: 1,
      noSlug: 1,
    });
    const byId = Object.fromEntries(report.entries.map((e) => [`${e.entityName}:${String(e.entityId)}`, e]));
    expect(byId[`Product:${dbId('filled')}`]).toMatchObject({ outcome: 'FILLED', slug: 'scarf' });
    expect(byId[`Product:${dbId('rewritten')}`]).toMatchObject({
      outcome: 'REWRITTEN',
      slug: 'coat',
      previousSlugs: [
        { languageCode: 'en', slug: 'coat' },
        { languageCode: 'uk', slug: 'palto' },
      ],
    });
    expect(byId[`Product:${dbId('generated')}`]).toMatchObject({ outcome: 'GENERATED', slug: 'linen-shirt' });
    expect(byId[`Product:${dbId('noSlug')}`]).toMatchObject({ outcome: 'NO_SLUG', slug: null });
    expect(byId[`Product:${dbId('conflict')}`]).toMatchObject({
      outcome: 'CONFLICT',
      slug: 'belt',
      conflictsWith: [dbId('keeper')],
    });
    expect(byId[`Product:${dbId('freed')}`]).toMatchObject({ outcome: 'FILLED', slug: 'cap' });
    expect(byId[`Product:${dbId('owner')}`]).toMatchObject({ outcome: 'REWRITTEN', slug: 'cap-strap' });
    expect(byId[`Collection:${dbId('collection')}`]).toMatchObject({ outcome: 'FILLED', slug: 'hats' });
    expect(byId[`Product:${dbId('unified')}`]).toBeUndefined();

    expect(await productSlugs('rewritten')).toEqual({ en: 'coat', uk: 'palto' });
    expect(await productSlugs('filled')).toEqual({ en: 'scarf', uk: '' });
  });

  it('narrows to one entity and prints one line per entity after the counts', async () => {
    const report = await backfill({ dryRun: true, entityName: 'Product' });

    expect(report).toMatchObject({ scanned: 9, filled: 2 });
    expect(printed).toHaveLength(report.entries.length + 1);
    expect(printed[0]).toMatch(/^Unified slug backfill \(dry run, nothing written\): 9 scanned, 2 filled/);
    expect(printed).toContain(`  Product ${dbId('rewritten')}: REWRITTEN coat (was en=coat uk=palto)`);
  });

  it('apply: unifies every entity it can and leaves conflicts alone', async () => {
    const report = await backfill({ dryRun: false });
    expect(report).toMatchObject({ dryRun: false, filled: 3, rewritten: 2, generated: 1, conflicts: 1 });

    expect(await productSlugs('unified')).toEqual({ en: 'gloves', uk: 'gloves' });
    expect(await productSlugs('filled')).toEqual({ en: 'scarf', uk: 'scarf' });
    expect(await productSlugs('rewritten')).toEqual({ en: 'coat', uk: 'coat' });
    expect(await productSlugs('generated')).toEqual({ en: 'linen-shirt', uk: 'linen-shirt' });
    expect(await productSlugs('noSlug')).toEqual({ en: '', uk: '' });
    expect(await productSlugs('conflict')).toEqual({ en: 'belt', uk: '' });
    expect(await productSlugs('keeper')).toEqual({ uk: 'belt' });
    expect(await productSlugs('freed')).toEqual({ en: 'cap', uk: 'cap' });
    expect(await productSlugs('owner')).toEqual({ en: 'cap-strap', uk: 'cap-strap' });
    const { collection } = await adminClient.query<{ collection: { translations: TranslationRow[] } }>(
      COLLECTION_SLUGS,
      { id: ids.collection },
    );
    expect(slugsByLanguage(collection.translations)).toEqual({ en: 'hats', uk: 'hats' });

    // No two products share a slug in one language.
    const rows = await server.app.get(TransactionalConnection).rawConnection.getRepository(ProductTranslation).find();
    const taken = rows.filter((r) => r.slug).map((r) => `${r.languageCode}:${r.slug}`);
    expect(new Set(taken).size).toBe(taken.length);
  });

  it('is idempotent: a second run finds only what needs a human', async () => {
    const report = await backfill({ dryRun: true });

    expect(report.entries.map((e) => [String(e.entityId), e.outcome])).toEqual([
      [dbId('noSlug'), 'NO_SLUG'],
      [dbId('conflict'), 'CONFLICT'],
    ]);
  });
});
