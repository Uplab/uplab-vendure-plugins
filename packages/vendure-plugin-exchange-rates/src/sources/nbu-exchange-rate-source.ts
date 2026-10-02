import { CurrencyCode } from '@vendure/core';
import { DEFAULT_SOURCE_TIMEOUT } from '../constants';
import { ExchangeRateSource, ExchangeRateSourceResult } from '../types';
import { fetchJsonArray } from './fetch-body';

/** A row of the NBU JSON endpoint: `rate` hryvnias per one unit of `cc`. */
interface NbuRate {
  cc: string;
  rate: number;
}

export interface NbuExchangeRateSourceOptions {
  /** @default 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json' */
  apiUrl?: string;
  /** @default 10000 */
  timeout?: number;
}

/**
 * @description
 * The National Bank of Ukraine's official rates, set once per business day. The list also carries
 * metals and the SDR, which are dropped because they are not Vendure currencies.
 */
export class NbuExchangeRateSource implements ExchangeRateSource {
  readonly name = 'nbu';
  private readonly apiUrl: string;
  private readonly timeout: number;

  constructor(options: NbuExchangeRateSourceOptions = {}) {
    this.apiUrl = options.apiUrl ?? 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json';
    this.timeout = options.timeout ?? DEFAULT_SOURCE_TIMEOUT;
  }

  async fetchRates(): Promise<ExchangeRateSourceResult> {
    const rows = await fetchJsonArray<NbuRate>(this.name, this.apiUrl, this.timeout);
    const quotes = rows.map((row) => ({ currencyCode: row.cc as CurrencyCode, rate: row.rate }));
    return { base: CurrencyCode.UAH, quotes };
  }
}
