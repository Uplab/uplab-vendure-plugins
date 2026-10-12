import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, ListQueryOptions, PaginatedList, RequestContext } from '@vendure/core';
import { plainActorLabel } from '../actors/built-in-resolvers';
import { CHANGE_HISTORY_ENTITY_TYPES, readChangeHistory } from '../constants';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import {
  ChangeHistoryDetailView,
  ChangeHistoryEntityTimeline,
  ChangeHistoryFilterOptions,
  ChangeHistoryReader,
  ChangeHistoryTimelineArgs,
} from '../read/change-history-reader.service';
import { BatchCount } from '../retention/compact';

type ListArgs = { options?: ListQueryOptions<ChangeHistoryEntry> };

const EMPTY: PaginatedList<ChangeHistoryEntry> = { items: [], totalItems: 0 };

/** A batch head written without a label: the writer stored its kind in the label column. */
function isUnlabelledBatchHead(entry: ChangeHistoryEntry): boolean {
  const { meta } = entry;
  return (
    entry.entityType === CHANGE_HISTORY_ENTITY_TYPES.Batch &&
    meta.label == null &&
    typeof meta.kind === 'string' &&
    entry.entityLabel === meta.kind
  );
}

@Resolver()
export class ChangeHistoryAdminResolver {
  constructor(private readonly reader: ChangeHistoryReader) {}

  @Query()
  @Allow(readChangeHistory.Permission)
  changeHistoryEntries(@Ctx() ctx: RequestContext, @Args() args: ListArgs): Promise<PaginatedList<ChangeHistoryEntry>> {
    return this.reader.list(ctx, args.options);
  }

  @Query()
  @Allow(readChangeHistory.Permission)
  changeHistoryEntry(@Ctx() ctx: RequestContext, @Args() args: { id: ID }): Promise<ChangeHistoryEntry | null> {
    return this.reader.entry(ctx, args.id);
  }

  @Query()
  @Allow(readChangeHistory.Permission)
  changeHistoryEntityTimeline(
    @Ctx() ctx: RequestContext,
    @Args() args: ChangeHistoryTimelineArgs,
  ): Promise<ChangeHistoryEntityTimeline> {
    return this.reader.timeline(ctx, args);
  }

  @Query()
  @Allow(readChangeHistory.Permission)
  changeHistoryRunDetails(
    @Ctx() ctx: RequestContext,
    @Args() args: { entryId: ID; skip?: number | null; take?: number | null },
  ): Promise<PaginatedList<ChangeHistoryDetailView>> {
    return this.reader.runDetails(ctx, args.entryId, args);
  }

  @Query()
  @Allow(readChangeHistory.Permission)
  changeHistoryFilterOptions(@Ctx() ctx: RequestContext): Promise<ChangeHistoryFilterOptions> {
    return this.reader.filterOptions(ctx);
  }
}

/** Fields computed per entry; the counts are loaded in one query per page. */
@Resolver('ChangeHistoryEntry')
export class ChangeHistoryEntryResolver {
  constructor(private readonly reader: ChangeHistoryReader) {}

  /**
   * The stored label, except for a batch recorded without one: its label column holds the batch kind, which is
   * a key, not a name — `null` tells the client to name the kind itself.
   */
  @ResolveField()
  entityLabel(@Parent() entry: ChangeHistoryEntry): string | null {
    return isUnlabelledBatchHead(entry) ? null : entry.entityLabel;
  }

  /** The actor's name (rows of pre-release versions said "Name (API key)"; `actorType` says it). */
  @ResolveField()
  actorLabel(@Parent() entry: ChangeHistoryEntry): string | null {
    return plainActorLabel(entry.actorType, entry.actorLabel);
  }

  @ResolveField()
  isCompacted(@Parent() entry: ChangeHistoryEntry): boolean {
    return entry.compactedAt != null;
  }

  @ResolveField()
  derivedCount(@Ctx() ctx: RequestContext, @Parent() entry: ChangeHistoryEntry): Promise<number> {
    return this.reader.derivedCount(ctx, entry);
  }

  @ResolveField()
  batchCounts(@Ctx() ctx: RequestContext, @Parent() entry: ChangeHistoryEntry): Promise<BatchCount[] | null> {
    return this.reader.batchCountsOf(ctx, entry);
  }

  @ResolveField()
  entityDeleted(@Ctx() ctx: RequestContext, @Parent() entry: ChangeHistoryEntry): Promise<boolean> {
    return this.reader.entityDeleted(ctx, entry);
  }

  @ResolveField()
  parentDeleted(@Ctx() ctx: RequestContext, @Parent() entry: ChangeHistoryEntry): Promise<boolean> {
    return this.reader.parentDeleted(ctx, entry);
  }

  @ResolveField()
  derivedEntries(
    @Ctx() ctx: RequestContext,
    @Parent() entry: ChangeHistoryEntry,
    @Args() args: ListArgs,
  ): Promise<PaginatedList<ChangeHistoryEntry>> {
    return this.reader.list(ctx, args.options, { derivedFromId: entry.id });
  }

  @ResolveField()
  async batchMembers(
    @Ctx() ctx: RequestContext,
    @Parent() entry: ChangeHistoryEntry,
    @Args() args: ListArgs,
  ): Promise<PaginatedList<ChangeHistoryEntry>> {
    if (entry.entityType !== CHANGE_HISTORY_ENTITY_TYPES.Batch || !entry.batchId) {
      return EMPTY;
    }
    return this.reader.list(ctx, args.options, { batchId: entry.batchId });
  }
}
