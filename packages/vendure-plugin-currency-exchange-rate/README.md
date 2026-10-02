# @uplab/vendure-plugin-currency-exchange-rate

[![npm](https://img.shields.io/npm/v/@uplab/vendure-plugin-currency-exchange-rate.svg)](https://www.npmjs.com/package/@uplab/vendure-plugin-currency-exchange-rate)
[![Vendure](https://img.shields.io/badge/Vendure-%5E3.7.0-17c9ff.svg)](https://www.vendure.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/Uplab/uplab-vendure-plugins/blob/main/LICENSE)

Exchange rates against the Ukrainian hryvnia for a Vendure shop that prices in UAH and shows or charges
in other currencies. Rates come from a **source you choose** — Monobank, the National Bank of Ukraine,
fixed rates or your own — are refreshed on a schedule, served on the Shop API, and can be overridden per
currency in the dashboard.

![Currency exchange rates in the dashboard](https://raw.githubusercontent.com/Uplab/uplab-vendure-plugins/main/packages/vendure-plugin-currency-exchange-rate/assets/screenshot-list.png)

Compatible with **Vendure ^3.7.0**.

## Contents

[Install](#install) · [Use cases](#use-cases) · [Sources](#sources) · [Options](#options) ·
[Dashboard](#dashboard) · [GraphQL API](#graphql-api) · [In your own code](#in-your-own-code) ·
[Event](#event) · [Database](#database) · [Limitations](#limitations)

## Install

```bash
npm install @uplab/vendure-plugin-currency-exchange-rate
```

```ts
import { CurrencyExchangeRatePlugin, MonobankExchangeRateSource } from '@uplab/vendure-plugin-currency-exchange-rate';

export const config: VendureConfig = {
  // ...
  plugins: [
    DefaultSchedulerPlugin.init(), // runs the scheduled refresh
    CurrencyExchangeRatePlugin.init({ source: new MonobankExchangeRateSource() }),
  ],
};
```

Generate a migration for the new `currency_exchange_rate` table. On first start the plugin fills it from
the source; every currency arrives **disabled** — enable the ones you sell in under
_Settings → Currency exchange rates_.

## Use cases

**Show prices in the visitor's currency.** The storefront reads the enabled rates once and divides:

```graphql
query {
  currencyExchangeRates {
    items {
      code
      rate
    } # rate = UAH per one unit, e.g. USD → 41.5
  }
}
```

```ts
const priceInUsd = Math.round(priceInUah / rates.USD);
```

**Charge in a foreign currency.** A payment plugin converts the order total with the rate it may bill in:

```ts
const rate = await currencyExchangeRateService.getRate(ctx, CurrencyCode.USD, { requireEnabled: true });
if (rate !== undefined) amount = Math.round(order.totalWithTax / rate);
```

**Price a product feed in another currency** (Google Merchant, Meta, …) even if the storefront does not
offer it: `getRate(ctx, CurrencyCode.EUR, { requireEnabled: false })`.

**Pin a rate.** Turn on _Use custom rate_ for a currency: the storefront and your code use your number
until you turn it off; the fetched rate keeps updating underneath.

**Fixed rates only.** No bank at all: `source: new StaticExchangeRateSource({ USD: 41.5, EUR: 45 })` and
`sync: false`, then manage everything in the dashboard.

## Sources

| Source                       | Rates                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MonobankExchangeRateSource` | Monobank's public rates. `side: 'buy'` (default — what the bank pays, the lower), `'sell'` or `'mid'`. Rate-limited; the endpoint is cached 5 minutes. |
| `NbuExchangeRateSource`      | The National Bank of Ukraine's official rate, set once per business day.                                                                               |
| `StaticExchangeRateSource`   | The numbers you pass: `new StaticExchangeRateSource({ USD: 41.5 })`.                                                                                   |

Both bank sources take `apiUrl` and `timeout` (default 10 s). Whatever a source returns, only Vendure
`CurrencyCode`s with a positive finite rate are stored — metals, the SDR and garbage are dropped. If the
source fails or returns nothing usable, the stored rates stay as they are.

### Your own source

```ts
import {
  ExchangeRateQuote,
  ExchangeRateSource,
  ExchangeRateSourceError,
} from '@uplab/vendure-plugin-currency-exchange-rate';

export class PrivatBankExchangeRateSource implements ExchangeRateSource {
  readonly name = 'privatbank';

  async fetchRates(): Promise<ExchangeRateQuote[]> {
    const res = await fetch('https://api.privatbank.ua/p24api/pubinfo?exchange&json&coursid=11');
    if (!res.ok) throw new ExchangeRateSourceError(`HTTP ${res.status}`, { source: this.name, status: res.status });
    const rows: Array<{ ccy: string; buy: string }> = await res.json();
    return rows.map((r) => ({ currencyCode: r.ccy as CurrencyCode, rate: Number(r.buy) }));
  }
}
```

A quote is `{ currencyCode, rate }`, `rate` being **UAH per one unit**. Throw on failure — never return
`[]` to mean "failed". If the source needs services, implement `init(injector)` (and `destroy()`); the
plugin calls `init` before the first fetch.

## Options

| Option   | Type                                                      | Default                            |
| -------- | --------------------------------------------------------- | ---------------------------------- |
| `source` | `ExchangeRateSource`                                      | `new MonobankExchangeRateSource()` |
| `sync`   | `{ schedule?: ScheduledTaskConfig['schedule'] } \| false` | `{ schedule: '40 2-23/3 * * *' }`  |

`sync` registers the scheduled task `currency-exchange-rate-updater` (every 3 hours by default). It needs
a scheduler plugin such as `DefaultSchedulerPlugin`. `sync: false` leaves it out; you can still call
`CurrencyExchangeRateSyncService.syncRates(ctx)` yourself.

## Dashboard

_Settings → Currency exchange rates_ lists every stored currency with its rate, whether it is enabled and
whether a custom rate is in use. A currency's page shows the fetched rate and lets you enable it and set a
custom rate.

![Editing a currency](https://raw.githubusercontent.com/Uplab/uplab-vendure-plugins/main/packages/vendure-plugin-currency-exchange-rate/assets/screenshot-detail.png)

Listing needs `ReadSettings`, editing `UpdateSettings`.

## GraphQL API

**Shop** (public)

```graphql
currencyExchangeRates(options: CurrencyExchangeRateListOptions): CurrencyExchangeRateList!
# items: { id, code, rate, enabled, createdAt, updatedAt } — enabled currencies only
```

`rate` is the custom rate when one is in use, otherwise the fetched one.

**Admin**

```graphql
currencyExchangeRates(options: CurrencyExchangeRateListOptions): CurrencyExchangeRateList!  # ReadSettings
currencyExchangeRate(id: ID!): CurrencyExchangeRate                                         # ReadSettings
updateCurrencyExchangeRate(input: { id, enabled, useCustomRate, customRate }): CurrencyExchangeRate!  # UpdateSettings
```

In the Admin API `rate` is always the fetched rate; `useCustomRate` and `customRate` are separate fields.
Turning on `useCustomRate` without a positive `customRate` is rejected.

## In your own code

| Export                            | Use                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `CurrencyExchangeRateService`     | `getRate(ctx, code, { requireEnabled })` → UAH per unit or `undefined`; `findAll`, `findOne`, `update` |
| `CurrencyExchangeRateSyncService` | `syncRates(ctx)` — refresh now                                                                         |
| `findEffectiveRate`               | `getRate` without injection, from a `TransactionalConnection`                                          |
| `effectiveRate(row)`              | The rate to convert with for a row you already loaded                                                  |

`requireEnabled` is your policy: `true` for anything the customer is billed in, `false` for internal uses.

## Event

`CurrencyExchangeRateEvent` is published after every change — `type: 'synced'` with every refreshed row,
or `'updated'` with the one an admin edited. Use it to drop caches that embed the rates:

```ts
eventBus.ofType(CurrencyExchangeRateEvent).subscribe(() => cache.delete('currency-rates'));
```

## Database

One table, `currency_exchange_rate`:

| Column          | Type                      |
| --------------- | ------------------------- |
| `code`          | varchar, unique           |
| `rate`          | decimal — the fetched one |
| `enabled`       | boolean, default `false`  |
| `useCustomRate` | boolean, default `false`  |
| `customRate`    | decimal, nullable         |

A sync only ever writes `rate` and adds new currencies; `enabled` and the custom rate are yours.

## Limitations

- **The base currency is UAH.** Every source quotes against the hryvnia; a shop priced in another
  currency needs its own source and has to read `rate` accordingly.
- **Postgres returns decimals as strings.** Use `getRate` / `effectiveRate`, which convert, rather than
  reading `rate` off the entity.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
