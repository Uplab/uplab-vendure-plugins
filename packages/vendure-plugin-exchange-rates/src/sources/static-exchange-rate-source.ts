import { CurrencyCode } from '@vendure/core';
import { ExchangeRateSource, ExchangeRateSourceResult } from '../types';

export interface StaticExchangeRateSourceOptions {
  /** The currency `rates` are expressed in. */
  base: CurrencyCode;
  /** Units of `base` per one unit of each currency. */
  rates: Partial<Record<CurrencyCode, number>>;
}

/**
 * @description
 * Fixed rates, for a shop that keys them in by hand, for development and for tests:
 * `new StaticExchangeRateSource({ base: CurrencyCode.USD, rates: { EUR: 1.12, GBP: 1.32 } })`.
 */
export class StaticExchangeRateSource implements ExchangeRateSource {
  readonly name = 'static';

  constructor(public config: StaticExchangeRateSourceOptions) {}

  fetchRates(): Promise<ExchangeRateSourceResult> {
    const quotes = Object.entries(this.config.rates).map(([currencyCode, rate]) => ({
      currencyCode: currencyCode as CurrencyCode,
      rate: rate as number,
    }));
    return Promise.resolve({ base: this.config.base, quotes });
  }
}
