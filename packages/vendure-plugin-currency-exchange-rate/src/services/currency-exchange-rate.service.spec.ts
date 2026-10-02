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

  it.each([null, undefined, 0, -1])('rejects a custom rate of %j when useCustomRate is on', async (customRate) => {
    const { service, save } = makeService();

    await expect(service.update(ctx, { id: '1', enabled: true, useCustomRate: true, customRate })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
});
