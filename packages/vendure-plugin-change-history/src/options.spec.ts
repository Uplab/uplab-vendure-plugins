import { describe, expect, it } from 'vitest';
import { NoBeforeStateStrategy } from './before-state/no-before-state.strategy';
import { CHANGE_HISTORY_READ_PERMISSIONS } from './constants';
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
      readPermissions: CHANGE_HISTORY_READ_PERMISSIONS,
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

  it.each([
    ['archive/history', 'archive/history'],
    ['archive/history///', 'archive/history'],
    ['a//b/', 'a//b'],
    ['/root/', '/root'],
  ])('drops the trailing slashes of the key prefix %j', (archiveKeyPrefix, expected) => {
    expect(resolveOptions({ retention: { archive, archiveKeyPrefix } }).retention.archiveKeyPrefix).toBe(expected);
  });

  it('drops trailing slashes in linear time, whatever the run of slashes', () => {
    // A backtracking `/\/+$/` takes quadratic time on a long run of slashes that does not end the string.
    const archiveKeyPrefix = `x${'/'.repeat(200_000)}x${'/'.repeat(200_000)}`;
    const started = performance.now();
    const { retention } = resolveOptions({ retention: { archive, archiveKeyPrefix } });
    expect(retention.archiveKeyPrefix).toBe(`x${'/'.repeat(200_000)}x`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('keeps explicit values, the "none" archive and a strategy instance', () => {
    const beforeState = new NoBeforeStateStrategy();
    const resolved = resolveOptions({
      enabled: false,
      beforeState,
      maxValueBytes: 1_000,
      handlerOrder: { Product: { before: 'other-handler' }, StockMovement: { after: 'stock-sync' } },
      readPermissions: { ProductOrder: 'ReadCatalog', Promotion: ['ReadPromotion', 'ReadMarketing'], Run: [] },
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
    expect(resolved.handlerOrder).toEqual({
      Product: { before: 'other-handler' },
      StockMovement: { after: 'stock-sync' },
    });
    // Over the core defaults: a host type, a replaced core type, a type opened to ReadChangeHistory alone.
    expect(resolved.readPermissions).toEqual({
      ...CHANGE_HISTORY_READ_PERMISSIONS,
      ProductOrder: ['ReadCatalog'],
      Promotion: ['ReadPromotion', 'ReadMarketing'],
      Run: [],
    });
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
    [
      'an empty actor resolver',
      { actorResolvers: [null], retention: { archive } },
      /every actor resolver needs a name/,
    ],
    [
      'an actor resolver without resolve()',
      { actorResolvers: [{ name: 'erp' }], retention: { archive } },
      /every actor resolver needs a name/,
    ],
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
      'an unknown handler',
      { handlerOrder: { Order: { after: 'x' } }, retention: { archive } },
      /"handlerOrder.Order" is not one of Product, .*StockMovement, Channel/,
    ],
    [
      'read permissions that are not an object',
      { readPermissions: ['ReadCatalog'], retention: { archive } },
      /"readPermissions" must be an object/,
    ],
    [
      'an empty read permission',
      { readPermissions: { ProductOrder: [''] }, retention: { archive } },
      /"readPermissions.ProductOrder" must be a permission name/,
    ],
    [
      'a read permission that is not a string',
      { readPermissions: { ProductOrder: 7 }, retention: { archive } },
      /"readPermissions.ProductOrder" must be a permission name/,
    ],
    [
      'an entity type longer than its column',
      { readPermissions: { ['T'.repeat(33)]: 'ReadCatalog' }, retention: { archive } },
      /an entity type is 1–32 characters/,
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

  it('keeps the actor resolvers it is given', () => {
    const resolver = { name: 'erp', resolve: () => undefined };
    expect(resolveOptions({ actorResolvers: [resolver], retention: { archive } }).actorResolvers).toEqual([resolver]);
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
