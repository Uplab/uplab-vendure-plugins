import { CurrencyCode } from '@vendure/core';
import { DEFAULT_SOURCE_TIMEOUT } from '../constants';
import { ExchangeRateSource, ExchangeRateSourceResult } from '../types';
import { fetchJsonObject, unexpectedBody } from './fetch-body';

export interface FrankfurterExchangeRateSourceOptions {
  /** @default 'https://api.frankfurter.dev/v1/latest' */
  apiUrl?: string;
  /** @default 10000 */
  timeout?: number;
  /** The base to ask for. The plugin re-bases either way; this only saves it a division. @default EUR */
  base?: CurrencyCode;
}

interface FrankfurterBody {
  amount?: number;
  base?: unknown;
  rates?: Record<string, number>;
}

/**
 * @description
 * [Frankfurter](https://frankfurter.dev): the ECB reference rates as JSON, in any of its currencies as
 * the base. Free, no key; can be self-hosted (`apiUrl`).
 */
export class FrankfurterExchangeRateSource implements ExchangeRateSource {
  readonly name = 'frankfurter';
  private readonly url: string;
  private readonly timeout: number;

  constructor(options: FrankfurterExchangeRateSourceOptions = {}) {
    const apiUrl = options.apiUrl ?? 'https://api.frankfurter.dev/v1/latest';
    this.url = options.base ? `${apiUrl}?base=${options.base}` : apiUrl;
    this.timeout = options.timeout ?? DEFAULT_SOURCE_TIMEOUT;
  }

  async fetchRates(): Promise<ExchangeRateSourceResult> {
    const body = await fetchJsonObject<FrankfurterBody>(this.name, this.url, this.timeout);
    if (typeof body.base !== 'string' || !/^[A-Z]{3}$/.test(body.base) || !body.rates) {
      throw unexpectedBody(this.name);
    }
    const amount = body.amount ?? 1;
    // `rates[c]` is "amount base = rates[c] c", the inverse of a quote.
    const quotes = Object.entries(body.rates).map(([code, rate]) => ({
      currencyCode: code as CurrencyCode,
      rate: amount / rate,
    }));
    return { base: body.base as CurrencyCode, quotes };
  }
}
