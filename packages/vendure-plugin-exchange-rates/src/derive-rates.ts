import type { CurrencyCode } from '@vendure/core';
import { MAX_RATE } from './constants';
import { ExchangeRateSourceError } from './exchange-rate-source-error';
import type { ExchangeRateQuote } from './types';

/** The 8 decimals a rate is stored with. */
export const round8 = (value: number): number => Math.round(value * 1e8) / 1e8;

/**
 * @description
 * Re-bases `quotes` (units of `sourceBase` per unit) onto `shopBase`. With a different base the cross
 * rate is `rate(c) / rate(shopBase)`, so the source must quote the shop's base currency; it throws when
 * it does not. A quote for the shop's base itself is dropped, and so is a result that rounds to 0 or does
 * not fit decimal(19, 8).
 */
export function deriveRates(
  source: string,
  shopBase: CurrencyCode,
  sourceBase: CurrencyCode,
  quotes: ExchangeRateQuote[],
): ExchangeRateQuote[] {
  let derived: ExchangeRateQuote[];
  if (sourceBase === shopBase) {
    derived = quotes;
  } else {
    const pivot = quotes.find((q) => q.currencyCode === shopBase)?.rate;
    if (!pivot || !Number.isFinite(pivot) || pivot <= 0) {
      throw new ExchangeRateSourceError(
        `${source} quotes against ${sourceBase} but not ${shopBase}, the shop's base currency`,
        { source },
      );
    }
    derived = [
      // A source may list its own base (at 1); it is derived from the pivot below instead.
      ...quotes
        .filter((q) => q.currencyCode !== sourceBase)
        .map((q) => ({ currencyCode: q.currencyCode, rate: q.rate / pivot })),
      { currencyCode: sourceBase, rate: 1 / pivot },
    ];
  }
  return derived
    .filter((q) => q.currencyCode !== shopBase)
    .map((q) => ({ currencyCode: q.currencyCode, rate: round8(q.rate) }))
    .filter((q) => q.rate > 0 && q.rate < MAX_RATE);
}
