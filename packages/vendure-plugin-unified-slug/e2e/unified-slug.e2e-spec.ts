import path from 'path';
import { CollectionTranslation, LanguageCode, mergeConfig, TransactionalConnection } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SlugGenerationService, UnifiedSlugPlugin } from '../src';
import { initialData } from './fixtures/initial-data';
import {
  ACTIVE_CHANNEL_ZONES,
  CREATE_CHANNEL,
  CREATE_COLLECTION,
  CREATE_PRODUCT,
  SLUG_FOR_ENTITY,
  slugsByLanguage,
  type TranslationRow,
  UNIFIED_SLUG_GENERATE,
  UNIFIED_SLUG_SETTINGS,
  UPDATE_COLLECTION,
  UPDATE_GLOBAL_LANGUAGES,
  UPDATE_PRODUCT,
  UPDATE_PRODUCTS,
} from './graphql';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__sqlite-data__')));

interface EntityResult {
  id: string;
  enabled?: boolean;
  translations: TranslationRow[];
}

/** Every mutation goes through the real Admin API: this is what proves Nest runs the interceptor. */
describe('UnifiedSlugPlugin', () => {
  const { server, adminClient } = createTestEnvironment(
    mergeConfig(testConfig, {
      // Its own port: vitest runs every e2e file of the repo in parallel.
      apiOptions: { port: 3052 },
      plugins: [UnifiedSlugPlugin.init()],
    }),
  );

  beforeAll(async () => {
    await server.init({ initialData, customerCount: 0 });
    await adminClient.asSuperAdmin();
  }, 120_000);

  afterAll(async () => {
    await server.destroy();
  });

  const createProduct = async (translations: object[]) =>
    (await adminClient.query<{ createProduct: EntityResult }>(CREATE_PRODUCT, { input: { translations } }))
      .createProduct;
  const updateProduct = async (input: object) =>
    (await adminClient.query<{ updateProduct: EntityResult }>(UPDATE_PRODUCT, { input })).updateProduct;
  const createCollection = async (translations: object[]) =>
    (
      await adminClient.query<{ createCollection: EntityResult }>(CREATE_COLLECTION, {
        input: { filters: [], translations },
      })
    ).createCollection;
  const generate = async (input: object) =>
    (await adminClient.query<{ unifiedSlugGenerate: string }>(UNIFIED_SLUG_GENERATE, { input })).unifiedSlugGenerate;

  describe('writes', () => {
    it('gives an empty translation slug the slug of the channel default language on create', async () => {
      const product = await createProduct([
        { languageCode: 'uk', name: 'Літня сукня', slug: '', description: '' },
        { languageCode: 'en', name: 'Summer dress', slug: 'summer-dress', description: '' },
      ]);

      expect(slugsByLanguage(product.translations)).toEqual({ en: 'summer-dress', uk: 'summer-dress' });
    });

    it('gives a language added on update the existing slug — the gap the core dashboard field leaves', async () => {
      const { id } = await createProduct([
        { languageCode: 'en', name: 'Linen shirt', slug: 'linen-shirt', description: '' },
      ]);

      const product = await updateProduct({
        id,
        translations: [{ languageCode: 'pl', name: 'Lniana koszula', description: '' }],
      });

      expect(slugsByLanguage(product.translations)).toEqual({ en: 'linen-shirt', pl: 'linen-shirt' });
      expect(product.translations.find((t) => t.languageCode === 'en')?.name).toBe('Linen shirt');
    });

    it('does the same for a collection', async () => {
      const { id } = await createCollection([
        { languageCode: 'en', name: 'Accessories', slug: 'accessories', description: '' },
      ]);

      const { updateCollection } = await adminClient.query<{ updateCollection: EntityResult }>(UPDATE_COLLECTION, {
        input: { id, translations: [{ languageCode: 'pl', name: 'Akcesoria', description: '' }] },
      });

      expect(slugsByLanguage(updateCollection.translations)).toEqual({ en: 'accessories', pl: 'accessories' });
    });

    it('moves every language to a slug sent for any one of them', async () => {
      const { id } = await createProduct([
        { languageCode: 'en', name: 'Wool coat', slug: 'wool-coat', description: '' },
        { languageCode: 'uk', name: 'Вовняне пальто', slug: 'wool-coat', description: '' },
      ]);

      const product = await updateProduct({ id, translations: [{ languageCode: 'uk', slug: 'coat' }] });

      expect(slugsByLanguage(product.translations)).toEqual({ en: 'coat', uk: 'coat' });
      expect(product.translations.find((t) => t.languageCode === 'en')?.name).toBe('Wool coat');
    });

    it('overrides a divergent slug with the channel default language’s', async () => {
      const product = await createProduct([
        { languageCode: 'uk', name: 'Шарф', slug: 'sharf', description: '' },
        { languageCode: 'en', name: 'Scarf', slug: 'scarf', description: '' },
      ]);

      expect(slugsByLanguage(product.translations)).toEqual({ en: 'scarf', uk: 'scarf' });
    });

    it('takes the first non-empty slug when the default language sent none', async () => {
      const collection = await createCollection([
        { languageCode: 'en', name: 'Dresses', slug: '', description: '' },
        { languageCode: 'uk', name: 'Сукні', slug: 'dresses', description: '' },
      ]);

      expect(slugsByLanguage(collection.translations)).toEqual({ en: 'dresses', uk: 'dresses' });
    });

    it('self-heals rows that drifted apart on an update that sends no translations', async () => {
      const { id } = await createCollection([
        { languageCode: 'en', name: 'Knitwear', slug: 'knitwear', description: '' },
        { languageCode: 'uk', name: 'Трикотаж', slug: 'knitwear', description: '' },
      ]);
      // Only possible behind the plugin's back — through the API it would have been unified.
      await server.app
        .get(TransactionalConnection)
        .rawConnection.getRepository(CollectionTranslation)
        .update({ base: { id }, languageCode: LanguageCode.uk }, { slug: 'knitwear-2' });

      const { updateCollection } = await adminClient.query<{ updateCollection: EntityResult }>(UPDATE_COLLECTION, {
        input: { id, translations: [] },
      });

      expect(slugsByLanguage(updateCollection.translations)).toEqual({ en: 'knitwear', uk: 'knitwear' });
      expect(updateCollection.translations.find((t) => t.languageCode === 'uk')?.name).toBe('Трикотаж');
    });

    // Each product only renames languages it already has. Core runs the elements of `updateProducts`
    // in parallel, and adding a new language to two products in one call mixes their translation
    // rows up even without this plugin (Vendure 3.7.2, sql.js) — that is not what is under test.
    it('unifies every product of an `updateProducts` bulk update against its own rows', async () => {
      const a = await createProduct([
        { languageCode: 'en', name: 'Belt', slug: 'belt', description: '' },
        { languageCode: 'uk', name: 'Ремінь', slug: 'belt', description: '' },
      ]);
      const b = await createProduct([
        { languageCode: 'en', name: 'Cap', slug: 'cap', description: '' },
        { languageCode: 'uk', name: 'Кепка', slug: 'cap', description: '' },
      ]);

      const { updateProducts } = await adminClient.query<{ updateProducts: EntityResult[] }>(UPDATE_PRODUCTS, {
        input: [
          { id: a.id, translations: [{ languageCode: 'uk', slug: 'strap' }] },
          { id: b.id, translations: [{ languageCode: 'en', slug: 'hat' }] },
        ],
      });

      expect(updateProducts.map((p) => slugsByLanguage(p.translations))).toEqual([
        { en: 'strap', uk: 'strap' },
        { en: 'hat', uk: 'hat' },
      ]);
    });

    it('leaves translations alone on an update that does not touch them', async () => {
      const { id } = await createProduct([
        { languageCode: 'en', name: 'Gloves', slug: 'gloves', description: '' },
        { languageCode: 'uk', name: 'Рукавички', slug: 'gloves', description: '' },
      ]);

      const product = await updateProduct({ id, enabled: false });

      expect(product.enabled).toBe(false);
      expect(slugsByLanguage(product.translations)).toEqual({ en: 'gloves', uk: 'gloves' });
    });

    it('prefers the default language of the channel the request runs in', async () => {
      // A channel can only default to a language that is enabled globally.
      await adminClient.query(UPDATE_GLOBAL_LANGUAGES, { languages: [LanguageCode.en, LanguageCode.uk] });
      const { activeChannel } = await adminClient.query<{
        activeChannel: { defaultShippingZone: { id: string }; defaultTaxZone: { id: string } };
      }>(ACTIVE_CHANNEL_ZONES);
      const { createChannel } = await adminClient.query<{ createChannel: { token: string } }>(CREATE_CHANNEL, {
        input: {
          code: 'uk-channel',
          token: 'uk-channel-token',
          defaultLanguageCode: LanguageCode.uk,
          availableLanguageCodes: [LanguageCode.uk, LanguageCode.en],
          currencyCode: 'UAH',
          pricesIncludeTax: true,
          defaultShippingZoneId: activeChannel.defaultShippingZone.id,
          defaultTaxZoneId: activeChannel.defaultTaxZone.id,
        },
      });
      adminClient.setChannelToken(createChannel.token);

      try {
        const product = await createProduct([
          { languageCode: 'en', name: 'Scarf', slug: 'scarf', description: '' },
          { languageCode: 'uk', name: 'Шарф', slug: 'sharf', description: '' },
        ]);

        expect(slugsByLanguage(product.translations)).toEqual({ en: 'sharf', uk: 'sharf' });
      } finally {
        adminClient.setChannelToken('e2e-default-channel');
      }
    });
  });

  describe('unifiedSlugGenerate', () => {
    it('answers what core’s slugForEntity answers for the same name', async () => {
      const name = 'Café Crème Collection';
      const { slugForEntity } = await adminClient.query<{ slugForEntity: string }>(SLUG_FOR_ENTITY, {
        input: { entityName: 'Collection', fieldName: 'slug', inputValue: name },
      });

      await expect(generate({ entityName: 'Collection', name })).resolves.toBe(slugForEntity);
      expect(slugForEntity).toBe('cafe-creme-collection');
    });

    it('suffixes a slug another product already owns, but not the product’s own', async () => {
      const { id } = await createProduct([{ languageCode: 'en', name: 'Silk tie', slug: 'silk-tie', description: '' }]);

      await expect(generate({ entityName: 'Product', name: 'Silk tie' })).resolves.toBe('silk-tie-1');
      await expect(generate({ entityName: 'Product', name: 'Silk tie', entityId: id })).resolves.toBe('silk-tie');
    });

    it('answers an empty slug for a name that yields none', async () => {
      await expect(generate({ entityName: 'Product', name: '***' })).resolves.toBe('');
    });

    it('refuses an entity it does not unify', async () => {
      await expect(generate({ entityName: 'Facet', name: 'Colour' })).rejects.toThrow(/does not know the entity/);
    });

    it('is the same service other plugins inject', async () => {
      expect(server.app.get(SlugGenerationService)).toBeInstanceOf(SlugGenerationService);
    });
  });

  it('reports no watched form fields for the default strategy', async () => {
    const { unifiedSlugSettings } = await adminClient.query<{ unifiedSlugSettings: { watchFormFields: string[] } }>(
      UNIFIED_SLUG_SETTINGS,
    );

    expect(unifiedSlugSettings.watchFormFields).toEqual([]);
  });
});
