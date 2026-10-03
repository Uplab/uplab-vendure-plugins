import path from 'path';
import { CurrencyCode, EventBus, RequestContextService, TransactionalConnection, mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import { firstValueFrom, take, toArray } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CurrencyExchangeRateEvent,
  CurrencyExchangeRateService,
  CurrencyExchangeRateSyncService,
  ExchangeRatesPlugin,
  StaticExchangeRateSource,
} from '../src';
import { initialData } from './fixtures/initial-data';
import {
  ACTIVE_CHANNEL,
  ADMIN_RATE,
  ADMIN_RATES,
  SHOP_RATES,
  SHOP_RATES_NESTED_OR,
  SHOP_RATES_OR,
  UPDATE_DEFAULT_CURRENCY,
  UPDATE_RATE,
} from './graphql';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__sqlite-data__')));

describe('ExchangeRatesPlugin', () => {
  // The test channel sells in USD, so this source already quotes the shop's base currency.
  const source = new StaticExchangeRateSource({ base: CurrencyCode.USD, rates: { EUR: 1.1, GBP: 1.3 } });
  const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig, {
      // Its own port: vitest runs every e2e file of the repo in parallel.
      apiOptions: { port: 3056 },
      plugins: [ExchangeRatesPlugin.init({ source })],
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
  const eurId = async () => (await adminRates()).find((r: { code: string }) => r.code === 'EUR').id;
  const sync = async () => {
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    return server.app.get(CurrencyExchangeRateSyncService).syncRates(ctx);
  };

  it('fills the empty table on bootstrap, with every currency disabled', async () => {
    expect(await adminRates()).toEqual([
      expect.objectContaining({ code: 'EUR', baseCurrency: 'USD', rate: 1.1, enabled: false, useCustomRate: false }),
      expect.objectContaining({ code: 'GBP', baseCurrency: 'USD', rate: 1.3, enabled: false, useCustomRate: false }),
    ]);
    // The Shop API never lists a disabled currency, not even through an OR filter.
    expect((await shopClient.query(SHOP_RATES)).currencyExchangeRates.totalItems).toBe(0);
    expect((await shopClient.query(SHOP_RATES_OR, { code: 'EUR' })).currencyExchangeRates.totalItems).toBe(0);
    expect((await shopClient.query(SHOP_RATES_NESTED_OR, { code: 'EUR' })).currencyExchangeRates.totalItems).toBe(0);
  });

  it('offers an enabled currency in the Shop API, at the custom rate once it is switched on', async () => {
    const id = await eurId();

    await adminClient.query(UPDATE_RATE, { input: { id, enabled: true, useCustomRate: false } });
    const fetched = (await shopClient.query(SHOP_RATES)).currencyExchangeRates.items;
    await adminClient.query(UPDATE_RATE, { input: { id, enabled: true, useCustomRate: true, customRate: 1.2 } });
    const custom = (await shopClient.query(SHOP_RATES)).currencyExchangeRates.items;

    expect(fetched).toEqual([{ id, code: 'EUR', baseCurrency: 'USD', rate: 1.1, enabled: true }]);
    expect(custom).toEqual([{ id, code: 'EUR', baseCurrency: 'USD', rate: 1.2, enabled: true }]);
  });

  it('needs UpdateSettings to change a rate and ReadSettings to list them in the Admin API', async () => {
    const id = await eurId();
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
    const id = await eurId();

    await adminClient.query(UPDATE_RATE, { input: { id, enabled: true, useCustomRate: false, customRate: 1.2 } });
    const { currencyExchangeRate } = await adminClient.query(ADMIN_RATE, { id });
    const shop = (await shopClient.query(SHOP_RATES)).currencyExchangeRates.items;
    await adminClient.query(UPDATE_RATE, { input: { id, enabled: true, useCustomRate: true, customRate: 1.2 } });

    expect(currencyExchangeRate).toMatchObject({ rate: 1.1, useCustomRate: false, customRate: 1.2 });
    expect(shop).toEqual([expect.objectContaining({ code: 'EUR', rate: 1.1 })]);
  });

  it('rejects a custom rate switched on without a positive value', async () => {
    await expect(
      adminClient.query(UPDATE_RATE, {
        input: { id: await eurId(), enabled: true, useCustomRate: true, customRate: null },
      }),
    ).rejects.toThrow(/custom rate must be a positive number/);
  });

  it('derives cross rates from a source in another base, keeping enabled and the custom rate, and announces it', async () => {
    const events = firstValueFrom(server.app.get(EventBus).ofType(CurrencyExchangeRateEvent).pipe(take(1), toArray()));
    // UAH per unit; in USD that is EUR 1.1, GBP 1.3, PLN 0.25 and UAH 0.025.
    source.config = { base: CurrencyCode.UAH, rates: { USD: 40, EUR: 44, GBP: 52, PLN: 10 } };

    await sync();

    expect(await adminRates()).toEqual([
      expect.objectContaining({ code: 'EUR', rate: 1.1, enabled: true, useCustomRate: true, customRate: 1.2 }),
      expect.objectContaining({ code: 'GBP', rate: 1.3, enabled: false }),
      expect.objectContaining({ code: 'PLN', rate: 0.25, enabled: false }),
      expect.objectContaining({ code: 'UAH', baseCurrency: 'USD', rate: 0.025, enabled: false }),
    ]);
    const [event] = await events;
    expect(event.type).toBe('synced');
    expect(event.entities).toHaveLength(4);
  });

  it('looks a rate up with the caller deciding whether a disabled currency counts', async () => {
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    const rates = server.app.get(CurrencyExchangeRateService);

    await expect(rates.getRate(ctx, CurrencyCode.EUR, { requireEnabled: true })).resolves.toBe(1.2);
    await expect(rates.getRate(ctx, CurrencyCode.GBP, { requireEnabled: true })).resolves.toBeUndefined();
    await expect(rates.getRate(ctx, CurrencyCode.GBP, { requireEnabled: false })).resolves.toBe(1.3);
  });

  it('follows a change of the default currency on the next sync, dropping rates of the old base', async () => {
    const gbpId = (await adminRates()).find((r: { code: string }) => r.code === 'GBP').id;
    await adminClient.query(UPDATE_RATE, { input: { id: gbpId, enabled: true, useCustomRate: true, customRate: 1.4 } });
    const { activeChannel } = await adminClient.query(ACTIVE_CHANNEL);
    await adminClient.query(UPDATE_DEFAULT_CURRENCY, { id: activeChannel.id, currency: 'EUR' });

    // Until the sync runs, nothing is offered in a base the shop no longer sells in.
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    expect((await shopClient.query(SHOP_RATES)).currencyExchangeRates.totalItems).toBe(0);
    await expect(
      server.app.get(CurrencyExchangeRateService).getRate(ctx, CurrencyCode.GBP, { requireEnabled: false }),
    ).resolves.toBeUndefined();
    await sync();

    const rates = await adminRates();
    expect(rates.map((r: { code: string; baseCurrency: string }) => [r.code, r.baseCurrency])).toEqual([
      ['GBP', 'EUR'],
      ['PLN', 'EUR'],
      ['UAH', 'EUR'],
      ['USD', 'EUR'],
    ]);
    // Still enabled, but a custom rate in USD means nothing in EUR.
    expect(rates.find((r: { code: string }) => r.code === 'GBP')).toMatchObject({
      rate: 1.18181818,
      enabled: true,
      useCustomRate: false,
      customRate: null,
    });
  });

  it('gives rows from before the baseCurrency column the current base on boot, keeping custom rates', async () => {
    const usdId = (await adminRates()).find((r: { code: string }) => r.code === 'USD').id;
    await adminClient.query(UPDATE_RATE, {
      input: { id: usdId, enabled: true, useCustomRate: true, customRate: 0.95 },
    });
    // What a table looks like right after a generated migration added the column.
    await server.app
      .get(TransactionalConnection)
      .rawConnection.query('UPDATE currency_exchange_rate SET "baseCurrency" = NULL');
    expect((await shopClient.query(SHOP_RATES)).currencyExchangeRates.totalItems).toBe(0);

    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    await server.app.get(CurrencyExchangeRateSyncService).backfillIfEmpty(ctx);

    expect((await adminRates()).every((r: { baseCurrency: string }) => r.baseCurrency === 'EUR')).toBe(true);
    expect((await shopClient.query(SHOP_RATES)).currencyExchangeRates.items).toEqual([
      expect.objectContaining({ code: 'GBP' }),
      expect.objectContaining({ code: 'USD', baseCurrency: 'EUR', rate: 0.95 }),
    ]);
  });
});
