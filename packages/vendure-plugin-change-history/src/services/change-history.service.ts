import { Inject, Injectable } from '@nestjs/common';
import {
  FacetValue,
  ID,
  ListQueryBuilder,
  ListQueryOptions,
  Logger,
  PaginatedList,
  ProductVariant,
  RequestContext,
  TransactionalConnection,
} from '@vendure/core';
import { randomUUID } from 'node:crypto';
import { In } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { CapturePipeline } from '../capture/capture-pipeline';
import { ChangeHistoryWriter } from '../capture/entry-writer.service';
import {
  CHANGE_HISTORY_ACTIONS,
  CHANGE_HISTORY_ENTITY_TYPES,
  CHANGE_HISTORY_PLUGIN_OPTIONS,
  DETAIL_CHUNK_SIZE,
  MAX_BATCH_KIND_LENGTH,
  loggerCtx,
} from '../constants';
import { ChangeHistoryDetail } from '../entities/change-history-detail.entity';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
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
    private readonly listQueryBuilder: ListQueryBuilder,
    private readonly context: ChangeHistoryContextService,
    private readonly writer: ChangeHistoryWriter,
    private readonly pipeline: CapturePipeline,
    private readonly definitions: ChangeHistoryDefinitions,
  ) {}

  /**
   * Diff and record entities after a write that bypassed Vendure's events (raw SQL, a plugin's own
   * repository save), in the caller's transaction. Call it **after** the write, with the caller's `ctx`:
   * the before-state is what the transaction saw last for the entity, else its last committed row.
   * `created: true` means the rows are new (the before-state is empty). An entity whose diff is empty gets
   * no entry. Captures `Product` and `ProductVariant`; other types resolve without recording (logged once).
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
          `[ChangeHistory] capture() does not support ${entityType} in this release; nothing was recorded`,
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
   * An external run: one `Run` entry plus one detail row per changed value. Writes nothing when there
   * are no details and every count is 0.
   */
  async recordRun(ctx: RequestContext, input: ChangeHistoryRunInput): Promise<void> {
    if (!this.options.enabled) {
      return;
    }
    const details = input.details ?? [];
    const counts = input.counts ?? {};
    if (details.length === 0 && !Object.values(counts).some((count) => count !== 0)) {
      return;
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
            meta: { ...input.meta, counts, durationMs: input.durationMs, detailCount: details.length },
          },
        ];
      },
      {
        afterInsert: async (tctx, [entry]) => {
          const rows = details.map((detail) => {
            const parent = detail.parent ?? parents.get(`${detail.entityType}:${String(detail.entityId)}`);
            return Object.assign(new ChangeHistoryDetail(), {
              entryId: entry.id,
              createdAt: entry.createdAt,
              entityType: detail.entityType,
              entityId: String(detail.entityId),
              parentType: parent?.type ?? null,
              parentId: parent ? String(parent.id) : null,
              kind: detail.kind,
              scope: detail.scope ?? null,
              scopeLabel: detail.scopeLabel ? clip(detail.scopeLabel, 128) : null,
              fromValue: detail.from ?? null,
              toValue: detail.to ?? null,
            });
          });
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
    state.batch = { ...batch, id: `${batch.kind}:${randomUUID()}`, headWritten: false };
    try {
      return await fn(ctx);
    } finally {
      state.batch = undefined;
    }
  }

  /**
   * The feed: entries with Vendure's list options (filter, sort, paging), newest first by default.
   * Unstable in 0.x — the `changeHistoryEntries` query is the stable read API.
   */
  async list(
    ctx: RequestContext,
    options: ListQueryOptions<ChangeHistoryEntry> = {},
  ): Promise<PaginatedList<ChangeHistoryEntry>> {
    const sort =
      options.sort && Object.keys(options.sort).length > 0 ? options.sort : { createdAt: 'DESC', id: 'DESC' };
    const [items, totalItems] = await this.listQueryBuilder
      .build(ChangeHistoryEntry, { ...options, sort } as ListQueryOptions<ChangeHistoryEntry>, { ctx })
      .getManyAndCount();
    return { items, totalItems };
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

function runSummary(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count !== 0)
    .map(([key, count]) => `${key} ${count}`);
  return parts.length > 0 ? parts.join(', ') : 'no changes';
}
