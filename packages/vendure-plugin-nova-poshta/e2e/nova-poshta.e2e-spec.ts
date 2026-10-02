import path from 'path';
import { ConfigService, Injector, mergeConfig, type RequestContext } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NovaPoshtaPlugin, NovaPoshtaService, type NovaPoshtaApiKeyStrategy } from '../src';
import { COUNTRY_SYNC_TASK_ID } from '../src/constants';
import { initialData } from './fixtures/initial-data';
import {
  AVAILABLE_COUNTRIES,
  CITIES,
  INTERNATIONAL_CITIES,
  INTERNATIONAL_WAREHOUSES,
  SYNC_COUNTRIES,
  UPDATE_COUNTRY,
  WAREHOUSES,
} from './graphql';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__sqlite-data__')));

const API_URL = 'https://np.test/v2.0/json/';

interface NpRequest {
  apiKey: string;
  modelName: string;
  calledMethod: string;
  methodProperties: Record<string, any>;
}

const warehousesByCategory: Record<string, { WarehouseRef: string; FullDescription: string }[]> = {
  PostBranch: [{ WarehouseRef: 'branch-1', FullDescription: 'WARSZAWA 10' }],
  Poshtomat: [{ WarehouseRef: 'locker-1', FullDescription: 'WAW01M' }],
};

/** Stands in for Nova Poshta. Anything else goes to the real `fetch`: the test server itself uses it. */
function answer(req: NpRequest): unknown {
  const method = `${req.modelName}.${req.calledMethod}`;
  const { FindByString, WarehouseCategory } = req.methodProperties;
  if (FindByString === 'fail') {
    return { success: false, data: [], errors: ['Something went wrong'], errorCodes: ['1'] };
  }
  switch (method) {
    case 'Address.getCities':
      return { success: true, data: [{ Ref: 'kyiv-ref', Description: 'Київ', Area: 'extra' }] };
    case 'Address.getWarehouses':
      return { success: true, data: [{ Ref: 'wh-1', Description: 'Відділення №1' }] };
    case 'International.getCities':
      return { success: true, data: [{ City: 'Warszawa' }] };
    case 'International.getWarehouses':
      return {
        success: true,
        data: WarehouseCategory ? warehousesByCategory[WarehouseCategory] : Object.values(warehousesByCategory).flat(),
      };
    case 'International.getCountries':
      return { success: true, data: [{ Code: 'PL', Ref: 'pl-ref', Description: 'Польща' }] };
    default:
      return { success: false, data: [], errors: [`Unknown method ${method}`] };
  }
}

class RecordingApiKeyStrategy implements NovaPoshtaApiKeyStrategy {
  injector: Injector | undefined;

  init(injector: Injector) {
    this.injector = injector;
  }

  getApiKey(ctx: RequestContext) {
    return `key-for-${ctx.apiType}`;
  }
}

describe('NovaPoshtaPlugin', () => {
  const strategy = new RecordingApiKeyStrategy();
  const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig, {
      // Its own port: vitest runs every e2e file of the repo in parallel.
      apiOptions: { port: 3055 },
      plugins: [NovaPoshtaPlugin.init({ apiKey: strategy, apiUrl: API_URL })],
    }),
  );
  const requests: NpRequest[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== API_URL) return realFetch(url, init);
      const req = JSON.parse(init?.body as string) as NpRequest;
      requests.push(req);
      return Promise.resolve(new Response(JSON.stringify(answer(req))));
    });
    await server.init({ initialData, customerCount: 0 });
    await adminClient.asSuperAdmin();
  }, 120_000);

  afterAll(async () => {
    await server.destroy();
    vi.unstubAllGlobals();
  });

  it('runs the API key strategy lifecycle and exports the service', () => {
    expect(strategy.injector).toBeInstanceOf(Injector);
    expect(server.app.get(NovaPoshtaService)).toBeInstanceOf(NovaPoshtaService);
  });

  it('registers the country sync task', () => {
    const task = server.app.get(ConfigService).schedulerOptions.tasks.find((t) => t.id === COUNTRY_SYNC_TASK_ID);
    expect(task?.options.schedule).toBe('0 7 * * *');
  });

  it('looks up cities and warehouses in Ukraine', async () => {
    const { novaPoshtaCities } = await shopClient.query(CITIES, { input: { term: 'Київ', limit: 5 } });
    const { novaPoshtaWarehouses } = await shopClient.query(WAREHOUSES, {
      input: { cityId: 'kyiv-ref', term: '1' },
    });

    expect(novaPoshtaCities).toEqual([{ Ref: 'kyiv-ref', Description: 'Київ' }]);
    expect(novaPoshtaWarehouses).toEqual([{ Ref: 'wh-1', Description: 'Відділення №1' }]);
    expect(requests.at(-2)).toEqual({
      apiKey: 'key-for-shop',
      modelName: 'Address',
      calledMethod: 'getCities',
      methodProperties: { FindByString: 'Київ', Limit: 5 },
    });
    expect(requests.at(-1)?.methodProperties).toEqual({ CityRef: 'kyiv-ref', FindByString: '1' });
  });

  it('syncs country refs and exposes them in the Shop API', async () => {
    const { novaPoshtaSyncCountries } = await adminClient.query(SYNC_COUNTRIES);
    const { availableCountries } = await shopClient.query(AVAILABLE_COUNTRIES);

    expect(novaPoshtaSyncCountries).toEqual({ matched: 1, updated: 1 });
    expect(requests.at(-1)).toMatchObject({ apiKey: 'key-for-admin', calledMethod: 'getCountries' });
    expect(availableCountries.map((c: { code: string; customFields: object }) => [c.code, c.customFields])).toEqual([
      ['UA', { novaPoshtaCountryRef: null }],
      ['PL', { novaPoshtaCountryRef: 'pl-ref' }],
    ]);
  });

  it('looks up cities abroad and the warehouse types selected for the country', async () => {
    const { availableCountries } = await shopClient.query(AVAILABLE_COUNTRIES);
    const poland = availableCountries.find((c: { code: string }) => c.code === 'PL');
    const input = { city: 'Warszawa', country: 'pl-ref' };

    const { novaPoshtaInternationalCities } = await shopClient.query(INTERNATIONAL_CITIES, {
      input: { term: 'Warsz', country: 'pl-ref', limit: 5 },
    });
    const before = await shopClient.query(INTERNATIONAL_WAREHOUSES, { input });
    await adminClient.query(UPDATE_COUNTRY, {
      input: { id: poland.id, customFields: { novaPoshtaWarehouseCategories: ['Poshtomat'] } },
    });
    const after = await shopClient.query(INTERNATIONAL_WAREHOUSES, { input });

    expect(novaPoshtaInternationalCities).toEqual([{ City: 'Warszawa' }]);
    expect(before.novaPoshtaInternationalWarehouses).toHaveLength(2);
    expect(after.novaPoshtaInternationalWarehouses).toEqual([{ WarehouseRef: 'locker-1', FullDescription: 'WAW01M' }]);
    expect(requests.at(-1)?.methodProperties).toMatchObject({ WarehouseCategory: 'Poshtomat' });
  });

  it('surfaces a refusal from Nova Poshta as a GraphQL error', async () => {
    await expect(shopClient.query(CITIES, { input: { term: 'fail', limit: 5 } })).rejects.toThrow(
      /Nova Poshta Address\.getCities failed: Something went wrong/,
    );
  });
});
