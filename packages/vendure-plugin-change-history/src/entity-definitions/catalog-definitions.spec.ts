import {
  Asset,
  Channel,
  Collection,
  CustomFieldConfig,
  Facet,
  FacetValue,
  Product,
  ProductVariant,
  Promotion,
  RequestContext,
  TaxCategory,
} from '@vendure/core';
import type { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { resolveOptions } from '../options';
import { ChangeHistoryFieldChanges, ChangeHistoryFieldExtractor, ChangeHistoryPluginOptions } from '../types';
import {
  assetDefinition,
  COLLECTION_POSITION_GROUP,
  collectionDefinition,
  facetDefinition,
  facetValueDefinition,
  facetValueIdsOfOperations,
  productDefinition,
  productVariantDefinition,
  promotionDefinition,
} from './catalog-definitions';
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
      findOne: vi.fn(async () => (rowsByEntity.get(entity) ?? []).find((row) => row.isRoot) ?? null),
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

const facetFilterOf = (value: string) => [
  {
    code: 'facet-value-filter',
    args: [
      { name: 'facetValueIds', value },
      { name: 'containsAny', value: 'true' },
    ],
  },
];

describe('the Collection definition', () => {
  const definition = collectionDefinition(options(), {
    Collection: [{ name: 'banner', type: 'string' }] as unknown as CustomFieldConfig[],
  });
  const row = {
    id: 5,
    parentId: 1,
    position: 3,
    isPrivate: false,
    inheritFilters: true,
    featuredAssetId: 55,
    filters: facetFilterOf('[12]'),
    translations: [{ languageCode: 'en', name: 'Sale', slug: 'sale', description: '' }],
    assets: [{ assetId: 55, position: 0 }],
    customFields: { banner: 'A' },
  };

  it('normalises a collection, under its parent unless that is the root, its position only on request', async () => {
    const { manager } = fakeManager(
      new Map<unknown, Array<Record<string, unknown>>>([[Collection, [row, { id: 1, isRoot: true }]]]),
    );
    const top = (await definition.load(ctx, [5], manager, definition.fullScope)).get('5');
    expect(top).toMatchObject({
      label: 'Sale',
      parentId: undefined,
      values: {
        isPrivate: false,
        inheritFilters: true,
        parent: '1',
        featuredAsset: '55',
        filters: facetFilterOf('[12]'),
        assets: ['55'],
        'name.en': 'Sale',
        'customFields.banner': 'A',
      },
    });
    expect(top?.values).not.toHaveProperty('position');
    expect(definition.groupOf('position')).toBe(COLLECTION_POSITION_GROUP);
    expect(definition.kindOf('filters')).toBe('json');

    const { manager: nested } = fakeManager(
      new Map<unknown, Array<Record<string, unknown>>>([[Collection, [{ ...row, parentId: 4 }]]]),
    );
    const moved = (await definition.load(ctx, [5], nested, new Set([BASE_GROUP, COLLECTION_POSITION_GROUP]))).get('5');
    expect(moved).toMatchObject({ parentId: '4', values: { position: 3 } });
  });

  it("reads an event's entity without a database: its own row and the relations it carries", () => {
    const state = definition.fromEntity(ctx, { ...row, assets: undefined, parent: { isRoot: false } });
    expect([...state.groups]).toEqual([BASE_GROUP]);
    expect(state).toMatchObject({ label: 'Sale', parentId: '1', values: { 'slug.en': 'sale' } });
    expect(state.values).not.toHaveProperty('assets');
  });

  it('labels the facet values inside the filters', async () => {
    const { manager } = fakeManager(
      new Map<unknown, Array<Record<string, unknown>>>([
        [FacetValue, [{ id: 12, translations: [{ languageCode: 'en', name: 'Red' }], facet: { name: 'Colour' } }]],
      ]),
    );
    const changes: ChangeHistoryFieldChanges = {
      filters: { kind: 'json', from: facetFilterOf('[12]'), to: facetFilterOf('not json') },
    };
    await definition.addLabels(ctx, manager, changes);
    expect(changes.filters.labels).toEqual({ '12': 'Colour: Red' });
  });
});

describe('the facet value ids inside operations', () => {
  it("reads core's facet arguments of filters, conditions and actions, nothing else", () => {
    expect(
      facetValueIdsOfOperations({
        from: [{ code: 'at_least_n_with_facets', args: [{ name: 'facets', value: '["3","4"]' }] }],
        to: [
          { code: 'facet-value-filter', args: [{ name: 'facetValueIds', value: '[4, 5]' }] },
          { code: 'variant-id-filter', args: [{ name: 'variantIds', value: '[9]' }] },
          { code: 'facet-value-filter', args: [{ name: 'facetValueIds', value: '"7"' }] },
        ],
      }),
    ).toEqual(['3', '4', '5']);
    expect(facetValueIdsOfOperations({ from: null, to: 'text' })).toEqual([]);
  });
});

describe('the Facet and FacetValue definitions', () => {
  it('records a facet by code, privacy and name', async () => {
    const definition = facetDefinition(options(), {});
    const { manager } = fakeManager(
      new Map<unknown, Array<Record<string, unknown>>>([
        [Facet, [{ id: 2, code: 'colour', isPrivate: true, translations: [] }]],
      ]),
    );
    expect((await definition.load(ctx, [2], manager, definition.fullScope)).get('2')).toMatchObject({
      label: 'Facet 2',
      values: { code: 'colour', isPrivate: true },
    });
  });

  it('labels a value "Facet: Value", under its facet', async () => {
    const definition = facetValueDefinition(options(), {});
    const { manager } = fakeManager(
      new Map<unknown, Array<Record<string, unknown>>>([
        [FacetValue, [{ id: 12, facetId: 2, code: 'red', translations: [{ languageCode: 'en', name: 'Red' }] }]],
        [Facet, [{ id: 2, translations: [{ languageCode: 'en', name: 'Colour' }] }]],
      ]),
    );
    const state = (await definition.load(ctx, [12], manager, definition.fullScope)).get('12');
    expect(state).toMatchObject({ label: 'Colour: Red', parentId: '2', values: { code: 'red', 'name.en': 'Red' } });
    expect(definition.parentType).toBe('Facet');

    const deleted = definition.fromEntity(ctx, {
      id: 13,
      facetId: 2,
      code: 'blue',
      translations: [{ languageCode: 'en', name: 'Blue' }],
      facet: { translations: [{ languageCode: 'en', name: 'Colour' }] },
    });
    expect(deleted.label).toBe('Colour: Blue');
    expect(definition.fromEntity(ctx, { id: 14, facetId: 2, translations: [] }).label).toBe('FacetValue 14');
  });
});

describe('the Promotion definition', () => {
  it('records dates, limits, conditions and actions, not the priority score', async () => {
    const definition = promotionDefinition(options(), {});
    const { manager } = fakeManager(
      new Map<unknown, Array<Record<string, unknown>>>([
        [
          Promotion,
          [
            {
              id: 8,
              enabled: true,
              startsAt: new Date('2026-01-01T00:00:00.000Z'),
              endsAt: null,
              couponCode: 'TEN',
              perCustomerUsageLimit: 1,
              usageLimit: null,
              priorityScore: 30,
              conditions: [{ code: 'minimum_order_amount', args: [{ name: 'amount', value: '100' }] }],
              actions: [{ code: 'order_percentage_discount', args: [{ name: 'discount', value: '10' }] }],
              translations: [{ languageCode: 'en', name: 'Ten off', description: '' }],
            },
          ],
        ],
      ]),
    );
    const state = (await definition.load(ctx, [8], manager, definition.fullScope)).get('8');
    expect(state?.values).toEqual({
      enabled: true,
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: null,
      couponCode: 'TEN',
      perCustomerUsageLimit: 1,
      usageLimit: null,
      conditions: [{ code: 'minimum_order_amount', args: [{ name: 'amount', value: '100' }] }],
      actions: [{ code: 'order_percentage_discount', args: [{ name: 'discount', value: '10' }] }],
      'name.en': 'Ten off',
      'description.en': '',
    });
    expect(state?.label).toBe('Ten off');
    expect(definition.kindOf('startsAt')).toBe('date');
  });
});

describe('the Asset definition', () => {
  it('records the file facts, the focal point and the tags by value', async () => {
    const definition = assetDefinition(options(), {});
    const asset = {
      id: 55,
      type: 'IMAGE',
      mimeType: 'image/png',
      fileSize: 120,
      width: 1,
      height: 1,
      focalPoint: { x: 0.5, y: 0.5 },
      tags: [{ value: 'sale' }, { value: 'hero' }],
      translations: [{ languageCode: 'en', name: 'front.png' }],
    };
    const { manager } = fakeManager(new Map<unknown, Array<Record<string, unknown>>>([[Asset, [asset]]]));
    expect((await definition.load(ctx, [55], manager, definition.fullScope)).get('55')).toMatchObject({
      label: 'front.png',
      values: { type: 'IMAGE', mimeType: 'image/png', focalPoint: { x: 0.5, y: 0.5 }, tags: ['hero', 'sale'] },
    });
    expect([...definition.scopeFor({ id: 55, name: 'x' })]).toEqual([BASE_GROUP]);
    expect([...definition.scopeFor({ id: 55, tags: [] })]).toEqual([BASE_GROUP, 'tags']);
    expect(definition.fromEntity(ctx, { id: 56, translations: [] }).label).toBe('Asset 56');
  });
});

describe('the definitions on sparse rows and host settings', () => {
  const extractorOf = (entityType: ChangeHistoryFieldExtractor['entityType']): ChangeHistoryFieldExtractor => ({
    entityType,
    key: `${entityType}Extra`,
    kind: 'json',
    load: vi.fn(async () => new Map()),
  });
  const factories = {
    Product: productDefinition,
    ProductVariant: productVariantDefinition,
    Collection: collectionDefinition,
    Facet: facetDefinition,
    FacetValue: facetValueDefinition,
    Promotion: promotionDefinition,
    Asset: assetDefinition,
  };

  it("takes only its own entity type's extractors, without labels when the extractor has none", async () => {
    const types = Object.keys(factories) as Array<keyof typeof factories>;
    const hostOptions = options({ fieldExtractors: types.map(extractorOf) });
    for (const type of types) {
      const definition = factories[type](hostOptions, {});
      expect(definition.kindOf(`${type}Extra`)).toBe('json');
      expect(definition.groupOf(`${type}Extra`)).toBe(`extractor:${type}Extra`);
      expect(definition.fullScope).toContain(`extractor:${type}Extra`);
      const other = types.find((t) => t !== type)!;
      expect(definition.kindOf(`${other}Extra`)).toBe('text');
      expect(definition.fullScope).not.toContain(`extractor:${other}Extra`);

      const { manager, finds } = fakeManager(new Map());
      const changes: ChangeHistoryFieldChanges = { [`${type}Extra`]: { kind: 'json', from: null, to: { id: '4' } } };
      await definition.addLabels(ctx, manager, changes);
      expect(changes[`${type}Extra`].labels).toBeUndefined();
      expect(finds).toEqual([]);
    }
  });

  it("applies the host's field kinds to columns, translated fields and keys of its own", () => {
    const definition = productDefinition(
      options({ entities: { Product: { fieldKinds: { enabled: 'text', name: 'richtext', extra: 'date' } } } }),
      {},
    );
    expect(definition.kindOf('enabled')).toBe('text');
    expect(definition.kindOf('name.uk')).toBe('richtext');
    expect(definition.kindOf('name')).toBe('text');
    expect(definition.kindOf('extra')).toBe('date');
    expect(definition.kindOf('unknown')).toBe('text');
  });

  it('reads a product without translations or loaded relations as empty lists, labelled by its id', async () => {
    const definition = productDefinition(options(), {});
    const { manager } = fakeManager(new Map([[Product, [{ id: 3, enabled: false, featuredAssetId: null }]]]));
    expect((await definition.load(ctx, [3], manager, definition.fullScope)).get('3')).toMatchObject({
      label: 'Product 3',
      values: { enabled: false, featuredAsset: null, facetValues: [], assets: [], optionGroups: [] },
    });
  });

  it('reads a variant without loaded prices, options or facet values as empty lists', async () => {
    const definition = productVariantDefinition(options(), {});
    const { manager } = fakeManager(new Map([[ProductVariant, [{ id: 21, productId: 3, translations: [] }]]]));
    expect((await definition.load(ctx, [21], manager, definition.fullScope)).get('21')?.values).toMatchObject({
      prices: [],
      options: [],
      facetValues: [],
      assets: [],
    });
  });

  it('reads a collection filter without arguments, and no filters at all, as plain JSON', () => {
    const definition = collectionDefinition(options(), {});
    const fromEntity = (filters: unknown) =>
      definition.fromEntity(ctx, { id: 5, parentId: 1, filters, translations: [] }).values.filters;
    expect(fromEntity([{ code: 'variant-name-filter' }])).toEqual([{ code: 'variant-name-filter', args: [] }]);
    expect(fromEntity(undefined)).toEqual([]);
    expect(definition.fromEntity(ctx, { id: 5, translations: [] }).label).toBe('Collection 5');
  });

  it('finds no facet value ids in empty operations or operations without arguments', () => {
    expect(
      facetValueIdsOfOperations({
        kind: 'json',
        from: [null, { code: 'facet-value-filter' }],
        to: [{ code: 'facet-value-filter', args: [null, { name: 'facetValueIds', value: '[8]' }] }],
      }),
    ).toEqual(['8']);
  });

  it('labels a promotion without a translation by its id', () => {
    const definition = promotionDefinition(options(), {});
    expect(definition.fromEntity(ctx, { id: 8, translations: [] }).label).toBe('Promotion 8');
  });

  it('reads an asset without loaded tags as no tags', async () => {
    const definition = assetDefinition(options(), {});
    const { manager } = fakeManager(new Map([[Asset, [{ id: 55, translations: [] }]]]));
    expect((await definition.load(ctx, [55], manager, definition.fullScope)).get('55')?.values.tags).toEqual([]);
  });

  it('keeps a change unlabelled when none of its ids exists any more', async () => {
    const definition = productDefinition(options(), {});
    const { manager, finds } = fakeManager(new Map());
    const changes: ChangeHistoryFieldChanges = { featuredAsset: { kind: 'ref', from: '55', to: null } };
    await definition.addLabels(ctx, manager, changes);
    expect(finds).toEqual([{ entity: Asset, relations: ['translations'] }]);
    expect(changes.featuredAsset.labels).toBeUndefined();
  });

  it('ignores relation rows of ids the first query did not return', async () => {
    const definition = productDefinition(options(), {});
    const find = vi.fn(async ({ relations }: { relations: string[] }) =>
      relations[0] === 'translations'
        ? [{ id: 3, translations: [] }]
        : [
            { id: 99, facetValues: [{ id: 2 }] },
            { id: 3, facetValues: [{ id: 1 }] },
          ],
    );
    const manager = { getRepository: () => ({ find }) } as unknown as EntityManager;
    const states = await definition.load(ctx, [3], manager, new Set([BASE_GROUP, 'facetValues']));
    expect([...states.keys()]).toEqual(['3']);
    expect(states.get('3')?.values.facetValues).toEqual(['1']);
  });
});
