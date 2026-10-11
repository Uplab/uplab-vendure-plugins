import { DEFAULTS } from './constants';
import { ChangeHistoryCoreEntityType, ChangeHistoryPluginOptions, ResolvedChangeHistoryPluginOptions } from './types';

const CORE_ENTITY_TYPES: readonly ChangeHistoryCoreEntityType[] = [
  'Product',
  'ProductVariant',
  'Collection',
  'Facet',
  'FacetValue',
  'Asset',
  'Promotion',
];

class OptionsError extends Error {
  constructor(message: string) {
    super(`ChangeHistoryPlugin: ${message}`);
  }
}

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new OptionsError(`"${name}" must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function checkEntityKeys(name: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isObject(value)) {
    throw new OptionsError(`"${name}" must be an object keyed by entity type`);
  }
  for (const key of Object.keys(value)) {
    if (!CORE_ENTITY_TYPES.includes(key as ChangeHistoryCoreEntityType)) {
      throw new OptionsError(`"${name}.${key}" is not one of ${CORE_ENTITY_TYPES.join(', ')}`);
    }
  }
}

function resolveRetention(retention: ChangeHistoryPluginOptions['retention']) {
  if (!isObject(retention) || retention.archive === undefined || retention.archive === null) {
    throw new OptionsError(
      '"retention.archive" is required: pass an archive storage (e.g. new FileSystemArchiveStorage({ dir })) or \'none\'',
    );
  }
  const { archive } = retention;
  if (archive !== 'none' && (typeof archive.put !== 'function' || typeof archive.exists !== 'function')) {
    throw new OptionsError('"retention.archive" must be \'none\' or an object with put() and exists()');
  }
  const detailDays = positiveInteger('retention.detailDays', retention.detailDays, DEFAULTS.detailDays);
  const summaryDays = positiveInteger('retention.summaryDays', retention.summaryDays, DEFAULTS.summaryDays);
  const runLineDays = positiveInteger('retention.runLineDays', retention.runLineDays, detailDays);
  if (detailDays > summaryDays) {
    throw new OptionsError(`"retention.detailDays" (${detailDays}) must not exceed "summaryDays" (${summaryDays})`);
  }
  if (runLineDays > summaryDays) {
    throw new OptionsError(`"retention.runLineDays" (${runLineDays}) must not exceed "summaryDays" (${summaryDays})`);
  }
  const { schedule } = retention;
  if (
    schedule !== undefined &&
    schedule !== false &&
    !(isObject(schedule) && nonEmptyString(schedule.compact) && nonEmptyString(schedule.purge))
  ) {
    throw new OptionsError('"retention.schedule" must be false or { compact: <cron>, purge: <cron> }');
  }
  const prefix = retention.archiveKeyPrefix ?? DEFAULTS.archiveKeyPrefix;
  if (!nonEmptyString(prefix)) {
    throw new OptionsError('"retention.archiveKeyPrefix" must be a non-empty string');
  }
  return {
    archive,
    archiveKeyPrefix: withoutTrailingSlashes(prefix),
    detailDays,
    summaryDays,
    runLineDays,
    compactValueBytes: positiveInteger(
      'retention.compactValueBytes',
      retention.compactValueBytes,
      DEFAULTS.compactValueBytes,
    ),
    schedule: schedule === false ? (false as const) : { ...DEFAULTS.schedule, ...schedule },
    compactBatchSize: positiveInteger('retention.batchSize', retention.batchSize, DEFAULTS.compactBatchSize),
    purgeBatchSize: positiveInteger('retention.batchSize', retention.batchSize, DEFAULTS.purgeBatchSize),
    maxBatches: positiveInteger('retention.maxBatches', retention.maxBatches, DEFAULTS.maxBatches),
  };
}

/** `'archive/history//'` → `'archive/history'`: linear, unlike a `/\/+$/` regex on a long run of slashes. */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) {
    end--;
  }
  return value.slice(0, end);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Applies the defaults and fails fast with a readable message on anything the plugin could not work with.
 */
export function resolveOptions(options: ChangeHistoryPluginOptions): ResolvedChangeHistoryPluginOptions {
  if (!isObject(options)) {
    throw new OptionsError('options are required, at least { retention: { archive } }');
  }
  if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
    throw new OptionsError(`"enabled" must be a boolean, got ${typeof options.enabled}`);
  }

  checkEntityKeys('entities', options.entities);

  checkEntityKeys('handlerOrder', options.handlerOrder);
  for (const [type, order] of Object.entries(options.handlerOrder ?? {})) {
    for (const side of ['before', 'after'] as const) {
      const id = order?.[side];
      if (id !== undefined && !nonEmptyString(id)) {
        throw new OptionsError(`"handlerOrder.${type}.${side}" must be a non-empty handler id`);
      }
    }
  }

  const extractorKeys = new Set<string>();
  for (const extractor of options.fieldExtractors ?? []) {
    if (!CORE_ENTITY_TYPES.includes(extractor?.entityType)) {
      throw new OptionsError(
        `field extractor "${extractor?.key}" has an unknown entityType "${extractor?.entityType}"`,
      );
    }
    if (!nonEmptyString(extractor.key) || typeof extractor.load !== 'function') {
      throw new OptionsError(`every field extractor of ${extractor.entityType} needs a key and a load() function`);
    }
    const id = `${extractor.entityType}.${extractor.key}`;
    if (extractorKeys.has(id)) {
      throw new OptionsError(`field extractor key "${extractor.key}" is registered twice for ${extractor.entityType}`);
    }
    extractorKeys.add(id);
  }

  for (const resolver of options.actorResolvers ?? []) {
    if (!nonEmptyString(resolver?.name) || typeof resolver.resolve !== 'function') {
      throw new OptionsError('every actor resolver needs a name and a resolve() function');
    }
  }

  const beforeState = options.beforeState ?? 'auto';
  if (beforeState !== 'auto' && (!isObject(beforeState) || typeof beforeState.withCommittedReader !== 'function')) {
    throw new OptionsError('"beforeState" must be \'auto\' or a BeforeStateStrategy instance');
  }

  return {
    enabled: options.enabled ?? true,
    entities: options.entities ?? {},
    fieldExtractors: options.fieldExtractors ?? [],
    actorResolvers: options.actorResolvers ?? [],
    handlerOrder: options.handlerOrder ?? {},
    beforeState,
    maxValueBytes: positiveInteger('maxValueBytes', options.maxValueBytes, DEFAULTS.maxValueBytes),
    retention: resolveRetention(options.retention),
  };
}
