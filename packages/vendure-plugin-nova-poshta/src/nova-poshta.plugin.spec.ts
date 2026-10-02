import { describe, expect, it } from 'vitest';
import { NovaPoshtaPlugin } from './nova-poshta.plugin';
import { StaticNovaPoshtaApiKeyStrategy } from './static-api-key-strategy';

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
