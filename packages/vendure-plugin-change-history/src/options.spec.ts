import { describe, expect, it } from 'vitest';
import { NoBeforeStateStrategy } from './before-state/no-before-state.strategy';
import { resolveOptions } from './options';
import { FileSystemArchiveStorage } from './retention/file-system-archive-storage';
import { ChangeHistoryFieldExtractor, ChangeHistoryPluginOptions } from './types';

const archive = new FileSystemArchiveStorage({ dir: '/tmp/change-history-test' });
const extractor = (entityType: string, key: string) =>
  ({ entityType, key, kind: 'json', load: async () => new Map() }) as unknown as ChangeHistoryFieldExtractor;

describe('resolveOptions', () => {
  it('applies every default with only the archive given', () => {
    expect(resolveOptions({ retention: { archive } })).toEqual({
      enabled: true,
      entities: {},
      fieldExtractors: [],
      actorResolvers: [],
      handlerOrder: {},
      beforeState: 'auto',
      maxValueBytes: 16_384,
      retention: {
        archive,
        archiveKeyPrefix: 'change-history-archive',
        detailDays: 90,
        summaryDays: 365,
        runLineDays: 90,
        compactValueBytes: 1_024,
        schedule: { compact: '45 4 * * *', purge: '15 5 * * *' },
        compactBatchSize: 2_000,
        purgeBatchSize: 5_000,
        maxBatches: 20,
      },
    });
  });

  it('keeps explicit values, the "none" archive and a strategy instance', () => {
    const beforeState = new NoBeforeStateStrategy();
    const resolved = resolveOptions({
      enabled: false,
      beforeState,
      maxValueBytes: 1_000,
      handlerOrder: { Product: { before: 'other-handler' } },
      retention: {
        archive: 'none',
        archiveKeyPrefix: 'archive/history/',
        detailDays: 30,
        summaryDays: 60,
        runLineDays: 10,
        schedule: false,
        batchSize: 100,
        maxBatches: 2,
      },
    });
    expect(resolved).toMatchObject({ enabled: false, beforeState, maxValueBytes: 1_000 });
    expect(resolved.retention).toMatchObject({
      archive: 'none',
      archiveKeyPrefix: 'archive/history',
      runLineDays: 10,
      schedule: false,
      compactBatchSize: 100,
      purgeBatchSize: 100,
      maxBatches: 2,
    });
  });

  it.each<[string, unknown, RegExp]>([
    ['no options', undefined, /options are required/],
    ['no retention', {}, /"retention.archive" is required/],
    ['no archive', { retention: {} }, /"retention.archive" is required/],
    ['an archive without put/exists', { retention: { archive: {} } }, /must be 'none' or an object/],
    ['a non-boolean kill switch', { enabled: 'false', retention: { archive } }, /"enabled" must be a boolean/],
    ['a fractional window', { retention: { archive, detailDays: 1.5 } }, /"retention.detailDays" must be a positive/],
    ['a detail window above the summary window', { retention: { archive, detailDays: 400 } }, /must not exceed/],
    ['a run window above the summary window', { retention: { archive, runLineDays: 400 } }, /"retention.runLineDays"/],
    ['a half schedule', { retention: { archive, schedule: { compact: '* * * * *' } } }, /"retention.schedule"/],
    ['an empty key prefix', { retention: { archive, archiveKeyPrefix: ' ' } }, /"retention.archiveKeyPrefix"/],
    ['a zero value cap', { maxValueBytes: 0, retention: { archive } }, /"maxValueBytes"/],
    ['an unknown entity', { entities: { Order: {} }, retention: { archive } }, /"entities.Order" is not one of/],
    [
      'entities that are not an object',
      { entities: 'Product', retention: { archive } },
      /"entities" must be an object/,
    ],
    [
      'an empty handler id',
      { handlerOrder: { Product: { after: '' } }, retention: { archive } },
      /"handlerOrder.Product.after" must be a non-empty handler id/,
    ],
    [
      'an extractor of an unknown entity',
      { fieldExtractors: [extractor('Order', 'x')], retention: { archive } },
      /unknown entityType "Order"/,
    ],
    [
      'an extractor without a key',
      { fieldExtractors: [extractor('Product', '')], retention: { archive } },
      /needs a key and a load\(\) function/,
    ],
    [
      'a duplicate extractor key',
      { fieldExtractors: [extractor('Product', 'x'), extractor('Product', 'x')], retention: { archive } },
      /registered twice for Product/,
    ],
    ['a nameless actor resolver', { actorResolvers: [{ resolve: () => undefined }], retention: { archive } }, /name/],
    ['an unknown before-state', { beforeState: 'committed', retention: { archive } }, /"beforeState" must be/],
  ])('rejects %s', (_case, options, message) => {
    expect(() => resolveOptions(options as ChangeHistoryPluginOptions)).toThrow(message);
  });

  it('allows the same extractor key on two entities', () => {
    expect(() =>
      resolveOptions({
        fieldExtractors: [extractor('Product', 'x'), extractor('ProductVariant', 'x')],
        retention: { archive },
      }),
    ).not.toThrow();
  });
});
