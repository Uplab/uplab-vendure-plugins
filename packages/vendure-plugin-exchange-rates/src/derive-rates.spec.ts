import { CurrencyCode } from '@vendure/core';
import { describe, expect, it } from 'vitest';
import { deriveRates, round8 } from './derive-rates';
import { ExchangeRateSourceError } from './exchange-rate-source-error';

const { EUR, GBP, JPY, UAH, USD } = CurrencyCode;

describe('deriveRates', () => {
  it('passes quotes through when the source already quotes the shop base', () => {
    expect(
      deriveRates('test', UAH, UAH, [
        { currencyCode: USD, rate: 41.5 },
        { currencyCode: EUR, rate: 45 },
      ]),
    ).toEqual([
      { currencyCode: USD, rate: 41.5 },
      { currencyCode: EUR, rate: 45 },
    ]);
  });

  it('derives cross rates through the shop base and adds the source base itself', () => {
    // EUR per unit: 1 USD = 0.8 EUR, 1 GBP = 1.2 EUR. The shop sells in USD.
    expect(
      deriveRates('test', USD, EUR, [
        { currencyCode: USD, rate: 0.8 },
        { currencyCode: GBP, rate: 1.2 },
      ]),
    ).toEqual([
      { currencyCode: GBP, rate: 1.5 },
      { currencyCode: EUR, rate: 1.25 },
    ]);
  });

  it('drops a quote for the shop base from a same-base source', () => {
    expect(deriveRates('test', UAH, UAH, [{ currencyCode: UAH, rate: 1 }])).toEqual([]);
  });

  it('rounds to the 8 decimals a rate is stored with, dropping what rounds to 0', () => {
    expect(
      deriveRates('test', UAH, UAH, [
        { currencyCode: JPY, rate: 0.285_361_234_5 },
        { currencyCode: USD, rate: 1e-9 },
      ]),
    ).toEqual([{ currencyCode: JPY, rate: 0.28536123 }]);
  });

  it('drops a rate that does not fit decimal(19, 8)', () => {
    expect(deriveRates('test', UAH, UAH, [{ currencyCode: USD, rate: 1e11 }])).toEqual([]);
  });

  it.each([
    ['missing', []],
    ['zero', [{ currencyCode: USD, rate: 0 }]],
  ])('throws when the pivot is %s', (_, pivot) => {
    const quotes = [{ currencyCode: GBP, rate: 1.2 }, ...pivot];

    expect(() => deriveRates('ecb', USD, EUR, quotes)).toThrow(ExchangeRateSourceError);
    expect(() => deriveRates('ecb', USD, EUR, quotes)).toThrow(
      "ecb quotes against EUR but not USD, the shop's base currency; nothing was written",
    );
  });
});

describe('round8', () => {
  it('rounds half away from zero at the 8th decimal', () => {
    expect(round8(1.234_567_895)).toBe(1.2345679);
  });
});
