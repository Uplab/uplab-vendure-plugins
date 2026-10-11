import { Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeHistoryDetail } from '../entities/change-history-detail.entity';
import { resolveOptions } from '../options';
import { ARCHIVE_TABLES } from '../retention/jsonl';
import { ChangeHistoryContextService } from './change-history-context.service';
import { ChangeHistoryRetentionService } from './change-history-retention.service';

const COLUMNS = [
  { propertyName: 'id', databaseName: 'id', type: 'int' },
  { propertyName: 'createdAt', databaseName: 'createdAt', type: 'timestamp', isCreateDate: true },
  { propertyName: 'entityType', databaseName: 'entityType', type: 'varchar' },
  { propertyName: 'action', databaseName: 'action', type: 'varchar' },
  { propertyName: 'changes', databaseName: 'changes', type: 'simple-json' },
  { propertyName: 'meta', databaseName: 'meta', type: 'simple-json' },
  { propertyName: 'compactedAt', databaseName: 'compactedAt', type: 'timestamp' },
];

/**
 * The service on a fake connection: every query builder resolves `getRawMany` from one queue, in call order.
 * `deleted` collects the ids of each `DELETE`, `query` the raw `INSERT`s.
 */
function setup(rawMany: unknown[][] = []) {
  const queue = [...rawMany];
  const deleted: unknown[] = [];
  const update = vi.fn(async () => undefined);
  const query = vi.fn(async () => undefined);
  const queryBuilder = () => {
    const qb: Record<string, unknown> = {};
    for (const method of [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'groupBy',
      'limit',
      'offset',
    ]) {
      qb[method] = () => qb;
    }
    qb.getRawMany = async () => queue.shift() ?? [];
    qb.delete = () => ({
      where: (condition: unknown) => ({
        execute: async () => {
          deleted.push(condition);
        },
      }),
    });
    return qb;
  };
  const connection = {
    getRepository: () => ({ createQueryBuilder: queryBuilder, update, manager: { query } }),
    withTransaction: (ctx: RequestContext, work: (tctx: RequestContext) => Promise<unknown>) => work(ctx),
    rawConnection: {
      options: { type: 'postgres' },
      driver: {
        escape: (name: string) => `"${name}"`,
        escapeQueryWithParameters: (sql: string, parameters: Record<string, unknown>) => [
          sql,
          Object.values(parameters),
        ],
      },
      getMetadata: (target: unknown) => ({
        columns: COLUMNS,
        tablePath: target === ChangeHistoryDetail ? 'change_history_detail' : 'change_history_entry',
      }),
    },
  } as unknown as TransactionalConnection;
  const context = {
    serialize: (_ctx: RequestContext, fn: () => Promise<unknown>) => fn(),
  } as unknown as ChangeHistoryContextService;
  const options = resolveOptions({ retention: { archive: 'none' } });
  const service = new ChangeHistoryRetentionService(options, connection, context);
  return { service, ctx: {} as RequestContext, update, query, deleted, queue };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChangeHistoryRetentionService.purge', () => {
  it('stops at maxBatches and reports a backlog that is left', async () => {
    const { service, ctx, deleted } = setup([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
    const result = await service.purge(ctx, { olderThanDays: 365, batchSize: 2, maxBatches: 1 });

    expect(result).toEqual({ scanned: 2, deleted: 2, batches: 1, drained: false });
    // The detail rows first, then the entries.
    expect(deleted).toHaveLength(2);
  });

  it('reports a backlog cut exactly at maxBatches as drained', async () => {
    const { service, ctx } = setup([[{ id: 1 }, { id: 2 }], []]);
    const result = await service.purge(ctx, { olderThanDays: 365, batchSize: 2, maxBatches: 1, dryRun: true });
    expect(result).toEqual({ scanned: 2, deleted: 0, batches: 1, drained: true });
  });

  it('drains on a short batch without another backlog check', async () => {
    const { service, ctx, queue } = setup([[{ id: 1 }], [{ id: 2 }]]);
    const result = await service.purge(ctx, { olderThanDays: 365, batchSize: 2, maxBatches: 1 });
    expect(result).toEqual({ scanned: 1, deleted: 1, batches: 1, drained: true });
    expect(queue).toEqual([[{ id: 2 }]]);
  });
});

describe('ChangeHistoryRetentionService.compact', () => {
  it('is drained at once when nothing is old enough', async () => {
    const { service, ctx, queue } = setup([[], [{ id: 1 }]]);
    const result = await service.compact(ctx, { olderThanDays: 90, maxBatches: 1, dryRun: true });
    expect(result).toMatchObject({ scanned: 0, batches: 0, drained: true });
    expect(queue).toEqual([[{ id: 1 }]]);
  });

  const entry = (id: number, meta: string | null) => ({
    id,
    createdAt: '2024-01-01 00:00:00',
    entityType: 'Product',
    action: 'updated',
    changes: JSON.stringify({ name: { kind: 'text', from: 'A', to: 'B' } }),
    meta,
  });

  it('compacts a batch without an archive copy, stops at maxBatches and checks the oldest rows again', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const { service, ctx, queue, deleted, update } = setup([
      [entry(1, null), entry(2, '{"source":"x"}')], // the batch
      [], // their detail row counts
      [], // their detail rows
      [], // derived entry counts of the kept entries
      [entry(3, null)], // the backlog check, from the start (a real run changed what it read)
    ]);
    const result = await service.compact(ctx, { olderThanDays: 90, batchSize: 2, maxBatches: 1 });

    expect(result).toMatchObject({ scanned: 2, archived: 0, archiveKeys: [], batches: 1, drained: false });
    expect(queue).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      '[ChangeHistory] compacting without an archive copy (retention.archive is "none")',
      'ChangeHistory',
    );
    // The detail rows of both entries leave; no entry is deleted (neither is derived, a member or a run line).
    expect(deleted).toHaveLength(1);
    // Both kept entries are marked compacted.
    const compacted = update.mock.calls.flatMap((call) => {
      const [criteria] = call as unknown as [unknown];
      return typeof criteria === 'number' ? [criteria] : [...(criteria as { id: { value: number[] } }).id.value];
    });
    expect(compacted.sort()).toEqual([1, 2]);
  });

  it.each([
    ['an Error', new Error('progress down'), 'progress down'],
    ['a string', 'progress down', 'progress down'],
    ['null', null, 'null'],
  ])(
    'stops a dry run at maxBatches, reports the backlog and survives a progress callback throwing %s',
    async (_kind, thrown, message) => {
      const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
      const { service, ctx, queue } = setup([
        [entry(1, null), entry(2, '{"source":"x"}')], // the batch
        [], // their detail row counts
        [], // their detail rows
        [entry(3, null)], // the backlog check
      ]);
      const result = await service.compact(ctx, {
        olderThanDays: 90,
        batchSize: 2,
        maxBatches: 1,
        dryRun: true,
        onProgress: () => {
          throw thrown;
        },
      });

      expect(result).toMatchObject({ scanned: 2, archived: 0, stripped: 0, batches: 1, drained: false });
      expect(queue).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        `[ChangeHistory] retention progress callback failed: ${message}`,
        'ChangeHistory',
      );
    },
  );
});

describe('ChangeHistoryRetentionService.restore', () => {
  it('restores the values of an existing entry and inserts the missing rows, skipping absent columns', async () => {
    const { service, ctx, update, query } = setup([[{ id: 1 }], []]);
    const result = await service.restore(ctx, [
      { table: ARCHIVE_TABLES.entry, row: { id: 1, changes: null, meta: null } },
      { table: ARCHIVE_TABLES.entry, row: { id: 2, entityType: 'Product', action: 'updated', meta: { a: 1 } } },
      { table: ARCHIVE_TABLES.detail, row: { id: 9, entityType: 'ProductVariant' } },
    ]);

    expect(result).toEqual({ entriesUpdated: 1, entriesInserted: 1, detailsInserted: 1 });
    // A null `changes` / `meta` comes back as null / {}.
    expect(update).toHaveBeenCalledWith(1, { changes: null, meta: {} });
    expect(query.mock.calls).toEqual([
      [
        'INSERT INTO "change_history_entry" ("id", "entityType", "action", "meta", "compactedAt") ' +
          'VALUES (:p0, :p2, :p3, :p5, CURRENT_TIMESTAMP)',
        [2, 'Product', 'updated', '{"a":1}'],
      ],
      ['INSERT INTO "change_history_detail" ("id", "entityType") VALUES (:p0, :p2)', [9, 'ProductVariant']],
    ]);
  });
});
