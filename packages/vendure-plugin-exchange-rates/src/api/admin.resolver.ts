import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
  Allow,
  Ctx,
  ID,
  ListQueryOptions,
  PaginatedList,
  Permission,
  RequestContext,
  Transaction,
} from '@vendure/core';
import { CurrencyExchangeRate } from '../entities/currency-exchange-rate.entity';
import { CurrencyExchangeRateService } from '../services/currency-exchange-rate.service';
import { MutationUpdateCurrencyExchangeRateArgs } from '../types';

@Resolver()
export class CurrencyExchangeRateAdminResolver {
  constructor(private currencyExchangeRateService: CurrencyExchangeRateService) {}

  @Query()
  @Allow(Permission.ReadSettings)
  currencyExchangeRates(
    @Ctx() ctx: RequestContext,
    @Args() args: { options: ListQueryOptions<CurrencyExchangeRate> },
  ): Promise<PaginatedList<CurrencyExchangeRate>> {
    return this.currencyExchangeRateService.findAll(ctx, args.options);
  }

  @Query()
  @Allow(Permission.ReadSettings)
  currencyExchangeRate(@Ctx() ctx: RequestContext, @Args() args: { id: ID }): Promise<CurrencyExchangeRate | null> {
    return this.currencyExchangeRateService.findOne(ctx, args.id);
  }

  @Transaction()
  @Mutation()
  @Allow(Permission.UpdateSettings)
  updateCurrencyExchangeRate(
    @Ctx() ctx: RequestContext,
    @Args() args: MutationUpdateCurrencyExchangeRateArgs,
  ): Promise<CurrencyExchangeRate> {
    return this.currencyExchangeRateService.update(ctx, args.input);
  }
}

@Resolver('CurrencyExchangeRate')
export class CurrencyExchangeRateAdminFieldResolver {
  constructor(private currencyExchangeRateService: CurrencyExchangeRateService) {}

  /**
   * A row from before the `baseCurrency` column is adopted on boot and in every sync; one that is listed
   * before that (e.g. while an older instance still runs a rolling deploy) shows the base it will get,
   * instead of failing the whole non-null list.
   */
  @ResolveField()
  async baseCurrency(@Ctx() ctx: RequestContext, @Parent() row: CurrencyExchangeRate) {
    return row.baseCurrency || this.currencyExchangeRateService.getBaseCurrency(ctx);
  }
}
