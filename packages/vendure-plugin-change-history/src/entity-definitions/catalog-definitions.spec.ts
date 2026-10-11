import {
  Asset,
  Channel,
  CustomFieldConfig,
  FacetValue,
  Product,
  ProductVariant,
  RequestContext,
  TaxCategory,
} from '@vendure/core';
import type { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { resolveOptions } from '../options';
import { ChangeHistoryFieldChanges, ChangeHistoryFieldExtractor, ChangeHistoryPluginOptions } from '../types';
import { productDefinition, productVariantDefinition } from './catalog-definitions';
import { BASE_GROUP } from './entity-definition';

const ctx = { languageCode: 'uk', channel: { defaultLanguageCode: 'en' } } as unknown as RequestContext;

const product = {
  id: 3,
  enabled: true,
  featuredAssetId: 55,
  deletedAt: null,
  translations: [
    { languageCode: 'en', name: 'Shirt', slug: 'shirt', description: '<p>Soft</p>', customFields: { seoTitle: 'Buy' } },
    { languageCode: 'uk', name: 'Сорочка', slug: 'sorochka', description: '', customFields: { seoTitle: null } },
  ],
  facetValues: [{ id: 12 }, { id: 7 }],
  assets: [
    { assetId: 56, position: 1 },
    { assetId: 55, position: 0 },
  ],
  optionGroups: [],
  customFields: { subtitle: 'Cotton', isOutStock: true, viewCount: 9, color: { id: 4 } },
};

const variant = {
  id: 21,
  productId: 3,
  sku: 'SH-1',
  enabled: true,
  taxCategoryId: 1,
  trackInventory: 'INHERIT',
  outOfStockThreshold: 0,
  useGlobalOutOfStockThreshold: true,
  featuredAssetId: null,
  deletedAt: new Date(),
  translations: [{ languageCode: 'en', name: 'Shirt S' }],
  productVariantPrices: [
    { channelId: 2, currencyCode: 'USD', price: 10 },
    { channelId: 1, currencyCode: 'UAH', price: 400 },
    { channelId: 1, currencyCode: 'EUR', price: 9 },
  ],
  options: [{ id: 30 }],
  facetValues: [],
  assets: [],
  customFields: {},
};

const productFields = [
  { name: 'subtitle', type: 'string' },
  { name: 'seoTitle', type: 'localeString' },
  { name: 'isOutStock', type: 'boolean' },
  { name: 'viewCount', type: 'int', readonly: true },
  { name: 'color', type: 'relation', entity: FacetValue },
] as unknown as CustomFieldConfig[];

/** A manager whose repositories return the fixture rows and record what was asked. */
function fakeManager(rowsByEntity: Map<unknown, Array<Record<string, unknown>>>) {
  const finds: Array<{ entity: unknown; relations: string[] }> = [];
  const manager = {
    getRepository: (entity: unknown) => ({
      find: vi.fn(async (options: { relations: string[] }) => {
        finds.push({ entity, relations: options.relations });
        return structuredClone(rowsByEntity.get(entity) ?? []);
      }),
    }),
    connection: {
      getMetadata: () => ({
        relations: [{ propertyName: 'translations' }],
        findRelationWithPropertyPath: () => ({
          inverseEntityMetadata: { relations: [{ propertyName: 'translations' }] },
        }),
      }),
    },
  } as unknown as EntityManager;
  return { manager, finds };
}

const options = (extra: Partial<ChangeHistoryPluginOptions> = {}) =>
  resolveOptions({ retention: { archive: 'none' }, ...extra });

describe('the Product definition', () => {
  const extractor: ChangeHistoryFieldExtractor = {
    entityType: 'Product',
    key: 'sortOrder',
    kind: 'json',
    inputKeys: ['sortOrder'],
    load: vi.fn(async () => new Map([['3', { main: 4 }]])),
    labels: vi.fn(async () => ({ '4': 'Main' })),
  };
  const definition = productDefinition(
    options({
      fieldExtractors: [extractor],
      entities: {
        Product: { ignoreFields: ['customFields.isOutStock'], fieldKinds: { 'customFields.subtitle': 'richtext' } },
      },
    }),
    { Product: productFields },
  );

  it('normalises a row into the flat history view', async () => {
    const { manager } = fakeManager(new Map([[Product, [product]]]));
    const state = (await definition.load(ctx, [3], manager, definition.fullScope)).get('3');

    expect(state).toEqual({
      values: {
        enabled: true,
        featuredAsset: '55',
        'name.en': 'Shirt',
        'slug.en': 'shirt',
        'description.en': '<p>Soft</p>',
        'customFields.seoTitle.en': 'Buy',
        'name.uk': 'Сорочка',
        'slug.uk': 'sorochka',
        'description.uk': '',
        'customFields.seoTitle.uk': null,
        'customFields.subtitle': 'Cotton',
        'customFields.color': '4',
        facetValues: ['7', '12'],
        assets: ['55', '56'],
        optionGroups: [],
        sortOrder: { main: 4 },
      },
      groups: definition.fullScope,
      label: 'Сорочка',
      parentId: undefined,
      deleted: false,
    });
  });

  it('loads only the groups an update input could change, one relation per query', async () => {
    const { manager, finds } = fakeManager(new Map([[Product, [product]]]));
    const scope = definition.scopeFor({ id: 3, translations: [], facetValueIds: ['7'] });
    expect([...scope]).toEqual([BASE_GROUP, 'facetValues']);

    const state = (await definition.load(ctx, [3], manager, scope)).get('3');
    expect(finds.map((f) => f.relations)).toEqual([['translations'], ['facetValues']]);
    expect(state?.values).not.toHaveProperty('assets');
    expect(state?.values).not.toHaveProperty('customFields.color');
    expect(state?.values).not.toHaveProperty('sortOrder');

    expect([...definition.scopeFor({ customFields: {}, sortOrder: 1 })]).toEqual([
      BASE_GROUP,
      'relations',
      'extractor:sortOrder',
    ]);
    expect(definition.scopeFor(3)).toEqual(definition.fullScope);
  });

  it('knows the kind and group of every key', () => {
    expect(definition.kindOf('description.uk')).toBe('richtext');
    expect(definition.kindOf('customFields.seoTitle.en')).toBe('text');
    expect(definition.kindOf('customFields.subtitle')).toBe('richtext');
    expect(definition.kindOf('customFields.color')).toBe('ref');
    expect(definition.kindOf('facetValues')).toBe('refs');
    expect(definition.kindOf('assets')).toBe('assets');
    expect(definition.kindOf('sortOrder')).toBe('json');
    expect(definition.groupOf('customFields.color')).toBe('relations');
    expect(definition.groupOf('sortOrder')).toBe('extractor:sortOrder');
    expect(definition.groupOf('name.en')).toBe(BASE_GROUP);
  });

  it('labels the changed references only', async () => {
    const { manager, finds } = fakeManager(
      new Map<unknown, Array<Record<string, unknown>>>([
        [
          FacetValue,
          [
            {
              id: 12,
              translations: [{ languageCode: 'en', name: 'Black' }],
              facet: { id: 1, translations: [{ languageCode: 'uk', name: 'Колір' }] },
            },
          ],
        ],
        [Asset, [{ id: 55, name: 'front.jpg' }]],
      ]),
    );
    const changes: ChangeHistoryFieldChanges = {
      facetValues: { kind: 'refs', added: ['12'], removed: [] },
      featuredAsset: { kind: 'ref', from: null, to: '55' },
      sortOrder: { kind: 'json', from: null, to: { main: 4 } },
      enabled: { kind: 'bool', from: true, to: false },
      assets: { kind: 'assets', from: [], to: [], added: [], removed: [] },
    };
    await definition.addLabels(ctx, manager, changes);

    expect(changes.facetValues.labels).toEqual({ '12': 'Колір: Black' });
    expect(changes.featuredAsset.labels).toEqual({ '55': 'front.jpg' });
    expect(changes.sortOrder.labels).toEqual({ '4': 'Main' });
    expect(changes.enabled.labels).toBeUndefined();
    expect(finds.map((f) => f.relations)).toEqual([['translations', 'facet', 'facet.translations'], ['translations']]);
  });

  it("uses the host's label, falling back to the name when it fails", async () => {
    const { manager } = fakeManager(new Map([[Product, [product]]]));
    const labelled = (label: () => string) =>
      productDefinition(options({ entities: { Product: { label } } }), {}).load(
        ctx,
        [3],
        manager,
        new Set([BASE_GROUP]),
      );

    expect((await labelled(() => 'Custom')).get('3')?.label).toBe('Custom');
    const failing = await labelled(() => {
      throw new Error('boom');
    });
    expect(failing.get('3')?.label).toBe('Сорочка');
  });

  it('loads nothing for no ids', async () => {
    const { manager, finds } = fakeManager(new Map());
    expect((await definition.load(ctx, [], manager, definition.fullScope)).size).toBe(0);
    expect(finds).toEqual([]);
  });
});

describe('the ProductVariant definition', () => {
  const definition = productVariantDefinition(options(), {});

  it('normalises prices, settings and options, under the product', async () => {
    const { manager } = fakeManager(new Map([[ProductVariant, [variant]]]));
    const state = (await definition.load(ctx, [21], manager, definition.fullScope)).get('21');

    expect(state).toMatchObject({
      label: 'Shirt S (SH-1)',
      parentId: '3',
      deleted: true,
      values: {
        sku: 'SH-1',
        taxCategory: '1',
        trackInventory: 'INHERIT',
        outOfStockThreshold: 0,
        useGlobalOutOfStockThreshold: true,
        featuredAsset: null,
        options: ['30'],
        prices: [
          { channelId: '1', currencyCode: 'EUR', price: 9 },
          { channelId: '1', currencyCode: 'UAH', price: 400 },
          { channelId: '2', currencyCode: 'USD', price: 10 },
        ],
      },
    });
    expect([
      ...definition.scopeFor([
        { id: 21, price: 5 },
        { id: 22, optionIds: [] },
      ]),
    ]).toEqual([BASE_GROUP, 'prices', 'options']);
    expect(definition.parentType).toBe('Product');
  });

  it('labels prices with channel codes and the tax category by name', async () => {
    const { manager } = fakeManager(
      new Map<unknown, Array<Record<string, unknown>>>([
        [Channel, [{ id: 1, code: '__default_channel__' }]],
        [TaxCategory, [{ id: 1, name: 'Standard' }]],
      ]),
    );
    const changes: ChangeHistoryFieldChanges = {
      prices: { kind: 'prices', from: [{ channelId: '1', currencyCode: 'UAH', price: 1 }], to: null },
      taxCategory: { kind: 'ref', from: '1', to: '2' },
    };
    await definition.addLabels(ctx, manager, changes);
    expect(changes.prices.labels).toEqual({ '1': '__default_channel__' });
    expect(changes.taxCategory.labels).toEqual({ '1': 'Standard' });
  });

  it('labels a variant without a translation by its id', async () => {
    const { manager } = fakeManager(new Map([[ProductVariant, [{ ...variant, sku: '', translations: [] }]]]));
    expect((await definition.load(ctx, [21], manager, new Set([BASE_GROUP]))).get('21')?.label).toBe('Variant 21');
  });
});
