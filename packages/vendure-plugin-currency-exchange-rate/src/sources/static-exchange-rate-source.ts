import { CurrencyCode } from '@vendure/core';
import { ExchangeRateQuote, ExchangeRateSource } from '../types';

/**
 * @description
 * Fixed rates, for a shop that keys them in by hand or for development:
 * `new StaticExchangeRateSource({ USD: 41.5, EUR: 45 })` — hryvnias per one unit.
 */
export class StaticExchangeRateSource implements ExchangeRateSource {
  readonly name = 'static';

  constructor(private readonly rates: Partial<Record<CurrencyCode, number>>) {}

  fetchRates(): Promise<ExchangeRateQuote[]> {
    return Promise.resolve(
      Object.entries(this.rates).map(([currencyCode, rate]) => ({
        currencyCode: currencyCode as CurrencyCode,
        rate: rate as number,
      })),
    );
  }
}
