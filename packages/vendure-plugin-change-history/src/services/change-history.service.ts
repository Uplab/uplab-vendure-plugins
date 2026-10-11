import { Inject, Injectable } from '@nestjs/common';
import {
  FacetValue,
  ID,
  ListQueryOptions,
  Logger,
  PaginatedList,
  ProductVariant,
  RequestContext,
  TransactionalConnection,
} from '@vendure/core';
import { randomUUID } from 'node:crypto';
import { Brackets, In, SelectQueryBuilder } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { CapturePipeline } from '../capture/capture-pipeline';
import { CollectionCapture } from '../capture/collection-capture';
import { ChangeHistoryWriter } from '../capture/entry-writer.service';
import { DETAIL_COLUMN_LENGTHS, fitColumns, warnClipped } from '../capture/fit';
import { inChannels, readableChannelIds } from '../read/channel-scope';
import {
  CHANGE_HISTORY_ACTIONS,
  CHANGE_HISTORY_ENTITY_TYPES,
  CHANGE_HISTORY_PLUGIN_OPTIONS,
  DETAIL_CHUNK_SIZE,
  MAX_BATCH_KIND_LENGTH,
  MAX_DETAIL_PAGE,
  MAX_RUN_DETAILS,
  loggerCtx,
} from '../constants';
import { ChangeHistoryDetail } from '../entities/change-history-detail.entity';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
import {
  ChangeHistoryEntityTimeline,
  ChangeHistoryFilterOptions,
  ChangeHistoryReader,
  ChangeHistoryTimelineArgs,
} from '../read/change-history-reader.service';
import {
  ChangeHistoryActionInput,
  ChangeHistoryBatchInput,
  ChangeHistoryCaptureOptions,
  ChangeHistoryCoreEntityType,
  ChangeHistoryDetailInput,
  ChangeHistoryRunInput,
  ResolvedChangeHistoryPluginOptions,
} from '../types';
import { ChangeHistoryContextService } from './change-history-context.service';

const BATCH_KIND_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** Detail entity types whose parent the package resolves itself. */
const PARENT_LOOKUPS = {
  ProductVariant: { parentType: 'Product', entity: ProductVariant, column: 'productId' },
  FacetValue: { parentType: 'Facet', entity: FacetValue, column: 'facetId' },
} as const;

const clip = (value: string, length: number) => (value.length > length ? value.slice(0, length) : value);

/**
 * @description
 * The change history's write and read facade — the one service hosts call.
 *
 * Every write method **never rejects because of a history failure**: the failure is logged with the
 * `[ChangeHistory]` prefix and the caller's work goes on. Writes run in `withTransaction(ctx)`: a
 * savepoint inside the caller's transaction (the entry commits or rolls back with the change it
 * describes), an own short transaction otherwise.
 *
 * @example
 * ```ts
 * await this.changeHistory.runBatch(ctx, { kind: 'bulk_edit' }, async (ctx) => {
 *   await this.saveAll(ctx, input);
 * });
 * ```
 */
@Injectable()
export class ChangeHistoryService {
  private readonly uncapturedWarned = new Set<string>();

  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly connection: TransactionalConnection,
    private readonly context: ChangeHistoryContextService,
    private readonly writer: ChangeHistoryWriter,
    private readonly pipeline: CapturePipeline,
    private readonly definitions: ChangeHistoryDefinitions,
    private readonly collections: CollectionCapture,
    private readonly reader: ChangeHistoryReader,
  ) {}

  /**
   * Diff and record entities after a write that bypassed Vendure's events (raw SQL, a plugin's own
   * repository save), in the caller's transaction. Call it **after** the write, with the caller's `ctx`:
   * the before-state is what the transaction saw last for the entity, else its last committed row.
   * `created: true` means the rows are new (the before-state is empty). An entity whose diff is empty gets
   * no entry. Captures the core catalogue types (`Product`, `ProductVariant`, `Collection`, `Facet`,
   * `FacetValue`, `Promotion`, `Asset`); any other type resolves without recording (logged once).
   *
   * @example
   * ```ts
   * await this.connection.getRepository(ctx, Product).update(ids, { customFields: { isArchived: true } });
   * await this.changeHistory.capture(ctx, 'Product', ids, { action: 'archived' });
   * ```
   */
  async capture(
    ctx: RequestContext,
    entityType: ChangeHistoryCoreEntityType,
    ids: ID[],
    opts: ChangeHistoryCaptureOptions,
  ): Promise<void> {
    if (!this.options.enabled || ids.length === 0) {
      return;
    }
    const definition = this.definitions.forType(entityType);
    if (!definition) {
      if (!this.uncapturedWarned.has(entityType)) {
        this.uncapturedWarned.add(entityType);
        Logger.warn(
          `[ChangeHistory] capture() does not support ${entityType}; nothing was recorded (use recordAction)`,
          loggerCtx,
        );
      }
      return;
    }
    await this.pipeline.run(ctx, definition, ids, {
      mode: opts.created ? 'created' : 'updated',
      action: opts.action,
      meta: opts.meta,
    });
  }

  /**
   * Overwrites the package's snapshot of every collection's products with the current contents. Call it
   * after a period with capture switched off; otherwise the first change of each collection afterwards
   * records the whole difference since then. Unlike the write methods, it rejects when it fails.
   */
  async reseedCollectionMembership(ctx: RequestContext): Promise<{ collections: number }> {
    return this.collections.reseed(ctx);
  }

  /** An action-only entry: no diff, no before-read. `entityType` may be a host type. */
  async recordAction(ctx: RequestContext, input: ChangeHistoryActionInput): Promise<void> {
    if (!this.options.enabled) {
      return;
    }
    await this.writer.write(ctx, 'recordAction', async () => [
      {
        entityType: input.entityType,
        entityId: String(input.entityId),
        entityLabel: input.entityLabel,
        parentType: input.parent?.type ?? null,
        parentId: input.parent ? String(input.parent.id) : null,
        action: input.action,
        summary: input.summary ?? input.action,
        meta: input.meta,
      },
    ]);
  }

  /**
   * An external run: one `Run` entry (`meta`: `counts`, `durationMs`, `detailCount`) plus one detail row per
   * changed value, written in chunks. Writes nothing when there are no details and every count is 0. The
   * parent of `ProductVariant` / `FacetValue` rows is resolved when the caller names none, so a product finds
   * the rows of its variants. At most 5,000 rows are stored per run (the rest are counted in
   * `meta.detailsOmitted` and logged). Inside the caller's transaction the run is written in a savepoint and
   * commits or rolls back with it; otherwise in its own short transaction. Never rejects.
   */
  async recordRun(ctx: RequestContext, input: ChangeHistoryRunInput): Promise<void> {
    if (!this.options.enabled) {
      return;
    }
    const all = input.details ?? [];
    const counts = input.counts ?? {};
    if (all.length === 0 && !Object.values(counts).some((count) => count !== 0)) {
      return;
    }
    const details = all.length > MAX_RUN_DETAILS ? all.slice(0, MAX_RUN_DETAILS) : all;
    const omitted = all.length - details.length;
    if (omitted > 0) {
      Logger.warn(
        `[ChangeHistory] run "${input.source}" has ${all.length} detail rows; stored the first ${MAX_RUN_DETAILS}`,
        loggerCtx,
      );
    }
    const parents = new Map<string, { type: string; id: ID }>();
    await this.writer.write(
      ctx,
      'recordRun',
      async (tctx) => {
        for (const [key, parent] of await this.resolveParents(tctx, details)) {
          parents.set(key, parent);
        }
        return [
          {
            entityType: CHANGE_HISTORY_ENTITY_TYPES.Run,
            entityId: input.entityId ?? input.source,
            entityLabel: input.label,
            action: CHANGE_HISTORY_ACTIONS.run,
            source: input.source,
            summary: runSummary(counts),
            meta: {
              ...input.meta,
              counts,
              durationMs: input.durationMs,
              detailCount: details.length,
              ...(omitted > 0 ? { detailsOmitted: omitted } : {}),
            },
          },
        ];
      },
      {
        afterInsert: async (tctx, [entry]) => {
          // The entry's own `createdAt`, copied in SQL: a JS `Date` would drop Postgres' microseconds, and
          // the timelines order run rows and entries on the same key.
          const createdAt = this.entryCreatedAtSql(entry.id);
          const clipped = new Set<string>();
          const rows = details.map((detail) => {
            const parent = detail.parent ?? parents.get(`${detail.entityType}:${String(detail.entityId)}`);
            return fitColumns(
              {
                entryId: entry.id,
                createdAt: () => createdAt,
                entityType: detail.entityType,
                entityId: String(detail.entityId),
                parentType: parent?.type ?? null,
                parentId: parent ? String(parent.id) : null,
                kind: detail.kind,
                scope: detail.scope ?? null,
                scopeLabel: detail.scopeLabel ? clip(detail.scopeLabel, 128) : null,
                fromValue: detail.from ?? null,
                toValue: detail.to ?? null,
              },
              DETAIL_COLUMN_LENGTHS,
              clipped,
            );
          });
          warnClipped(`recordRun "${input.source}" detail rows`, clipped);
          const repository = this.connection.getRepository(tctx, ChangeHistoryDetail);
          for (let i = 0; i < rows.length; i += DETAIL_CHUNK_SIZE) {
            await repository.insert(
              rows.slice(i, i + DETAIL_CHUNK_SIZE) as QueryDeepPartialEntity<ChangeHistoryDetail>[],
            );
          }
        },
      },
    );
  }

  /**
   * Groups every entry written inside `fn` under one batch, optionally under another actor. The batch's
   * head entry is written with its first member, so a batch that changed nothing leaves no row. Nested
   * inside another batch it is a plain call (the outer batch wins). `fn`'s own errors are rethrown.
   */
  async runBatch<T>(
    ctx: RequestContext,
    batch: ChangeHistoryBatchInput,
    fn: (ctx: RequestContext) => Promise<T>,
  ): Promise<T> {
    if (
      typeof batch?.kind !== 'string' ||
      batch.kind.length > MAX_BATCH_KIND_LENGTH ||
      !BATCH_KIND_PATTERN.test(batch.kind)
    ) {
      throw new Error(
        `ChangeHistoryService.runBatch: kind "${batch?.kind}" must be 1–${MAX_BATCH_KIND_LENGTH} letters, digits, "_", "-" or "."`,
      );
    }
    const state = this.context.stateOf(ctx);
    if (state.batch || !this.options.enabled) {
      return fn(ctx);
    }
    state.batch = { ...batch, id: `${batch.kind}:${randomUUID()}` };
    try {
      return await fn(ctx);
    } finally {
      state.batch = undefined;
    }
  }

  /**
   * The feed: entries with Vendure's list options (filter, sort, paging), newest first by default. Derived
   * entries are left out unless the filter names `derivedFromId`. Unstable in 0.x — the `changeHistoryEntries`
   * query is the stable read API.
   */
  list(
    ctx: RequestContext,
    options: ListQueryOptions<ChangeHistoryEntry> = {},
  ): Promise<PaginatedList<ChangeHistoryEntry>> {
    return this.context.serialize(ctx, () => this.reader.list(ctx, options));
  }

  /**
   * One entity's history, newest first, keyset-paged (`first` 1–100, `after` = the previous `endCursor`): its
   * own entries, its children's non-derived ones and the runs that changed it with only its rows. Read from the
   * primary database. Unstable in 0.x — the `changeHistoryEntityTimeline` query is the stable read API.
   */
  entityHistory(ctx: RequestContext, args: ChangeHistoryTimelineArgs): Promise<ChangeHistoryEntityTimeline> {
    return this.context.serialize(ctx, () => this.reader.timeline(ctx, args));
  }

  /**
   * Distinct actors, sources, actions and entity types of the last `summaryDays` (cached for 60 s). Unstable in
   * 0.x — the `changeHistoryFilterOptions` query is the stable read API.
   */
  filterOptions(ctx: RequestContext): Promise<ChangeHistoryFilterOptions> {
    return this.context.serialize(ctx, () => this.reader.filterOptions(ctx));
  }

  /**
   * The detail rows of one run, in the order they were recorded, paged (`take` 1–500, default 100).
   * Unstable in 0.x — the stable read API is the GraphQL layer.
   */
  async runDetails(
    ctx: RequestContext,
    entryId: ID,
    opts: { skip?: number; take?: number } = {},
  ): Promise<PaginatedList<ChangeHistoryDetail>> {
    return this.context.serialize(ctx, async () => {
      if (!(await this.reader.readable(ctx, entryId))) {
        return { items: [], totalItems: 0 };
      }
      const [items, totalItems] = await this.connection.getRepository(ctx, ChangeHistoryDetail).findAndCount({
        where: { entryId },
        order: { id: 'ASC' },
        skip: Math.max(0, Math.trunc(opts.skip ?? 0)),
        take: Math.min(MAX_DETAIL_PAGE, Math.max(1, Math.trunc(opts.take ?? 100))),
      });
      return { items, totalItems };
    });
  }

  /**
   * The runs that changed an entity, newest first, each with **only that entity's rows**: the rows recorded
   * for it, or for its children (a product gets the rows of its variants, a facet those of its values). Paged
   * by run (`take` 1–100, default 20). Unstable in 0.x — the stable read API is the GraphQL layer.
   */
  async runsForEntity(
    ctx: RequestContext,
    subject: { entityType: string; entityId: ID },
    opts: { skip?: number; take?: number } = {},
  ): Promise<PaginatedList<{ entry: ChangeHistoryEntry; details: ChangeHistoryDetail[] }>> {
    return this.context.serialize(ctx, () => this.loadRunsForEntity(ctx, subject, opts));
  }

  /**
   * One entity's rows of the given runs, grouped by run id (as a string): what a timeline shows under each
   * run item. Matches the rows recorded for the entity and for its children, like `runsForEntity`.
   */
  runDetailsForEntity(
    ctx: RequestContext,
    subject: { entityType: string; entityId: ID },
    entryIds: ID[],
  ): Promise<Map<string, ChangeHistoryDetail[]>> {
    return this.context.serialize(ctx, () => this.loadRunDetailsForEntity(ctx, subject, entryIds));
  }

  private async loadRunsForEntity(
    ctx: RequestContext,
    subject: { entityType: string; entityId: ID },
    opts: { skip?: number; take?: number },
  ): Promise<PaginatedList<{ entry: ChangeHistoryEntry; details: ChangeHistoryDetail[] }>> {
    const query = () => this.runRows(ctx, subject);
    const counted = await query()
      .select('COUNT(DISTINCT detail.entryId)', 'count')
      .getRawOne<{ count: string | number }>();
    const page = await query()
      .select('detail.entryId', 'entryId')
      .addSelect('detail.createdAt', 'createdAt')
      .groupBy('detail.entryId')
      .addGroupBy('detail.createdAt')
      .orderBy('detail.createdAt', 'DESC')
      .addOrderBy('detail.entryId', 'DESC')
      .offset(Math.max(0, Math.trunc(opts.skip ?? 0)))
      .limit(Math.min(100, Math.max(1, Math.trunc(opts.take ?? 20))))
      .getRawMany<{ entryId: ID }>();
    const entryIds = page.map((row) => row.entryId);
    const entries =
      entryIds.length > 0
        ? await this.connection.getRepository(ctx, ChangeHistoryEntry).find({ where: { id: In(entryIds) } })
        : [];
    const details = await this.loadRunDetailsForEntity(ctx, subject, entryIds);
    const byId = new Map(entries.map((entry) => [String(entry.id), entry]));
    return {
      items: entryIds
        .filter((id) => byId.has(String(id)))
        .map((id) => ({ entry: byId.get(String(id))!, details: details.get(String(id)) ?? [] })),
      totalItems: Number(counted?.count ?? 0),
    };
  }

  /** The subject's detail rows, of runs in the channels `ctx` may read. */
  private runRows(
    ctx: RequestContext,
    subject: { entityType: string; entityId: ID },
  ): SelectQueryBuilder<ChangeHistoryDetail> {
    const query = this.connection
      .getRepository(ctx, ChangeHistoryDetail)
      .createQueryBuilder('detail')
      .where(subjectCondition(subject));
    const channels = readableChannelIds(ctx);
    if (channels) {
      query.innerJoin(ChangeHistoryEntry, 'run', 'run.id = detail.entryId');
      inChannels(query, 'run', channels);
    }
    return query;
  }

  private async loadRunDetailsForEntity(
    ctx: RequestContext,
    subject: { entityType: string; entityId: ID },
    entryIds: ID[],
  ): Promise<Map<string, ChangeHistoryDetail[]>> {
    const grouped = new Map<string, ChangeHistoryDetail[]>();
    for (let i = 0; i < entryIds.length; i += DETAIL_CHUNK_SIZE) {
      const rows = await this.runRows(ctx, subject)
        .andWhere({ entryId: In(entryIds.slice(i, i + DETAIL_CHUNK_SIZE)) })
        .orderBy('detail.id', 'ASC')
        .getMany();
      for (const row of rows) {
        const key = String(row.entryId);
        grouped.set(key, [...(grouped.get(key) ?? []), row]);
      }
    }
    return grouped;
  }

  /** `(SELECT createdAt FROM <entry table> WHERE id = <id>)`, portable across the supported drivers. */
  private entryCreatedAtSql(id: ID): string {
    const { driver } = this.connection.rawConnection;
    const metadata = this.connection.rawConnection.getMetadata(ChangeHistoryEntry);
    const column = (property: string) => driver.escape(metadata.findColumnWithPropertyName(property)!.databaseName);
    const table = metadata.tablePath
      .split('.')
      .map((part) => driver.escape(part))
      .join('.');
    const literal = typeof id === 'number' ? String(id) : `'${String(id).replace(/'/g, "''")}'`;
    return `(SELECT ${column('createdAt')} FROM ${table} WHERE ${column('id')} = ${literal})`;
  }

  /** `{ 'ProductVariant:12' → { type: 'Product', id: 3 } }` for details that name no parent. */
  private async resolveParents(
    ctx: RequestContext,
    details: ChangeHistoryDetailInput[],
  ): Promise<Map<string, { type: string; id: ID }>> {
    const parents = new Map<string, { type: string; id: ID }>();
    for (const [entityType, lookup] of Object.entries(PARENT_LOOKUPS)) {
      const ids = [
        ...new Set(details.filter((d) => !d.parent && d.entityType === entityType).map((d) => String(d.entityId))),
      ];
      for (let i = 0; i < ids.length; i += DETAIL_CHUNK_SIZE) {
        const rows = (await this.connection.getRepository(ctx, lookup.entity).find({
          select: { id: true, [lookup.column]: true },
          where: { id: In(ids.slice(i, i + DETAIL_CHUNK_SIZE)) },
        })) as unknown as Array<Record<string, ID>>;
        for (const row of rows) {
          parents.set(`${entityType}:${String(row.id)}`, { type: lookup.parentType, id: row[lookup.column] });
        }
      }
    }
    return parents;
  }
}

/** Rows recorded for the entity itself, or for one of its children (a product's variants). */
function subjectCondition(subject: { entityType: string; entityId: ID }): Brackets {
  const params = { subjectType: subject.entityType, subjectId: String(subject.entityId) };
  return new Brackets((qb) =>
    qb
      .where('(detail.entityType = :subjectType AND detail.entityId = :subjectId)', params)
      .orWhere('(detail.parentType = :subjectType AND detail.parentId = :subjectId)', params),
  );
}

function runSummary(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count !== 0)
    .map(([key, count]) => `${key} ${count}`);
  return parts.length > 0 ? parts.join(', ') : 'no changes';
}
