import { CurrencyCode, EventBus, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrencyExchangeRateSyncService } from './currency-exchange-rate-sync.service';
import { CurrencyExchangeRateService } from './currency-exchange-rate.service';
import { CurrencyExchangeRate } from '../entities/currency-exchange-rate.entity';
import { CurrencyExchangeRateEvent } from '../events/currency-exchange-rate.event';
import { ExchangeRateQuote } from '../types';

const ctx = {} as RequestContext;

function storedRate(overrides: Partial<CurrencyExchangeRate> = {}): CurrencyExchangeRate {
  return {
    id: '1',
    code: CurrencyCode.USD,
    baseCurrency: CurrencyCode.UAH,
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
  count = 0 as number | Partial<Record<CurrencyCode, number>>,
  shopBase = CurrencyCode.UAH,
  sourceBase = CurrencyCode.UAH,
} = {}) {
  const find = vi.fn().mockResolvedValue(stored);
  // TypeORM's `save` echoes back what it persisted — that is what the event must carry.
  const save = vi.fn().mockImplementation((entities: unknown) => Promise.resolve(entities));
  const update = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  const countRows = vi.fn(({ where }: { where: { baseCurrency: CurrencyCode } }) =>
    Promise.resolve(typeof count === 'number' ? count : (count[where.baseCurrency] ?? 0)),
  );
  const repository = { find, save, update, delete: remove, count: countRows };
  const publish = vi.fn().mockResolvedValue(undefined);
  const fetchRates = vi.fn(() =>
    quotes instanceof Error ? Promise.reject(quotes) : Promise.resolve({ base: sourceBase, quotes }),
  );

  const service = new CurrencyExchangeRateSyncService(
    { source: { name: 'test', fetchRates }, sync: false },
    {
      getRepository: vi.fn().mockReturnValue(repository),
      withTransaction: (txCtx: RequestContext, work: (c: RequestContext) => unknown) => work(txCtx),
    } as unknown as TransactionalConnection,
    { publish } as unknown as EventBus,
    { getBaseCurrency: vi.fn().mockResolvedValue(shopBase) } as unknown as CurrencyExchangeRateService,
  );

  return { service, save, update, remove, publish, fetchRates };
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

  it('writes only the fetched rate of a stored currency, keeping its id and admin overrides', async () => {
    const { service, update, save } = makeService({ stored: [storedRate()] });

    const persisted = await service.syncRates(ctx);

    expect(update).toHaveBeenCalledWith({ id: '1' }, { rate: 42 });
    expect(save).toHaveBeenCalledWith([]);
    expect(persisted).toEqual([
      expect.objectContaining({ id: '1', rate: 42, enabled: true, useCustomRate: true, customRate: 45 }),
    ]);
  });

  it('leaves a row alone when its rate has not changed, so its updatedAt stays', async () => {
    const { service, update } = makeService({ stored: [storedRate({ rate: 42 })] });

    await service.syncRates(ctx);

    expect(update).not.toHaveBeenCalled();
  });

  it('warns about an enabled currency the source no longer quotes, which keeps its last rate', async () => {
    const { service, remove } = makeService({
      stored: [
        storedRate(),
        storedRate({ id: '2', code: CurrencyCode.PLN }),
        storedRate({ id: '3', code: CurrencyCode.CZK, enabled: false }),
      ],
    });

    await service.syncRates(ctx);

    expect(Logger.warn).toHaveBeenCalledWith(
      'test no longer quotes PLN; they keep their last rate',
      expect.any(String),
    );
    expect(remove).toHaveBeenCalledWith({ baseCurrency: expect.objectContaining({ _type: 'not', _value: 'UAH' }) });
  });

  it('adds a currency it has not seen before as a new, disabled row', async () => {
    const { service, save } = makeService({ stored: [] });

    await service.syncRates(ctx);

    const [[saved]] = save.mock.calls as [[CurrencyExchangeRate[]]];
    expect(saved[0]).toBeInstanceOf(CurrencyExchangeRate);
    expect(saved[0]).toMatchObject({ code: CurrencyCode.USD, rate: 42 });
    expect(saved[0].enabled).toBeFalsy();
  });

  it('saves one row per currency when sources quote the same code, the last quote winning', async () => {
    const { service, save } = makeService({
      quotes: [
        { currencyCode: CurrencyCode.USD, rate: 42 },
        { currencyCode: CurrencyCode.USD, rate: 43 },
      ],
    });

    await service.syncRates(ctx);

    const [[saved]] = save.mock.calls as [[CurrencyExchangeRate[]]];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ code: CurrencyCode.USD, rate: 43 });
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

describe('CurrencyExchangeRateSyncService.syncRates across bases', () => {
  it('re-bases the quotes of a source in another base onto the shop base', async () => {
    // ECB-style: EUR per 1 unit. The shop sells in USD (1 EUR = 1.10 USD, 1 GBP = 1.30 USD).
    const { service, save } = makeService({
      shopBase: CurrencyCode.USD,
      sourceBase: CurrencyCode.EUR,
      quotes: [
        { currencyCode: CurrencyCode.USD, rate: 1 / 1.1 },
        { currencyCode: CurrencyCode.GBP, rate: 1.3 / 1.1 },
      ],
    });

    await service.syncRates(ctx);

    const [[saved]] = save.mock.calls as [[CurrencyExchangeRate[]]];
    expect(saved.map(({ code, baseCurrency, rate }) => ({ code, baseCurrency, rate }))).toEqual([
      { code: CurrencyCode.GBP, baseCurrency: CurrencyCode.USD, rate: 1.3 },
      { code: CurrencyCode.EUR, baseCurrency: CurrencyCode.USD, rate: 1.1 },
    ]);
  });

  it('writes nothing when the source does not quote the shop base', async () => {
    const { service, save, publish } = makeService({
      shopBase: CurrencyCode.UAH,
      sourceBase: CurrencyCode.EUR,
      quotes: [{ currencyCode: CurrencyCode.USD, rate: 0.9 }],
    });

    await expect(service.syncRates(ctx)).rejects.toThrow(/not UAH/);

    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('moves a row stored in an old base to the new one and drops its custom rate', async () => {
    const { service, update } = makeService({
      shopBase: CurrencyCode.EUR,
      sourceBase: CurrencyCode.EUR,
      stored: [storedRate({ baseCurrency: CurrencyCode.UAH })],
      quotes: [{ currencyCode: CurrencyCode.USD, rate: 0.9 }],
    });

    const persisted = await service.syncRates(ctx);

    expect(update).toHaveBeenCalledWith(
      { id: '1' },
      { baseCurrency: CurrencyCode.EUR, rate: 0.9, useCustomRate: false, customRate: null },
    );
    expect(persisted).toEqual([expect.objectContaining({ id: '1', enabled: true, customRate: null })]);
    expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('USD'), expect.any(String));
  });

  it('deletes the rows the new base did not re-quote', async () => {
    const { service, remove } = makeService({ shopBase: CurrencyCode.EUR, sourceBase: CurrencyCode.EUR });

    await service.syncRates(ctx);

    expect(remove).toHaveBeenCalledWith({ baseCurrency: expect.objectContaining({ _type: 'not', _value: 'EUR' }) });
  });
});

describe('CurrencyExchangeRateSyncService.backfillIfEmpty', () => {
  it('fills an empty table', async () => {
    const { service, publish } = makeService({ count: 0 });

    await service.backfillIfEmpty(ctx);

    expect(publishedEvent(publish).type).toBe('synced');
  });

  it('does nothing when rates are already stored in the current base', async () => {
    const { service, fetchRates } = makeService({ count: { UAH: 3 } });

    await service.backfillIfEmpty(ctx);

    expect(fetchRates).not.toHaveBeenCalled();
  });

  it('re-bases on boot when the stored rates are only in another base', async () => {
    const { service, update } = makeService({
      count: { UAH: 3 },
      shopBase: CurrencyCode.EUR,
      sourceBase: CurrencyCode.EUR,
      stored: [storedRate()],
      quotes: [{ currencyCode: CurrencyCode.USD, rate: 0.9 }],
    });

    await service.backfillIfEmpty(ctx);

    expect(update).toHaveBeenCalledWith({ id: '1' }, expect.objectContaining({ baseCurrency: CurrencyCode.EUR }));
  });

  it('logs a source failure instead of throwing, so the server still boots', async () => {
    const { service } = makeService({ count: 0, quotes: new Error('network down') });

    await expect(service.backfillIfEmpty(ctx)).resolves.toBeUndefined();
    expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('network down'), expect.any(String));
  });
});
