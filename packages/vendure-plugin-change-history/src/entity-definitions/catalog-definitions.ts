import {
  Asset,
  Channel,
  Collection,
  Facet,
  FacetValue,
  ID,
  Product,
  ProductOption,
  ProductOptionGroup,
  ProductVariant,
  Promotion,
  RequestContext,
  TaxCategory,
  Type,
} from '@vendure/core';
import { CustomFieldConfig } from '@vendure/core';
import { byNumericId } from '../common/utils';
import { customFieldSpecs } from '../custom-fields/custom-field-specs';
import { ChangeHistoryFieldChange, ResolvedChangeHistoryPluginOptions } from '../types';
import { CatalogEntityDefinition, CatalogRow, ColumnField, LabelLoader } from './catalog-definition';
import { labelsOf, pickTranslation } from './labels';

const labels =
  (target: Type<unknown>, parent?: string): LabelLoader =>
  (ctx, manager, ids) =>
    labelsOf(ctx, manager, target, ids, parent);

/** An id column as the string the history stores for references. */
const idString = (value: unknown) => (value == null ? null : String(value));

/** Sorted ids of a many-to-many relation. */
const idsOf = (key: string) => (row: CatalogRow) =>
  ((row[key] as Array<{ id: ID }> | undefined) ?? []).map((item) => String(item.id)).sort(byNumericId);

/** Asset ids of an orderable asset relation, in display order. */
const orderedAssetIds = (row: CatalogRow) =>
  ((row.assets as Array<{ assetId: ID; position: number }> | undefined) ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((asset) => String(asset.assetId));

const nameOf = (row: CatalogRow, ctx: RequestContext) =>
  pickTranslation(row.translations as Array<{ languageCode: never; name?: string }>, ctx)?.name;

type CustomFieldsConfig = Partial<Record<string, CustomFieldConfig[]>>;

/** The Product definition: own columns, translations, facet values, assets, option groups, custom fields. */
export function productDefinition(
  options: ResolvedChangeHistoryPluginOptions,
  customFields: CustomFieldsConfig,
): CatalogEntityDefinition {
  const overrides = options.entities.Product ?? {};
  return new CatalogEntityDefinition({
    entityType: 'Product',
    entity: Product,
    translatedFields: { name: 'text', slug: 'text', description: 'richtext' },
    columns: [
      { key: 'enabled', kind: 'bool', read: (row) => row.enabled },
      { key: 'featuredAsset', kind: 'ref', read: (row) => idString(row.featuredAssetId), labels: labels(Asset) },
    ],
    relations: [
      {
        key: 'facetValues',
        relation: 'facetValues',
        inputKeys: ['facetValueIds'],
        kind: 'refs',
        read: idsOf('facetValues'),
        labels: labels(FacetValue, 'facet'),
      },
      {
        key: 'assets',
        relation: 'assets',
        inputKeys: ['assetIds'],
        kind: 'assets',
        read: orderedAssetIds,
        labels: labels(Asset),
      },
      {
        key: 'optionGroups',
        relation: 'optionGroups',
        // Not an input of updateProduct: the pseudo key of the ProductOptionGroupChangeEvent handler.
        inputKeys: ['optionGroupIds'],
        kind: 'refs',
        read: idsOf('optionGroups'),
        labels: labels(ProductOptionGroup),
      },
    ],
    customFields: customFieldSpecs(customFields.Product, overrides),
    extractors: options.fieldExtractors.filter((e) => e.entityType === 'Product'),
    overrides,
    label: (row, ctx) => nameOf(row, ctx) ?? `Product ${String(row.id)}`,
  });
}

interface PriceValue {
  channelId: string;
  currencyCode: string;
  price: number;
}

/** Prices as a stable list: one `{ channelId, currencyCode, price }` per channel and currency. */
const pricesOf = (row: CatalogRow): PriceValue[] =>
  ((row.productVariantPrices as Array<{ channelId: ID; currencyCode: string; price: number }> | undefined) ?? [])
    .map((p) => ({ channelId: String(p.channelId), currencyCode: p.currencyCode, price: p.price }))
    .sort((a, b) => byNumericId(a.channelId, b.channelId) || a.currencyCode.localeCompare(b.currencyCode));

/** Channel ids of a prices change, for the channel-code labels. */
const priceChannelIds = (change: ChangeHistoryFieldChange) =>
  [...((change.from as PriceValue[] | null) ?? []), ...((change.to as PriceValue[] | null) ?? [])].map(
    (price) => price.channelId,
  );

/**
 * The ProductVariant definition: SKU, flags, stock settings, tax category, prices per channel and currency,
 * options, facet values, assets, custom fields. Stock levels are not part of it — stock is recorded from
 * the adjustments (`stock_adjusted`).
 */
export function productVariantDefinition(
  options: ResolvedChangeHistoryPluginOptions,
  customFields: CustomFieldsConfig,
): CatalogEntityDefinition {
  const overrides = options.entities.ProductVariant ?? {};
  return new CatalogEntityDefinition({
    entityType: 'ProductVariant',
    entity: ProductVariant,
    parentType: 'Product',
    parentId: (row) => row.productId as ID | undefined,
    translatedFields: { name: 'text' },
    columns: [
      { key: 'sku', kind: 'text', read: (row) => row.sku },
      { key: 'enabled', kind: 'bool', read: (row) => row.enabled },
      { key: 'taxCategory', kind: 'ref', read: (row) => idString(row.taxCategoryId), labels: labels(TaxCategory) },
      { key: 'trackInventory', kind: 'enum', read: (row) => row.trackInventory },
      { key: 'outOfStockThreshold', kind: 'text', read: (row) => row.outOfStockThreshold },
      { key: 'useGlobalOutOfStockThreshold', kind: 'bool', read: (row) => row.useGlobalOutOfStockThreshold },
      { key: 'featuredAsset', kind: 'ref', read: (row) => idString(row.featuredAssetId), labels: labels(Asset) },
    ],
    relations: [
      {
        key: 'prices',
        relation: 'productVariantPrices',
        inputKeys: ['price', 'prices'],
        kind: 'prices',
        read: pricesOf,
        labels: labels(Channel),
        labelIds: priceChannelIds,
      },
      {
        key: 'options',
        relation: 'options',
        inputKeys: ['optionIds'],
        kind: 'refs',
        read: idsOf('options'),
        labels: labels(ProductOption, 'group'),
      },
      {
        key: 'facetValues',
        relation: 'facetValues',
        inputKeys: ['facetValueIds'],
        kind: 'refs',
        read: idsOf('facetValues'),
        labels: labels(FacetValue, 'facet'),
      },
      {
        key: 'assets',
        relation: 'assets',
        inputKeys: ['assetIds'],
        kind: 'assets',
        read: orderedAssetIds,
        labels: labels(Asset),
      },
    ],
    customFields: customFieldSpecs(customFields.ProductVariant, overrides),
    extractors: options.fieldExtractors.filter((e) => e.entityType === 'ProductVariant'),
    overrides,
    label: (row, ctx) => {
      const name = nameOf(row, ctx) ?? `Variant ${String(row.id)}`;
      return row.sku ? `${name} (${String(row.sku)})` : name;
    },
  });
}

/** A configurable operation as stored by core (a collection filter, a promotion condition or action). */
interface Operation {
  code: string;
  args: Array<{ name: string; value: string }>;
}

/** The operations as plain JSON: `[{ code, args: [{ name, value }] }]`, in their configured order. */
const operationsOf = (key: string) => (row: CatalogRow) =>
  ((row[key] as Operation[] | undefined) ?? []).map((op) => ({
    code: op.code,
    args: (op.args ?? []).map((arg) => ({ name: arg.name, value: arg.value })),
  }));

/**
 * Arguments that hold facet value ids in core's operations: the facet filter (`facetValueIds`), the
 * `at_least_n_with_facets` condition and the `facet_based_discount` action (`facets`).
 */
const FACET_VALUE_ARGS = new Set(['facetValueIds', 'facets']);

/** Facet value ids inside the operations' facet value arguments, for their labels. */
export const facetValueIdsOfOperations = (change: ChangeHistoryFieldChange): string[] => {
  const ids = new Set<string>();
  for (const side of [change.from, change.to]) {
    for (const op of Array.isArray(side) ? (side as Operation[]) : []) {
      for (const arg of op?.args ?? []) {
        if (!FACET_VALUE_ARGS.has(arg?.name)) {
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(arg.value);
          (Array.isArray(parsed) ? parsed : []).forEach((id) => ids.add(String(id)));
        } catch {
          // Not a JSON list: nothing to label.
        }
      }
    }
  }
  return [...ids];
};

/** A JSON column of configurable operations, its facet values labelled "Facet: Value". */
const operationsColumn = (key: string): ColumnField => ({
  key,
  kind: 'json',
  read: operationsOf(key),
  labels: labels(FacetValue, 'facet'),
  labelIds: facetValueIdsOfOperations,
});

/** The group of a collection's `position`: loaded and compared for a move only. */
export const COLLECTION_POSITION_GROUP = 'position';

/**
 * The Collection definition: name / slug / description per language, `isPrivate`, `inheritFilters`, the parent,
 * the filters (JSON), featured asset and assets, custom fields. `position` is compared only for a move (core
 * renumbers siblings without events). The parent link is the parent collection, unless that is the root.
 */
export function collectionDefinition(
  options: ResolvedChangeHistoryPluginOptions,
  customFields: CustomFieldsConfig,
): CatalogEntityDefinition {
  const overrides = options.entities.Collection ?? {};
  return new CatalogEntityDefinition({
    entityType: 'Collection',
    entity: Collection,
    parentType: 'Collection',
    parentId: (row) => ((row.parent as { isRoot?: boolean } | undefined)?.isRoot ? undefined : (row.parentId as ID)),
    translatedFields: { name: 'text', slug: 'text', description: 'richtext' },
    columns: [
      { key: 'isPrivate', kind: 'bool', read: (row) => row.isPrivate },
      { key: 'inheritFilters', kind: 'bool', read: (row) => row.inheritFilters },
      { key: 'parent', kind: 'ref', read: (row) => idString(row.parentId), labels: labels(Collection) },
      { key: 'featuredAsset', kind: 'ref', read: (row) => idString(row.featuredAssetId), labels: labels(Asset) },
      operationsColumn('filters'),
      { key: 'position', kind: 'text', read: (row) => row.position, group: COLLECTION_POSITION_GROUP },
    ],
    relations: [
      {
        key: 'assets',
        relation: 'assets',
        inputKeys: ['assetIds'],
        kind: 'assets',
        read: orderedAssetIds,
        labels: labels(Asset),
      },
    ],
    enrich: async (_ctx, manager, rows) => {
      // Not a `parent` relation: TypeORM's query strategy cannot join the collection to itself on SQLite.
      const root = await manager
        .getRepository(Collection)
        .findOne({ where: { isRoot: true }, select: { id: true }, loadEagerRelations: false });
      for (const row of rows) {
        row.parent = { id: row.parentId, isRoot: root != null && String(row.parentId) === String(root.id) };
      }
    },
    customFields: customFieldSpecs(customFields.Collection, overrides),
    extractors: options.fieldExtractors.filter((e) => e.entityType === 'Collection'),
    overrides,
    label: (row, ctx) => nameOf(row, ctx) ?? `Collection ${String(row.id)}`,
  });
}

/** The Facet definition: name per language, `code`, `isPrivate`, custom fields. */
export function facetDefinition(
  options: ResolvedChangeHistoryPluginOptions,
  customFields: CustomFieldsConfig,
): CatalogEntityDefinition {
  const overrides = options.entities.Facet ?? {};
  return new CatalogEntityDefinition({
    entityType: 'Facet',
    entity: Facet,
    translatedFields: { name: 'text' },
    columns: [
      { key: 'code', kind: 'text', read: (row) => row.code },
      { key: 'isPrivate', kind: 'bool', read: (row) => row.isPrivate },
    ],
    relations: [],
    customFields: customFieldSpecs(customFields.Facet, overrides),
    extractors: options.fieldExtractors.filter((e) => e.entityType === 'Facet'),
    overrides,
    label: (row, ctx) => nameOf(row, ctx) ?? `Facet ${String(row.id)}`,
  });
}

/** The FacetValue definition: name per language, `code`, custom fields; under its facet, labelled "Facet: Value". */
export function facetValueDefinition(
  options: ResolvedChangeHistoryPluginOptions,
  customFields: CustomFieldsConfig,
): CatalogEntityDefinition {
  const overrides = options.entities.FacetValue ?? {};
  return new CatalogEntityDefinition({
    entityType: 'FacetValue',
    entity: FacetValue,
    parentType: 'Facet',
    parentId: (row) => row.facetId as ID | undefined,
    translatedFields: { name: 'text' },
    columns: [{ key: 'code', kind: 'text', read: (row) => row.code }],
    relations: [],
    enrich: async (ctx, manager, rows) => {
      const names = await labelsOf(
        ctx,
        manager,
        Facet,
        rows.map((row) => String(row.facetId)),
      );
      for (const row of rows) {
        row.facetName = names[String(row.facetId)];
      }
    },
    customFields: customFieldSpecs(customFields.FacetValue, overrides),
    extractors: options.fieldExtractors.filter((e) => e.entityType === 'FacetValue'),
    overrides,
    label: (row, ctx) => {
      const name = nameOf(row, ctx) ?? `FacetValue ${String(row.id)}`;
      // Loaded by `enrich`, or the facet an event attached (a deleted facet's values).
      const facet = row.facet as CatalogRow | undefined;
      const facetName = (row.facetName as string | undefined) ?? (facet ? nameOf(facet, ctx) : undefined);
      return facetName ? `${facetName}: ${name}` : name;
    },
  });
}

/**
 * The Promotion definition: name / description per language, `enabled`, `startsAt` / `endsAt`, `couponCode`,
 * the usage limits, conditions and actions (JSON), custom fields. `priorityScore` is computed by core from the
 * conditions and actions and is left out.
 */
export function promotionDefinition(
  options: ResolvedChangeHistoryPluginOptions,
  customFields: CustomFieldsConfig,
): CatalogEntityDefinition {
  const overrides = options.entities.Promotion ?? {};
  return new CatalogEntityDefinition({
    entityType: 'Promotion',
    entity: Promotion,
    translatedFields: { name: 'text', description: 'richtext' },
    columns: [
      { key: 'enabled', kind: 'bool', read: (row) => row.enabled },
      { key: 'startsAt', kind: 'date', read: (row) => row.startsAt },
      { key: 'endsAt', kind: 'date', read: (row) => row.endsAt },
      { key: 'couponCode', kind: 'text', read: (row) => row.couponCode },
      { key: 'perCustomerUsageLimit', kind: 'text', read: (row) => row.perCustomerUsageLimit },
      { key: 'usageLimit', kind: 'text', read: (row) => row.usageLimit },
      operationsColumn('conditions'),
      operationsColumn('actions'),
    ],
    relations: [],
    customFields: customFieldSpecs(customFields.Promotion, overrides),
    extractors: options.fieldExtractors.filter((e) => e.entityType === 'Promotion'),
    overrides,
    label: (row, ctx) => nameOf(row, ctx) ?? `Promotion ${String(row.id)}`,
  });
}

/** Tag values, sorted: a tag is its value, so the value is the "id" and needs no label. */
const tagValuesOf = (row: CatalogRow) =>
  ((row.tags as Array<{ value: string }> | undefined) ?? []).map((tag) => tag.value).sort();

/**
 * The Asset definition: name per language, the file facts (`type`, `mimeType`, `fileSize`, `width`,
 * `height`), `focalPoint`, tags, custom fields. Where an asset is used is recorded on the product, variant or
 * collection that uses it.
 */
export function assetDefinition(
  options: ResolvedChangeHistoryPluginOptions,
  customFields: CustomFieldsConfig,
): CatalogEntityDefinition {
  const overrides = options.entities.Asset ?? {};
  return new CatalogEntityDefinition({
    entityType: 'Asset',
    entity: Asset,
    translatedFields: { name: 'text' },
    columns: [
      { key: 'type', kind: 'enum', read: (row) => row.type },
      { key: 'mimeType', kind: 'text', read: (row) => row.mimeType },
      { key: 'fileSize', kind: 'text', read: (row) => row.fileSize },
      { key: 'width', kind: 'text', read: (row) => row.width },
      { key: 'height', kind: 'text', read: (row) => row.height },
      { key: 'focalPoint', kind: 'json', read: (row) => row.focalPoint },
    ],
    relations: [{ key: 'tags', relation: 'tags', inputKeys: ['tags'], kind: 'refs', read: tagValuesOf }],
    customFields: customFieldSpecs(customFields.Asset, overrides),
    extractors: options.fieldExtractors.filter((e) => e.entityType === 'Asset'),
    overrides,
    label: (row, ctx) => nameOf(row, ctx) ?? `Asset ${String(row.id)}`,
  });
}
