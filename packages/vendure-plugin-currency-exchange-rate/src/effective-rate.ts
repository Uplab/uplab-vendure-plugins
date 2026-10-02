import type { CurrencyExchangeRate } from './entities/currency-exchange-rate.entity';

/**
 * @description
 * The rate to convert with — the admin's custom rate while it is switched on, otherwise the fetched
 * one — or `undefined` when that rate is not a positive number.
 */
export function effectiveRate(
  rate: Pick<CurrencyExchangeRate, 'rate' | 'useCustomRate' | 'customRate'>,
): number | undefined {
  const value = rate.useCustomRate ? rate.customRate : rate.rate;
  return value != null && Number.isFinite(value) && value > 0 ? value : undefined;
}
