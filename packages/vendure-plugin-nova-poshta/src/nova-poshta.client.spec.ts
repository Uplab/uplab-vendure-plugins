import type { RequestContext } from '@vendure/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NovaPoshtaError } from './nova-poshta-error';
import { NovaPoshtaClient } from './nova-poshta.client';
import { StaticNovaPoshtaApiKeyStrategy } from './static-api-key-strategy';
import type { NovaPoshtaApiKeyStrategy } from './types';

const ctx = {} as RequestContext;

function makeClient(apiKeyStrategy: NovaPoshtaApiKeyStrategy = new StaticNovaPoshtaApiKeyStrategy('key-1')) {
  return new NovaPoshtaClient({ apiKeyStrategy, apiUrl: 'https://np.test/json/', timeout: 1000, countrySync: false });
}

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NovaPoshtaClient.request', () => {
  it('posts the method with the resolved key and returns data', async () => {
    const fetchMock = stubFetch(json({ success: true, data: [{ Ref: 'r1' }] }));

    const data = await makeClient().request(ctx, 'Address', 'getCities', { FindByString: 'Київ' });

    expect(data).toEqual([{ Ref: 'r1' }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://np.test/json/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      apiKey: 'key-1',
      modelName: 'Address',
      calledMethod: 'getCities',
      methodProperties: { FindByString: 'Київ' },
    });
  });

  it('asks the strategy for the key on every request', async () => {
    stubFetch(json({ success: true, data: [] }));
    const getApiKey = vi.fn().mockResolvedValue('per-request');

    await makeClient({ getApiKey }).request(ctx, 'Address', 'getCities');

    expect(getApiKey).toHaveBeenCalledWith(ctx);
  });

  it('fails without a request when the strategy has no key', async () => {
    const fetchMock = stubFetch(json({ success: true, data: [] }));

    await expect(makeClient({ getApiKey: () => undefined }).request(ctx, 'Address', 'getCities')).rejects.toThrow(
      /No Nova Poshta API key/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('carries the errors of a refused request', async () => {
    stubFetch(json({ success: false, data: [], errors: ['API key expired'], errorCodes: ['20000200068'] }));

    const error = await makeClient()
      .request(ctx, 'Address', 'getCities')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NovaPoshtaError);
    expect(error).toMatchObject({
      message: 'Nova Poshta Address.getCities failed: API key expired',
      errors: ['API key expired'],
      errorCodes: ['20000200068'],
    });
  });

  it('reports a non-2xx status with the reason Nova Poshta gave', async () => {
    stubFetch(json({ success: false, data: [], errors: ['API key incorrect'] }, 401));

    await expect(makeClient().request(ctx, 'Address', 'getCities')).rejects.toMatchObject({
      message: 'Nova Poshta Address.getCities failed: HTTP 401: API key incorrect',
      status: 401,
      errors: ['API key incorrect'],
    });
  });

  it('reports a non-2xx status without a body', async () => {
    stubFetch(new Response('Bad gateway', { status: 502 }));

    await expect(makeClient().request(ctx, 'Address', 'getCities')).rejects.toMatchObject({
      message: 'Nova Poshta Address.getCities failed: HTTP 502',
      status: 502,
    });
  });

  it('reports a network failure', async () => {
    stubFetch(new TypeError('fetch failed'));

    await expect(makeClient().request(ctx, 'Address', 'getCities')).rejects.toThrow(
      'Nova Poshta Address.getCities failed: fetch failed',
    );
  });

  it('reports a body that is not JSON', async () => {
    stubFetch(new Response('<html>', { status: 200 }));

    await expect(makeClient().request(ctx, 'Address', 'getCities')).rejects.toThrow(/invalid JSON/);
  });
});
