import { CurrencyCode, RequestContext, TransactionalConnection } from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
import { effectiveRate, findEffectiveRate } from './effective-rate';
import { CurrencyExchangeRate } from './entities/currency-exchange-rate.entity';

const ctx = {} as RequestContext;

function connectionWith(row: Partial<CurrencyExchangeRate> | null) {
  return { getRepository: () => ({ findOne: vi.fn().mockResolvedValue(row) }) } as unknown as TransactionalConnection;
}

describe('effectiveRate', () => {
  it('uses the fetched rate when the custom rate is off', () => {
    expect(effectiveRate({ rate: 41, useCustomRate: false, customRate: 45 })).toBe(41);
  });

  it('uses the custom rate when it is on, whatever it is', () => {
    expect(effectiveRate({ rate: 41, useCustomRate: true, customRate: 45 })).toBe(45);
    expect(effectiveRate({ rate: 41, useCustomRate: true, customRate: undefined })).toBeNaN();
  });

  it('reads the decimal strings Postgres returns', () => {
    expect(
      effectiveRate({
        rate: '41.25' as unknown as number,
        useCustomRate: true,
        customRate: '45.5' as unknown as number,
      }),
    ).toBe(45.5);
  });
});

describe('findEffectiveRate', () => {
  const enabledUsd = { code: CurrencyCode.USD, rate: 41, enabled: true, useCustomRate: false };

  it('returns the effective rate of a stored currency', async () => {
    await expect(
      findEffectiveRate(connectionWith(enabledUsd), ctx, CurrencyCode.USD, { requireEnabled: true }),
    ).resolves.toBe(41);
  });

  it('honours requireEnabled for a disabled currency', async () => {
    const disabled = connectionWith({ ...enabledUsd, enabled: false });

    await expect(findEffectiveRate(disabled, ctx, CurrencyCode.USD, { requireEnabled: true })).resolves.toBeUndefined();
    await expect(findEffectiveRate(disabled, ctx, CurrencyCode.USD, { requireEnabled: false })).resolves.toBe(41);
  });

  it.each([null, 0, -1])('returns undefined for a custom rate of %j rather than guessing', async (customRate) => {
    const connection = connectionWith({ ...enabledUsd, useCustomRate: true, customRate: customRate as number });

    await expect(
      findEffectiveRate(connection, ctx, CurrencyCode.USD, { requireEnabled: false }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the currency is not stored', async () => {
    await expect(
      findEffectiveRate(connectionWith(null), ctx, CurrencyCode.USD, { requireEnabled: false }),
    ).resolves.toBeUndefined();
  });
});
