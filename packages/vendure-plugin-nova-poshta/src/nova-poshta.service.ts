import { Injectable } from '@nestjs/common';
import { Country, Logger, type RequestContext, TransactionalConnection } from '@vendure/core';
import { NOVA_POSHTA_LOGGER_CTX, NOVA_POSHTA_WAREHOUSE_CATEGORIES } from './constants';
import { NovaPoshtaClient } from './nova-poshta.client';
import type {
  NovaPoshtaCitiesInput,
  NovaPoshtaCity,
  NovaPoshtaCountry,
  NovaPoshtaCountrySyncResult,
  NovaPoshtaInternationalCitiesInput,
  NovaPoshtaInternationalCity,
  NovaPoshtaInternationalWarehouse,
  NovaPoshtaInternationalWarehousesInput,
  NovaPoshtaWarehouse,
  NovaPoshtaWarehouseCategory,
  NovaPoshtaWarehousesInput,
} from './types';

/** Nova Poshta matches `’` and friends only as a plain apostrophe: «Кам’янське». */
export function normalizeSearchTerm(term: string | null | undefined): string | undefined {
  return term?.replace(/[’‘`′ʼ]/g, "'") ?? undefined;
}

function isWarehouseCategory(value: string): value is NovaPoshtaWarehouseCategory {
  return (NOVA_POSHTA_WAREHOUSE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * @description
 * The directory lookups behind the Shop API queries, and the country-ref sync. Every call is a live
 * request to Nova Poshta; nothing is cached or stored except the country refs.
 */
@Injectable()
export class NovaPoshtaService {
  constructor(
    private readonly connection: TransactionalConnection,
    private readonly client: NovaPoshtaClient,
  ) {}

  getCities(ctx: RequestContext, input: NovaPoshtaCitiesInput): Promise<NovaPoshtaCity[]> {
    return this.client.request(ctx, 'Address', 'getCities', {
      FindByString: normalizeSearchTerm(input.term),
      Limit: input.limit,
    });
  }

  getWarehouses(ctx: RequestContext, input: NovaPoshtaWarehousesInput): Promise<NovaPoshtaWarehouse[]> {
    return this.client.request(ctx, 'Address', 'getWarehouses', {
      CityRef: input.cityId,
      FindByString: normalizeSearchTerm(input.term),
      Limit: input.limit ?? undefined,
    });
  }

  getInternationalCities(
    ctx: RequestContext,
    input: NovaPoshtaInternationalCitiesInput,
  ): Promise<NovaPoshtaInternationalCity[]> {
    return this.client.request(ctx, 'International', 'getCities', {
      FindByString: normalizeSearchTerm(input.term),
      Country: input.country,
      Limit: input.limit,
    });
  }

  /**
   * Only the warehouse types selected on the country whose `novaPoshtaCountryRef` is `input.country`;
   * every type when none is selected or no country carries the ref.
   */
  async getInternationalWarehouses(
    ctx: RequestContext,
    input: NovaPoshtaInternationalWarehousesInput,
  ): Promise<NovaPoshtaInternationalWarehouse[]> {
    const country = await this.connection
      .getRepository(ctx, Country)
      .findOne({ where: { customFields: { novaPoshtaCountryRef: input.country } } });
    const categories = (country?.customFields.novaPoshtaWarehouseCategories ?? []).filter(isWarehouseCategory);
    const limit = input.limit ?? undefined;

    // Nova Poshta takes one WarehouseCategory per request and does not say the category in the
    // response, so several categories mean one request each.
    const responses = await Promise.all(
      (categories.length ? categories : [undefined]).map((category) =>
        this.client.request<NovaPoshtaInternationalWarehouse[]>(ctx, 'International', 'getWarehouses', {
          City: input.city,
          Country: input.country,
          Limit: limit,
          WarehouseCategory: category,
        }),
      ),
    );
    const warehouses = responses.flat();
    return limit ? warehouses.slice(0, limit) : warehouses;
  }

  /**
   * Writes Nova Poshta's ref into `customFields.novaPoshtaCountryRef` of every country whose ISO code it
   * knows. Clients read the ref from `availableCountries` and pass it to the international queries.
   */
  async syncCountries(ctx: RequestContext): Promise<NovaPoshtaCountrySyncResult> {
    const npCountries = await this.client.request<NovaPoshtaCountry[]>(ctx, 'International', 'getCountries', {
      Limit: 300,
    });
    const refByCode = new Map(npCountries.map((c) => [c.Code.toUpperCase(), c.Ref]));
    const repository = this.connection.getRepository(ctx, Country);

    let matched = 0;
    const changed: Country[] = [];
    for (const country of await repository.find()) {
      const ref = refByCode.get(country.code.toUpperCase());
      if (!ref) continue;
      matched++;
      if (country.customFields.novaPoshtaCountryRef !== ref) {
        country.customFields.novaPoshtaCountryRef = ref;
        changed.push(country);
      }
    }
    if (changed.length) {
      await repository.save(changed);
      Logger.info(`Updated the Nova Poshta ref of ${changed.length} countries`, NOVA_POSHTA_LOGGER_CTX);
    }
    return { matched, updated: changed.length };
  }
}
