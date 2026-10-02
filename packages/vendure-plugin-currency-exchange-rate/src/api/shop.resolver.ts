import { Args, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ListQueryOptions, PaginatedList, Permission, RequestContext } from '@vendure/core';
import { CurrencyExchangeRate } from '../entities/currency-exchange-rate.entity';
import { effectiveRate } from '../effective-rate';
import { CurrencyExchangeRateService } from '../services/currency-exchange-rate.service';

@Resolver()
export class CurrencyExchangeRateShopResolver {
  constructor(private currencyExchangeRateService: CurrencyExchangeRateService) {}

  /** Only the currencies an admin enabled: the storefront offers nothing else. */
  @Query()
  @Allow(Permission.Public)
  currencyExchangeRates(
    @Ctx() ctx: RequestContext,
    @Args() args: { options?: ListQueryOptions<CurrencyExchangeRate> },
  ): Promise<PaginatedList<CurrencyExchangeRate>> {
    const options = args.options ?? {};
    return this.currencyExchangeRateService.findAll(ctx, {
      ...options,
      filter: { ...options.filter, enabled: { eq: true } },
    });
  }
}

@Resolver('CurrencyExchangeRate')
export class CurrencyExchangeRateShopFieldResolver {
  @ResolveField()
  rate(currencyExchangeRate: CurrencyExchangeRate) {
    return effectiveRate(currencyExchangeRate);
  }
}
