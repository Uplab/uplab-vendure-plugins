import {
  Asset,
  Channel,
  FacetValue,
  ID,
  Product,
  ProductOption,
  ProductOptionGroup,
  ProductVariant,
  RequestContext,
  TaxCategory,
  Type,
} from '@vendure/core';
import { CustomFieldConfig } from '@vendure/core';
import { customFieldSpecs } from '../custom-fields/custom-field-specs';
import { ChangeHistoryFieldChange, ResolvedChangeHistoryPluginOptions } from '../types';
import { CatalogEntityDefinition, CatalogRow, LabelLoader } from './catalog-definition';
import { labelsOf, pickTranslation } from './labels';

const labels =
  (target: Type<unknown>, parent?: string): LabelLoader =>
  (ctx, manager, ids) =>
    labelsOf(ctx, manager, target, ids, parent);

/** An id column as the string the history stores for references. */
const idString = (value: unknown) => (value == null ? null : String(value));

const byNumericId = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

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
