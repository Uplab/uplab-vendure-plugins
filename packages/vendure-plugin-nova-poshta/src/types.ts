import type { InjectableStrategy, RequestContext, ScheduledTaskConfig } from '@vendure/core';
import type { NOVA_POSHTA_WAREHOUSE_CATEGORIES } from './constants';

// Typed here so every consumer of the package sees the fields.
declare module '@vendure/core/dist/entity/custom-entity-fields' {
  interface CustomRegionFields {
    novaPoshtaCountryRef?: string | null;
    novaPoshtaWarehouseCategories?: string[] | null;
  }
}

export type NovaPoshtaWarehouseCategory = (typeof NOVA_POSHTA_WAREHOUSE_CATEGORIES)[number];

/**
 * @description
 * Supplies the Nova Poshta API key per request — for a key kept in the database, or a different key per
 * channel. The plugin calls `init(injector)` on bootstrap and `destroy()` on shutdown.
 *
 * @example
 * ```ts
 * class ChannelApiKeyStrategy implements NovaPoshtaApiKeyStrategy {
 *   getApiKey(ctx: RequestContext) {
 *     return ctx.channel.customFields.novaPoshtaApiKey;
 *   }
 * }
 * ```
 */
export interface NovaPoshtaApiKeyStrategy extends InjectableStrategy {
  /** Return `undefined` when there is no key: the request then fails with a {@link NovaPoshtaError}. */
  getApiKey(ctx: RequestContext): string | undefined | Promise<string | undefined>;
}

/**
 * @description
 * Options for `NovaPoshtaPlugin.init()`.
 */
export interface NovaPoshtaPluginOptions {
  /** The API key from the Nova Poshta business account, or a strategy that resolves it per request. */
  apiKey: string | NovaPoshtaApiKeyStrategy;
  /** @default 'https://api.novaposhta.ua/v2.0/json/' */
  apiUrl?: string;
  /** Milliseconds before a request is aborted. @default 10000 */
  timeout?: number;
  /**
   * The daily task that writes Nova Poshta's country refs into `Country.customFields.novaPoshtaCountryRef`.
   * Needs a scheduler plugin such as `DefaultSchedulerPlugin`. `false` leaves it out; the
   * `novaPoshtaSyncCountries` mutation still works.
   *
   * @default { schedule: '0 7 * * *' }
   */
  countrySync?: { schedule?: ScheduledTaskConfig['schedule'] } | false;
}

/**
 * @description
 * {@link NovaPoshtaPluginOptions} with every default applied.
 */
export interface ResolvedNovaPoshtaPluginOptions {
  apiKeyStrategy: NovaPoshtaApiKeyStrategy;
  apiUrl: string;
  timeout: number;
  countrySync: { schedule: ScheduledTaskConfig['schedule'] } | false;
}

export interface NovaPoshtaCitiesInput {
  term: string;
  limit: number;
}

export interface NovaPoshtaWarehousesInput {
  cityId: string;
  term?: string | null;
  limit?: number | null;
}

export interface NovaPoshtaInternationalCitiesInput {
  term: string;
  /** Nova Poshta's country ref, as stored in `novaPoshtaCountryRef`. */
  country: string;
  limit: number;
}

export interface NovaPoshtaInternationalWarehousesInput {
  city: string;
  /** Nova Poshta's country ref, as stored in `novaPoshtaCountryRef`. */
  country: string;
  limit?: number | null;
}

/** `Address.getCities`. Nova Poshta returns more fields; these are the ones the Shop API exposes. */
export interface NovaPoshtaCity {
  Ref: string;
  Description: string;
}

/** `Address.getWarehouses`. */
export interface NovaPoshtaWarehouse {
  Ref: string;
  Description: string;
}

/** `International.getCities`. */
export interface NovaPoshtaInternationalCity {
  City: string;
}

/** `International.getWarehouses`. */
export interface NovaPoshtaInternationalWarehouse {
  WarehouseRef: string;
  FullDescription: string;
}

/** `International.getCountries`. */
export interface NovaPoshtaCountry {
  Ref: string;
  /** ISO 3166-1 alpha-2. */
  Code: string;
  Description: string;
}

export interface NovaPoshtaCountrySyncResult {
  /** Vendure countries whose ISO code Nova Poshta knows. */
  matched: number;
  /** Of those, the ones whose ref was missing or different and has been written. */
  updated: number;
}
