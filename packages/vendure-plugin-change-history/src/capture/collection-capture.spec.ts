import {
  Collection,
  CollectionEvent,
  CollectionModificationEvent,
  ID,
  Logger,
  Product,
  ProductVariant,
  RequestContext,
  TransactionalConnection,
} from '@vendure/core';
import type { EntityManager } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeHistoryCollectionMembers } from '../entities/change-history-collection-members.entity';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
import { BatchState, ChangeHistoryContextService } from '../services/change-history-context.service';
import { ResolvedChangeHistoryPluginOptions } from '../types';
import { CapturePipeline } from './capture-pipeline';
import { CAPTURE_OFF_MARKER, CollectionCapture } from './collection-capture';
import { ChangeHistoryWriter, EntryDraft } from './entry-writer.service';
import { TransactionState } from './transaction-state';

const ctx = { languageCode: 'en' } as unknown as RequestContext;

/** A chainable query builder whose terminal calls answer `one` / `raw`. */
function queryBuilder(result: { one?: unknown; raw?: unknown[] }) {
  const qb: Record<string, unknown> = {};
  for (const method of ['select', 'addSelect', 'where', 'andWhere', 'innerJoin', 'distinct', 'setLock']) {
    qb[method] = () => qb;
  }
  qb.getOne = async () => result.one ?? null;
  qb.getRawMany = async () => result.raw ?? [];
  return qb;
}

/**
 * A fake database for one collection: its snapshot (`null` = none), whether it still exists, the products its
 * variants are in now, the products that still exist and the display names of products and collections.
 */
function fakeManager(
  db: {
    snapshot?: string[] | null;
    exists?: boolean;
    current?: string[];
    live?: string[];
    collectionNames?: Record<string, string>;
    productNames?: Record<string, string>;
    root?: { id: ID } | null;
  } = {},
) {
  const rowsOf = (names: Record<string, string> = {}) =>
    Object.entries(names).map(([id, name]) => ({ id, name, translations: [] }));
  const manager = {
    connection: { options: { type: 'sqljs' }, getMetadata: () => ({ relations: [] }) },
    getRepository: (target: unknown) => {
      if (target === ChangeHistoryCollectionMembers) {
        const one = db.snapshot ? { collectionId: '5', productIds: db.snapshot } : null;
        return { createQueryBuilder: () => queryBuilder({ one }) };
      }
      if (target === Collection) {
        return {
          count: async () => (db.exists === false ? 0 : 1),
          find: async () => rowsOf(db.collectionNames),
          findOne: vi.fn(async () => (db.root === undefined ? { id: 1 } : db.root)),
        };
      }
      return { find: async () => rowsOf(db.productNames) };
    },
    createQueryBuilder: (target: unknown) => {
      if (target === ProductVariant) {
        return queryBuilder({ raw: (db.current ?? []).map((productId) => ({ collectionId: '5', productId })) });
      }
      if (target === Product) {
        return queryBuilder({ raw: (db.live ?? []).map((id) => ({ id })) });
      }
      throw new Error(`unexpected query on ${String(target)}`);
    },
    delete: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  };
  return manager;
}

/**
 * The connection's own manager as the boot sees it: whether the capture-off marker is there, the collections,
 * the snapshots it has; records what is inserted and deleted.
 */
function bootManager(db: { marker?: boolean; collections?: string[]; snapshots?: string[] } = {}) {
  const inserted: Array<{ collectionId: string; productIds: string[] }> = [];
  const deleted: unknown[] = [];
  const manager = {
    count: vi.fn(async () => (db.marker ? 1 : 0)),
    transaction: vi.fn(async (work: (manager: unknown) => Promise<unknown>) => work(manager)),
    delete: vi.fn(async (_target: unknown, where: unknown) => {
      deleted.push(where);
    }),
    createQueryBuilder: (target?: unknown) => {
      if (target === Collection) {
        return queryBuilder({ raw: (db.collections ?? []).map((id) => ({ id })) });
      }
      if (target === ChangeHistoryCollectionMembers) {
        return queryBuilder({ raw: (db.snapshots ?? []).map((collectionId) => ({ collectionId })) });
      }
      if (target === ProductVariant) {
        return queryBuilder({ raw: [{ collectionId: '5', productId: '7' }] });
      }
      return {
        insert: () => ({
          into: () => ({
            values: (rows: typeof inserted) => ({
              orIgnore: () => ({
                execute: async () => {
                  inserted.push(...rows);
                },
              }),
            }),
          }),
        }),
      };
    },
  };
  return { manager, inserted, deleted };
}

/**
 * The capture with mocked collaborators. `run` stands in for the pipeline (records its requests);
 * the writer runs the work it is given on the same context and hands back what it produced.
 */
function setup(
  options: {
    enabled?: boolean;
    inTransaction?: boolean;
    manager?: ReturnType<typeof fakeManager>;
    run?: (request: { collect?: EntryDraft[]; entities?: Map<string, Collection> }) => Promise<void> | void;
    rawManager?: unknown;
  } = {},
) {
  const manager = options.manager ?? fakeManager();
  const state = new TransactionState();
  const produced: EntryDraft[][] = [];
  const writes: Array<{ operation: string; options?: { batch?: BatchState } }> = [];
  const context = {
    transactionOf: vi.fn(() => (options.inTransaction === false ? undefined : { isTransactionActive: true })),
    transactionStateOf: vi.fn(() => state),
  };
  const pipeline = {
    run: vi.fn(async (_ctx: RequestContext, _definition: unknown, _ids: string[], request: object) =>
      options.run?.(request),
    ),
    managerOf: vi.fn(() => manager as unknown as EntityManager),
  };
  const writer = {
    write: vi.fn(
      async (
        tctx: RequestContext,
        operation: string,
        produce: (tctx: RequestContext) => Promise<EntryDraft[]>,
        writeOptions?: { batch?: BatchState },
      ) => {
        const drafts = await produce(tctx);
        produced.push(drafts);
        writes.push({ operation, options: writeOptions });
        return drafts.map((draft, i) => ({ ...draft, id: 100 + i }));
      },
    ),
    inSavepoint: vi.fn(async (tctx: RequestContext, _operation: string, fn: (tctx: RequestContext) => unknown) =>
      fn(tctx),
    ),
  };
  const connection = { rawConnection: { manager: options.rawManager } } as unknown as TransactionalConnection;
  const capture = new CollectionCapture(
    { enabled: options.enabled ?? true } as ResolvedChangeHistoryPluginOptions,
    connection,
    context as unknown as ChangeHistoryContextService,
    { collection: { entityType: 'Collection' } } as unknown as ChangeHistoryDefinitions,
    pipeline as unknown as CapturePipeline,
    writer as unknown as ChangeHistoryWriter,
  );
  return { capture, manager, state, context, pipeline, writer, produced, writes };
}

const collectionEvent = (type: 'created' | 'updated' | 'deleted', entity: Partial<Collection>, input?: object) =>
  ({ ctx, type, entity: Object.assign(new Collection(), entity), input }) as unknown as CollectionEvent;

const modificationEvent = (collection: Partial<Collection>) =>
  ({ ctx, collection: Object.assign(new Collection(), collection) }) as unknown as CollectionModificationEvent;

const draftOf = (id: string): EntryDraft => ({
  entityType: 'Collection',
  entityId: id,
  entityLabel: `Collection ${id}`,
  action: 'deleted',
  summary: 'deleted',
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CollectionCapture switched off', () => {
  it('records nothing for collection events or contents changes, and marks the snapshots stale at boot', async () => {
    const boot = bootManager({ collections: ['5'] });
    const { capture, pipeline, writer, context } = setup({ enabled: false, rawManager: boot.manager });

    await capture.onCollectionEvent(collectionEvent('updated', { id: 5 }, { id: 5 }));
    await capture.onModification(modificationEvent({ id: 5 }));

    expect(await capture.onBoot()).toEqual({ reseeded: 0, seeded: 0 });
    expect(boot.inserted).toEqual([{ collectionId: CAPTURE_OFF_MARKER, productIds: [] }]);
    expect(pipeline.run).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
    expect(context.transactionOf).not.toHaveBeenCalled();
  });
});

describe('CollectionCapture at boot', () => {
  it('seeds only the collections without a snapshot', async () => {
    const boot = bootManager({ collections: ['4', '5'], snapshots: ['4'] });
    const { capture } = setup({ rawManager: boot.manager });

    expect(await capture.onBoot()).toEqual({ reseeded: 0, seeded: 1 });
    expect(boot.inserted).toEqual([{ collectionId: '5', productIds: ['7'] }]);
    expect(boot.manager.transaction).not.toHaveBeenCalled();
  });

  it('re-records every collection after a boot with capture off, then removes the marker', async () => {
    vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
    const boot = bootManager({ marker: true, collections: ['4', '5'], snapshots: ['4', '5', CAPTURE_OFF_MARKER] });
    const { capture } = setup({ rawManager: boot.manager });

    expect(await capture.onBoot()).toEqual({ reseeded: 2, seeded: 0 });
    expect(boot.inserted).toEqual([
      { collectionId: '4', productIds: [] },
      { collectionId: '5', productIds: ['7'] },
    ]);
    expect(boot.deleted).toEqual([
      { collectionId: expect.objectContaining({ _value: ['4', '5'] }) },
      { collectionId: CAPTURE_OFF_MARKER },
    ]);
    expect(Logger.info).toHaveBeenCalledWith(
      'capture was switched off: recorded the contents of 2 collection(s) again',
      'ChangeHistory',
    );
  });
});

describe('CollectionCapture failures', () => {
  it('logs a failed collection event instead of failing the mutation', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { capture, pipeline } = setup();
    pipeline.run.mockRejectedValueOnce(new Error('pipeline down'));

    await expect(capture.onCollectionEvent(collectionEvent('updated', { id: 5 }, { id: 5 }))).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      'write failed in updated Collection: pipeline down',
      expect.any(String),
      expect.any(String),
    );
  });

  it('logs a failed contents diff instead of failing the filters job', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { capture, writer } = setup();
    writer.write.mockRejectedValueOnce(new Error('no connection'));

    await expect(capture.onModification(modificationEvent({ id: 5 }))).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      'write failed in collection membership: no connection',
      expect.any(String),
      expect.any(String),
    );
  });

  it.each([
    ['an Error', new Error('relation does not exist'), 'relation does not exist'],
    ['a non-Error value', 'connection reset', 'connection reset'],
  ])('logs %s thrown while seeding the snapshots and reports none seeded', async (_label, thrown, message) => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const rawManager = {
      count: async () => 0,
      createQueryBuilder: () => {
        throw thrown;
      },
    };
    const { capture } = setup({ rawManager });

    expect(await capture.onBoot()).toEqual({ reseeded: 0, seeded: 0 });
    expect(error).toHaveBeenCalledWith(
      `recording the contents of the collections failed: ${message}`,
      expect.any(String),
      expect.any(String),
    );
  });
});

describe('CollectionCapture contents diff', () => {
  it('records nothing when every product that left the collection was deleted', async () => {
    const manager = fakeManager({ snapshot: ['1', '2'], current: [], live: [] });
    const { capture, produced } = setup({ manager });

    await capture.onModification(modificationEvent({ id: 5 }));

    // The snapshot follows the collection; the deleted products' own entries say they are gone.
    expect(manager.update).toHaveBeenCalledWith(
      ChangeHistoryCollectionMembers,
      { collectionId: '5' },
      { productIds: [] },
    );
    expect(produced).toEqual([[]]);
  });

  it('labels the batch and its entries by id when the collection and product have no name', async () => {
    const manager = fakeManager({ snapshot: ['1'], current: ['1', '2'], live: [] });
    const { capture, produced, writes } = setup({ manager });

    await capture.onModification(modificationEvent({ id: 5 }));

    expect(writes[0].options?.batch).toMatchObject({
      kind: 'collection_rules',
      label: 'Collection 5',
      summary: '+1 / −0',
      parent: { type: 'Collection', id: '5' },
      meta: { counts: { added: 1, removed: 0 } },
    });
    expect(produced[0]).toEqual([
      expect.objectContaining({
        entityType: 'Product',
        entityId: '2',
        entityLabel: 'Product 2',
        action: 'collection_added',
        summary: 'added to Collection 5',
        meta: { collectionLabel: 'Collection 5' },
      }),
    ]);
  });
});

describe('CollectionCapture deletion found by the contents diff', () => {
  it('records nothing for a collection that is gone without a snapshot and with no entry to write', async () => {
    const manager = fakeManager({ exists: false, snapshot: null });
    const { capture, pipeline, state, writer } = setup({ manager });

    await capture.onModification(modificationEvent({ id: 5, parentId: null as unknown as ID }));

    expect(manager.delete).not.toHaveBeenCalled();
    const request = pipeline.run.mock.calls[0][3] as { meta?: unknown; entities: Map<string, Collection> };
    // No snapshot: no member count to keep.
    expect(request.meta).toBeUndefined();
    // A root-level collection is its own last state; no parent to look up.
    expect(request.entities.get('5')?.parent).toBeUndefined();
    expect(writer.inSavepoint).not.toHaveBeenCalled();
    expect(state.takeDeletions().size).toBe(0);
    expect(writer.write).toHaveBeenCalledTimes(1);
  });

  it('writes the deletion at once outside a transaction, with the parent it already carries', async () => {
    const manager = fakeManager({ exists: false, snapshot: ['3', '4'] });
    const parent = Object.assign(new Collection(), { id: 2, isRoot: false });
    const { capture, pipeline, produced, writes, writer } = setup({
      manager,
      inTransaction: false,
      run: (request) => {
        request.collect?.push(draftOf('5'));
      },
    });

    await capture.onModification(modificationEvent({ id: 5, parentId: 2, parent }));

    expect(manager.delete).toHaveBeenCalledWith(ChangeHistoryCollectionMembers, { collectionId: '5' });
    const request = pipeline.run.mock.calls[0][3] as { meta?: unknown; entities: Map<string, Collection> };
    expect(request.meta).toEqual({ memberCount: 2 });
    expect(request.entities.get('5')?.parent).toBe(parent);
    expect(writer.inSavepoint).not.toHaveBeenCalled();
    expect(writes.map((w) => w.operation)).toEqual(['collection membership', 'deleted Collection']);
    expect(produced[1]).toEqual([draftOf('5')]);
  });
});

describe('CollectionCapture deleted event', () => {
  it('records a collection deleted without a membership event the plain way and drops its snapshot', async () => {
    const manager = fakeManager({ root: null });
    const { capture, pipeline, state, writes, produced } = setup({
      manager,
      run: () => state.remember('Collection:5', 42),
    });

    await capture.onCollectionEvent(collectionEvent('deleted', { id: 5, parentId: 2 }));

    const request = pipeline.run.mock.calls[0][3] as { mode: string; entities: Map<string, Collection> };
    expect(request.mode).toBe('deleted');
    // No root collection found: the parent is linked as an ordinary collection.
    expect(request.entities.get('5')?.parent).toEqual({ id: 2, isRoot: false });
    expect(manager.delete).toHaveBeenCalledWith(ChangeHistoryCollectionMembers, { collectionId: '5' });
    expect(writes.map((w) => w.operation)).toEqual(['deleted Collection']);
    expect(produced).toEqual([[]]);
  });

  it('marks a parent that is the root collection and looks the root up only once', async () => {
    const { capture, pipeline, writer } = setup({ manager: fakeManager({ root: { id: 1 } }) });

    await capture.onCollectionEvent(collectionEvent('deleted', { id: 5, parentId: 1 }));
    await capture.onCollectionEvent(collectionEvent('deleted', { id: 6, parentId: 1 }));

    const parents = pipeline.run.mock.calls.map(
      (call) => [...(call[3] as { entities: Map<string, Collection> }).entities.values()][0].parent,
    );
    expect(parents).toEqual([
      { id: 1, isRoot: true },
      { id: 1, isRoot: true },
    ]);
    expect(writer.inSavepoint).toHaveBeenCalledTimes(1);
  });

  it('records remembered descendants with no derived link when the collection itself left no entry', async () => {
    const { capture, state, produced } = setup();
    state.deferDeletion('7', draftOf('7'));
    state.deferDeletion('6', draftOf('6'));

    await capture.onCollectionEvent(collectionEvent('deleted', { id: 5, parentId: null as unknown as ID }));

    // Deepest first from core, so reversed: the parent before its child.
    expect(produced.at(-1)).toEqual([
      { ...draftOf('6'), derivedFromId: null },
      { ...draftOf('7'), derivedFromId: null },
    ]);
  });

  it('writes the remembered collection first and derives its descendants from its entry', async () => {
    const { capture, state, pipeline, produced } = setup();
    state.deferDeletion('6', draftOf('6'));
    state.deferDeletion('5', draftOf('5'));

    await capture.onCollectionEvent(collectionEvent('deleted', { id: 5 }));

    expect(pipeline.run).not.toHaveBeenCalled();
    expect(produced).toEqual([[draftOf('5')], [{ ...draftOf('6'), derivedFromId: 100 }]]);
  });
});
