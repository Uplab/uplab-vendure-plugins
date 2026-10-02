import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
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
    return this.currencyExchangeRateService.findAll(ctx, args.options || undefined);
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
  ): Promise<CurrencyExchangeRate | undefined> {
    return this.currencyExchangeRateService.update(ctx, args.input);
  }
}
