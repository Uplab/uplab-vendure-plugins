import {
  ChannelService,
  CurrencyCode,
  EventBus,
  ListQueryBuilder,
  RequestContext,
  TransactionalConnection,
} from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrencyExchangeRateService } from './currency-exchange-rate.service';
import { CurrencyExchangeRate } from '../entities/currency-exchange-rate.entity';
import { CurrencyExchangeRateEvent } from '../events/currency-exchange-rate.event';

const ctx = {} as RequestContext;

function makeService(existing: Partial<CurrencyExchangeRate> = {}) {
  const entity = {
    id: '1',
    code: CurrencyCode.USD,
    rate: 40,
    enabled: false,
    useCustomRate: false,
    customRate: null,
    ...existing,
  } as unknown as CurrencyExchangeRate;
  // Stands in for the database: `update` writes the row that `getEntityOrThrow` reads back.
  const update = vi.fn().mockImplementation((_where: unknown, changes: object) => {
    Object.assign(entity, changes);
    return Promise.resolve();
  });
  const publish = vi.fn().mockResolvedValue(undefined);

  const service = new CurrencyExchangeRateService(
    { source: { name: 'test', fetchRates: vi.fn() }, sync: false },
    {
      getEntityOrThrow: vi.fn().mockImplementation(() => Promise.resolve({ ...entity })),
      getRepository: vi.fn().mockReturnValue({ update }),
    } as unknown as TransactionalConnection,
    {} as ListQueryBuilder,
    { publish } as unknown as EventBus,
    {} as ChannelService,
  );

  return { service, publish, update };
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
    const { service, update, publish } = makeService();

    await service.update(ctx, { id: '1', enabled: true, useCustomRate: false });

    expect(update.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0]);
  });

  it('writes only the admin columns, so a concurrent sync keeps its rate and base', async () => {
    const { service, update } = makeService();

    await service.update(ctx, { id: '1', enabled: true, useCustomRate: true, customRate: 44 });

    expect(update).toHaveBeenCalledWith({ id: '1' }, { enabled: true, useCustomRate: true, customRate: 44 });
  });

  it('stores a custom rate with the 8 decimals of the column', async () => {
    const { service, update } = makeService();

    await service.update(ctx, { id: '1', enabled: true, useCustomRate: true, customRate: 1.123456789 });

    expect(update).toHaveBeenCalledWith({ id: '1' }, expect.objectContaining({ customRate: 1.12345679 }));
  });

  it.each([1e12, 1e-9])(
    'rejects a custom rate of %j that the column cannot hold, even while it is off',
    async (customRate) => {
      const { service, update } = makeService();

      await expect(service.update(ctx, { id: '1', enabled: true, useCustomRate: false, customRate })).rejects.toThrow(
        'A custom rate must be between 0.00000001 and 100000000000',
      );
      expect(update).not.toHaveBeenCalled();
    },
  );

  it.each([null, undefined, 0, -1])('rejects a custom rate of %j when useCustomRate is on', async (customRate) => {
    const { service, update } = makeService();

    await expect(service.update(ctx, { id: '1', enabled: true, useCustomRate: true, customRate })).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('CurrencyExchangeRateService.getRate', () => {
  const enabledUsd = { code: CurrencyCode.USD, rate: 41, enabled: true, useCustomRate: false, customRate: null };

  const findOne = vi.fn();

  function serviceWith(row: Partial<CurrencyExchangeRate> | null, baseCurrency?: CurrencyCode) {
    findOne.mockReset().mockResolvedValue(row);
    return new CurrencyExchangeRateService(
      { source: { name: 'test', fetchRates: vi.fn() }, baseCurrency, sync: false },
      { getRepository: () => ({ findOne }) } as unknown as TransactionalConnection,
      {} as ListQueryBuilder,
      {} as EventBus,
      {
        getDefaultChannel: vi.fn().mockResolvedValue({ defaultCurrencyCode: CurrencyCode.UAH }),
      } as unknown as ChannelService,
    );
  }

  it('looks the rate up in the default channel currency', async () => {
    await serviceWith(enabledUsd).getRate(ctx, CurrencyCode.USD, { requireEnabled: true });

    expect(findOne).toHaveBeenCalledWith({ where: { code: CurrencyCode.USD, baseCurrency: CurrencyCode.UAH } });
  });

  it('looks the rate up in the configured base currency when one is set', async () => {
    await serviceWith(enabledUsd, CurrencyCode.EUR).getRate(ctx, CurrencyCode.USD, { requireEnabled: true });

    expect(findOne).toHaveBeenCalledWith({ where: { code: CurrencyCode.USD, baseCurrency: CurrencyCode.EUR } });
  });

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
