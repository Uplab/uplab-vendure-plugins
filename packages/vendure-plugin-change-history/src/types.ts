import { ID, RequestContext, VendureEvent } from '@vendure/core';
import type { EntityManager } from 'typeorm';
import { BeforeStateStrategy } from './before-state/before-state-strategy';
import { CHANGE_HISTORY_ACTOR_TYPES, CHANGE_HISTORY_HANDLER_IDS } from './constants';
import { ChangeHistoryArchiveStorage } from './retention/archive-storage';

/** The core catalogue entities whose changes the package captures from Vendure events. */
export type ChangeHistoryCoreEntityType =
  'Product' | 'ProductVariant' | 'Collection' | 'Facet' | 'FacetValue' | 'Asset' | 'Promotion';

/**
 * @description
 * How the dashboard renders a changed value. Hosts may add kinds; the dashboard then needs a renderer
 * registered for them (`registerChangeHistoryValueRenderer`).
 */
export type ChangeHistoryValueKind =
  | 'text'
  | 'richtext'
  | 'money'
  | 'bool'
  | 'date'
  | 'enum'
  | 'ref'
  | 'refs'
  | 'assets'
  | 'prices'
  | 'json'
  | 'stock'
  | (string & {});

/** One changed field of an entry: `from` → `to`, or `added` / `removed` ids for lists. */
export interface ChangeHistoryFieldChange {
  from?: unknown;
  to?: unknown;
  kind?: ChangeHistoryValueKind;
  added?: string[];
  removed?: string[];
  reordered?: boolean;
  /** Display labels of the ids inside the value. */
  labels?: Record<string, string>;
  /** A side was longer than `maxValueBytes`; head and tail are kept. */
  truncated?: boolean;
  /** Compaction replaced the values with their lengths. */
  stripped?: boolean;
  fromLength?: number;
  toLength?: number;
  [extra: string]: unknown;
}

/** The `changes` of an entry, keyed by field (`name.en`, `customFields.price`, `facetValues`, …). */
export type ChangeHistoryFieldChanges = Record<string, ChangeHistoryFieldChange>;

/**
 * @description
 * How the dashboard renders one value of a deleted entity's `meta.lastState`, kept next to it in
 * `meta.lastStateFields`: the value's kind and the display labels of the ids inside it. A key without an item
 * is plain text; entries recorded before these were kept have no `lastStateFields` at all.
 */
export interface ChangeHistoryLastStateField {
  kind: ChangeHistoryValueKind;
  labels?: Record<string, string>;
}

/**
 * @description
 * Per built-in entity: noise filters, readonly exceptions, value kinds, label. Hosts tune the built-in
 * capture definitions, they do not replace them.
 */
export interface ChangeHistoryEntityOverrides {
  /** Keys of the normalised view to drop (noise written by jobs). Added to the built-in list. */
  ignoreFields?: string[];
  /** Readonly custom fields that ARE meaningful (by default every `readonly: true` custom field is ignored). */
  includeReadonlyCustomFields?: string[];
  /** Value kind per key when the custom-field type is not enough (an `int` that is money). */
  fieldKinds?: Record<string, ChangeHistoryValueKind>;
  /** Label snapshot override (default: name in the request language, variants add the SKU). */
  label?: (entity: any, ctx: RequestContext) => string;
}

/**
 * @description
 * Adds a field to an entity's history view, e.g. a value a plugin keeps in its own table. Loaded on both
 * sides of the diff with the respective manager.
 */
export interface ChangeHistoryFieldExtractor {
  entityType: ChangeHistoryCoreEntityType;
  /** Key in the normalised view and in `changes`. Must not collide with built-in keys. */
  key: string;
  kind: ChangeHistoryValueKind;
  /**
   * Load the value for each id. Called twice per capture with different managers: the committed reader
   * (before) and the transaction's manager (after). Must only read.
   */
  load(ctx: RequestContext, ids: ID[], manager: EntityManager): Promise<Map<string, unknown>>;
  /** Top-level mutation `input` keys that can change this value. Omit to always load it. */
  inputKeys?: string[];
  /** Labels for ids inside the value, loaded after the diff for changed ids only. */
  labels?(ctx: RequestContext, ids: ID[], manager: EntityManager): Promise<Record<string, string>>;
}

/** Who made a change, as recorded on an entry. */
export interface ResolvedActor {
  actorType: (typeof CHANGE_HISTORY_ACTOR_TYPES)[keyof typeof CHANGE_HISTORY_ACTOR_TYPES];
  /** Administrator id for `admin` / `api_key`. */
  actorId?: ID;
  actorLabel?: string;
  /** One of `CHANGE_HISTORY_SOURCES` or a host source. */
  source: string;
  meta?: Record<string, unknown>;
}

/**
 * @description
 * A host resolver in the actor chain, tried after a `runBatch` actor override and before the built-in
 * session resolver. Return `undefined` to pass to the next one; a resolver that throws is skipped.
 */
export interface ChangeHistoryActorResolver {
  name: string;
  resolve(ctx: RequestContext, event?: VendureEvent): Promise<ResolvedActor | undefined> | ResolvedActor | undefined;
}

/** One row of an external run: a value the host changed outside Vendure's events. */
export interface ChangeHistoryDetailInput {
  /** `ProductVariant`, or a host type. */
  entityType: ChangeHistoryCoreEntityType | (string & {});
  entityId: ID;
  /** Omit for `ProductVariant` / `FacetValue`: the package resolves the Product / Facet itself. */
  parent?: { type: string; id: ID };
  /** Dashboard detail-renderer key (e.g. `stock`). */
  kind: string;
  /** E.g. a stock location id. */
  scope?: string;
  /** Snapshot label of the scope, at most 128 characters. */
  scopeLabel?: string;
  /** Small JSON values. */
  from: unknown;
  to: unknown;
}

/** What a run was about (`ChangeHistoryRunInput.subject`). */
export interface ChangeHistoryRunSubject {
  /** E.g. `'SO-1042'`. At most 255 characters. */
  label: string;
  /** An entity type, e.g. `'Order'`. */
  type?: string;
  id?: ID;
}

/** An external sync run (`recordRun`): one `Run` entry plus its detail rows. */
export interface ChangeHistoryRunInput {
  /** E.g. `erp_stock_sync`. */
  source: string;
  /** Stored as the entry's label. */
  label: string;
  /** The pseudo entity the run belongs to. Default: `source`. */
  entityId?: string;
  /**
   * What the run was about, when it was about one thing: the order whose stock a run refreshed, the file an
   * import read. Stored as `meta.subject`, its label also in the entry's `subjectLabel`, which the feed's search
   * matches; the dashboard shows the label as the run's object (a link when `type` is an entity type it can
   * open).
   */
  subject?: ChangeHistoryRunSubject;
  /** E.g. `{ updated: 37, failed: 0 }`. */
  counts: Record<string, number>;
  durationMs?: number;
  meta?: Record<string, unknown>;
  /** May be empty; then an entry is written only when a count is non-zero. */
  details: ChangeHistoryDetailInput[];
}

/** An action-only entry (`recordAction`): no diff, no before-read. */
export interface ChangeHistoryActionInput {
  /** A core type or a host type. */
  entityType: string;
  entityId: ID;
  entityLabel: string;
  action: string;
  parent?: { type: string; id: ID };
  summary?: string;
  meta?: Record<string, unknown>;
}

/** Groups every entry written inside `runBatch`'s callback. */
export interface ChangeHistoryBatchInput {
  /** At most 27 characters (`<kind>:<uuid>` fits the `batchId` column); letters, digits, `_`, `-`, `.`. */
  kind: string;
  label?: string;
  /** Records every member under this actor instead of the request's. */
  actor?: ResolvedActor;
  meta?: Record<string, unknown>;
}

export interface ChangeHistoryCaptureOptions {
  action: string;
  /** The rows were just created: the before-state is empty, nothing committed is read. */
  created?: boolean;
  meta?: Record<string, unknown>;
}

/** Options of {@link ChangeHistoryRetentionService.compact} and `purge`. */
export interface RetentionRunOptions {
  olderThanDays: number;
  batchSize?: number;
  maxBatches?: number;
  /**
   * `compact` only: detail rows (of external runs) one batch loads and archives at most. A batch stops taking
   * entries once their rows would pass it; an entry over it on its own is a batch by itself. Default 50,000.
   */
  maxDetailRows?: number;
  dryRun?: boolean;
  /** Called with the running total after each batch; errors are swallowed. */
  onProgress?: (affected: number) => Promise<void> | void;
}

export interface ChangeHistoryRetentionOptions {
  /** Where the full record goes before compaction. `'none'` is an explicit opt-out (logged at boot). */
  archive: ChangeHistoryArchiveStorage | 'none';
  /** Default `'change-history-archive'`. */
  archiveKeyPrefix?: string;
  /** Full detail is kept this many days. Default 90. */
  detailDays?: number;
  /** Compacted entries are kept this many days. Default 365. */
  summaryDays?: number;
  /** `Run` entries are deleted at compaction after this many days. Default `detailDays`. */
  runLineDays?: number;
  /** Longer text values are stripped to a marker at compaction. Default 1024 bytes. */
  compactValueBytes?: number;
  /**
   * Built-in scheduling via Vendure `ScheduledTask`s (cron expressions). `false` = the host calls
   * `ChangeHistoryRetentionService` from its own scheduler.
   * Default `{ compact: '45 4 * * *', purge: '15 5 * * *' }`.
   */
  schedule?: { compact: string; purge: string } | false;
  /** Rows per batch. Default 2000 for compaction, 5000 for purge. */
  batchSize?: number;
  /** Batches per run. Default 20. */
  maxBatches?: number;
}

/** A blocking event handler of the package, named as in `CHANGE_HISTORY_HANDLER_IDS`. */
export type ChangeHistoryHandlerName = keyof typeof CHANGE_HISTORY_HANDLER_IDS;

/** `handlerOrder`: per handler of the package, the one other handler id it runs before and / or after. */
export type ChangeHistoryHandlerOrder = Partial<Record<ChangeHistoryHandlerName, { before?: string; after?: string }>>;

/**
 * @description
 * Options of {@link ChangeHistoryPlugin.init}. Only `retention.archive` is required.
 */
export interface ChangeHistoryPluginOptions {
  /** Kill switch, read once per process. Default `true`. Hosts map their env variable here. */
  enabled?: boolean;
  /** Per built-in entity: noise filters, readonly exceptions, value kinds, label. */
  entities?: Partial<Record<ChangeHistoryCoreEntityType, ChangeHistoryEntityOverrides>>;
  /** Extra fields of the history view, loaded on both sides of the diff. */
  fieldExtractors?: ChangeHistoryFieldExtractor[];
  /** Host actor resolvers, tried before the built-in ones. */
  actorResolvers?: ChangeHistoryActorResolver[];
  /**
   * Ordering of the package's blocking event handlers relative to other handlers, per handler (the keys of
   * `CHANGE_HISTORY_HANDLER_IDS`): `{ Product: { before: 'some-handler-id' } }`. Vendure takes one id per side
   * and silently ignores an id that is not registered. For a handler the host owns, declaring
   * `after: CHANGE_HISTORY_HANDLER_IDS.Product` on that handler is the equivalent.
   */
  handlerOrder?: ChangeHistoryHandlerOrder;
  /**
   * What a reader needs besides `ReadChangeHistory` to read the entries of an entity type: any one of the
   * listed permissions, in the entry's channel. Merged over `CHANGE_HISTORY_READ_PERMISSIONS` (the core
   * types); give your own types theirs (`{ ProductOrder: ['ReadCatalog'] }`). A type nobody lists, and one
   * given `[]`, needs `ReadChangeHistory` only.
   */
  readPermissions?: Record<string, string | string[]>;
  /**
   * `'auto'` (default): committed-row on postgres / aurora-postgres / mysql / aurora-mysql / mariadb, no
   * before-state on SQLite and any other driver (boot warning). Or a strategy instance.
   */
  beforeState?: 'auto' | BeforeStateStrategy;
  /** Cap per side of a stored value, in bytes. Default 16384. */
  maxValueBytes?: number;
  /** Required: the host must say where the archive goes. */
  retention: ChangeHistoryRetentionOptions;
}

export interface ResolvedChangeHistoryRetentionOptions {
  archive: ChangeHistoryArchiveStorage | 'none';
  archiveKeyPrefix: string;
  detailDays: number;
  summaryDays: number;
  runLineDays: number;
  compactValueBytes: number;
  schedule: { compact: string; purge: string } | false;
  compactBatchSize: number;
  purgeBatchSize: number;
  maxBatches: number;
}

/** {@link ChangeHistoryPluginOptions} with every default applied, provided under `CHANGE_HISTORY_PLUGIN_OPTIONS`. */
export interface ResolvedChangeHistoryPluginOptions {
  enabled: boolean;
  entities: Partial<Record<ChangeHistoryCoreEntityType, ChangeHistoryEntityOverrides>>;
  fieldExtractors: ChangeHistoryFieldExtractor[];
  actorResolvers: ChangeHistoryActorResolver[];
  handlerOrder: ChangeHistoryHandlerOrder;
  /** `CHANGE_HISTORY_READ_PERMISSIONS` with the host's entries over it. */
  readPermissions: Record<string, readonly string[]>;
  beforeState: 'auto' | BeforeStateStrategy;
  maxValueBytes: number;
  retention: ResolvedChangeHistoryRetentionOptions;
}
