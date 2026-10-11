import { Inject, Injectable } from '@nestjs/common';
import {
  ID,
  ListQueryBuilder,
  ListQueryOptions,
  PaginatedList,
  RequestContext,
  TransactionalConnection,
} from '@vendure/core';
import { Brackets, EntityManager, In, SelectQueryBuilder } from 'typeorm';
import { ChangeHistoryWriter } from '../capture/entry-writer.service';
import {
  CHANGE_HISTORY_ACTIONS,
  CHANGE_HISTORY_ENTITY_TYPES,
  CHANGE_HISTORY_PLUGIN_OPTIONS,
  DETAIL_CHUNK_SIZE,
  MAX_DETAIL_PAGE,
} from '../constants';
import { ChangeHistoryDetail } from '../entities/change-history-detail.entity';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { BatchCount } from '../retention/compact';
import { ResolvedChangeHistoryPluginOptions } from '../types';
import { Batcher } from './batcher';
import { compareKeys, decodeCursor, encodeCursor, TimelineKey } from './cursor';
import { currentLabels, deletedRefs, refKey } from './entity-lookups';
import { ordersTimestampsAsText, timestampAsText, withPrimaryManager } from './sql';

/** One row of a run with the current label of its entity, as the Admin API serves it. */
export interface ChangeHistoryDetailView {
  id: ID;
  entryId: ID;
  entityType: string;
  entityId: string;
  /** Current name in the request's language (a facet value as "Facet: Value"); `null` when it is gone. */
  entityLabel: string | null;
  /** The variant's current SKU. */
  sku: string | null;
  parentType: string | null;
  parentId: string | null;
  kind: string;
  scope: string | null;
  scopeLabel: string | null;
  from: unknown;
  to: unknown;
}

/** A timeline item; a run carries the subject's rows of it in `details`. */
export type ChangeHistoryTimelineEntry = ChangeHistoryEntry & { details?: ChangeHistoryDetailView[] };

export interface ChangeHistoryEntityTimeline {
  items: ChangeHistoryTimelineEntry[];
  /** Pass as `after` for the next page; `null` when the page is empty. */
  endCursor: string | null;
  hasMore: boolean;
}

export interface ChangeHistoryTimelineArgs {
  entityType: string;
  /** The id as stored in `entityId` (the database id). */
  entityId: ID;
  /** Children's own entries (variants of a product, values of a facet, …). Default `true`. */
  includeChildren?: boolean;
  /** Page size, 1–100. Default 20. */
  first?: number;
  after?: string | null;
}

export interface ChangeHistoryFilterOptions {
  actors: Array<{ id: ID; type: string; label: string }>;
  sources: string[];
  actions: string[];
  entityTypes: string[];
}

interface Candidate {
  entry: ChangeHistoryTimelineEntry;
  key: TimelineKey;
  run: boolean;
}

const MEMBERSHIP_ACTIONS = [CHANGE_HISTORY_ACTIONS.collection_added, CHANGE_HISTORY_ACTIONS.collection_removed];
const MAX_TIMELINE_PAGE = 100;
const FILTER_OPTIONS_TTL_MS = 60_000;
const DAY_MS = 86_400_000;
const collator = new Intl.Collator(undefined, { numeric: true });

const clamp = (value: number | undefined | null, fallback: number, max: number) =>
  Math.min(max, Math.max(1, Math.trunc(value ?? fallback)));

function chunks<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += DETAIL_CHUNK_SIZE) {
    result.push(items.slice(i, i + DETAIL_CHUNK_SIZE));
  }
  return result;
}

/** Whether a list filter names `property`, also inside `_and` / `_or`. */
function filterMentions(filter: unknown, property: string): boolean {
  if (!filter || typeof filter !== 'object') {
    return false;
  }
  return Object.entries(filter as Record<string, unknown>).some(([key, value]) =>
    key === '_and' || key === '_or'
      ? Array.isArray(value) && value.some((nested) => filterMentions(nested, property))
      : key === property,
  );
}

/** Sorted by SKU (or name), then name, then scope — the order a person scans a run in. */
function compareDetails(a: ChangeHistoryDetailView, b: ChangeHistoryDetailView): number {
  return (
    collator.compare(a.sku ?? a.entityLabel ?? a.entityId, b.sku ?? b.entityLabel ?? b.entityId) ||
    collator.compare(a.entityLabel ?? '', b.entityLabel ?? '') ||
    collator.compare(a.scopeLabel ?? a.scope ?? '', b.scopeLabel ?? b.scope ?? '') ||
    collator.compare(String(a.id), String(b.id))
  );
}

/**
 * The read side behind the Admin API: the feed, entity timelines (keyset), run details with current labels,
 * filter options and the per-entry counts. Field values are loaded in one query per page (`Batcher`).
 */
@Injectable()
export class ChangeHistoryReader {
  private readonly derivedCounts = new Batcher<RequestContext, ChangeHistoryEntry, number>(
    (entry) => String(entry.id),
    (ctx, entries) => this.loadDerivedCounts(ctx, entries),
  );
  private readonly batchCounts = new Batcher<RequestContext, ChangeHistoryEntry, BatchCount[]>(
    (entry) => String(entry.id),
    (ctx, entries) => this.loadBatchCounts(ctx, entries),
  );
  private readonly deleted = new Batcher<RequestContext, ChangeHistoryEntry, boolean>(
    (entry) => String(entry.id),
    (ctx, entries) => this.loadDeleted(ctx, entries),
  );
  private filterOptionsCache?: { at: number; writes: number; value: ChangeHistoryFilterOptions };

  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly connection: TransactionalConnection,
    private readonly listQueryBuilder: ListQueryBuilder,
    private readonly writer: ChangeHistoryWriter,
  ) {}

  /**
   * The feed: Vendure's list options, newest first by default. Derived entries are left out unless the filter
   * names `derivedFromId` (their cause shows `derivedCount`). `scope` narrows to one cause's derived entries or
   * one batch's members (the head excluded).
   */
  async list(
    ctx: RequestContext,
    options: ListQueryOptions<ChangeHistoryEntry> = {},
    scope: { derivedFromId?: ID; batchId?: string } = {},
  ): Promise<PaginatedList<ChangeHistoryEntry>> {
    const sort =
      options.sort && Object.keys(options.sort).length > 0 ? options.sort : { createdAt: 'DESC', id: 'DESC' };
    const query = this.listQueryBuilder.build(
      ChangeHistoryEntry,
      { ...options, sort } as ListQueryOptions<ChangeHistoryEntry>,
      { ctx },
    );
    const alias = query.alias;
    if (scope.derivedFromId !== undefined) {
      query.andWhere(`${alias}.derivedFromId = :chDerivedFromId`, { chDerivedFromId: scope.derivedFromId });
    } else if (!filterMentions(options.filter, 'derivedFromId')) {
      query.andWhere(`${alias}.derivedFromId IS NULL`);
    }
    if (scope.batchId !== undefined) {
      query
        .andWhere(`${alias}.batchId = :chBatchId`, { chBatchId: scope.batchId })
        .andWhere(`${alias}.entityType != :chBatchType`, { chBatchType: CHANGE_HISTORY_ENTITY_TYPES.Batch });
    }
    const [items, totalItems] = await query.getManyAndCount();
    return { items, totalItems };
  }

  entry(ctx: RequestContext, id: ID): Promise<ChangeHistoryEntry | null> {
    return this.connection.getRepository(ctx, ChangeHistoryEntry).findOne({ where: { id } });
  }

  /**
   * One entity's history, newest first, keyset-paged on `(createdAt, id)` with the raw database timestamp in
   * the cursor. Own entries (derived ones included); with `includeChildren` the children's non-derived
   * entries (a product's variants, a facet's values, a collection's child collections and rules batches — not
   * the batch members); runs whose rows name the entity (or, with children, its children) as one item each with
   * only those rows. Read from the primary database.
   */
  async timeline(ctx: RequestContext, args: ChangeHistoryTimelineArgs): Promise<ChangeHistoryEntityTimeline> {
    const first = clamp(args.first, 20, MAX_TIMELINE_PAGE);
    const after = args.after ? decodeCursor(args.after) : undefined;
    const includeChildren = args.includeChildren !== false;
    const subject = { subjectType: args.entityType, subjectId: String(args.entityId) };
    const driver = this.connection.rawConnection.options.type;
    return withPrimaryManager(this.connection, ctx, async (manager) => {
      const candidates: Candidate[] = [
        ...(await this.entryBranch(manager, after, first + 1, (query) =>
          query.where('entry.entityType = :subjectType AND entry.entityId = :subjectId', subject),
        )),
      ];
      const runKeys = await this.runBranch(manager, 'entity', subject, after, first + 1);
      if (includeChildren) {
        candidates.push(
          ...(await this.entryBranch(manager, after, first + 1, (query) => {
            query
              .where('entry.parentType = :subjectType AND entry.parentId = :subjectId', subject)
              .andWhere('entry.derivedFromId IS NULL');
            if (args.entityType === CHANGE_HISTORY_ENTITY_TYPES.Collection) {
              // Contents changes are represented by their rules batch head.
              query.andWhere('entry.action NOT IN (:...membershipActions)', { membershipActions: MEMBERSHIP_ACTIONS });
            }
          })),
        );
        runKeys.push(...(await this.runBranch(manager, 'parent', subject, after, first + 1)));
      }
      candidates.push(...(await this.runCandidates(manager, runKeys)));

      const byId = new Map<string, Candidate>();
      for (const candidate of candidates) {
        const known = byId.get(candidate.key.id);
        byId.set(candidate.key.id, known ? { ...known, run: known.run || candidate.run } : candidate);
      }
      const textual = ordersTimestampsAsText(driver);
      const sorted = [...byId.values()].sort((a, b) => compareKeys(b.key, a.key, textual));
      const page = sorted.slice(0, first);
      await this.fillDetails(ctx, manager, subject, includeChildren, page);
      const last = page.at(-1);
      return {
        items: page.map((candidate) => candidate.entry),
        endCursor: last ? encodeCursor(last.key) : null,
        hasMore: sorted.length > first,
      };
    });
  }

  /** A run's rows with current labels, sorted by SKU (or name), name, scope; paged (`take` 1–500, default 100). */
  async runDetails(
    ctx: RequestContext,
    entryId: ID,
    opts: { skip?: number | null; take?: number | null } = {},
  ): Promise<PaginatedList<ChangeHistoryDetailView>> {
    const skip = Math.max(0, Math.trunc(opts.skip ?? 0));
    const take = clamp(opts.take, 100, MAX_DETAIL_PAGE);
    const manager = this.connection.getRepository(ctx, ChangeHistoryDetail).manager;
    const rows = await manager.getRepository(ChangeHistoryDetail).find({ where: { entryId }, order: { id: 'ASC' } });
    const views = await this.detailViews(ctx, manager, rows);
    return { items: views.slice(skip, skip + take), totalItems: views.length };
  }

  /**
   * Distinct actors, sources, actions and entity types of the last `summaryDays`, for the filter dropdowns.
   * Cached for 60 s per process, and dropped as soon as this process writes an entry.
   */
  async filterOptions(ctx: RequestContext): Promise<ChangeHistoryFilterOptions> {
    const now = Date.now();
    const cached = this.filterOptionsCache;
    if (cached && cached.writes === this.writer.writes && now - cached.at < FILTER_OPTIONS_TTL_MS) {
      return cached.value;
    }
    const writes = this.writer.writes;
    const since = new Date(now - this.options.retention.summaryDays * DAY_MS);
    const recent = () =>
      this.connection
        .getRepository(ctx, ChangeHistoryEntry)
        .createQueryBuilder('entry')
        .where('entry.createdAt >= :since', { since });
    const distinct = async (column: 'source' | 'action' | 'entityType') =>
      (await recent().select(`entry.${column}`, 'value').groupBy(`entry.${column}`).getRawMany<{ value: string }>())
        .map((row) => row.value)
        .sort(collator.compare);
    const actorRows = await recent()
      .select('entry.actorId', 'id')
      .addSelect('entry.actorType', 'type')
      .addSelect('entry.actorLabel', 'label')
      .addSelect('MAX(entry.createdAt)', 'lastAt')
      .andWhere('entry.actorId IS NOT NULL')
      .groupBy('entry.actorId')
      .addGroupBy('entry.actorType')
      .addGroupBy('entry.actorLabel')
      .getRawMany<{ id: string; type: string; label: string | null; lastAt: unknown }>();
    // One item per actor and type, under the label it was last recorded with.
    const latest = new Map<string, { id: string; type: string; label: string; at: number }>();
    for (const row of actorRows) {
      const at = row.lastAt instanceof Date ? row.lastAt.getTime() : Date.parse(String(row.lastAt).replace(' ', 'T'));
      const key = `${row.type}:${row.id}`;
      const known = latest.get(key);
      if (!known || at > known.at) {
        latest.set(key, { id: String(row.id), type: row.type, label: row.label ?? String(row.id), at });
      }
    }
    const value: ChangeHistoryFilterOptions = {
      actors: [...latest.values()]
        .sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.type, b.type))
        .map(({ id, type, label }) => ({ id, type, label })),
      sources: await distinct('source'),
      actions: await distinct('action'),
      entityTypes: await distinct('entityType'),
    };
    this.filterOptionsCache = { at: now, writes, value };
    return value;
  }

  /** Entries derived from this one; the snapshot compaction kept, once the rows are gone. */
  async derivedCount(ctx: RequestContext, entry: ChangeHistoryEntry): Promise<number> {
    return (await this.derivedCounts.get(ctx, entry)) ?? 0;
  }

  /** A batch head's members by type and action (the snapshot once compacted); `null` for other entries. */
  async batchCountsOf(ctx: RequestContext, entry: ChangeHistoryEntry): Promise<BatchCount[] | null> {
    if (entry.entityType !== CHANGE_HISTORY_ENTITY_TYPES.Batch || !entry.batchId) {
      return null;
    }
    return (await this.batchCounts.get(ctx, entry)) ?? [];
  }

  /** Whether the recorded core entity no longer exists (or is soft-deleted). Always `false` for other types. */
  async entityDeleted(ctx: RequestContext, entry: ChangeHistoryEntry): Promise<boolean> {
    return (await this.deleted.get(ctx, entry)) ?? false;
  }

  private asText(path: string): string {
    return timestampAsText(this.connection.rawConnection.options.type, path);
  }

  private async entryBranch(
    manager: EntityManager,
    after: TimelineKey | undefined,
    limit: number,
    where: (query: SelectQueryBuilder<ChangeHistoryEntry>) => void,
  ): Promise<Candidate[]> {
    const query = manager
      .getRepository(ChangeHistoryEntry)
      .createQueryBuilder('entry')
      .addSelect(this.asText('entry.createdAt'), 'cursor_created_at');
    where(query);
    if (after) {
      query.andWhere('(entry.createdAt < :afterAt OR (entry.createdAt = :afterAt AND entry.id < :afterId))', {
        afterAt: after.createdAt,
        afterId: after.id,
      });
    }
    const { entities, raw } = await query
      .orderBy('entry.createdAt', 'DESC')
      .addOrderBy('entry.id', 'DESC')
      .limit(limit)
      .getRawAndEntities<{ entry_id: unknown; cursor_created_at: unknown }>();
    const createdAt = new Map(raw.map((row) => [String(row.entry_id), String(row.cursor_created_at)]));
    return entities.map((entry) => ({
      entry,
      key: { createdAt: createdAt.get(String(entry.id)) ?? '', id: String(entry.id) },
      run: false,
    }));
  }

  /** Runs with a row of the subject (`entity`) or of one of its children (`parent`): `(createdAt, entryId)`. */
  private async runBranch(
    manager: EntityManager,
    side: 'entity' | 'parent',
    subject: { subjectType: string; subjectId: string },
    after: TimelineKey | undefined,
    limit: number,
  ): Promise<TimelineKey[]> {
    const [typeColumn, idColumn] = side === 'entity' ? ['entityType', 'entityId'] : ['parentType', 'parentId'];
    const query = manager
      .getRepository(ChangeHistoryDetail)
      .createQueryBuilder('detail')
      .select('detail.entryId', 'entryId')
      .addSelect(this.asText('detail.createdAt'), 'createdAt')
      .where(`detail.${typeColumn} = :subjectType AND detail.${idColumn} = :subjectId`, subject);
    if (after) {
      query.andWhere('(detail.createdAt < :afterAt OR (detail.createdAt = :afterAt AND detail.entryId < :afterId))', {
        afterAt: after.createdAt,
        afterId: after.id,
      });
    }
    const rows = await query
      .groupBy('detail.entryId')
      .addGroupBy('detail.createdAt')
      .orderBy('detail.createdAt', 'DESC')
      .addOrderBy('detail.entryId', 'DESC')
      .limit(limit)
      .getRawMany<{ entryId: unknown; createdAt: unknown }>();
    return rows.map((row) => ({ createdAt: String(row.createdAt), id: String(row.entryId) }));
  }

  private async runCandidates(manager: EntityManager, keys: TimelineKey[]): Promise<Candidate[]> {
    if (keys.length === 0) {
      return [];
    }
    const entries = await manager
      .getRepository(ChangeHistoryEntry)
      .find({ where: { id: In([...new Set(keys.map((key) => key.id))]) } });
    const byId = new Map(entries.map((entry) => [String(entry.id), entry]));
    return keys.filter((key) => byId.has(key.id)).map((key) => ({ entry: byId.get(key.id)!, key, run: true }));
  }

  /** Puts the subject's rows of each run of the page on the run's item, labelled and sorted. */
  private async fillDetails(
    ctx: RequestContext,
    manager: EntityManager,
    subject: { subjectType: string; subjectId: string },
    includeChildren: boolean,
    page: Candidate[],
  ): Promise<void> {
    const runs = page.filter((candidate) => candidate.run);
    if (runs.length === 0) {
      return;
    }
    const rows = await manager
      .getRepository(ChangeHistoryDetail)
      .createQueryBuilder('detail')
      .where({ entryId: In(runs.map((candidate) => candidate.entry.id)) })
      .andWhere(
        new Brackets((query) => {
          query.where('(detail.entityType = :subjectType AND detail.entityId = :subjectId)', subject);
          if (includeChildren) {
            query.orWhere('(detail.parentType = :subjectType AND detail.parentId = :subjectId)', subject);
          }
        }),
      )
      .orderBy('detail.id', 'ASC')
      .getMany();
    const grouped = new Map<string, ChangeHistoryDetailView[]>();
    for (const view of await this.detailViews(ctx, manager, rows)) {
      const key = String(view.entryId);
      grouped.set(key, [...(grouped.get(key) ?? []), view]);
    }
    for (const candidate of runs) {
      candidate.entry.details = grouped.get(String(candidate.entry.id)) ?? [];
    }
  }

  private async detailViews(
    ctx: RequestContext,
    manager: EntityManager,
    rows: ChangeHistoryDetail[],
  ): Promise<ChangeHistoryDetailView[]> {
    const labels = await currentLabels(ctx, manager, rows);
    return rows
      .map((row) => {
        const label = labels.get(refKey(row));
        return {
          id: row.id,
          entryId: row.entryId,
          entityType: row.entityType,
          entityId: row.entityId,
          entityLabel: label?.label ?? null,
          sku: label?.sku ?? null,
          parentType: row.parentType,
          parentId: row.parentId,
          kind: row.kind,
          scope: row.scope,
          scopeLabel: row.scopeLabel,
          from: row.fromValue ?? null,
          to: row.toValue ?? null,
        };
      })
      .sort(compareDetails);
  }

  private async loadDerivedCounts(ctx: RequestContext, entries: ChangeHistoryEntry[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const live: ID[] = [];
    for (const entry of entries) {
      const snapshot = entry.compactedAt ? entry.meta?.derivedCount : undefined;
      if (typeof snapshot === 'number') {
        result.set(String(entry.id), snapshot);
      } else {
        result.set(String(entry.id), 0);
        live.push(entry.id);
      }
    }
    for (const chunk of chunks(live)) {
      const rows = await this.connection
        .getRepository(ctx, ChangeHistoryEntry)
        .createQueryBuilder('entry')
        .select('entry.derivedFromId', 'derivedFromId')
        .addSelect('COUNT(*)', 'count')
        .where({ derivedFromId: In(chunk) })
        .groupBy('entry.derivedFromId')
        .getRawMany<{ derivedFromId: unknown; count: string | number }>();
      for (const row of rows) {
        result.set(String(row.derivedFromId), Number(row.count));
      }
    }
    return result;
  }

  private async loadBatchCounts(ctx: RequestContext, heads: ChangeHistoryEntry[]): Promise<Map<string, BatchCount[]>> {
    const result = new Map<string, BatchCount[]>();
    const live = new Map<string, string[]>();
    for (const head of heads) {
      const snapshot = head.compactedAt ? head.meta?.batchCounts : undefined;
      if (Array.isArray(snapshot)) {
        result.set(String(head.id), snapshot as BatchCount[]);
      } else {
        result.set(String(head.id), []);
        live.set(head.batchId!, [...(live.get(head.batchId!) ?? []), String(head.id)]);
      }
    }
    for (const chunk of chunks([...live.keys()])) {
      const rows = await this.connection
        .getRepository(ctx, ChangeHistoryEntry)
        .createQueryBuilder('entry')
        .select('entry.batchId', 'batchId')
        .addSelect('entry.entityType', 'entityType')
        .addSelect('entry.action', 'action')
        .addSelect('COUNT(*)', 'count')
        .where({ batchId: In(chunk) })
        .andWhere('entry.entityType != :batch', { batch: CHANGE_HISTORY_ENTITY_TYPES.Batch })
        .groupBy('entry.batchId')
        .addGroupBy('entry.entityType')
        .addGroupBy('entry.action')
        .orderBy('entry.entityType', 'ASC')
        .addOrderBy('entry.action', 'ASC')
        .getRawMany<{ batchId: string; entityType: string; action: string; count: string | number }>();
      for (const row of rows) {
        for (const headId of live.get(row.batchId) ?? []) {
          result.get(headId)!.push({ entityType: row.entityType, action: row.action, count: Number(row.count) });
        }
      }
    }
    return result;
  }

  private async loadDeleted(ctx: RequestContext, entries: ChangeHistoryEntry[]): Promise<Map<string, boolean>> {
    const manager = this.connection.getRepository(ctx, ChangeHistoryEntry).manager;
    const deleted = await deletedRefs(manager, entries);
    return new Map(entries.map((entry) => [String(entry.id), deleted.has(refKey(entry))]));
  }
}
