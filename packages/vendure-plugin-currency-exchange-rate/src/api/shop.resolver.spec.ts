import { describe, expect, it } from 'vitest';
import { CurrencyExchangeRateShopFieldResolver } from './shop.resolver';
import { CurrencyExchangeRate } from '../entities/currency-exchange-rate.entity';

describe('CurrencyExchangeRateShopFieldResolver.rate', () => {
  const resolver = new CurrencyExchangeRateShopFieldResolver();
  const row = (fields: Partial<CurrencyExchangeRate>) =>
    ({ rate: 41, useCustomRate: false, customRate: null, ...fields }) as CurrencyExchangeRate;

  it('serves the custom rate while it is on', () => {
    expect(resolver.rate(row({ useCustomRate: true, customRate: 42 }))).toBe(42);
  });

  it('falls back to the fetched rate for an old row whose custom rate is on but empty', () => {
    expect(resolver.rate(row({ useCustomRate: true, customRate: null }))).toBe(41);
  });
});
