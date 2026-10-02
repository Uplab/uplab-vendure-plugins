import type { CurrencyCode, ID, InjectableStrategy, RequestContext, ScheduledTaskConfig } from '@vendure/core';

/** One fetched rate: `rate` is UAH per one unit of `currencyCode`. */
export interface ExchangeRateQuote {
  currencyCode: CurrencyCode;
  rate: number;
}

/**
 * @description
 * Where the rates come from. `fetchRates` returns every pair the source has, each as UAH per one unit; the
 * plugin drops unusable quotes, upserts the rest by code and never touches an admin's custom rate.
 *
 * Throw (ideally an {@link ExchangeRateSourceError}) when the source cannot be read — never return an
 * empty array to mean "failed". The plugin calls `init(injector)` on bootstrap and `destroy()` on
 * shutdown.
 */
export interface ExchangeRateSource extends InjectableStrategy {
  /** Short name for logs, e.g. `'monobank'`. */
  readonly name: string;
  fetchRates(ctx: RequestContext): Promise<ExchangeRateQuote[]>;
}

export interface CurrencyExchangeRatePluginOptions {
  /** @default new MonobankExchangeRateSource() */
  source?: ExchangeRateSource;
  /**
   * The scheduled refresh. `false` leaves the task out; `CurrencyExchangeRateSyncService` can still
   * be called.
   *
   * @default { schedule: '40 2-23/3 * * *' }
   */
  sync?: { schedule?: ScheduledTaskConfig['schedule'] } | false;
}

/** {@link CurrencyExchangeRatePluginOptions} with every default applied. */
export interface ResolvedCurrencyExchangeRatePluginOptions {
  source: ExchangeRateSource;
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
