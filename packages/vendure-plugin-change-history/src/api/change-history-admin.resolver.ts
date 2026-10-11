import { Args, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ListQueryOptions, PaginatedList, RequestContext } from '@vendure/core';
import { readChangeHistory } from '../constants';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { ChangeHistoryService } from '../services/change-history.service';

@Resolver()
export class ChangeHistoryAdminResolver {
  constructor(private readonly changeHistoryService: ChangeHistoryService) {}

  @Query()
  @Allow(readChangeHistory.Permission)
  changeHistoryEntries(
    @Ctx() ctx: RequestContext,
    @Args() args: { options?: ListQueryOptions<ChangeHistoryEntry> },
  ): Promise<PaginatedList<ChangeHistoryEntry>> {
    return this.changeHistoryService.list(ctx, args.options);
  }
}
