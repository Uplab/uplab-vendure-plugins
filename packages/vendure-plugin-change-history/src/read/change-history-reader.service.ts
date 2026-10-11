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
  MAX_TIMELINE_RUN_DETAILS,
} from '../constants';
import { ChangeHistoryDetail } from '../entities/change-history-detail.entity';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { BatchCount } from '../retention/compact';
import { ResolvedChangeHistoryPluginOptions } from '../types';
import { Batcher } from './batcher';
import { inChannels, readableChannelIds, scopeKey } from './channel-scope';
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

/**
 * A timeline item; a run carries the subject's rows of it in `details` (the first {@link MAX_TIMELINE_RUN_DETAILS}),
 * how many it has in `detailsTotal` and how many entities they touch in `detailsEntityCount`.
 */
export type ChangeHistoryTimelineEntry = ChangeHistoryEntry & {
  details?: ChangeHistoryDetailView[];
  detailsTotal?: number;
  detailsEntityCount?: number;
};

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

interface CachedActor {
  id: string;
  type: string;
  label: string;
  /** When it was last recorded: its label then wins. */
  at: number;
}

interface CachedFilterOptions {
  at: number;
  /** The scope the values were read for (`undefined`: every channel). */
  channels: string[] | undefined;
  /** By `type:id`. */
  actors: Map<string, CachedActor>;
  sources: Set<string>;
  actions: Set<string>;
  entityTypes: Set<string>;
}

function rememberActor(actors: Map<string, CachedActor>, actor: CachedActor): void {
  const key = `${actor.type}:${actor.id}`;
  const known = actors.get(key);
  if (!known || actor.at >= known.at) {
    actors.set(key, actor);
  }
}

function filterOptionsOf(cached: CachedFilterOptions): ChangeHistoryFilterOptions {
  const sorted = (values: Set<string>) => [...values].sort(collator.compare);
  return {
    actors: [...cached.actors.values()]
      .sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.type, b.type))
      .map(({ id, type, label }) => ({ id, type, label })),
    sources: sorted(cached.sources),
    actions: sorted(cached.actions),
    entityTypes: sorted(cached.entityTypes),
  };
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
  private readonly parentsDeleted = new Batcher<RequestContext, ChangeHistoryEntry, boolean>(
    (entry) => String(entry.id),
    (ctx, entries) => this.loadParentsDeleted(ctx, entries),
  );
  /** Per channel scope (see `scopeKey`). */
  private readonly filterOptionsCache = new Map<string, CachedFilterOptions>();

  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly connection: TransactionalConnection,
    private readonly listQueryBuilder: ListQueryBuilder,
    writer: ChangeHistoryWriter,
  ) {
    writer.onSaved((entries) => this.mergeFilterOptions(entries));
  }

  /** Whether `ctx` may read the entry: always, unless the entry is in a channel the user may not read. */
  async readable(ctx: RequestContext, entryId: ID): Promise<boolean> {
    return !readableChannelIds(ctx) || (await this.entry(ctx, entryId)) !== null;
  }

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
    inChannels(query, alias, readableChannelIds(ctx));
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

  /** One entry, `null` when it does not exist or belongs to a channel the user may not read. */
  entry(ctx: RequestContext, id: ID): Promise<ChangeHistoryEntry | null> {
    const query = this.connection
      .getRepository(ctx, ChangeHistoryEntry)
      .createQueryBuilder('entry')
      .where('entry.id = :id', { id });
    return inChannels(query, 'entry', readableChannelIds(ctx)).getOne();
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
    const channels = readableChannelIds(ctx);
    return withPrimaryManager(this.connection, ctx, async (manager) => {
      const candidates: Candidate[] = [
        ...(await this.entryBranch(manager, channels, after, first + 1, (query) =>
          query.where('entry.entityType = :subjectType AND entry.entityId = :subjectId', subject),
        )),
      ];
      const runKeys = await this.runBranch(manager, channels, 'entity', subject, after, first + 1);
      if (includeChildren) {
        candidates.push(
          ...(await this.entryBranch(manager, channels, after, first + 1, (query) => {
            query
              .where('entry.parentType = :subjectType AND entry.parentId = :subjectId', subject)
              .andWhere('entry.derivedFromId IS NULL');
            if (args.entityType === CHANGE_HISTORY_ENTITY_TYPES.Collection) {
              // Contents changes are represented by their rules batch head.
              query.andWhere('entry.action NOT IN (:...membershipActions)', { membershipActions: MEMBERSHIP_ACTIONS });
            }
          })),
        );
        runKeys.push(...(await this.runBranch(manager, channels, 'parent', subject, after, first + 1)));
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
    if (!(await this.readable(ctx, entryId))) {
      return { items: [], totalItems: 0 };
    }
    const rows = await manager.getRepository(ChangeHistoryDetail).find({ where: { entryId }, order: { id: 'ASC' } });
    const views = await this.detailViews(ctx, manager, rows);
    return { items: views.slice(skip, skip + take), totalItems: views.length };
  }

  /**
   * Distinct actors, sources, actions and entity types of the last `summaryDays` in the channels the user may
   * read, for the filter dropdowns. Cached for 60 s per process and channel scope; what this process writes in
   * the meantime is merged into the cached values at once, so a write does not cost the next feed load four
   * grouped scans.
   */
  async filterOptions(ctx: RequestContext): Promise<ChangeHistoryFilterOptions> {
    const now = Date.now();
    const channels = readableChannelIds(ctx);
    const key = scopeKey(channels);
    const cached = this.filterOptionsCache.get(key);
    if (cached && now - cached.at < FILTER_OPTIONS_TTL_MS) {
      return filterOptionsOf(cached);
    }
    const since = new Date(now - this.options.retention.summaryDays * DAY_MS);
    const recent = () =>
      inChannels(
        this.connection
          .getRepository(ctx, ChangeHistoryEntry)
          .createQueryBuilder('entry')
          .where('entry.createdAt >= :since', { since }),
        'entry',
        channels,
      );
    const distinct = async (column: 'source' | 'action' | 'entityType') =>
      new Set(
        (
          await recent().select(`entry.${column}`, 'value').groupBy(`entry.${column}`).getRawMany<{ value: string }>()
        ).map((row) => row.value),
      );
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
    const actors = new Map<string, CachedActor>();
    for (const row of actorRows) {
      const at = row.lastAt instanceof Date ? row.lastAt.getTime() : Date.parse(String(row.lastAt).replace(' ', 'T'));
      rememberActor(actors, { id: String(row.id), type: row.type, label: row.label ?? String(row.id), at });
    }
    const fresh: CachedFilterOptions = {
      at: now,
      channels,
      actors,
      sources: await distinct('source'),
      actions: await distinct('action'),
      entityTypes: await distinct('entityType'),
    };
    this.filterOptionsCache.set(key, fresh);
    return filterOptionsOf(fresh);
  }

  /** New values of this process's writes go into every cached scope that may read them. */
  private mergeFilterOptions(entries: ChangeHistoryEntry[]): void {
    const now = Date.now();
    for (const cached of this.filterOptionsCache.values()) {
      for (const entry of entries) {
        if (cached.channels && !cached.channels.includes(String(entry.channelId))) {
          continue;
        }
        cached.sources.add(entry.source);
        cached.actions.add(entry.action);
        cached.entityTypes.add(entry.entityType);
        if (entry.actorId != null) {
          const id = String(entry.actorId);
          rememberActor(cached.actors, { id, type: entry.actorType, label: entry.actorLabel ?? id, at: now });
        }
      }
    }
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

  /**
   * Whether the entry's parent (a rules batch head's collection, the collection of a membership row, a variant's
   * product) no longer exists or is soft-deleted. Always `false` without a core parent.
   */
  async parentDeleted(ctx: RequestContext, entry: ChangeHistoryEntry): Promise<boolean> {
    if (!entry.parentType || !entry.parentId) {
      return false;
    }
    return (await this.parentsDeleted.get(ctx, entry)) ?? false;
  }

  private asText(path: string): string {
    return timestampAsText(this.connection.rawConnection.options.type, path);
  }

  private async entryBranch(
    manager: EntityManager,
    channels: string[] | undefined,
    after: TimelineKey | undefined,
    limit: number,
    where: (query: SelectQueryBuilder<ChangeHistoryEntry>) => void,
  ): Promise<Candidate[]> {
    const query = manager
      .getRepository(ChangeHistoryEntry)
      .createQueryBuilder('entry')
      .addSelect(this.asText('entry.createdAt'), 'cursor_created_at');
    where(query);
    inChannels(query, 'entry', channels);
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
    channels: string[] | undefined,
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
    if (channels) {
      // A run belongs to the channel of its entry.
      query.innerJoin(ChangeHistoryEntry, 'run', 'run.id = detail.entryId');
      inChannels(query, 'run', channels);
    }
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

  /**
   * Puts the subject's rows of each run of the page on the run's item — the first
   * {@link MAX_TIMELINE_RUN_DETAILS} by insertion order, labelled and sorted — with their total and the number
   * of entities they touch. A run of thousands of rows costs one grouped count and one capped read.
   */
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
    const ofSubject = (entryIds: ID[]) =>
      manager
        .getRepository(ChangeHistoryDetail)
        .createQueryBuilder('detail')
        .where({ entryId: In(entryIds) })
        .andWhere(
          new Brackets((query) => {
            query.where('(detail.entityType = :subjectType AND detail.entityId = :subjectId)', subject);
            if (includeChildren) {
              query.orWhere('(detail.parentType = :subjectType AND detail.parentId = :subjectId)', subject);
            }
          }),
        );
    const counts = await ofSubject(runs.map((candidate) => candidate.entry.id))
      .select('detail.entryId', 'entryId')
      .addSelect('COUNT(*)', 'total')
      .addSelect('COUNT(DISTINCT detail.entityId)', 'entities')
      .groupBy('detail.entryId')
      .addGroupBy('detail.entityType')
      .getRawMany<{ entryId: unknown; total: string | number; entities: string | number }>();
    const totals = new Map<string, { total: number; entities: number }>();
    for (const row of counts) {
      const known = totals.get(String(row.entryId)) ?? { total: 0, entities: 0 };
      totals.set(String(row.entryId), {
        total: known.total + Number(row.total),
        entities: known.entities + Number(row.entities),
      });
    }
    const rows: ChangeHistoryDetail[] = [];
    for (const candidate of runs) {
      const total = totals.get(String(candidate.entry.id))?.total ?? 0;
      if (total > 0) {
        rows.push(
          ...(await ofSubject([candidate.entry.id])
            .orderBy('detail.id', 'ASC')
            .limit(MAX_TIMELINE_RUN_DETAILS)
            .getMany()),
        );
      }
    }
    const grouped = new Map<string, ChangeHistoryDetailView[]>();
    for (const view of await this.detailViews(ctx, manager, rows)) {
      const key = String(view.entryId);
      grouped.set(key, [...(grouped.get(key) ?? []), view]);
    }
    for (const candidate of runs) {
      const key = String(candidate.entry.id);
      candidate.entry.details = grouped.get(key) ?? [];
      candidate.entry.detailsTotal = totals.get(key)?.total ?? 0;
      candidate.entry.detailsEntityCount = totals.get(key)?.entities ?? 0;
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

  /**
   * The derived entries still stored (counted live, kept cascaded deletions included), plus — once compacted —
   * the ones compaction deleted (its snapshot): the same total before and after compaction.
   */
  private async loadDerivedCounts(ctx: RequestContext, entries: ChangeHistoryEntry[]): Promise<Map<string, number>> {
    const compactedAway = new Map<string, number>();
    for (const entry of entries) {
      const snapshot = entry.compactedAt ? entry.meta?.derivedCount : undefined;
      compactedAway.set(String(entry.id), typeof snapshot === 'number' ? snapshot : 0);
    }
    const result = new Map(compactedAway);
    for (const chunk of chunks(entries.map((entry) => entry.id))) {
      const rows = await this.connection
        .getRepository(ctx, ChangeHistoryEntry)
        .createQueryBuilder('entry')
        .select('entry.derivedFromId', 'derivedFromId')
        .addSelect('COUNT(*)', 'count')
        .where({ derivedFromId: In(chunk) })
        .groupBy('entry.derivedFromId')
        .getRawMany<{ derivedFromId: unknown; count: string | number }>();
      for (const row of rows) {
        const id = String(row.derivedFromId);
        result.set(id, (compactedAway.get(id) ?? 0) + Number(row.count));
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

  private async loadParentsDeleted(ctx: RequestContext, entries: ChangeHistoryEntry[]): Promise<Map<string, boolean>> {
    const manager = this.connection.getRepository(ctx, ChangeHistoryEntry).manager;
    const parentOf = (entry: ChangeHistoryEntry) => ({ entityType: entry.parentType!, entityId: entry.parentId! });
    const deleted = await deletedRefs(manager, entries.map(parentOf));
    return new Map(entries.map((entry) => [String(entry.id), deleted.has(refKey(parentOf(entry)))]));
  }
}
