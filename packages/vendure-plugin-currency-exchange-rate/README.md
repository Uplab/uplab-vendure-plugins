<p align="center">
  <img src="https://raw.githubusercontent.com/Uplab/uplab-vendure-plugins/main/packages/vendure-plugin-currency-exchange-rate/assets/icon.svg" alt="" width="96" height="96">
</p>

# @uplab/vendure-plugin-currency-exchange-rate

[![npm](https://img.shields.io/npm/v/@uplab/vendure-plugin-currency-exchange-rate.svg)](https://www.npmjs.com/package/@uplab/vendure-plugin-currency-exchange-rate)
[![Vendure](https://img.shields.io/badge/Vendure-%5E3.7.0-17c9ff.svg)](https://www.vendure.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/Uplab/uplab-vendure-plugins/blob/main/LICENSE)

Exchange rates against the Ukrainian hryvnia for a Vendure shop that prices in UAH and shows or charges
in other currencies. Rates come from a **source you choose** — Monobank, the National Bank of Ukraine,
fixed rates or your own — are refreshed on a schedule, served on the Shop API, and can be overridden per
currency in the dashboard.

The plugin stores and serves rates; it does not touch Vendure prices or orders — your storefront, feed or
payment code converts with them. Vendure's own per-currency variant prices are unaffected.

![Currency exchange rates in the dashboard](https://raw.githubusercontent.com/Uplab/uplab-vendure-plugins/main/packages/vendure-plugin-currency-exchange-rate/assets/screenshot-list.png)

Compatible with **Vendure ^3.7.0**.

## Contents

[Install](#install) · [Use cases](#use-cases) · [Sources](#sources) · [Options](#options) ·
[Dashboard](#dashboard) · [GraphQL API](#graphql-api) · [In your own code](#in-your-own-code) ·
[Event](#event) · [Database](#database) · [Limitations](#limitations)

## Install

```bash
npm install @uplab/vendure-plugin-currency-exchange-rate
# or
pnpm add @uplab/vendure-plugin-currency-exchange-rate
```

```ts
import { DefaultSchedulerPlugin, VendureConfig } from '@vendure/core';
import { CurrencyExchangeRatePlugin, MonobankExchangeRateSource } from '@uplab/vendure-plugin-currency-exchange-rate';

export const config: VendureConfig = {
  // ...
  plugins: [
    DefaultSchedulerPlugin.init(), // runs the scheduled refresh
    CurrencyExchangeRatePlugin.init({ source: new MonobankExchangeRateSource() }),
  ],
};
```

`@vendure/core`, `@nestjs/*` and `typeorm` are peers. The dashboard pages need `@vendure/dashboard` (an
optional peer): its Vite plugin discovers the extension — restart the dashboard dev server after
installing.

**First deploy.** Generate and run a migration for the new `currency_exchange_rate` table. On the API
server's first boot the plugin fills the empty table from the source (startup waits for it, up to the
source's `timeout`); if the source is unreachable then, the table stays empty until the next scheduled
refresh. Every currency arrives **disabled** — enable the
ones you sell in under _Settings → Currency exchange rates_. Until you do, the storefront sees no rates
and stays in UAH.

## Use cases

**Show prices in the visitor's currency.** The storefront reads the enabled rates once:

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
type Rate = { code: string; rate: number };

/** `rates` = the query's items, [] until an admin enables a currency. */
export function convertPrice(priceInKopecks: number, rates: Rate[], code: string): number | undefined {
  const rate = rates.find((r) => r.code === code)?.rate;
  // Vendure prices are minor units: kopecks ÷ rate = cents. undefined → show UAH.
  return rate ? Math.round(priceInKopecks / rate) : undefined;
}
```

For a currency whose minor unit is not 1/100 (JPY has none, KWD and BHD have 1/1000), multiply the result
by 10^(digits − 2).

**Charge in a foreign currency.** A `PaymentMethodHandler` gets the service in `init` and converts the
amount it is asked to collect:

```ts
import { CurrencyCode, LanguageCode, PaymentMethodHandler } from '@vendure/core';
import { CurrencyExchangeRateService } from '@uplab/vendure-plugin-currency-exchange-rate';

let rates: CurrencyExchangeRateService;

export const usdCardHandler = new PaymentMethodHandler({
  code: 'usd-card',
  description: [{ languageCode: LanguageCode.en, value: 'Card, billed in USD' }],
  args: {},
  init: (injector) => {
    rates = injector.get(CurrencyExchangeRateService);
  },
  createPayment: async (ctx, _order, amount) => {
    const rate = await rates.getRate(ctx, CurrencyCode.USD, { requireEnabled: true });
    const amountInCents = rate ? Math.round(amount / rate) : undefined; // undefined → bill in UAH
    // …call your payment provider with amountInCents
    return { amount, state: 'Authorized', metadata: { amountInCents } };
  },
  settlePayment: () => ({ success: true }),
});
```

**Price a product feed in another currency** (Google Merchant, Meta, …) even if the storefront does not
offer it: `getRate(ctx, CurrencyCode.EUR, { requireEnabled: false })`.

**Pin a rate.** Turn on _Use custom rate_ for a currency: the storefront and your code use your number
until you turn it off; the fetched rate keeps updating underneath, and your number is kept for next time.

**Fixed rates only.** `source: new StaticExchangeRateSource({ USD: 41.5, EUR: 45 })`. Keep the sync on, so
a number you change in config is picked up on the next refresh; pin any currency in the meantime with
_Use custom rate_.

## Sources

| Source                       | Rates                                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MonobankExchangeRateSource` | Monobank's public rates. `side: 'buy'` (default) is what the bank pays you for the currency — the lower rate, so a UAH price converted with it never comes up short; or `'sell'`, `'mid'`. Rate-limited; cached 5 minutes. |
| `NbuExchangeRateSource`      | The National Bank of Ukraine's official rate, set once per business day.                                                                                                                                                   |
| `StaticExchangeRateSource`   | The numbers you pass: `new StaticExchangeRateSource({ USD: 41.5 })`. Also the source for your own e2e tests — no network.                                                                                                  |

Both bank sources take `apiUrl` and `timeout` (default 10 s). Whatever a source returns, only Vendure
`CurrencyCode`s with a positive finite rate are stored — metals, the SDR and garbage are dropped. If the
source fails or returns nothing usable, the stored rates stay as they are.

### Your own source

```ts
import { CurrencyCode } from '@vendure/core';
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
    const rows = (await res.json()) as Array<{ ccy: string; base_ccy: string; buy: string }>;
    return rows
      .filter((r) => r.base_ccy === 'UAH')
      .map((r) => ({ currencyCode: r.ccy as CurrencyCode, rate: Number(r.buy) }));
  }
}
```

A quote is `{ currencyCode, rate }`, `rate` being **UAH per one unit**. Throw on failure — never return
`[]` to mean "failed". If the source needs services, implement `init(injector)` (and `destroy()`); the
plugin calls `init` before the first fetch.

### Combining sources

When a bank rate-limits or is down, fall back to another — the first source that answers wins:

```ts
import { RequestContext } from '@vendure/core';
import {
  ExchangeRateQuote,
  ExchangeRateSource,
  MonobankExchangeRateSource,
  NbuExchangeRateSource,
} from '@uplab/vendure-plugin-currency-exchange-rate';

export class FallbackExchangeRateSource implements ExchangeRateSource {
  readonly name = 'fallback';
  constructor(private readonly sources: ExchangeRateSource[]) {}

  async fetchRates(ctx: RequestContext): Promise<ExchangeRateQuote[]> {
    let lastError: unknown;
    for (const source of this.sources) {
      try {
        return await source.fetchRates(ctx);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }
}

export const source = new FallbackExchangeRateSource([new MonobankExchangeRateSource(), new NbuExchangeRateSource()]);
```

To add a currency your bank does not quote, return the quotes of several sources together instead
(`(await Promise.all(sources.map((s) => s.fetchRates(ctx)))).flat()`, a `StaticExchangeRateSource` last).
When two quotes share a code, the last one wins. Forward `init`/`destroy` if the inner sources need them.

## Options

| Option   | Type                                                      | Default                           |
| -------- | --------------------------------------------------------- | --------------------------------- |
| `source` | `ExchangeRateSource` — required                           | —                                 |
| `sync`   | `{ schedule?: ScheduledTaskConfig['schedule'] } \| false` | `{ schedule: '40 2-23/3 * * *' }` |

`sync` registers the scheduled task `currency-exchange-rate-updater` (every 3 hours). It needs a scheduler
plugin such as `DefaultSchedulerPlugin`, and runs in the worker — so the worker needs the plugin in its
config too. `sync: false` leaves it out; you can still call `CurrencyExchangeRateSyncService.syncRates(ctx)`.

To refresh now, run it under _System → Scheduled tasks_ (or `runScheduledTask(id: "currency-exchange-rate-updater")`);
its last run there tells you the sync is alive. A row's `updatedAt` moves only when its rate changes, and a
currency the source stops quoting keeps its last rate.

## Dashboard

_Settings → Currency exchange rates_ lists every stored currency with its rate, whether it is enabled and
whether a custom rate is in use. A currency's page shows the fetched rate and lets you enable it and set a
custom rate.

![Editing a currency](https://raw.githubusercontent.com/Uplab/uplab-vendure-plugins/main/packages/vendure-plugin-currency-exchange-rate/assets/screenshot-detail.png)

Rates are shop settings: listing needs `ReadSettings`, editing `UpdateSettings` — no extra role setup.

## GraphQL API

**Shop** (public)

```graphql
currencyExchangeRates(options: CurrencyExchangeRateListOptions): CurrencyExchangeRateList!
# items: { id, code, rate, enabled, createdAt, updatedAt } — enabled currencies only, whatever the filter
```

`rate` is the custom rate while one is in use, otherwise the fetched one.

**Admin**

```graphql
currencyExchangeRates(options: CurrencyExchangeRateListOptions): CurrencyExchangeRateList!          # ReadSettings
currencyExchangeRate(id: ID!): CurrencyExchangeRate                                                 # ReadSettings
updateCurrencyExchangeRate(input: { id, enabled, useCustomRate, customRate }): CurrencyExchangeRate! # UpdateSettings
```

In the Admin API `rate` is always the fetched rate; `useCustomRate` and `customRate` are separate fields.
Turning on `useCustomRate` without a positive `customRate` is rejected.

## In your own code

| Export                            | Use                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `CurrencyExchangeRateService`     | `getRate(ctx, code, { requireEnabled })` → UAH per unit or `undefined`; `findAll`, `findOne`, `update` |
| `CurrencyExchangeRateSyncService` | `syncRates(ctx)` — refresh now                                                                         |
| `effectiveRate(row)`              | The rate to convert with for a row you loaded yourself, or `undefined` if it is not usable             |

`requireEnabled` is your policy: `true` for anything the customer is billed in, `false` for internal uses.

## Event

`CurrencyExchangeRateEvent` is published after every change — `type: 'synced'` with every refreshed row,
or `'updated'` with the one an admin edited — once the transaction has committed. Use it to drop caches
that embed the rates:

```ts
import { OnApplicationBootstrap } from '@nestjs/common';
import { EventBus, PluginCommonModule, VendurePlugin } from '@vendure/core';
import { CurrencyExchangeRateEvent } from '@uplab/vendure-plugin-currency-exchange-rate';

@VendurePlugin({ imports: [PluginCommonModule] })
export class RatesCachePlugin implements OnApplicationBootstrap {
  constructor(private readonly eventBus: EventBus) {}

  onApplicationBootstrap() {
    this.eventBus.ofType(CurrencyExchangeRateEvent).subscribe(() => {
      // drop whatever caches the rates, e.g. a cached Shop API response
    });
  }
}
```

## Database

One table, `currency_exchange_rate`:

| Column          | Type                             |
| --------------- | -------------------------------- |
| `code`          | varchar, unique                  |
| `rate`          | decimal(19, 8) — the fetched one |
| `enabled`       | boolean, default `false`         |
| `useCustomRate` | boolean, default `false`         |
| `customRate`    | decimal(19, 8), nullable         |

A sync only ever writes `rate` and adds new currencies, in one transaction; `enabled` and the custom rate
are yours.

## Limitations

- **The base currency is UAH.** Every source quotes against the hryvnia; a shop priced in another
  currency needs its own source and has to read `rate` accordingly.
- **Rates are global** — one table, not per channel: anyone with `UpdateSettings` in any channel can
  change them.
- **Filtering and sorting on `rate`** use the fetched rate, while the returned `rate` is the effective one.
- **Dashboard 3.7.0–3.7.3 in dev mode** can render a blank page with two or more dashboard extensions
  (for example together with `@uplab/vendure-plugin-unified-slug`). It is a Vendure bug, fixed in 3.7.4
  ([vendure#5459](https://github.com/vendure-ecommerce/vendure/pull/5459)); production builds are fine.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
