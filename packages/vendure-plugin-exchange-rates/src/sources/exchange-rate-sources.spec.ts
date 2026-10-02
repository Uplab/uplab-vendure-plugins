import { CurrencyCode } from '@vendure/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EcbExchangeRateSource } from './ecb-exchange-rate-source';
import { FrankfurterExchangeRateSource } from './frankfurter-exchange-rate-source';
import { MonobankExchangeRateSource } from './monobank-exchange-rate-source';
import { NbuExchangeRateSource } from './nbu-exchange-rate-source';
import { StaticExchangeRateSource } from './static-exchange-rate-source';
import { ExchangeRateSourceError } from '../exchange-rate-source-error';

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

// Shapes as returned by https://api.monobank.ua/bank/currency on 2026-10-05.
const usdUah = { currencyCodeA: 840, currencyCodeB: 980, date: 1_790_888_474, rateBuy: 44.8, rateSell: 45.2 };
const gbpUah = { currencyCodeA: 826, currencyCodeB: 980, date: 1_790_953_071, rateCross: 60.048 };
const usdEur = { currencyCodeA: 840, currencyCodeB: 978, date: 1_790_888_474, rateBuy: 0.9, rateSell: 0.95 };
const goldUah = { currencyCodeA: 959, currencyCodeB: 980, date: 1_790_888_474, rateCross: 188_000 };

describe('MonobankExchangeRateSource', () => {
  it('returns the buy rate of every UAH pair, and the cross rate where that is all there is', async () => {
    stubFetch(json([usdUah, gbpUah, usdEur, goldUah]));

    // Gold passes through: the sync drops what is not a Vendure currency, for every source alike.
    await expect(new MonobankExchangeRateSource().fetchRates()).resolves.toEqual({
      base: CurrencyCode.UAH,
      quotes: [
        { currencyCode: CurrencyCode.USD, rate: 44.8 },
        { currencyCode: CurrencyCode.GBP, rate: 60.048 },
        { currencyCode: 'XAU', rate: 188_000 },
      ],
    });
  });

  it('maps ISO numbers below 100, which the code table keeps zero-padded', async () => {
    stubFetch(json([{ currencyCodeA: 36, currencyCodeB: 980, date: 1_790_888_474, rateCross: 29.4 }]));

    await expect(new MonobankExchangeRateSource().fetchRates()).resolves.toEqual({
      base: CurrencyCode.UAH,
      quotes: [{ currencyCode: CurrencyCode.AUD, rate: 29.4 }],
    });
  });

  it('hands on a pair without any rate for the sync to drop', async () => {
    stubFetch(json([{ currencyCodeA: 840, currencyCodeB: 980, date: 1_790_888_474 }]));

    await expect(new MonobankExchangeRateSource().fetchRates()).resolves.toEqual({
      base: CurrencyCode.UAH,
      quotes: [{ currencyCode: CurrencyCode.USD, rate: NaN }],
    });
  });

  it('reports a failure that is not an Error', async () => {
    vi.stubGlobal('fetch', () => Promise.reject('socket hang up'));

    await expect(new MonobankExchangeRateSource().fetchRates()).rejects.toThrow(
      'monobank rates request failed: socket hang up',
    );
  });

  it('reports a 200 whose body is not the list of pairs', async () => {
    stubFetch(json({ errorDescription: 'Too many requests' }));

    await expect(new MonobankExchangeRateSource().fetchRates()).rejects.toThrow(
      'monobank answered with an unexpected body',
    );
  });

  it.each([
    ['sell', 45.2],
    ['mid', 45],
  ] as const)('can store the %s rate', async (side, rate) => {
    stubFetch(json([usdUah]));

    await expect(new MonobankExchangeRateSource({ side }).fetchRates()).resolves.toEqual({
      base: CurrencyCode.UAH,
      quotes: [{ currencyCode: CurrencyCode.USD, rate }],
    });
  });

  it('requests the configured endpoint', async () => {
    const fetchMock = stubFetch(json([]));

    await new MonobankExchangeRateSource({ apiUrl: 'https://mono.test/currency' }).fetchRates();

    expect(fetchMock).toHaveBeenCalledWith('https://mono.test/currency', expect.anything());
  });

  it('reports a rate-limited request with its status', async () => {
    stubFetch(json({ errorDescription: 'Too many requests' }, 429));

    const error = await new MonobankExchangeRateSource().fetchRates().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExchangeRateSourceError);
    expect(error).toMatchObject({
      source: 'monobank',
      status: 429,
      message: 'monobank rates request failed: HTTP 429',
    });
  });

  it('reports a timeout with the configured limit', async () => {
    stubFetch(new DOMException('aborted', 'TimeoutError'));

    await expect(new MonobankExchangeRateSource({ timeout: 500 }).fetchRates()).rejects.toThrow(
      'monobank rates request failed: timed out after 500 ms',
    );
  });

  it('reports a body that is not JSON', async () => {
    stubFetch(new Response('<html>', { status: 200 }));

    await expect(new MonobankExchangeRateSource().fetchRates()).rejects.toThrow('monobank answered with invalid JSON');
  });
});

describe('NbuExchangeRateSource', () => {
  it('returns every row as a per-unit quote, leaving non-currencies for the sync to drop', async () => {
    // Shape as returned by https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json on 2026-10-05.
    stubFetch(
      json([
        { r030: 840, txt: 'Долар США', rate: 44.9857, cc: 'USD', exchangedate: '05.10.2026' },
        { r030: 392, txt: 'Єна', rate: 0.28536, cc: 'JPY', exchangedate: '05.10.2026' },
        { r030: 959, txt: 'Золото', rate: 188168.98, cc: 'XAU', exchangedate: '05.10.2026' },
      ]),
    );

    await expect(new NbuExchangeRateSource().fetchRates()).resolves.toEqual({
      base: CurrencyCode.UAH,
      quotes: [
        { currencyCode: 'USD', rate: 44.9857 },
        { currencyCode: 'JPY', rate: 0.28536 },
        { currencyCode: 'XAU', rate: 188168.98 },
      ],
    });
  });

  it('reports a failed request', async () => {
    stubFetch(new Response('', { status: 503 }));

    await expect(new NbuExchangeRateSource().fetchRates()).rejects.toMatchObject({ source: 'nbu', status: 503 });
  });
});

// Abridged from https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml on 2026-10-02.
const ecbXml = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-10-02'>
      <Cube currency='USD' rate='1.25'/>
      <Cube currency='JPY' rate='160.5'/>
      <Cube currency="GBP" rate="0.8" />
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe('EcbExchangeRateSource', () => {
  it('turns the euro reference rates into EUR per unit', async () => {
    stubFetch(new Response(ecbXml));

    const { base, quotes } = await new EcbExchangeRateSource().fetchRates();

    expect(base).toBe(CurrencyCode.EUR);
    expect(quotes).toEqual([
      { currencyCode: 'USD', rate: 0.8 },
      { currencyCode: 'JPY', rate: 1 / 160.5 },
      { currencyCode: 'GBP', rate: 1.25 },
    ]);
  });

  it('reports a body without any rate', async () => {
    stubFetch(new Response('<html>maintenance</html>'));

    await expect(new EcbExchangeRateSource().fetchRates()).rejects.toThrow('ecb answered with an unexpected body');
  });

  it('requests the configured endpoint', async () => {
    const fetchMock = stubFetch(new Response(ecbXml));

    await new EcbExchangeRateSource({ apiUrl: 'https://ecb.test/daily.xml' }).fetchRates();

    expect(fetchMock).toHaveBeenCalledWith('https://ecb.test/daily.xml', expect.anything());
  });
});

describe('FrankfurterExchangeRateSource', () => {
  // Shape as returned by https://api.frankfurter.dev/v1/latest on 2026-10-02.
  const latest = { amount: 1, base: 'EUR', date: '2026-10-02', rates: { USD: 1.25, GBP: 0.8 } };

  it('turns the rates into units of the answered base per unit', async () => {
    stubFetch(json(latest));

    await expect(new FrankfurterExchangeRateSource().fetchRates()).resolves.toEqual({
      base: CurrencyCode.EUR,
      quotes: [
        { currencyCode: 'USD', rate: 0.8 },
        { currencyCode: 'GBP', rate: 1.25 },
      ],
    });
  });

  it('honours an amount other than 1', async () => {
    stubFetch(json({ ...latest, amount: 10, rates: { USD: 12.5 } }));

    const { quotes } = await new FrankfurterExchangeRateSource().fetchRates();

    expect(quotes).toEqual([{ currencyCode: 'USD', rate: 0.8 }]);
  });

  it('asks for the configured base', async () => {
    const fetchMock = stubFetch(json({ ...latest, base: 'USD' }));

    const { base } = await new FrankfurterExchangeRateSource({ base: CurrencyCode.USD }).fetchRates();

    expect(fetchMock).toHaveBeenCalledWith('https://api.frankfurter.dev/v1/latest?base=USD', expect.anything());
    expect(base).toBe(CurrencyCode.USD);
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['no base', { rates: { USD: 1 } }],
    ['no rates', { base: 'EUR' }],
  ])('reports %s as an unexpected body', async (_, body) => {
    stubFetch(json(body));

    await expect(new FrankfurterExchangeRateSource().fetchRates()).rejects.toThrow(
      'frankfurter answered with an unexpected body',
    );
  });
});

describe('StaticExchangeRateSource', () => {
  it('returns the rates it was given', async () => {
    const source = new StaticExchangeRateSource({ base: CurrencyCode.UAH, rates: { USD: 41.5, EUR: 45 } });

    await expect(source.fetchRates()).resolves.toEqual({
      base: CurrencyCode.UAH,
      quotes: [
        { currencyCode: CurrencyCode.USD, rate: 41.5 },
        { currencyCode: CurrencyCode.EUR, rate: 45 },
      ],
    });
  });
});
