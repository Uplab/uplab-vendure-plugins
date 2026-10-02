# @uplab/vendure-plugin-nova-poshta

[![npm](https://img.shields.io/npm/v/@uplab/vendure-plugin-nova-poshta.svg)](https://www.npmjs.com/package/@uplab/vendure-plugin-nova-poshta)
[![Vendure](https://img.shields.io/badge/Vendure-%5E3.7.0-17c9ff.svg)](https://www.vendure.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/Uplab/uplab-vendure-plugins/blob/main/LICENSE)

Feed your checkout's delivery pickers from [Nova Poshta](https://novaposhta.ua/): cities and warehouses
in Ukraine, and cities and warehouses abroad. The plugin adds four Shop API queries, picks the warehouse
types customers may choose per country, and keeps Nova Poshta's country refs on your `Country` entities.

Every query is a live request to Nova Poshta: nothing is cached or stored besides the country refs. The
client is built on the global `fetch`, so the plugin has no runtime dependencies besides `graphql-tag`.

Compatible with **Vendure ^3.7.0**.

## Contents

[Install](#install) · [Usage](#usage) · [Options](#options) · [Database](#database) ·
[Shop API](#shop-api) · [Delivering abroad](#delivering-abroad) · [Admin API](#admin-api) ·
[API key per request](#api-key-per-request) · [Calling other methods](#calling-other-methods) ·
[Errors](#errors) · [Limitations](#limitations)

## Install

```bash
npm install @uplab/vendure-plugin-nova-poshta
# or
pnpm add @uplab/vendure-plugin-nova-poshta
```

## Usage

```ts
import { DefaultSchedulerPlugin, VendureConfig } from '@vendure/core';
import { NovaPoshtaPlugin } from '@uplab/vendure-plugin-nova-poshta';

export const config: VendureConfig = {
  // ...
  plugins: [
    DefaultSchedulerPlugin.init(), // runs the daily country sync
    NovaPoshtaPlugin.init({ apiKey: process.env.NOVA_POSHTA_API_KEY! }),
  ],
};
```

Get the key in your Nova Poshta business account: _Settings → Security → API key_.

## Options

| Option        | Type                                                                 | Default                                  | Description                                                                                                        |
| ------------- | -------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apiKey`      | `string \| NovaPoshtaApiKeyStrategy`                                 | —                                        | The key, or a strategy that resolves it per request: see [API key per request](#api-key-per-request).              |
| `apiUrl`      | `string`                                                             | `'https://api.novaposhta.ua/v2.0/json/'` | Nova Poshta's JSON endpoint.                                                                                       |
| `timeout`     | `number`                                                             | `10000`                                  | Milliseconds before a request is aborted.                                                                          |
| `countrySync` | `{ schedule?: string \| (cron: CronExpression) => string } \| false` | `{ schedule: '0 7 * * *' }`              | The daily task that syncs country refs. Needs a scheduler plugin. `false` leaves the task out; the mutation stays. |

## Database

The plugin adds two `Region` custom fields and no tables. Generate a migration after installing it:

| Custom field                    | Type                               | Public | Written by       |
| ------------------------------- | ---------------------------------- | ------ | ---------------- |
| `novaPoshtaCountryRef`          | `string`, nullable, read-only      | yes    | the country sync |
| `novaPoshtaWarehouseCategories` | `string` list, one of four options | no     | an admin         |

Custom fields on `Region` apply to provinces too; the plugin reads them on countries only.

## Shop API

```graphql
novaPoshtaCities(input: { term: String!, limit: Int! }): [NovaPoshtaCity!]!            # { Ref, Description }
novaPoshtaWarehouses(input: { cityId: String!, term: String, limit: Int }): [NovaPoshtaWarehouse!]!  # { Ref, Description }
novaPoshtaInternationalCities(input: { term: String!, country: String!, limit: Int! }): [NovaPoshtaInternationalCity!]!  # { City }
novaPoshtaInternationalWarehouses(input: { city: String!, country: String!, limit: Int }): [NovaPoshtaInternationalWarehouse!]!  # { WarehouseRef, FullDescription }
```

The queries are public, like the rest of checkout. `cityId` is the `Ref` of a city from `novaPoshtaCities`.
Typographic apostrophes in `term` (`Кам’янське`) are replaced with the plain one Nova Poshta matches.

A typical domestic picker:

```graphql
query {
  novaPoshtaCities(input: { term: "Київ", limit: 10 }) {
    Ref
    Description
  }
}
```

then `novaPoshtaWarehouses(input: { cityId: "<Ref>", term: "5" })` as the customer types the branch.

## Delivering abroad

Nova Poshta identifies a country by its own `Ref`, not by ISO code. The country sync reads
`International.getCountries` and writes that ref into `customFields.novaPoshtaCountryRef` of every Vendure
country whose ISO code matches. Clients read it from `availableCountries` and pass it as `country`:

```graphql
query {
  availableCountries {
    code
    customFields {
      novaPoshtaCountryRef
    }
  }
}
```

Countries without a ref are the ones Nova Poshta does not deliver to.

### Warehouse types per country

On the country page in the dashboard, _Nova Poshta: warehouse types_ chooses which types
`novaPoshtaInternationalWarehouses` returns there. Empty means all of them.

| Value         | Meaning                                   | Warsaw, 2026-09-30 |
| ------------- | ----------------------------------------- | ------------------ |
| `PostBranch`  | Nova Post's own post branches             | 21                 |
| `CargoBranch` | Nova Post's cargo branches and fulfilment | 2                  |
| `PUDO`        | Partner pick-up points                    | 242                |
| `Poshtomat`   | Parcel lockers                            | 2106               |

These are the values of the `WarehouseCategory` filter of `International.getWarehouses`, which Nova Poshta
does not document publicly. Checked against the live API on 2026-09-30:

- The four values cover the whole list: their counts add up to the unfiltered total.
- The filter takes **one value per request**, and the response does not say a warehouse's type. So each
  selected type is a request of its own, run in parallel; the results are merged in the order the types
  are stored and capped at `limit`.

## Admin API

```graphql
mutation {
  novaPoshtaSyncCountries {
    matched # Vendure countries Nova Poshta knows
    updated # of those, the ones whose ref changed
  }
}
```

Runs the country sync now. Requires `UpdateCountry`. Run it once after installing the plugin, or wait for
the daily task.

## API key per request

To keep the key in the database or use a key per channel, pass a strategy instead of a string. The plugin
calls its `init(injector)` on bootstrap and `destroy()` on shutdown.

```ts
import { Injector, RequestContext, TransactionalConnection } from '@vendure/core';
import { NovaPoshtaApiKeyStrategy } from '@uplab/vendure-plugin-nova-poshta';

class DbApiKeyStrategy implements NovaPoshtaApiKeyStrategy {
  private connection: TransactionalConnection;

  init(injector: Injector) {
    this.connection = injector.get(TransactionalConnection);
  }

  async getApiKey(ctx: RequestContext) {
    const settings = await this.connection.getRepository(ctx, MySettings).findOneBy({});
    return settings?.novaPoshtaApiKey;
  }
}

NovaPoshtaPlugin.init({ apiKey: new DbApiKeyStrategy() });
```

## Calling other methods

`NovaPoshtaClient` is exported and calls any method of the Nova Poshta API with the resolved key: creating a
waybill, tracking a parcel.

```ts
const statuses = await novaPoshtaClient.request(ctx, 'TrackingDocument', 'getStatusDocuments', {
  Documents: [{ DocumentNumber: '20450000000000' }],
});
```

`NovaPoshtaService` is exported as well, for the lookups above.

## Errors

Every failure throws a `NovaPoshtaError`:

- no API key;
- a network error or timeout;
- a non-2xx status, in `status`;
- an answer with `success: false`, with Nova Poshta's `errors` and `errorCodes`.

In the Shop API it surfaces as a GraphQL error.

## Limitations

- **Your API quota.** The Shop queries are public and uncached, so every keystroke of a picker is a request
  on your key. Debounce on the client.
- **The country page of the Vendure dashboard up to 3.7.3** shows no custom fields, so it does not show the
  warehouse types. [vendure#5449](https://github.com/vendure-ecommerce/vendure/pull/5449) fixes it for the next
  release; until then set them through `updateCountry` in the Admin API.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
