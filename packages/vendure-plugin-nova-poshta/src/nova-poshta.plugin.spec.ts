import {
  ChannelService,
  getConfigurationFunction,
  type Injector,
  RequestContextService,
  type RuntimeVendureConfig,
} from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
import { COUNTRY_SYNC_TASK_ID } from './constants';
import { NovaPoshtaPlugin } from './nova-poshta.plugin';
import { NovaPoshtaService } from './nova-poshta.service';
import { StaticNovaPoshtaApiKeyStrategy } from './static-api-key-strategy';

/** Applies the plugin's `configuration` hook to a config carrying only what it touches. */
async function configure(config: object = { customFields: {}, schedulerOptions: {} }) {
  const runtime = config as unknown as RuntimeVendureConfig;
  return (await getConfigurationFunction(NovaPoshtaPlugin)?.(runtime)) ?? runtime;
}

describe('NovaPoshtaPlugin.init', () => {
  it('applies the defaults and wraps a string key in the static strategy', () => {
    NovaPoshtaPlugin.init({ apiKey: 'key-1' });

    expect(NovaPoshtaPlugin.options).toEqual({
      apiKeyStrategy: new StaticNovaPoshtaApiKeyStrategy('key-1'),
      apiUrl: 'https://api.novaposhta.ua/v2.0/json/',
      timeout: 10_000,
      countrySync: { schedule: '0 7 * * *' },
    });
    expect(NovaPoshtaPlugin.options.apiKeyStrategy.getApiKey({} as never)).toBe('key-1');
  });

  it('keeps a strategy and lets the country sync be turned off', () => {
    const apiKeyStrategy = { getApiKey: () => 'k' };

    NovaPoshtaPlugin.init({ apiKey: apiKeyStrategy, countrySync: false, timeout: 3000 });

    expect(NovaPoshtaPlugin.options).toMatchObject({ apiKeyStrategy, countrySync: false, timeout: 3000 });
  });
});

describe('NovaPoshtaPlugin configuration', () => {
  it('adds the Region custom fields and a country sync task that syncs with the scheduler context', async () => {
    NovaPoshtaPlugin.init({ apiKey: 'k', countrySync: { schedule: '0 3 * * *' } });

    const config = await configure();
    const task = config.schedulerOptions.tasks.find((t) => t.id === COUNTRY_SYNC_TASK_ID);
    const syncCountries = vi.fn().mockResolvedValue({ matched: 0, updated: 0 });
    const scheduledContext = { apiType: 'admin' };
    const services = new Map<unknown, unknown>([
      [NovaPoshtaService, { syncCountries }],
      [RequestContextService, { create: () => Promise.resolve(scheduledContext) }],
      [ChannelService, { getDefaultChannel: () => Promise.resolve({}) }],
    ]);
    await task?.execute({ get: (token: unknown) => services.get(token) } as Injector);

    expect(config.customFields.Region?.map((f) => f.name)).toEqual([
      'novaPoshtaCountryRef',
      'novaPoshtaWarehouseCategories',
    ]);
    expect(task?.options.schedule).toBe('0 3 * * *');
    expect(syncCountries).toHaveBeenCalledWith(scheduledContext);
  });

  it('registers no task when the country sync is off', async () => {
    NovaPoshtaPlugin.init({ apiKey: 'k', countrySync: false });

    const config = await configure({ customFields: { Region: [] }, schedulerOptions: { tasks: [] } });

    expect(config.schedulerOptions.tasks).toEqual([]);
  });
});
