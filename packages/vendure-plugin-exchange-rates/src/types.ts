import type { CurrencyCode, ID, InjectableStrategy, RequestContext, ScheduledTaskConfig } from '@vendure/core';

/** One fetched rate: `rate` units of the source's base currency buy one unit of `currencyCode`. */
export interface ExchangeRateQuote {
  currencyCode: CurrencyCode;
  rate: number;
}

/** What a source fetched: its quotes, and the base currency they are expressed in. */
export interface ExchangeRateSourceResult {
  base: CurrencyCode;
  quotes: ExchangeRateQuote[];
}

/**
 * @description
 * Where the rates come from. `fetchRates` returns every pair the source has, in whatever base it quotes
 * in; the plugin re-bases them onto the shop's base currency, drops unusable quotes, upserts the rest by
 * code and never touches an admin's custom rate.
 *
 * Throw (ideally an {@link ExchangeRateSourceError}) when the source cannot be read — never return no
 * quotes to mean "failed". The plugin calls `init(injector)` on bootstrap and `destroy()` on shutdown.
 */
export interface ExchangeRateSource extends InjectableStrategy {
  /** Short name for logs, e.g. `'ecb'`. */
  readonly name: string;
  fetchRates(ctx: RequestContext): Promise<ExchangeRateSourceResult>;
}

export interface ExchangeRatesPluginOptions {
  /** Where the rates come from: `EcbExchangeRateSource`, `FrankfurterExchangeRateSource`, … or your own. */
  source: ExchangeRateSource;
  /**
   * The currency rates are expressed in: `rate` = units of it per one unit of a currency.
   *
   * @default the default channel's `defaultCurrencyCode`
   */
  baseCurrency?: CurrencyCode;
  /**
   * The scheduled refresh. `false` leaves the task out; `CurrencyExchangeRateSyncService` can still
   * be called.
   *
   * @default { schedule: '40 2-23/3 * * *' } — every 3 hours
   */
  sync?: { schedule?: ScheduledTaskConfig['schedule'] } | false;
}

/** {@link ExchangeRatesPluginOptions} with every default applied. */
export interface ResolvedExchangeRatesPluginOptions {
  source: ExchangeRateSource;
  baseCurrency?: CurrencyCode;
  sync: { schedule: ScheduledTaskConfig['schedule'] } | false;
}

/** Mirrors `UpdateCurrencyExchangeRateInput` in `api-extensions.ts`. */
export interface UpdateCurrencyExchangeRateInput {
  id: ID;
  enabled: boolean;
  useCustomRate: boolean;
  customRate?: number | null;
}

export interface MutationUpdateCurrencyExchangeRateArgs {
  input: UpdateCurrencyExchangeRateInput;
}
