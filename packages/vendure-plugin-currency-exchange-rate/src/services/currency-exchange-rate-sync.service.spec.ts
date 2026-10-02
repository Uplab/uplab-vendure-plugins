import { CurrencyCode, EventBus, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrencyExchangeRateSyncService } from './currency-exchange-rate-sync.service';
import { CurrencyExchangeRate } from '../entities/currency-exchange-rate.entity';
import { CurrencyExchangeRateEvent } from '../events/currency-exchange-rate.event';
import { ExchangeRateQuote } from '../types';

const ctx = {} as RequestContext;

function storedRate(overrides: Partial<CurrencyExchangeRate> = {}): CurrencyExchangeRate {
  return {
    id: '1',
    code: CurrencyCode.USD,
    rate: 40,
    enabled: true,
    useCustomRate: true,
    customRate: 45,
    ...overrides,
  } as CurrencyExchangeRate;
}

function makeService({
  stored = [] as CurrencyExchangeRate[],
  quotes = [{ currencyCode: CurrencyCode.USD, rate: 42 }] as ExchangeRateQuote[] | Error,
  count = 0,
} = {}) {
  const find = vi.fn().mockResolvedValue(stored);
  // TypeORM's `save` echoes back what it persisted — that is what the event must carry.
  const save = vi.fn().mockImplementation((entities: unknown) => Promise.resolve(entities));
  const repository = { find, save, count: vi.fn().mockResolvedValue(count) };
  const publish = vi.fn().mockResolvedValue(undefined);
  const fetchRates = vi.fn(() => (quotes instanceof Error ? Promise.reject(quotes) : Promise.resolve(quotes)));

  const service = new CurrencyExchangeRateSyncService(
    { source: { name: 'test', fetchRates }, sync: false },
    { getRepository: vi.fn().mockReturnValue(repository) } as unknown as TransactionalConnection,
    { publish } as unknown as EventBus,
  );

  return { service, save, publish, fetchRates };
}

/** The single argument of the n-th `publish` call, typed. */
const publishedEvent = (publish: Mock, index = 0) => publish.mock.calls[index][0] as CurrencyExchangeRateEvent;

beforeEach(() => {
  vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('CurrencyExchangeRateSyncService.syncRates', () => {
  it('publishes a synced event carrying the persisted rates', async () => {
    const { service, publish, fetchRates } = makeService();

    await service.syncRates(ctx);

    expect(fetchRates).toHaveBeenCalledWith(ctx);
    const event = publishedEvent(publish);
    expect(event).toBeInstanceOf(CurrencyExchangeRateEvent);
    expect(event.type).toBe('synced');
    expect(event.ctx).toBe(ctx);
    expect(event.entities).toEqual([expect.objectContaining({ code: CurrencyCode.USD, rate: 42 })]);
  });

  it('replaces only the fetched rate of a stored currency, keeping its id and admin overrides', async () => {
    const { service, save } = makeService({ stored: [storedRate()] });

    await service.syncRates(ctx);

    expect(save).toHaveBeenCalledWith([
      expect.objectContaining({ id: '1', rate: 42, enabled: true, useCustomRate: true, customRate: 45 }),
    ]);
  });

  it('adds a currency it has not seen before as a new, disabled row', async () => {
    const { service, save } = makeService({ stored: [] });

    await service.syncRates(ctx);

    const [[saved]] = save.mock.calls as [[CurrencyExchangeRate[]]];
    expect(saved[0]).toBeInstanceOf(CurrencyExchangeRate);
    expect(saved[0]).toMatchObject({ code: CurrencyCode.USD, rate: 42 });
    expect(saved[0].enabled).toBeFalsy();
  });

  it('publishes only after the rates are persisted', async () => {
    const { service, save, publish } = makeService();

    await service.syncRates(ctx);

    expect(save.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0]);
  });

  it('drops quotes that are not Vendure currencies or not positive finite numbers', async () => {
    const { service, save } = makeService({
      quotes: [
        { currencyCode: CurrencyCode.USD, rate: 42 },
        { currencyCode: 'XAU' as CurrencyCode, rate: 188_000 },
        { currencyCode: CurrencyCode.EUR, rate: NaN },
        { currencyCode: CurrencyCode.PLN, rate: 0 },
      ],
    });

    await service.syncRates(ctx);

    expect(save).toHaveBeenCalledWith([expect.objectContaining({ code: CurrencyCode.USD })]);
  });

  it('keeps the stored rates and publishes nothing when no quote is usable', async () => {
    const { service, save, publish } = makeService({ quotes: [] });

    await expect(service.syncRates(ctx)).resolves.toEqual([]);

    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('rethrows a source failure without touching the stored rates', async () => {
    const { service, save, publish } = makeService({ quotes: new Error('HTTP 429') });

    await expect(service.syncRates(ctx)).rejects.toThrow('HTTP 429');

    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('CurrencyExchangeRateSyncService.backfillIfEmpty', () => {
  it('fills an empty table', async () => {
    const { service, publish } = makeService({ count: 0 });

    await service.backfillIfEmpty(ctx);

    expect(publishedEvent(publish).type).toBe('synced');
  });

  it('does nothing when rates are already stored', async () => {
    const { service, fetchRates } = makeService({ count: 3 });

    await service.backfillIfEmpty(ctx);

    expect(fetchRates).not.toHaveBeenCalled();
  });

  it('logs a source failure instead of throwing, so the server still boots', async () => {
    const { service } = makeService({ count: 0, quotes: new Error('network down') });

    await expect(service.backfillIfEmpty(ctx)).resolves.toBeUndefined();
    expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining('network down'), expect.any(String));
  });
});
