import { CurrencyCode, EventBus, ListQueryBuilder, RequestContext, TransactionalConnection } from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrencyExchangeRateService } from './currency-exchange-rate.service';
import { CurrencyExchangeRate } from '../entities/currency-exchange-rate.entity';
import { CurrencyExchangeRateEvent } from '../events/currency-exchange-rate.event';

const ctx = {} as RequestContext;

function makeService(existing: Partial<CurrencyExchangeRate> = {}) {
  // Every column is present, including the nullable one: `patchEntity` copies only keys the entity already has.
  const entity = {
    id: '1',
    code: CurrencyCode.USD,
    rate: 40,
    enabled: false,
    useCustomRate: false,
    customRate: null,
    ...existing,
  } as unknown as CurrencyExchangeRate;
  const save = vi.fn().mockImplementation((updated: unknown) => Promise.resolve(updated));
  const publish = vi.fn().mockResolvedValue(undefined);

  const service = new CurrencyExchangeRateService(
    {
      getEntityOrThrow: vi.fn().mockResolvedValue(entity),
      getRepository: vi.fn().mockReturnValue({ save }),
    } as unknown as TransactionalConnection,
    {} as ListQueryBuilder,
    { publish } as unknown as EventBus,
  );

  return { service, publish, save };
}

describe('CurrencyExchangeRateService.update', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes an updated event carrying the saved rate', async () => {
    const { service, publish } = makeService();

    await service.update(ctx, { id: '1', enabled: true, useCustomRate: true, customRate: 44 });

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0][0] as CurrencyExchangeRateEvent;
    expect(event).toBeInstanceOf(CurrencyExchangeRateEvent);
    expect(event.type).toBe('updated');
    expect(event.ctx).toBe(ctx);
    expect(event.entities).toEqual([expect.objectContaining({ id: '1', enabled: true, customRate: 44 })]);
  });

  it('returns the patched rate', async () => {
    const { service } = makeService();

    const result = await service.update(ctx, { id: '1', enabled: true, useCustomRate: true, customRate: 44 });

    expect(result).toEqual(expect.objectContaining({ enabled: true, useCustomRate: true, customRate: 44 }));
  });

  it('publishes only after the change is persisted', async () => {
    const { service, save, publish } = makeService();

    await service.update(ctx, { id: '1', enabled: true, useCustomRate: false });

    expect(save.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0]);
  });

  it('rejects a custom rate too large for the column, even while it is off', async () => {
    const { service, save } = makeService();

    await expect(
      service.update(ctx, { id: '1', enabled: true, useCustomRate: false, customRate: 1e12 }),
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 0, -1])('rejects a custom rate of %j when useCustomRate is on', async (customRate) => {
    const { service, save } = makeService();

    await expect(service.update(ctx, { id: '1', enabled: true, useCustomRate: true, customRate })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('CurrencyExchangeRateService.getRate', () => {
  const enabledUsd = { code: CurrencyCode.USD, rate: 41, enabled: true, useCustomRate: false, customRate: null };

  function serviceWith(row: Partial<CurrencyExchangeRate> | null) {
    return new CurrencyExchangeRateService(
      { getRepository: () => ({ findOne: vi.fn().mockResolvedValue(row) }) } as unknown as TransactionalConnection,
      {} as ListQueryBuilder,
      {} as EventBus,
    );
  }

  it('returns the effective rate of a stored currency', async () => {
    await expect(serviceWith(enabledUsd).getRate(ctx, CurrencyCode.USD, { requireEnabled: true })).resolves.toBe(41);
  });

  it('honours requireEnabled for a disabled currency', async () => {
    const service = serviceWith({ ...enabledUsd, enabled: false });

    await expect(service.getRate(ctx, CurrencyCode.USD, { requireEnabled: true })).resolves.toBeUndefined();
    await expect(service.getRate(ctx, CurrencyCode.USD, { requireEnabled: false })).resolves.toBe(41);
  });

  it.each([null, 0, -1])('returns undefined for a custom rate of %j rather than guessing', async (customRate) => {
    const service = serviceWith({ ...enabledUsd, useCustomRate: true, customRate });

    await expect(service.getRate(ctx, CurrencyCode.USD, { requireEnabled: false })).resolves.toBeUndefined();
  });

  it('returns undefined when the currency is not stored', async () => {
    await expect(serviceWith(null).getRate(ctx, CurrencyCode.USD, { requireEnabled: false })).resolves.toBeUndefined();
  });
});
