import { ListQueryBuilder, Product, RequestContext, TransactionalConnection, Type } from '@vendure/core';
import { Brackets, WhereExpressionBuilder } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { ChangeHistoryWriter } from '../capture/entry-writer.service';
import { CHANGE_HISTORY_ENTITY_TYPES, CHANGE_HISTORY_READ_PERMISSIONS } from '../constants';
import { ChangeHistoryDetail } from '../entities/change-history-detail.entity';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { ResolvedChangeHistoryPluginOptions } from '../types';
import { ChangeHistoryReader, ChangeHistoryTimelineEntry } from './change-history-reader.service';
import { decodeCursor } from './cursor';

type Terminal = 'getRawMany' | 'getMany' | 'getOne' | 'getManyAndCount' | 'getRawAndEntities';
type Call = [method: string, ...args: unknown[]];

interface FakeQuery {
  query: object;
  calls: Call[];
}

/** A chainable query builder that records its calls, runs `Brackets` factories and resolves the given results. */
function fakeQuery(results: Partial<Record<Terminal, unknown>> = {}, alias = 'entry'): FakeQuery {
  const calls: Call[] = [];
  const query: object = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'alias') {
          return alias;
        }
        if (typeof prop !== 'string' || prop === 'then') {
          return undefined;
        }
        if (prop in results) {
          return async () => results[prop as Terminal];
        }
        return (...args: unknown[]) => {
          calls.push([prop, ...args]);
          for (const arg of args) {
            if (arg instanceof Brackets) {
              arg.whereFactory(query as WhereExpressionBuilder);
            }
          }
          return query;
        };
      },
    },
  );
  return { query, calls };
}

const methods = (fake: FakeQuery) => fake.calls.map(([method]) => method);

/** A connection whose query builders are handed out in order and whose `find` results are queued. */
function fakeDb() {
  const queries: FakeQuery[] = [];
  const found: unknown[][] = [];
  const find = vi.fn(async () => found.shift() ?? []);
  const manager = {
    connection: {
      getMetadata: (entity: Type<unknown>) => ({
        primaryColumns: [{ type: 'int' }],
        findColumnWithPropertyName: (name: string) => (entity === Product && name === 'deletedAt' ? {} : undefined),
      }),
    },
    getRepository: (entity: Type<unknown>) => ({
      manager,
      find,
      createQueryBuilder: () => {
        const next = queries.shift();
        if (!next) {
          throw new Error(`Unexpected query on ${entity.name}`);
        }
        return next.query;
      },
    }),
  };
  const connection = {
    rawConnection: { options: { type: 'postgres' } },
    getRepository: (_ctx: RequestContext, entity: Type<unknown>) => manager.getRepository(entity),
  } as unknown as TransactionalConnection;
  return {
    connection,
    find,
    queue: (...fakes: FakeQuery[]) => queries.push(...fakes),
    queueFound: (...rows: unknown[][]) => found.push(...rows),
    pending: () => queries.length,
  };
}

function setup(listQueryBuilder = {} as ListQueryBuilder) {
  const db = fakeDb();
  let saved: (entries: ChangeHistoryEntry[]) => void = () => undefined;
  const writer = {
    onSaved: (listener: typeof saved) => {
      saved = listener;
    },
  } as unknown as ChangeHistoryWriter;
  const options = {
    retention: { summaryDays: 30 },
    readPermissions: CHANGE_HISTORY_READ_PERMISSIONS,
  } as unknown as ResolvedChangeHistoryPluginOptions;
  const reader = new ChangeHistoryReader(options, db.connection, listQueryBuilder, writer);
  return { reader, db, save: (entries: ChangeHistoryEntry[]) => saved(entries) };
}

const system = () => ({}) as RequestContext;
const inChannel2 = (...permissions: string[]) =>
  ({
    session: {
      user: { channelPermissions: [{ id: 2, permissions: ['ReadChangeHistory', 'ReadCatalog', ...permissions] }] },
    },
  }) as unknown as RequestContext;

/** An entry with only the columns a test needs (stored values as the database returns them). */
const entry = (fields: Record<string, unknown>) => ({ ...fields }) as unknown as ChangeHistoryTimelineEntry;
const detail = (id: number, entryId: number, entityId: string) =>
  ({
    id,
    entryId,
    entityType: 'Custom',
    entityId,
    parentType: null,
    parentId: null,
    kind: 'field',
    scope: null,
    scopeLabel: null,
    fromValue: undefined,
    toValue: id,
  }) as unknown as ChangeHistoryDetail;
const at = (second: number) => `2026-10-11 06:00:0${second}`;

describe('ChangeHistoryReader.list', () => {
  it('sorts newest first unless the options name a sort', async () => {
    const fake = fakeQuery({ getManyAndCount: [[entry({ id: 1 })], 1] }, 'changehistoryentry');
    const build = vi.fn(() => fake.query);
    const { reader } = setup({ build } as unknown as ListQueryBuilder);

    await expect(reader.list(system())).resolves.toEqual({ items: [{ id: 1 }], totalItems: 1 });
    await reader.list(system(), { sort: {} });
    await reader.list(system(), { sort: { id: 'ASC' } });
    await reader.list(system(), { sort: { createdAt: 'ASC' } });
    await reader.list(system(), { sort: { entityLabel: 'ASC', createdAt: 'DESC' } });

    const sorts = build.mock.calls
      .map((call) => (call as unknown[])[1])
      .map((options) => (options as { sort: unknown }).sort);
    // `id` breaks the ties of one transaction's shared `createdAt`, in the direction of the last key.
    expect(sorts).toEqual([
      { createdAt: 'DESC', id: 'DESC' },
      { createdAt: 'DESC', id: 'DESC' },
      { id: 'ASC' },
      { createdAt: 'ASC', id: 'ASC' },
      { entityLabel: 'ASC', createdAt: 'DESC', id: 'DESC' },
    ]);
    expect(fake.calls).toContainEqual(['andWhere', 'changehistoryentry.derivedFromId IS NULL']);
  });
});

describe('ChangeHistoryReader.timeline', () => {
  it('merges own entries, children and runs into one keyset page with the subject rows of each run', async () => {
    const { reader, db } = setup();
    const [e3, e4, e7, e8] = [3, 4, 7, 8].map((id) => entry({ id }));
    const own = fakeQuery({ getRawAndEntities: { entities: [e3], raw: [{ entry_id: 3, cursor_created_at: at(3) }] } });
    const ownRuns = fakeQuery({
      getRawMany: [
        { entryId: 3, createdAt: at(3) },
        { entryId: 7, createdAt: at(7) },
      ],
    });
    const children = fakeQuery({
      getRawAndEntities: { entities: [e4], raw: [{ entry_id: 4, cursor_created_at: at(4) }] },
    });
    const childRuns = fakeQuery({
      getRawMany: [
        { entryId: 7, createdAt: at(7) },
        { entryId: 8, createdAt: at(8) },
      ],
    });
    // Run 7 touches the subject with two entity types; run 8 and 3 have no subject rows left.
    const counts = fakeQuery({
      getRawMany: [
        { entryId: 7, total: '2', entities: '1' },
        { entryId: 7, total: 1, entities: 1 },
      ],
    });
    const rowsOf7 = fakeQuery({ getMany: [detail(11, 7, 'b'), detail(12, 7, 'a')] });
    db.queue(own, ownRuns, children, childRuns, counts, rowsOf7);
    db.queueFound([e3, e7, e8]);

    const page = await reader.timeline(system(), { entityType: 'Product', entityId: 1, first: 10 });

    expect(page.items.map((item) => item.id)).toEqual([8, 7, 4, 3]);
    expect(page.hasMore).toBe(false);
    expect(decodeCursor(page.endCursor!)).toEqual({ createdAt: at(3), id: '3' });
    expect(methods(own)).toContain('limit');
    expect(own.calls).toContainEqual(['limit', 11]);
    // Children's rows count too.
    expect(methods(counts)).toContain('orWhere');
    expect(e7.details?.map((view) => view.entityId)).toEqual(['a', 'b']);
    expect(e7.details?.[0]).toMatchObject({ entityLabel: null, sku: null, from: null, to: 12 });
    expect(e7).toMatchObject({ detailsTotal: 3, detailsEntityCount: 2 });
    expect(e8).toMatchObject({ details: [], detailsTotal: 0, detailsEntityCount: 0 });
    // Own entry 3 is also a run: one item, filled as a run.
    expect(e3).toMatchObject({ details: [], detailsTotal: 0, detailsEntityCount: 0 });
    expect(e4.details).toBeUndefined();
    expect(db.pending()).toBe(0);
  });

  it('pages 20 by default and leaves the children out on request', async () => {
    const { reader, db } = setup();
    const e9 = entry({ id: 9 });
    const own = fakeQuery({ getRawAndEntities: { entities: [], raw: [] } });
    const ownRuns = fakeQuery({ getRawMany: [{ entryId: 9, createdAt: at(9) }] });
    const counts = fakeQuery({ getRawMany: [{ entryId: 9, total: 1, entities: 1 }] });
    const rowsOf9 = fakeQuery({ getMany: [detail(21, 9, 'x')] });
    db.queue(own, ownRuns, counts, rowsOf9);
    db.queueFound([e9]);

    const page = await reader.timeline(system(), { entityType: 'Product', entityId: 1, includeChildren: false });

    expect(page.items).toEqual([e9]);
    expect(own.calls).toContainEqual(['limit', 21]);
    expect(methods(counts)).not.toContain('orWhere');
    expect(e9).toMatchObject({ detailsTotal: 1, detailsEntityCount: 1 });
    expect(e9.details?.map((view) => view.id)).toEqual([21]);
    expect(db.pending()).toBe(0);
  });
});

describe('ChangeHistoryReader.runDetails', () => {
  it('pages the sorted rows, 100 from the start by default, sorting the run once', async () => {
    const { reader, db } = setup();
    const rows = [detail(1, 7, 'c'), detail(2, 7, 'a'), detail(3, 7, 'b')];
    const order = fakeQuery({ getMany: rows }, 'detail');
    db.queue(order);
    db.queueFound([rows[2]], [rows[0], rows[1], rows[2]]);

    const page = await reader.runDetails(system(), 7, { skip: 1, take: 1 });
    expect(page.totalItems).toBe(3);
    expect(page.items.map((view) => view.entityId)).toEqual(['b']);
    expect(order.calls).toContainEqual(['where', 'detail.entryId = :entryId', { entryId: 7 }]);
    // Only the page's rows are loaded with their values.
    expect(db.find).toHaveBeenLastCalledWith({ where: { id: expect.objectContaining({ _value: ['3'] }) } });

    // The next page reuses the order: no second sorting query is queued.
    const all = await reader.runDetails(system(), 7);
    expect(all.items.map((view) => view.entityId)).toEqual(['a', 'b', 'c']);
    expect(db.pending()).toBe(0);
  });

  it('leaves out the rows of types the reader may not read, and every row of a run they may not read', async () => {
    const { reader, db } = setup();
    const run = entry({ id: 7, entityType: 'Run', channelId: '2' });
    const order = fakeQuery({ getMany: [detail(1, 7, 'a')] }, 'detail');
    db.queue(fakeQuery({ getOne: run }), order, fakeQuery({ getOne: null }));
    db.queueFound([detail(1, 7, 'a')]);

    const page = await reader.runDetails(inChannel2(), 7);
    expect(page.totalItems).toBe(1);
    expect(order.calls).toContainEqual([
      'andWhere',
      'detail.entityType NOT IN (:...deniedTypes)',
      { deniedTypes: ['Promotion'] },
    ]);
    await expect(reader.runDetails(inChannel2(), 8)).resolves.toEqual({ items: [], totalItems: 0 });
    expect(db.pending()).toBe(0);
  });
});

describe('ChangeHistoryReader.filterOptions', () => {
  const values = (...list: string[]) => fakeQuery({ getRawMany: list.map((value) => ({ value })) });

  it('lists each actor once under its latest label, sorted by label then type, and caches the result', async () => {
    const { reader, db } = setup();
    const actors = fakeQuery({
      getRawMany: [
        { id: 1, type: 'administrator', label: 'Old', lastAt: '2026-10-01 10:00:00' },
        { id: 1, type: 'administrator', label: 'New', lastAt: new Date('2026-10-02T10:00:00Z') },
        { id: 1, type: 'administrator', label: 'Older', lastAt: '2026-09-01 10:00:00' },
        { id: 2, type: 'administrator', label: null, lastAt: '2026-10-01 10:00:00' },
        { id: 'x', type: 'apiKey', label: 'Same', lastAt: '2026-10-01 10:00:00' },
        { id: 3, type: 'administrator', label: 'Same', lastAt: '2026-10-01 10:00:00' },
      ],
    });
    db.queue(actors, values('odoo', 'admin-api'), values('updated'), values('Product'));

    const expected = {
      actors: [
        { id: '2', type: 'administrator', label: '2' },
        { id: '1', type: 'administrator', label: 'New' },
        { id: '3', type: 'administrator', label: 'Same' },
        { id: 'x', type: 'apiKey', label: 'Same' },
      ],
      sources: ['admin-api', 'odoo'],
      actions: ['updated'],
      entityTypes: ['Product'],
    };
    await expect(reader.filterOptions(system())).resolves.toEqual(expected);
    // Served from the cache: no query is queued for a second read.
    await expect(reader.filterOptions(system())).resolves.toEqual(expected);
  });

  it("merges this process's writes into the cached scopes that may read them", async () => {
    const { reader, db, save } = setup();
    db.queue(...[1, 2, 3, 4, 5, 6, 7, 8].map(() => fakeQuery({ getRawMany: [] })));
    await reader.filterOptions(system());
    await reader.filterOptions(inChannel2());

    save([
      entry({
        channelId: 3,
        source: 'odoo',
        action: 'updated',
        entityType: 'Product',
        actorId: 9,
        actorType: 'administrator',
        actorLabel: null,
      }),
      entry({
        channelId: 2,
        source: 'admin-api',
        action: 'created',
        entityType: 'Facet',
        actorId: 10,
        actorType: 'administrator',
        actorLabel: 'Zed',
      }),
      entry({ channelId: 2, source: 'job', action: 'deleted', entityType: 'Asset', actorId: null }),
      // The reader of channel 2 may not read promotions; a legacy API-key label reads as the plain name.
      entry({
        channelId: 2,
        source: 'api_key',
        action: 'promoted',
        entityType: 'Promotion',
        actorId: 11,
        actorType: 'api_key',
        actorLabel: 'Key Owner (API key)',
      }),
    ]);

    await expect(reader.filterOptions(system())).resolves.toEqual({
      actors: [
        { id: '9', type: 'administrator', label: '9' },
        { id: '11', type: 'api_key', label: 'Key Owner' },
        { id: '10', type: 'administrator', label: 'Zed' },
      ],
      sources: ['admin-api', 'api_key', 'job', 'odoo'],
      actions: ['created', 'deleted', 'promoted', 'updated'],
      entityTypes: ['Asset', 'Facet', 'Product', 'Promotion'],
    });
    await expect(reader.filterOptions(inChannel2())).resolves.toEqual({
      actors: [{ id: '10', type: 'administrator', label: 'Zed' }],
      sources: ['admin-api', 'job'],
      actions: ['created', 'deleted'],
      entityTypes: ['Asset', 'Facet'],
    });
  });
});

describe('ChangeHistoryReader field values', () => {
  it('counts derived entries live plus the compacted snapshot', async () => {
    const { reader, db } = setup();
    const compacted = entry({ id: 5, compactedAt: new Date(), meta: { derivedCount: 3 } });
    const live = entry({ id: 6 });
    db.queue(fakeQuery({ getRawMany: [{ derivedFromId: 5, count: '2' }] }));

    const ctx = system();
    await expect(Promise.all([reader.derivedCount(ctx, compacted), reader.derivedCount(ctx, live)])).resolves.toEqual([
      5, 0,
    ]);
  });

  it("leaves the members of types the reader may not read out of a compacted batch's counts", async () => {
    const { reader } = setup();
    const snapshot = [
      { entityType: 'Product', action: 'updated', count: 4 },
      { entityType: 'Promotion', action: 'updated', count: 2 },
    ];
    const head = entry({
      id: 2,
      entityType: CHANGE_HISTORY_ENTITY_TYPES.Batch,
      batchId: 'b2',
      channelId: '2',
      compactedAt: new Date(),
      meta: { batchCounts: snapshot },
    });
    await expect(reader.batchCountsOf(inChannel2(), head)).resolves.toEqual([snapshot[0]]);
    await expect(reader.batchCountsOf(inChannel2('ReadPromotion'), head)).resolves.toEqual(snapshot);
  });

  it("counts a batch's members live, or from the snapshot once compacted, and nothing for other entries", async () => {
    const { reader, db } = setup();
    const batch = CHANGE_HISTORY_ENTITY_TYPES.Batch;
    const live = entry({ id: 1, entityType: batch, batchId: 'b1' });
    const snapshot = [{ entityType: 'Product', action: 'updated', count: 4 }];
    const compacted = entry({
      id: 2,
      entityType: batch,
      batchId: 'b2',
      compactedAt: new Date(),
      meta: { batchCounts: snapshot },
    });
    db.queue(
      fakeQuery({ getRawMany: [{ batchId: 'b1', entityType: 'ProductVariant', action: 'updated', count: '3' }] }),
    );

    const ctx = system();
    await expect(Promise.all([reader.batchCountsOf(ctx, live), reader.batchCountsOf(ctx, compacted)])).resolves.toEqual(
      [[{ entityType: 'ProductVariant', action: 'updated', count: 3 }], snapshot],
    );
    await expect(reader.batchCountsOf(ctx, entry({ id: 3, entityType: 'Product', batchId: 'b1' }))).resolves.toBeNull();
  });

  it('reports deleted and soft-deleted core entities and parents', async () => {
    const { reader, db } = setup();
    const alive = fakeQuery({ getRawMany: [{ id: 2 }] });
    db.queue(alive, fakeQuery({ getRawMany: [] }));
    const ctx = system();

    await expect(
      Promise.all([
        reader.entityDeleted(ctx, entry({ id: 1, entityType: 'Product', entityId: '1' })),
        reader.entityDeleted(ctx, entry({ id: 2, entityType: 'Product', entityId: '2' })),
        reader.entityDeleted(ctx, entry({ id: 3, entityType: 'Custom', entityId: 'z' })),
      ]),
    ).resolves.toEqual([true, false, false]);
    expect(alive.calls).toContainEqual(['andWhere', 'row.deletedAt IS NULL']);

    await expect(reader.parentDeleted(ctx, entry({ id: 4, entityType: 'ProductVariant' }))).resolves.toBe(false);
    await expect(
      reader.parentDeleted(ctx, entry({ id: 5, entityType: 'ProductVariant', parentType: 'Product', parentId: '4' })),
    ).resolves.toBe(true);
  });

  it('falls back to the empty value when a load has nothing for the entry', async () => {
    const { reader } = setup();
    const loaders = reader as unknown as Record<
      'loadDerivedCounts' | 'loadBatchCounts' | 'loadDeleted' | 'loadParentsDeleted',
      () => Promise<Map<string, unknown>>
    >;
    for (const name of ['loadDerivedCounts', 'loadBatchCounts', 'loadDeleted', 'loadParentsDeleted'] as const) {
      vi.spyOn(loaders, name).mockResolvedValue(new Map());
    }
    const ctx = system();
    const head = entry({
      id: 1,
      entityType: CHANGE_HISTORY_ENTITY_TYPES.Batch,
      batchId: 'b1',
      parentType: 'Collection',
      parentId: '2',
    });

    await expect(reader.derivedCount(ctx, head)).resolves.toBe(0);
    await expect(reader.batchCountsOf(ctx, head)).resolves.toEqual([]);
    await expect(reader.entityDeleted(ctx, head)).resolves.toBe(false);
    await expect(reader.parentDeleted(ctx, head)).resolves.toBe(false);
  });
});
