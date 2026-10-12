import { ProductVariant, RequestContext, TransactionalConnection } from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
import { CapturePipeline } from '../capture/capture-pipeline';
import { CollectionCapture } from '../capture/collection-capture';
import { ChangeHistoryWriter, EntryDraft } from '../capture/entry-writer.service';
import { ChangeHistoryDetail } from '../entities/change-history-detail.entity';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
import { CHANGE_HISTORY_READ_PERMISSIONS } from '../constants';
import { ChangeHistoryReader } from '../read/change-history-reader.service';
import { readScopeOf } from '../read/read-scope';
import { ChangeHistoryRunInput, ResolvedChangeHistoryPluginOptions } from '../types';
import { ChangeHistoryContextService } from './change-history-context.service';
import { ChangeHistoryService } from './change-history.service';

type Call = [string, unknown[]];

/** A query builder that records its calls; `getRawOne` / `getRawMany` / `getMany` resolve the given results. */
function queryBuilder(results: { rawOne?: unknown; rawMany?: unknown[]; many?: unknown[] }, calls: Call[]) {
  const qb: Record<string, unknown> = {};
  for (const method of [
    'where',
    'andWhere',
    'innerJoin',
    'select',
    'addSelect',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'addOrderBy',
    'offset',
    'limit',
  ]) {
    qb[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return qb;
    };
  }
  qb.getRawOne = async () => results.rawOne;
  qb.getRawMany = async () => results.rawMany ?? [];
  qb.getMany = async () => results.many ?? [];
  return qb;
}

/**
 * The facade on fakes: a writer that runs `produce` and `afterInsert` with the drafts saved under `entryId`, and
 * a connection whose repositories are picked by entity.
 */
function setup(
  options: {
    enabled?: boolean;
    entryId?: string | number;
    /** What the reader says the user may not read of a run's rows; `null`: the run itself. */
    denied?: string[] | null;
    variants?: Array<{ id: number; productId: number }>;
    runs?: { count: number; page: Array<{ entryId: number }>; entries: Array<{ id: number }>; rows: unknown[] };
  } = {},
) {
  const drafts: EntryDraft[] = [];
  const write = vi.fn(
    async (
      ctx: RequestContext,
      _operation: string,
      produce: (tctx: RequestContext) => Promise<EntryDraft[]>,
      opts: { afterInsert?: (tctx: RequestContext, entries: ChangeHistoryEntry[]) => Promise<void> } = {},
    ) => {
      const produced = await produce(ctx);
      drafts.push(...produced);
      const entries = produced.map(
        (draft) => ({ ...draft, id: options.entryId ?? 10 }) as unknown as ChangeHistoryEntry,
      );
      await opts.afterInsert?.(ctx, entries);
      return entries;
    },
  );
  const insert = vi.fn(async () => undefined);
  const findAndCount = vi.fn(async () => [[{ id: 1 }], 1]);
  const calls: Call[] = [];
  const runs = options.runs ?? { count: 0, page: [], entries: [], rows: [] };
  const variantFind = vi.fn(async () => options.variants ?? []);
  const repositories = new Map<unknown, unknown>([
    [ProductVariant, { find: variantFind }],
    [
      ChangeHistoryDetail,
      {
        insert,
        findAndCount,
        createQueryBuilder: () =>
          queryBuilder({ rawOne: { count: runs.count }, rawMany: runs.page, many: runs.rows }, calls),
      },
    ],
    [ChangeHistoryEntry, { find: vi.fn(async () => runs.entries) }],
  ]);
  const connection = {
    getRepository: (_ctx: RequestContext, target: unknown) => repositories.get(target) ?? { find: async () => [] },
    rawConnection: {
      driver: { escape: (name: string) => `"${name}"` },
      getMetadata: () => ({
        tablePath: 'public.change_history_entry',
        findColumnWithPropertyName: (property: string) => ({ databaseName: property }),
      }),
    },
  } as unknown as TransactionalConnection;
  const serialize = vi.fn((_ctx: RequestContext, fn: () => Promise<unknown>) => fn());
  const context = { serialize } as unknown as ChangeHistoryContextService;
  const reader = {
    list: vi.fn(async () => ({ items: [], totalItems: 0 })),
    timeline: vi.fn(async () => ({ items: [], pageInfo: { hasNextPage: false } })),
    filterOptions: vi.fn(async () => ({ actors: [] })),
    deniedDetailTypes: vi.fn(async () => (options.denied === undefined ? [] : options.denied)),
    scopeOf: vi.fn((ctx: RequestContext) => readScopeOf(ctx, CHANGE_HISTORY_READ_PERMISSIONS)),
  };
  const service = new ChangeHistoryService(
    { enabled: options.enabled ?? true } as ResolvedChangeHistoryPluginOptions,
    connection,
    context,
    { write } as unknown as ChangeHistoryWriter,
    {} as CapturePipeline,
    {} as ChangeHistoryDefinitions,
    {} as CollectionCapture,
    reader as unknown as ChangeHistoryReader,
  );
  return { service, write, drafts, insert, findAndCount, reader, serialize, calls, variantFind };
}

const ctxOf = (permissions?: string[]) =>
  ({
    session: permissions ? { user: { channelPermissions: [{ id: 3, permissions }] } } : undefined,
  }) as unknown as RequestContext;

const run = (input: Partial<ChangeHistoryRunInput>) =>
  ({ source: 'erp_sync', label: 'ERP sync', ...input }) as ChangeHistoryRunInput;

describe('ChangeHistoryService.recordRun', () => {
  it('writes nothing when switched off', async () => {
    const { service, write } = setup({ enabled: false });
    await service.recordRun(ctxOf(), run({ counts: { updated: 1 }, details: [] }));
    expect(write).not.toHaveBeenCalled();
  });

  it('writes nothing for a run without details or counts', async () => {
    const { service, write } = setup();
    await service.recordRun(ctxOf(), run({}));
    await service.recordRun(ctxOf(), run({ counts: { updated: 0 }, details: [] }));
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps what a run was about in meta.subject, the label clipped and the id a string', async () => {
    const { service, drafts } = setup();
    await service.recordRun(
      ctxOf(),
      run({ counts: { updated: 1 }, details: [], subject: { type: 'Order', id: 1042, label: 'S'.repeat(300) } }),
    );
    await service.recordRun(ctxOf(), run({ counts: { updated: 1 }, details: [], subject: { label: 'import.csv' } }));
    await service.recordRun(ctxOf(), run({ counts: { updated: 1 }, details: [] }));
    expect(drafts.map((draft) => draft.meta?.subject)).toEqual([
      { type: 'Order', id: '1042', label: 'S'.repeat(255) },
      { label: 'import.csv' },
      undefined,
    ]);
  });

  it('records the detail rows of a run without counts, its parents resolved and a long scope label clipped', async () => {
    const { service, drafts, insert, variantFind } = setup({ entryId: "run'7", variants: [{ id: 12, productId: 3 }] });
    await service.recordRun(
      ctxOf(),
      run({
        details: [
          {
            entityType: 'ProductVariant',
            entityId: 12,
            kind: 'stock',
            scope: 'kyiv',
            scopeLabel: 'W'.repeat(200),
            from: undefined,
            to: undefined,
          },
          { entityType: 'ProductVariant', entityId: 12, kind: 'price', from: '1', to: '2', scopeLabel: 'Retail' },
        ],
      }),
    );

    expect(variantFind).toHaveBeenCalledTimes(1);
    expect(drafts).toEqual([
      expect.objectContaining({
        entityType: 'Run',
        entityId: 'erp_sync',
        summary: 'no changes',
        meta: expect.objectContaining({ counts: {}, detailCount: 2 }),
      }),
    ]);
    const [rows] = insert.mock.calls[0] as unknown as [Array<Record<string, unknown>>];
    expect(rows).toEqual([
      expect.objectContaining({
        entryId: "run'7",
        parentType: 'Product',
        parentId: '3',
        scope: 'kyiv',
        scopeLabel: 'W'.repeat(128),
        fromValue: null,
        toValue: null,
      }),
      expect.objectContaining({ scope: null, scopeLabel: 'Retail', fromValue: '1', toValue: '2' }),
    ]);
    // A string entry id is quoted, its quotes doubled.
    expect((rows[0].createdAt as () => string)()).toBe(
      `(SELECT "createdAt" FROM "public"."change_history_entry" WHERE "id" = 'run''7')`,
    );
  });

  it('copies the createdAt of a numeric entry id unquoted', async () => {
    const { service, insert } = setup({ entryId: 42 });
    await service.recordRun(
      ctxOf(),
      run({
        counts: { updated: 1 },
        details: [{ entityType: 'Order', entityId: 1, kind: 'state', from: 'draft', to: 'placed' }],
      }),
    );
    const [rows] = insert.mock.calls[0] as unknown as [Array<Record<string, unknown>>];
    expect((rows[0].createdAt as () => string)()).toBe(
      '(SELECT "createdAt" FROM "public"."change_history_entry" WHERE "id" = 42)',
    );
  });
});

describe('ChangeHistoryService reads', () => {
  it('serves the feed, the timeline and the filter options from the reader, serialized', async () => {
    const { service, reader, serialize } = setup();
    const ctx = ctxOf();
    await expect(service.list(ctx, { take: 5 })).resolves.toEqual({ items: [], totalItems: 0 });
    await expect(service.entityHistory(ctx, { entityType: 'Product', entityId: 1 })).resolves.toEqual({
      items: [],
      pageInfo: { hasNextPage: false },
    });
    await expect(service.filterOptions(ctx)).resolves.toEqual({ actors: [] });

    expect(reader.list).toHaveBeenCalledWith(ctx, { take: 5 });
    expect(reader.timeline).toHaveBeenCalledWith(ctx, { entityType: 'Product', entityId: 1 });
    expect(reader.filterOptions).toHaveBeenCalledWith(ctx);
    expect(serialize).toHaveBeenCalledTimes(3);
  });

  it('lists no detail rows of a run the user may not read', async () => {
    const { service, findAndCount } = setup({ denied: null });
    await expect(service.runDetails(ctxOf(), 1)).resolves.toEqual({ items: [], totalItems: 0 });
    expect(findAndCount).not.toHaveBeenCalled();
  });

  it('leaves out the detail rows of types the user may not read', async () => {
    const { service, findAndCount } = setup({ denied: ['Promotion'] });
    await service.runDetails(ctxOf(), 1);
    expect(findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entryId: 1, entityType: expect.objectContaining({ _type: 'not' }) },
      }),
    );
  });

  it('pages the detail rows of a readable run', async () => {
    const { service, findAndCount } = setup();
    await expect(service.runDetails(ctxOf(), 1, { skip: -3, take: 9999 })).resolves.toEqual({
      items: [{ id: 1 }],
      totalItems: 1,
    });
    expect(findAndCount).toHaveBeenCalledWith(expect.objectContaining({ where: { entryId: 1 }, skip: 0, take: 500 }));
  });

  it("scopes an entity's runs to the channels the user may read, a run without rows getting none", async () => {
    const { service, calls } = setup({
      runs: {
        count: 2,
        page: [{ entryId: 1 }, { entryId: 2 }],
        entries: [{ id: 1 }, { id: 2 }],
        rows: [{ id: 5, entryId: 1 }],
      },
    });
    const result = await service.runsForEntity(ctxOf(['ReadChangeHistory']), { entityType: 'Product', entityId: 3 });

    expect(result).toEqual({
      items: [
        { entry: { id: 1 }, details: [{ id: 5, entryId: 1 }] },
        { entry: { id: 2 }, details: [] },
      ],
      totalItems: 2,
    });
    expect(calls).toContainEqual(['innerJoin', [ChangeHistoryEntry, 'run', 'run.id = detail.entryId']]);
    // The run's channel, and in it only the types the user may read: ReadChangeHistory alone reads none of the core.
    expect(calls).toContainEqual([
      'andWhere',
      [
        '(run.channelId IN (:...chRowC0) AND detail.entityType NOT IN (:...chRowT0))',
        expect.objectContaining({ chRowC0: ['3'], chRowT0: expect.arrayContaining(['Product', 'ProductVariant']) }),
      ],
    ]);
  });

  it('reads the runs of every channel for a SuperAdmin', async () => {
    const { service, calls } = setup();
    const details = await service.runDetailsForEntity(
      ctxOf(['SuperAdmin']),
      { entityType: 'Product', entityId: 3 },
      [1],
    );
    expect(details).toEqual(new Map());
    expect(calls.some(([method]) => method === 'innerJoin')).toBe(false);
  });
});
