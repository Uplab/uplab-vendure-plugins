import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, ListQueryOptions, PaginatedList, RequestContext } from '@vendure/core';
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
