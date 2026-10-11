/**
 * The package's built-in labels and how a label is chosen: host registrations first, then these, then the
 * raw key made readable.
 *
 * The built-ins are plain message descriptors with explicit ids (`change-history.*`), translated by
 * `i18n._()` at render time from `i18n/{en,uk}.po` — no Lingui macro, so this file runs in unit tests, and
 * the ids cannot collide with another plugin's messages in the dashboard's shared dictionary.
 */
import type {
  ChangeHistoryLabel,
  ChangeHistoryRegistry,
  ChangeHistorySourceDefinition,
  ChangeHistorySourceTone,
} from './registry';

export interface BuiltInLabel {
  id: string;
  message: string;
}

const label = (id: string, message: string): BuiltInLabel => ({ id: `change-history.${id}`, message });

/** Core fields, keyed as in `changes` without the language suffix. */
export const FIELD_LABELS: Record<string, BuiltInLabel> = {
  name: label('field.name', 'Name'),
  slug: label('field.slug', 'Slug'),
  description: label('field.description', 'Description'),
  enabled: label('field.enabled', 'Enabled'),
  sku: label('field.sku', 'SKU'),
  price: label('field.price', 'Price'),
  prices: label('field.prices', 'Price'),
  featuredAsset: label('field.featuredAsset', 'Featured image'),
  assets: label('field.assets', 'Images'),
  facetValues: label('field.facetValues', 'Facet values'),
  optionGroups: label('field.optionGroups', 'Option groups'),
  options: label('field.options', 'Options'),
  taxCategory: label('field.taxCategory', 'Tax category'),
  trackInventory: label('field.trackInventory', 'Track inventory'),
  outOfStockThreshold: label('field.outOfStockThreshold', 'Out-of-stock threshold'),
  useGlobalOutOfStockThreshold: label('field.useGlobalOutOfStockThreshold', 'Use global out-of-stock threshold'),
  stock: label('field.stock', 'Stock'),
  isPrivate: label('field.isPrivate', 'Private'),
  inheritFilters: label('field.inheritFilters', 'Inherit filters'),
  parent: label('field.parent', 'Parent collection'),
  filters: label('field.filters', 'Filters'),
  position: label('field.position', 'Position'),
  code: label('field.code', 'Code'),
  startsAt: label('field.startsAt', 'Starts at'),
  endsAt: label('field.endsAt', 'Ends at'),
  couponCode: label('field.couponCode', 'Coupon code'),
  perCustomerUsageLimit: label('field.perCustomerUsageLimit', 'Per-customer usage limit'),
  usageLimit: label('field.usageLimit', 'Usage limit'),
  conditions: label('field.conditions', 'Conditions'),
  actions: label('field.actions', 'Actions'),
  type: label('field.type', 'Type'),
  mimeType: label('field.mimeType', 'MIME type'),
  fileSize: label('field.fileSize', 'File size'),
  width: label('field.width', 'Width'),
  height: label('field.height', 'Height'),
  focalPoint: label('field.focalPoint', 'Focal point'),
  tags: label('field.tags', 'Tags'),
};

/** The entity types the package records, as the type column and filter show them. */
const ENTITY_TYPE_LABELS: Record<string, BuiltInLabel> = {
  Product: label('type.Product', 'Product'),
  ProductVariant: label('type.ProductVariant', 'Variant'),
  Collection: label('type.Collection', 'Collection'),
  Facet: label('type.Facet', 'Facet'),
  FacetValue: label('type.FacetValue', 'Facet value'),
  Asset: label('type.Asset', 'Asset'),
  Promotion: label('type.Promotion', 'Promotion'),
  Batch: label('type.Batch', 'Bulk operation'),
  Run: label('type.Run', 'System'),
};

/** Plural nouns for the count line of a run («Variants: 3 · Rows: 4»): numbers sit next to them, no plurals. */
const ENTITY_TYPE_PLURAL_LABELS: Record<string, BuiltInLabel> = {
  Product: label('types.Product', 'Products'),
  ProductVariant: label('types.ProductVariant', 'Variants'),
  Collection: label('types.Collection', 'Collections'),
  Facet: label('types.Facet', 'Facets'),
  FacetValue: label('types.FacetValue', 'Facet values'),
  Asset: label('types.Asset', 'Assets'),
  Promotion: label('types.Promotion', 'Promotions'),
};

export const OBJECTS_LABEL = label('types.other', 'Objects');
export const ROWS_LABEL = label('rows', 'Rows');

const ACTION_LABELS: Record<string, BuiltInLabel> = {
  created: label('action.created', 'created'),
  updated: label('action.updated', 'updated'),
  deleted: label('action.deleted', 'deleted'),
  moved: label('action.moved', 'moved'),
  collection_added: label('action.collection_added', 'added to collection'),
  collection_removed: label('action.collection_removed', 'removed from collection'),
  stock_adjusted: label('action.stock_adjusted', 'stock adjusted'),
  channel_assigned: label('action.channel_assigned', 'assigned to channel'),
  channel_removed: label('action.channel_removed', 'removed from channel'),
  option_group_added: label('action.option_group_added', 'option group added'),
  option_group_removed: label('action.option_group_removed', 'option group removed'),
  batch: label('action.batch', 'bulk operation'),
  run: label('action.run', 'sync'),
};

interface BuiltInSource {
  label: BuiltInLabel;
  tone: ChangeHistorySourceTone;
}

const SOURCE_LABELS: Record<string, BuiltInSource> = {
  admin: { label: label('source.admin', 'Dashboard'), tone: 'human' },
  api_key: { label: label('source.api_key', 'API key'), tone: 'human' },
  collection_rules: { label: label('source.collection_rules', 'Collection rules'), tone: 'system' },
  unknown_system: { label: label('source.unknown_system', 'System'), tone: 'system' },
};

const BATCH_KIND_LABELS: Record<string, BuiltInLabel> = {
  collection_rules: label('batch.collection_rules', 'Collection contents updated'),
};

/** Keys of a run's `counts` and of a collection-rules batch's `meta.counts`. */
const COUNT_LABELS: Record<string, BuiltInLabel> = {
  created: label('count.created', 'created'),
  updated: label('count.updated', 'updated'),
  deleted: label('count.deleted', 'deleted'),
  failed: label('count.failed', 'failed'),
  added: label('count.added', 'added'),
  removed: label('count.removed', 'removed'),
};

/** Every built-in descriptor, for the catalog test. */
export const ALL_BUILT_IN_LABELS: BuiltInLabel[] = [
  ...Object.values(FIELD_LABELS),
  ...Object.values(ENTITY_TYPE_LABELS),
  ...Object.values(ENTITY_TYPE_PLURAL_LABELS),
  OBJECTS_LABEL,
  ROWS_LABEL,
  ...Object.values(ACTION_LABELS),
  ...Object.values(SOURCE_LABELS).map((source) => source.label),
  ...Object.values(BATCH_KIND_LABELS),
  ...Object.values(COUNT_LABELS),
];

const LANGUAGE_SUFFIX = /^[a-z]{2}(_[A-Za-z]{2,4})?$/;

/**
 * `name.uk` → `{ base: 'name', language: 'uk' }`; `customFields.subtitle.en` → base `customFields.subtitle`.
 * A key without a language-code suffix comes back whole.
 */
export function splitLanguage(key: string): { base: string; language?: string } {
  const dot = key.lastIndexOf('.');
  if (dot > 0 && LANGUAGE_SUFFIX.test(key.slice(dot + 1))) {
    return { base: key.slice(0, dot), language: key.slice(dot + 1) };
  }
  return { base: key };
}

/** `customFields.discountStartAt` → `Discount start at`: the last resort for a field nobody labelled. */
export function humanizeKey(key: string): string {
  const last = key.replace(/^customFields\./, '');
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/** A field's label and the language of a translatable one (shown as «Name (uk)»). */
export function fieldLabelOf(
  registry: ChangeHistoryRegistry,
  entityType: string,
  key: string,
): { label: ChangeHistoryLabel; language?: string } {
  const { base, language } = splitLanguage(key);
  const host = registry.fieldLabels.get(entityType);
  const found = host?.get(key) ?? (language ? host?.get(base) : undefined);
  if (found) {
    return { label: found, language: host?.has(key) ? undefined : language };
  }
  const builtIn = FIELD_LABELS[key] ?? FIELD_LABELS[base];
  if (builtIn) {
    return { label: builtIn, language: FIELD_LABELS[key] ? undefined : language };
  }
  return { label: humanizeKey(base), language };
}

export function entityTypeLabelOf(registry: ChangeHistoryRegistry, type: string): ChangeHistoryLabel {
  return registry.entityTypes.get(type)?.label ?? ENTITY_TYPE_LABELS[type] ?? type;
}

export function entityTypePluralLabelOf(type: string | undefined): BuiltInLabel {
  return (type && ENTITY_TYPE_PLURAL_LABELS[type]) || OBJECTS_LABEL;
}

export function actionLabelOf(registry: ChangeHistoryRegistry, action: string): ChangeHistoryLabel {
  return registry.actions.get(action)?.label ?? ACTION_LABELS[action] ?? action.replace(/_/g, ' ');
}

export function batchKindLabelOf(registry: ChangeHistoryRegistry, kind: string): ChangeHistoryLabel {
  return registry.batchKinds.get(kind)?.label ?? BATCH_KIND_LABELS[kind] ?? humanizeKey(kind);
}

/**
 * A source's label, tone, icon and count labels. An unknown source is a person's change unless the server
 * recorded a system actor.
 */
export function sourceOf(
  registry: ChangeHistoryRegistry,
  source: string,
  actorType?: string,
): ChangeHistorySourceDefinition {
  const host = registry.sources.get(source);
  if (host) {
    return host;
  }
  const builtIn = SOURCE_LABELS[source];
  if (builtIn) {
    return { label: builtIn.label, tone: builtIn.tone };
  }
  return { label: humanizeKey(source), tone: actorType === 'system' ? 'system' : 'human' };
}

export function countLabelOf(registry: ChangeHistoryRegistry, source: string, key: string): ChangeHistoryLabel {
  return registry.sources.get(source)?.countLabels?.[key] ?? COUNT_LABELS[key] ?? key.replace(/_/g, ' ');
}

/** The batch kind of a member entry: `batchId` is `<kind>:<uuid>`. */
export function batchKindOf(batchId: string | null | undefined): string | undefined {
  if (!batchId) {
    return undefined;
  }
  const colon = batchId.lastIndexOf(':');
  return colon > 0 ? batchId.slice(0, colon) : undefined;
}
