import { ID, Logger, ProcessContext, RequestContext, TransactionalConnection } from '@vendure/core';
import type { EntityManager } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoBeforeState } from '../before-state/before-state-strategy';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { BASE_GROUP, ChangeHistoryEntityDefinition, LoadedState } from '../entity-definitions/entity-definition';
import { resolveOptions } from '../options';
import { ChangeHistoryFieldChanges } from '../types';
import { ChangeHistoryContextService } from '../services/change-history-context.service';
import { ChangeHistoryStrategies } from '../services/change-history-strategies.service';
import { CapturePipeline } from './capture-pipeline';
import { ChangeHistoryWriter, EntryDraft } from './entry-writer.service';

type Rows = Record<string, Record<string, unknown> | undefined>;

const ADMIN = { id: 1, firstName: 'Olena', lastName: 'Koval' };

/**
 * The pipeline with its real collaborators (context, writer) on a fake database: `committed` is what the
 * before-state strategy reads, `current` what the transaction sees.
 */
function setup(
  options: {
    committed?: Rows | NoBeforeState | Error;
    current?: Rows;
    inTransaction?: boolean;
    enabled?: boolean;
    failSave?: boolean;
  } = {},
) {
  const committedManager = { name: 'committed' } as unknown as EntityManager;
  const queryRunner = options.inTransaction === false ? undefined : { isTransactionActive: true, isReleased: false };
  const saved: ChangeHistoryEntry[] = [];
  let nextId = 1;
  const transactionManager = {
    queryRunner,
    getRepository: () => ({ find: vi.fn(async () => []) }),
  } as unknown as EntityManager;
  const save = vi.fn(async (entries: ChangeHistoryEntry | ChangeHistoryEntry[]) => {
    if (options.failSave) {
      throw new Error('insert failed');
    }
    const list = Array.isArray(entries) ? entries : [entries];
    for (const entry of list) {
      entry.id = nextId++;
      saved.push(entry);
    }
    return entries;
  });
  const count = vi.fn(
    async ({ where }: { where: Partial<ChangeHistoryEntry> }) =>
      saved.filter((entry) => entry.batchId === where.batchId && entry.entityType === where.entityType).length,
  );
  const connection = {
    getRepository: () => ({ manager: transactionManager, save, count }),
    withTransaction: (ctx: RequestContext, work: (tctx: RequestContext) => Promise<unknown>) => work(ctx),
  } as unknown as TransactionalConnection;

  const rows = (side: Rows | undefined, ids: ID[], scope: ReadonlySet<string>) =>
    new Map<string, LoadedState>(
      ids
        .map(String)
        .filter((id) => side?.[id])
        .map((id) => {
          const { deleted, parentId, ...values } = side![id]!;
          const scoped = Object.fromEntries(Object.entries(values).filter(([k]) => scope.has(groupOf(k))));
          return [
            id,
            {
              values: scoped,
              groups: scope,
              label: `Item ${id}`,
              deleted: deleted === true,
              parentId: parentId as string,
            },
          ];
        }),
    );
  const groupOf = (key: string) => (key === 'facetValues' ? 'facetValues' : BASE_GROUP);
  const load = vi.fn(async (_ctx: RequestContext, ids: ID[], manager: EntityManager, scope: ReadonlySet<string>) =>
    rows(manager === committedManager ? (options.committed as Rows) : options.current, ids, scope),
  );
  const definition: ChangeHistoryEntityDefinition = {
    entityType: 'ProductVariant',
    parentType: 'Product',
    fullScope: new Set([BASE_GROUP, 'facetValues']),
    scopeFor: (input) => new Set([BASE_GROUP, ...('facetValueIds' in (input as object) ? ['facetValues'] : [])]),
    load,
    groupOf,
    kindOf: (key) => (key === 'facetValues' ? 'refs' : 'text'),
    addLabels: vi.fn(async (_ctx: RequestContext, _manager: EntityManager, changes: ChangeHistoryFieldChanges) => {
      for (const change of Object.values(changes)) {
        change.labels = { x: 'label' };
      }
    }),
  };

  const withCommittedReader = vi.fn(async (_ctx: RequestContext, fn: (m: EntityManager) => Promise<unknown>) => {
    if (options.committed instanceof Error) {
      throw options.committed;
    }
    if (options.committed && 'noBefore' in options.committed) {
      return options.committed;
    }
    return fn(committedManager);
  });
  const resolved = resolveOptions({ enabled: options.enabled, retention: { archive: 'none' } });
  const context = new ChangeHistoryContextService(
    resolved,
    { resolveActorAdministrator: async () => ADMIN } as never,
    { isWorker: false } as ProcessContext,
    connection,
  );
  const strategies = { beforeState: { withCommittedReader } } as unknown as ChangeHistoryStrategies;
  const pipeline = new CapturePipeline(
    resolved,
    connection,
    context,
    strategies,
    new ChangeHistoryWriter(connection, context),
  );
  const ctx = { apiType: 'admin', channel: { id: 1 } } as unknown as RequestContext;
  return { pipeline, definition, ctx, saved, load, withCommittedReader, context, save, connection };
}

const updated = { mode: 'updated' as const, action: 'updated', input: { id: 1 } };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CapturePipeline', () => {
  it('records the changed fields of an update, under the parent and the session actor', async () => {
    const { pipeline, definition, ctx, saved } = setup({
      committed: { '1': { sku: 'A', name: 'Shirt', parentId: '3' } },
      current: { '1': { sku: 'B', name: 'Shirt', parentId: '3' } },
    });
    await pipeline.run(ctx, definition, [1], updated);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      entityType: 'ProductVariant',
      entityId: '1',
      entityLabel: 'Item 1',
      parentType: 'Product',
      parentId: '3',
      action: 'updated',
      summary: '1 field: sku',
      changes: { sku: { kind: 'text', from: 'A', to: 'B', labels: { x: 'label' } } },
      actorType: 'admin',
      actorLabel: 'Olena Koval',
      source: 'admin',
      channelId: '1',
      derivedFromId: null,
    });
  });

  it('writes nothing for an update that changed nothing', async () => {
    const { pipeline, definition, ctx, saved } = setup({
      committed: { '1': { sku: 'A' } },
      current: { '1': { sku: 'A' } },
    });
    await pipeline.run(ctx, definition, [1], updated);
    expect(saved).toEqual([]);
  });

  it('records a creation with every value and without a committed read', async () => {
    const { pipeline, definition, ctx, saved, withCommittedReader, context } = setup({
      current: { '1': { sku: 'A' } },
    });
    await pipeline.run(ctx, definition, [1], { mode: 'created', action: 'created' });

    expect(withCommittedReader).not.toHaveBeenCalled();
    expect(saved[0]).toMatchObject({
      action: 'created',
      summary: 'created',
      changes: { sku: { from: null, to: 'A' } },
    });
    expect(context.transactionStateOf(ctx).createdIds.has('ProductVariant:1')).toBe(true);
  });

  it('records a deletion with the last committed state, but not a row deleted before', async () => {
    const { pipeline, definition, ctx, saved } = setup({
      committed: { '1': { sku: 'A' }, '2': { sku: 'B', deleted: true } },
      current: { '1': { sku: 'A', deleted: true }, '2': { sku: 'B', deleted: true } },
    });
    await pipeline.run(ctx, definition, [1, 2], { mode: 'deleted', action: 'deleted' });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      entityId: '1',
      action: 'deleted',
      summary: 'deleted',
      changes: null,
      meta: expect.objectContaining({ lastState: { sku: 'A' } }),
    });
    expect(saved[0].meta).not.toHaveProperty('noBefore');
  });

  it('keeps the kind and the labels of each non-text value of the last state', async () => {
    const { pipeline, definition, ctx, saved } = setup({
      committed: { '1': { sku: 'A', facetValues: ['7'] }, '2': { sku: 'B', facetValues: [] } },
      current: { '1': { sku: 'A', deleted: true }, '2': { sku: 'B', deleted: true } },
    });
    await pipeline.run(ctx, definition, [1, 2], { mode: 'deleted', action: 'deleted' });

    expect(saved.map((entry) => entry.meta.lastStateFields)).toEqual([
      // `sku` is text: no item. The id list carries its labels.
      { facetValues: { kind: 'refs', labels: { x: 'label' } } },
      // A blank value needs no kind.
      {},
    ]);
  });

  it.each([
    ['unsupported', { noBefore: 'unsupported' as const }],
    ['pool', { noBefore: 'pool' as const }],
    ['error', new Error('read failed')],
  ])('records an update without values when the before-state is unavailable (%s)', async (reason, committed) => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const { pipeline, definition, ctx, saved } = setup({ committed, current: { '1': { sku: 'B' } } });
    await pipeline.run(ctx, definition, [1], updated);

    expect(saved[0]).toMatchObject({
      action: 'updated',
      changes: null,
      summary: 'updated (details unavailable)',
      meta: expect.objectContaining({ noBefore: reason }),
    });
  });

  it('records a deletion without a before-state from the current row, unless one was recorded already', async () => {
    const { pipeline, definition, ctx, saved } = setup({
      committed: { noBefore: 'unsupported' },
      current: { '1': { sku: 'A', deleted: true } },
    });
    await pipeline.run(ctx, definition, [1], { mode: 'deleted', action: 'deleted' });
    expect(saved[0]).toMatchObject({
      meta: expect.objectContaining({ noBefore: 'unsupported', lastState: { sku: 'A' } }),
    });
  });

  it('does not read a committed row outside a transaction, and warns once', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const { pipeline, definition, ctx, saved, withCommittedReader } = setup({
      inTransaction: false,
      current: { '1': { sku: 'B' } },
    });
    await pipeline.run(ctx, definition, [1], updated);
    await pipeline.run(ctx, definition, [1], updated);

    expect(withCommittedReader).not.toHaveBeenCalled();
    expect(saved[0].meta).toMatchObject({ noBefore: 'no_transaction' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('diffs against an empty state when the row has no committed version', async () => {
    const { pipeline, definition, ctx, saved } = setup({ committed: {}, current: { '1': { sku: 'B' } } });
    await pipeline.run(ctx, definition, [1], updated);
    expect(saved[0]).toMatchObject({
      changes: { sku: { from: null, to: 'B' } },
      meta: expect.objectContaining({ noBefore: 'no_row' }),
    });
  });

  it('diffs a second save in the same transaction against the first one, reading only what it lacks', async () => {
    const { pipeline, definition, ctx, saved, load, withCommittedReader } = setup({
      committed: { '1': { sku: 'A', facetValues: ['7'] } },
      current: { '1': { sku: 'B', facetValues: ['7'] } },
    });
    await pipeline.run(ctx, definition, [1], updated);
    expect(saved).toHaveLength(1);

    // Second save: the transaction's own state is the before; facet values were not loaded by the first.
    await pipeline.run(ctx, definition, [1], { ...updated, input: { facetValueIds: [] } });
    expect(withCommittedReader).toHaveBeenCalledTimes(2);
    expect([...load.mock.calls[2][3]]).toEqual(['facetValues']);
    expect(saved).toHaveLength(1);

    // Third: everything is known; nothing is read.
    await pipeline.run(ctx, definition, [1], updated);
    expect(withCommittedReader).toHaveBeenCalledTimes(2);
  });

  it("links a child's entry to its parent's entry in the same transaction", async () => {
    const { pipeline, definition, ctx, saved, context } = setup({
      committed: { '1': { sku: 'A', parentId: '3' } },
      current: { '1': { sku: 'B', parentId: '3' } },
    });
    context.transactionStateOf(ctx).entriesByEntity.set('Product:3', 99);
    await pipeline.run(ctx, definition, [1], updated);
    expect(saved[0].derivedFromId).toBe(99);
  });

  it('records a save without a diff when the state of an earlier save in the transaction was evicted', async () => {
    const { pipeline, definition, ctx, saved, context } = setup({
      committed: { '1': { sku: 'A' } },
      current: { '1': { sku: 'C' } },
    });
    // The committed `A` would repeat the transaction's earlier A → B as part of this change.
    context.transactionStateOf(ctx).evicted.add('ProductVariant:1');
    await pipeline.run(ctx, definition, [1], updated);

    expect(saved[0]).toMatchObject({
      summary: 'updated (details unavailable)',
      changes: null,
      meta: expect.objectContaining({ noBefore: 'evicted' }),
    });
  });

  it('writes a batch head once, with the first member', async () => {
    const { pipeline, definition, ctx, saved, context } = setup({
      committed: { '1': { sku: 'A' }, '2': { sku: 'A' } },
      current: { '1': { sku: 'B' }, '2': { sku: 'B' } },
    });
    context.stateOf(ctx).batch = { kind: 'bulk_edit', id: 'bulk_edit:abc' };
    await pipeline.run(ctx, definition, [1], updated);
    await pipeline.run(ctx, definition, [2], updated);

    expect(saved.map((e) => [e.entityType, e.batchId])).toEqual([
      ['Batch', 'bulk_edit:abc'],
      ['ProductVariant', 'bulk_edit:abc'],
      ['ProductVariant', 'bulk_edit:abc'],
    ]);
    expect(saved[0]).toMatchObject({ entityId: 'abc', action: 'batch', entityLabel: 'bulk_edit' });
  });

  it('never rejects when the insert fails, and logs it', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { pipeline, definition, ctx } = setup({
      committed: { '1': { sku: 'A' } },
      current: { '1': { sku: 'B' } },
      failSave: true,
    });
    await expect(pipeline.run(ctx, definition, [1], updated)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[ChangeHistory] write failed in updated ProductVariant: insert failed'),
      'ChangeHistory',
      expect.any(String),
    );
  });

  it('compares only the fields a capture names, with the groups it asks for', async () => {
    const { pipeline, definition, ctx, saved, load } = setup({
      committed: { '1': { sku: 'A', name: 'Old' } },
      current: { '1': { sku: 'B', name: 'New' } },
    });
    const scope = new Set([BASE_GROUP]);
    await pipeline.run(ctx, definition, [1], { mode: 'updated', action: 'moved', scope, fields: ['name'] });

    expect(load.mock.calls.map((call) => [...call[3]])).toEqual([[BASE_GROUP], [BASE_GROUP]]);
    expect(saved[0]).toMatchObject({ action: 'moved', changes: { name: { from: 'Old', to: 'New' } } });
    expect(saved[0].changes).not.toHaveProperty('sku');
  });

  it("records a hard-deleted row without a before-state from the event's entity, with meta per id", async () => {
    const { pipeline, definition, ctx, saved } = setup({ committed: { noBefore: 'unsupported' }, current: {} });
    definition.fromEntity = (_ctx, entity) => ({
      values: { ...(entity as Record<string, unknown>) },
      groups: new Set([BASE_GROUP]),
      label: 'From the event',
      parentId: '3',
      deleted: false,
    });
    await pipeline.run(ctx, definition, [1, 2], {
      mode: 'deleted',
      action: 'deleted',
      entities: new Map([['1', { sku: 'GONE' }]]),
      metaById: new Map([['1', { usedByProducts: 4 }]]),
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      entityId: '1',
      entityLabel: 'From the event',
      parentId: '3',
      meta: expect.objectContaining({ usedByProducts: 4, noBefore: 'unsupported', lastState: { sku: 'GONE' } }),
    });
  });

  it('hands the drafts to the caller instead of writing them', async () => {
    const { pipeline, definition, ctx, saved } = setup({
      committed: { '1': { sku: 'A' } },
      current: {},
    });
    const collected: EntryDraft[] = [];
    await pipeline.run(ctx, definition, [1], { mode: 'deleted', action: 'deleted', collect: collected });

    expect(saved).toEqual([]);
    expect(collected).toEqual([expect.objectContaining({ entityId: '1', action: 'deleted' })]);
  });

  it("writes a write-only batch's head with its summary and parent, unless an outer batch runs", async () => {
    const { ctx, saved, context, connection } = setup({ current: {} });
    const writer = new ChangeHistoryWriter(connection, context);
    const draft = { entityType: 'Product', entityId: '5', entityLabel: 'P', action: 'collection_added', summary: 's' };
    const own = () => ({
      kind: 'collection_rules',
      id: `collection_rules:${saved.length}`,
      label: 'Sale',
      summary: '+1 / −0',
      parent: { type: 'Collection', id: '9' },
    });

    await writer.write(ctx, 'test', async () => [{ ...draft, derivedFromId: 77 }], { batch: own() });
    expect(saved.map((e) => [e.entityType, e.summary, e.parentType, e.parentId, e.derivedFromId])).toEqual([
      ['Batch', '+1 / −0', 'Collection', '9', null],
      ['Product', 's', null, null, 77],
    ]);

    context.stateOf(ctx).batch = { kind: 'bulk_edit', id: 'bulk_edit:outer' };
    context.transactionStateOf(ctx).markHead('bulk_edit:outer');
    await writer.write(ctx, 'test', async () => [draft], { batch: own() });
    expect(saved.at(-1)).toMatchObject({ entityType: 'Product', batchId: 'bulk_edit:outer' });
    expect(saved).toHaveLength(3);
  });

  it('does nothing when disabled or without ids', async () => {
    const off = setup({ enabled: false, current: { '1': { sku: 'B' } } });
    await off.pipeline.run(off.ctx, off.definition, [1], updated);
    const none = setup({ current: {} });
    await none.pipeline.run(none.ctx, none.definition, [], updated);
    expect(off.load).not.toHaveBeenCalled();
    expect(none.load).not.toHaveBeenCalled();
  });
});
