import { ModuleRef } from '@nestjs/core';
import {
  ChannelService,
  CurrencyCode,
  getConfigurationFunction,
  Injector,
  ProcessContext,
  RequestContext,
  RequestContextService,
  RuntimeVendureConfig,
} from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
import { SYNC_TASK_ID } from './constants';
import { ExchangeRatesPlugin } from './exchange-rates.plugin';
import { CurrencyExchangeRateSyncService } from './services/currency-exchange-rate-sync.service';
import { StaticExchangeRateSource } from './sources/static-exchange-rate-source';
import { ExchangeRateSource, ExchangeRatesPluginOptions } from './types';

async function configure() {
  const config = { schedulerOptions: { tasks: [] } } as unknown as RuntimeVendureConfig;
  return (await getConfigurationFunction(ExchangeRatesPlugin)?.(config)) ?? config;
}

function makePlugin(isServer = true) {
  const order: string[] = [];
  const source: ExchangeRateSource = {
    name: 'test',
    init: vi.fn(() => void order.push('init')),
    destroy: vi.fn(),
    fetchRates: vi.fn(),
  };
  ExchangeRatesPlugin.init({ source });
  const syncService = {
    backfillIfEmpty: vi.fn(() => Promise.resolve(void order.push('backfill'))),
    adoptRowsWithoutBase: vi.fn(() => Promise.resolve(void order.push('adopt'))),
  };
  const plugin = new ExchangeRatesPlugin(
    {} as ModuleRef,
    { isServer } as ProcessContext,
    { create: vi.fn().mockResolvedValue({} as RequestContext) } as unknown as RequestContextService,
    syncService as unknown as CurrencyExchangeRateSyncService,
  );
  return { plugin, source, syncService, order };
}

describe('ExchangeRatesPlugin options', () => {
  const source = new StaticExchangeRateSource({ base: CurrencyCode.UAH, rates: { USD: 41.5 } });

  it('refreshes every 3 hours by default', async () => {
    ExchangeRatesPlugin.init({ source });

    expect(ExchangeRatesPlugin.options.source).toBe(source);
    const task = (await configure()).schedulerOptions.tasks.find((t) => t.id === SYNC_TASK_ID);
    expect(task?.options.schedule).toBe('40 2-23/3 * * *');
  });

  it('registers a task that syncs with the scheduler context', async () => {
    ExchangeRatesPlugin.init({ source });
    const task = (await configure()).schedulerOptions.tasks.find((t) => t.id === SYNC_TASK_ID);
    const scheduledContext = { apiType: 'admin' } as RequestContext;
    const syncRates = vi.fn().mockResolvedValue([{}, {}]);
    const services = new Map<unknown, unknown>([
      [CurrencyExchangeRateSyncService, { syncRates }],
      [RequestContextService, { create: () => Promise.resolve(scheduledContext) }],
      [ChannelService, { getDefaultChannel: () => Promise.resolve({}) }],
    ]);

    const result = await task?.execute({ get: (token: unknown) => services.get(token) } as Injector);

    expect(syncRates).toHaveBeenCalledWith(scheduledContext);
    expect(result).toEqual({ rates: 2 });
  });

  it('uses a custom schedule', async () => {
    ExchangeRatesPlugin.init({ source, sync: { schedule: '0 6 * * *' } });

    expect((await configure()).schedulerOptions.tasks[0].options.schedule).toBe('0 6 * * *');
  });

  it('takes the base currency from the default channel unless one is set', () => {
    ExchangeRatesPlugin.init({ source });
    expect(ExchangeRatesPlugin.options.baseCurrency).toBeUndefined();

    ExchangeRatesPlugin.init({ source, baseCurrency: CurrencyCode.EUR });
    expect(ExchangeRatesPlugin.options.baseCurrency).toBe(CurrencyCode.EUR);
  });

  it('requires a source', () => {
    expect(() => ExchangeRatesPlugin.init({} as ExchangeRatesPluginOptions)).toThrow('"source" is required');
  });

  it('rejects a base currency that is not a CurrencyCode', () => {
    expect(() => ExchangeRatesPlugin.init({ source, baseCurrency: 'usd' as CurrencyCode })).toThrow(
      '"usd" is not a CurrencyCode',
    );
  });

  it('registers no task when the sync is off', async () => {
    ExchangeRatesPlugin.init({ source, sync: false });

    expect((await configure()).schedulerOptions.tasks).toEqual([]);
  });
});

describe('ExchangeRatesPlugin lifecycle', () => {
  it('initialises the source before the first backfill', async () => {
    const { plugin, order } = makePlugin();

    await plugin.onApplicationBootstrap();

    expect(order).toEqual(['init', 'backfill']);
  });

  it('only adopts rows without a base in the worker, without backfilling', async () => {
    const { plugin, order } = makePlugin(false);

    await plugin.onApplicationBootstrap();

    expect(order).toEqual(['init', 'adopt']);
  });

  it('destroys the source on shutdown', async () => {
    const { plugin, source } = makePlugin();

    await plugin.onApplicationShutdown();

    expect(source.destroy).toHaveBeenCalled();
  });
});
