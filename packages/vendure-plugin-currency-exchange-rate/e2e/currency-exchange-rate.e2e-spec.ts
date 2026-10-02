import path from 'path';
import { CurrencyCode, EventBus, RequestContextService, mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import { firstValueFrom, take, toArray } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CurrencyExchangeRateEvent,
  CurrencyExchangeRatePlugin,
  CurrencyExchangeRateService,
  CurrencyExchangeRateSyncService,
  StaticExchangeRateSource,
} from '../src';
import { initialData } from './fixtures/initial-data';
import { ADMIN_RATE, ADMIN_RATES, SHOP_RATES, SHOP_RATES_OR, UPDATE_RATE } from './graphql';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__sqlite-data__')));

describe('CurrencyExchangeRatePlugin', () => {
  const source = new StaticExchangeRateSource({ USD: 41.5, EUR: 45 });
  const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig, {
      // Its own port: vitest runs every e2e file of the repo in parallel.
      apiOptions: { port: 3056 },
      plugins: [CurrencyExchangeRatePlugin.init({ source })],
    }),
  );

  beforeAll(async () => {
    await server.init({ initialData, customerCount: 0 });
    await adminClient.asSuperAdmin();
  }, 120_000);

  afterAll(async () => {
    await server.destroy();
  });

  const adminRates = async () => (await adminClient.query(ADMIN_RATES)).currencyExchangeRates.items;
  const usdId = async () => (await adminRates()).find((r: { code: string }) => r.code === 'USD').id;

  it('fills the empty table on bootstrap, with every currency disabled', async () => {
    expect(await adminRates()).toEqual([
      expect.objectContaining({ code: 'EUR', rate: 45, enabled: false, useCustomRate: false }),
      expect.objectContaining({ code: 'USD', rate: 41.5, enabled: false, useCustomRate: false }),
    ]);
    // The Shop API never lists a disabled currency, not even through an OR filter.
    expect((await shopClient.query(SHOP_RATES)).currencyExchangeRates.totalItems).toBe(0);
    expect((await shopClient.query(SHOP_RATES_OR, { code: 'EUR' })).currencyExchangeRates.totalItems).toBe(0);
  });

  it('offers an enabled currency in the Shop API, at the custom rate once it is switched on', async () => {
    const id = await usdId();

    await adminClient.query(UPDATE_RATE, { input: { id, enabled: true, useCustomRate: false } });
    const fetched = (await shopClient.query(SHOP_RATES)).currencyExchangeRates.items;
    await adminClient.query(UPDATE_RATE, { input: { id, enabled: true, useCustomRate: true, customRate: 42 } });
    const custom = (await shopClient.query(SHOP_RATES)).currencyExchangeRates.items;

    expect(fetched).toEqual([{ id, code: 'USD', rate: 41.5, enabled: true }]);
    expect(custom).toEqual([{ id, code: 'USD', rate: 42, enabled: true }]);
  });

  it('needs UpdateSettings to change a rate and ReadSettings to list them in the Admin API', async () => {
    const id = await usdId();
    await adminClient.asAnonymousUser();
    try {
      await expect(
        adminClient.query(UPDATE_RATE, { input: { id, enabled: false, useCustomRate: false } }),
      ).rejects.toThrow(/not currently authorized/);
      await expect(adminClient.query(ADMIN_RATES)).rejects.toThrow(/not currently authorized/);
    } finally {
      await adminClient.asSuperAdmin();
    }
  });

  it('keeps the custom rate stored while it is switched off', async () => {
    const id = await usdId();

    await adminClient.query(UPDATE_RATE, { input: { id, enabled: true, useCustomRate: false, customRate: 42 } });
    const { currencyExchangeRate } = await adminClient.query(ADMIN_RATE, { id });
    const shop = (await shopClient.query(SHOP_RATES)).currencyExchangeRates.items;
    await adminClient.query(UPDATE_RATE, { input: { id, enabled: true, useCustomRate: true, customRate: 42 } });

    expect(currencyExchangeRate).toMatchObject({ rate: 41.5, useCustomRate: false, customRate: 42 });
    expect(shop).toEqual([expect.objectContaining({ code: 'USD', rate: 41.5 })]);
  });

  it('rejects a custom rate switched on without a positive value', async () => {
    await expect(
      adminClient.query(UPDATE_RATE, {
        input: { id: await usdId(), enabled: true, useCustomRate: true, customRate: null },
      }),
    ).rejects.toThrow(/custom rate must be a positive number/);
  });

  it('refreshes only the fetched rate on a sync, keeping enabled and the custom rate, and announces it', async () => {
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    const events = firstValueFrom(server.app.get(EventBus).ofType(CurrencyExchangeRateEvent).pipe(take(1), toArray()));
    Object.assign(source, { rates: { USD: 43, EUR: 46, PLN: 11 } });

    await server.app.get(CurrencyExchangeRateSyncService).syncRates(ctx);

    expect(await adminRates()).toEqual([
      expect.objectContaining({ code: 'EUR', rate: 46, enabled: false }),
      expect.objectContaining({ code: 'PLN', rate: 11, enabled: false }),
      expect.objectContaining({ code: 'USD', rate: 43, enabled: true, useCustomRate: true, customRate: 42 }),
    ]);
    const [event] = await events;
    expect(event.type).toBe('synced');
    expect(event.entities).toHaveLength(3);
  });

  it('looks a rate up with the caller deciding whether a disabled currency counts', async () => {
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    const rates = server.app.get(CurrencyExchangeRateService);

    await expect(rates.getRate(ctx, CurrencyCode.USD, { requireEnabled: true })).resolves.toBe(42);
    await expect(rates.getRate(ctx, CurrencyCode.EUR, { requireEnabled: true })).resolves.toBeUndefined();
    await expect(rates.getRate(ctx, CurrencyCode.EUR, { requireEnabled: false })).resolves.toBe(46);
  });
});
