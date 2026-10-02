import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext, Transaction } from '@vendure/core';
import { NovaPoshtaService } from './nova-poshta.service';
import type {
  NovaPoshtaCitiesInput,
  NovaPoshtaCity,
  NovaPoshtaCountrySyncResult,
  NovaPoshtaInternationalCitiesInput,
  NovaPoshtaInternationalCity,
  NovaPoshtaInternationalWarehouse,
  NovaPoshtaInternationalWarehousesInput,
  NovaPoshtaWarehouse,
  NovaPoshtaWarehousesInput,
} from './types';

/** Public, like the rest of checkout: a guest picks a warehouse before signing in. */
@Resolver()
export class NovaPoshtaShopResolver {
  constructor(private readonly novaPoshtaService: NovaPoshtaService) {}

  @Query()
  novaPoshtaCities(
    @Ctx() ctx: RequestContext,
    @Args() args: { input: NovaPoshtaCitiesInput },
  ): Promise<NovaPoshtaCity[]> {
    return this.novaPoshtaService.getCities(ctx, args.input);
  }

  @Query()
  novaPoshtaWarehouses(
    @Ctx() ctx: RequestContext,
    @Args() args: { input: NovaPoshtaWarehousesInput },
  ): Promise<NovaPoshtaWarehouse[]> {
    return this.novaPoshtaService.getWarehouses(ctx, args.input);
  }

  @Query()
  novaPoshtaInternationalCities(
    @Ctx() ctx: RequestContext,
    @Args() args: { input: NovaPoshtaInternationalCitiesInput },
  ): Promise<NovaPoshtaInternationalCity[]> {
    return this.novaPoshtaService.getInternationalCities(ctx, args.input);
  }

  @Query()
  novaPoshtaInternationalWarehouses(
    @Ctx() ctx: RequestContext,
    @Args() args: { input: NovaPoshtaInternationalWarehousesInput },
  ): Promise<NovaPoshtaInternationalWarehouse[]> {
    return this.novaPoshtaService.getInternationalWarehouses(ctx, args.input);
  }
}

@Resolver()
export class NovaPoshtaAdminResolver {
  constructor(private readonly novaPoshtaService: NovaPoshtaService) {}

  @Transaction()
  @Mutation()
  @Allow(Permission.UpdateCountry)
  novaPoshtaSyncCountries(@Ctx() ctx: RequestContext): Promise<NovaPoshtaCountrySyncResult> {
    return this.novaPoshtaService.syncCountries(ctx);
  }
}
