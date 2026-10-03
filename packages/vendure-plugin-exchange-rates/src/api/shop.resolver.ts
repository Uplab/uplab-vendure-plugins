import { Args, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ListQueryOptions, PaginatedList, Permission, RequestContext } from '@vendure/core';
import { CurrencyExchangeRate } from '../entities/currency-exchange-rate.entity';
import { effectiveRate } from '../effective-rate';
import { CurrencyExchangeRateService } from '../services/currency-exchange-rate.service';

@Resolver()
export class CurrencyExchangeRateShopResolver {
  constructor(private currencyExchangeRateService: CurrencyExchangeRateService) {}

  /** Only the currencies an admin enabled, in the current base: the storefront offers nothing else. */
  @Query()
  @Allow(Permission.Public)
  async currencyExchangeRates(
    @Ctx() ctx: RequestContext,
    @Args() args: { options?: ListQueryOptions<CurrencyExchangeRate> },
  ): Promise<PaginatedList<CurrencyExchangeRate>> {
    return this.currencyExchangeRateService.findAll(ctx, args.options, {
      enabled: true,
      baseCurrency: await this.currencyExchangeRateService.getBaseCurrency(ctx),
    });
  }
}

@Resolver('CurrencyExchangeRate')
export class CurrencyExchangeRateShopFieldResolver {
  @ResolveField()
  rate(currencyExchangeRate: CurrencyExchangeRate) {
    // The Admin API forbids a custom rate that is on but empty, so this falls back only for old rows.
    return effectiveRate(currencyExchangeRate) ?? currencyExchangeRate.rate;
  }
}
