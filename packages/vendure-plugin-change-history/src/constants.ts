import { PermissionDefinition } from '@vendure/core';

/** Injection token of the {@link ResolvedChangeHistoryPluginOptions}. */
export const CHANGE_HISTORY_PLUGIN_OPTIONS = Symbol('CHANGE_HISTORY_PLUGIN_OPTIONS');

export const loggerCtx = 'ChangeHistory';

/**
 * @description
 * The entity types the package records out of the box. `entityType` is a plain string in the database
 * and in GraphQL, so a host can record its own types too (`recordAction`).
 */
export const CHANGE_HISTORY_ENTITY_TYPES = {
  Product: 'Product',
  ProductVariant: 'ProductVariant',
  Collection: 'Collection',
  Facet: 'Facet',
  FacetValue: 'FacetValue',
  Asset: 'Asset',
  Promotion: 'Promotion',
  Batch: 'Batch',
  Run: 'Run',
} as const;

/** The built-in actions. Hosts add their own strings. */
export const CHANGE_HISTORY_ACTIONS = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  moved: 'moved',
  collection_added: 'collection_added',
  collection_removed: 'collection_removed',
  stock_adjusted: 'stock_adjusted',
  channel_assigned: 'channel_assigned',
  channel_removed: 'channel_removed',
  option_group_added: 'option_group_added',
  option_group_removed: 'option_group_removed',
  batch: 'batch',
  run: 'run',
} as const;

/** The built-in sources. Hosts add their own strings (an ERP sync, a scheduler, …). */
export const CHANGE_HISTORY_SOURCES = {
  admin: 'admin',
  api_key: 'api_key',
  collection_rules: 'collection_rules',
  unknown_system: 'unknown_system',
} as const;

/** Who made a change. The "hide system changes" filter keys on this. */
export const CHANGE_HISTORY_ACTOR_TYPES = {
  admin: 'admin',
  api_key: 'api_key',
  system: 'system',
} as const;

/**
 * @description
 * Ids of the package's blocking event handlers. A host that owns a handler which must run after the
 * history handler declares `after: CHANGE_HISTORY_HANDLER_IDS.Product` on its own registration.
 */
export const CHANGE_HISTORY_HANDLER_IDS = {
  Product: 'change-history-product',
  ProductVariant: 'change-history-product-variant',
  Collection: 'change-history-collection',
  /** The contents of a collection (`collection_added` / `collection_removed` on the products). */
  CollectionMembership: 'change-history-collection-membership',
  Facet: 'change-history-facet',
  FacetValue: 'change-history-facet-value',
  Asset: 'change-history-asset',
  Promotion: 'change-history-promotion',
  /** Option groups added to / removed from a product (`option_group_added` / `option_group_removed`). */
  ProductOptionGroup: 'change-history-product-option-group',
  /** Manual stock adjustments of variants (`stock_adjusted`). */
  StockMovement: 'change-history-stock-movement',
  /** Products, variants and assets assigned to / removed from a channel. */
  Channel: 'change-history-channel',
} as const;

/**
 * @description
 * Grants read access to the change history (every query of the package). `readChangeHistory.Permission`
 * is `'ReadChangeHistory'`.
 */
export const readChangeHistory = new PermissionDefinition({
  name: 'ReadChangeHistory',
  description: 'Allows reading the change history of the catalogue',
});

/** `<kind>:<uuid>` must fit the `batchId` column, `varchar(64)`. */
export const MAX_BATCH_KIND_LENGTH = 27;

/** Detail rows are inserted in chunks of this size; `IN (…)` lists are chunked the same way. */
export const DETAIL_CHUNK_SIZE = 500;

/** Detail rows stored per run; a larger run keeps the first ones and counts the rest in `meta.detailsOmitted`. */
export const MAX_RUN_DETAILS = 5_000;

/**
 * Detail rows one compaction batch loads and archives at most: the batch stops taking entries once their rows
 * pass it (an entry over it on its own is a batch by itself).
 */
export const MAX_COMPACT_DETAIL_ROWS = 50_000;

/** Largest page of `ChangeHistoryService.runDetails`. */
export const MAX_DETAIL_PAGE = 500;

/**
 * Detail rows a run item of an entity timeline carries at most (`details`); `detailsTotal` says how many the run
 * has, the rest is paged through `changeHistoryRunDetails`.
 */
export const MAX_TIMELINE_RUN_DETAILS = 50;

export const DEFAULTS = {
  maxValueBytes: 16_384,
  archiveKeyPrefix: 'change-history-archive',
  detailDays: 90,
  summaryDays: 365,
  compactValueBytes: 1_024,
  schedule: { compact: '45 4 * * *', purge: '15 5 * * *' },
  compactBatchSize: 2_000,
  purgeBatchSize: 5_000,
  maxBatches: 20,
  acquireTimeoutMs: 500,
} as const;
