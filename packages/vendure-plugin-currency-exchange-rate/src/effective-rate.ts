import type { CurrencyExchangeRate } from './entities/currency-exchange-rate.entity';

/**
 * @description
 * The rate to convert with: the admin's custom rate while it is switched on, otherwise the fetched one.
 * `NaN` when the custom rate is on but empty — check the result before dividing by it.
 */
export function effectiveRate(rate: Pick<CurrencyExchangeRate, 'rate' | 'useCustomRate' | 'customRate'>): number {
  return rate.useCustomRate ? (rate.customRate ?? NaN) : rate.rate;
}
