import { ModuleRef } from '@nestjs/core';
import {
  ChannelService,
  getConfigurationFunction,
  Injector,
  ProcessContext,
  RequestContext,
  RequestContextService,
  RuntimeVendureConfig,
} from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
import { SYNC_TASK_ID } from './constants';
import { CurrencyExchangeRatePlugin } from './currency-exchange-rate.plugin';
import { CurrencyExchangeRateSyncService } from './services/currency-exchange-rate-sync.service';
import { StaticExchangeRateSource } from './sources/static-exchange-rate-source';
import { ExchangeRateSource } from './types';

async function configure() {
  const config = { schedulerOptions: { tasks: [] } } as unknown as RuntimeVendureConfig;
  return (await getConfigurationFunction(CurrencyExchangeRatePlugin)?.(config)) ?? config;
}

function makePlugin(isServer = true) {
  const order: string[] = [];
  const source: ExchangeRateSource = {
    name: 'test',
    init: vi.fn(() => void order.push('init')),
    destroy: vi.fn(),
    fetchRates: vi.fn(),
  };
  CurrencyExchangeRatePlugin.init({ source });
  const syncService = { backfillIfEmpty: vi.fn(() => Promise.resolve(void order.push('backfill'))) };
  const plugin = new CurrencyExchangeRatePlugin(
    {} as ModuleRef,
    { isServer } as ProcessContext,
    { create: vi.fn().mockResolvedValue({} as RequestContext) } as unknown as RequestContextService,
    syncService as unknown as CurrencyExchangeRateSyncService,
  );
  return { plugin, source, syncService, order };
}

describe('CurrencyExchangeRatePlugin options', () => {
  const source = new StaticExchangeRateSource({ USD: 41.5 });

  it('refreshes every 3 hours by default', async () => {
    CurrencyExchangeRatePlugin.init({ source });

    expect(CurrencyExchangeRatePlugin.options.source).toBe(source);
    const task = (await configure()).schedulerOptions.tasks.find((t) => t.id === SYNC_TASK_ID);
    expect(task?.options.schedule).toBe('40 2-23/3 * * *');
  });

  it('registers a task that syncs with the scheduler context', async () => {
    CurrencyExchangeRatePlugin.init({ source });
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
    expect(result).toEqual({ updated: 2 });
  });

  it('uses a custom schedule', async () => {
    CurrencyExchangeRatePlugin.init({ source, sync: { schedule: '0 6 * * *' } });

    expect((await configure()).schedulerOptions.tasks[0].options.schedule).toBe('0 6 * * *');
  });

  it('registers no task when the sync is off', async () => {
    CurrencyExchangeRatePlugin.init({ source, sync: false });

    expect((await configure()).schedulerOptions.tasks).toEqual([]);
  });
});

describe('CurrencyExchangeRatePlugin lifecycle', () => {
  it('initialises the source before the first backfill', async () => {
    const { plugin, order } = makePlugin();

    await plugin.onApplicationBootstrap();

    expect(order).toEqual(['init', 'backfill']);
  });

  it('does not backfill in the worker', async () => {
    const { plugin, source, syncService } = makePlugin(false);

    await plugin.onApplicationBootstrap();

    expect(source.init).toHaveBeenCalled();
    expect(syncService.backfillIfEmpty).not.toHaveBeenCalled();
  });

  it('destroys the source on shutdown', async () => {
    const { plugin, source } = makePlugin();

    await plugin.onApplicationShutdown();

    expect(source.destroy).toHaveBeenCalled();
  });
});
