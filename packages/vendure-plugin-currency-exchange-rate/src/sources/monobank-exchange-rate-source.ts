import { CurrencyCode } from '@vendure/core';
import currencyCodes from 'currency-codes';
import { DEFAULT_SOURCE_TIMEOUT } from '../constants';
import { ExchangeRateQuote, ExchangeRateSource } from '../types';
import { fetchJsonArray } from './fetch-json';

const UAH_NUMERIC_CODE = 980;

/** A pair of Monobank's public endpoint: numeric ISO codes, and either buy/sell or a cross rate. */
interface MonobankPair {
  currencyCodeA: number;
  currencyCodeB: number;
  rateBuy?: number;
  rateSell?: number;
  rateCross?: number;
}

export interface MonobankExchangeRateSourceOptions {
  /** @default 'https://api.monobank.ua/bank/currency' */
  apiUrl?: string;
  /** @default 10000 */
  timeout?: number;
  /**
   * Which of Monobank's rates to store: `'buy'` is what the bank pays for the currency (the lower),
   * `'sell'` what it charges, `'mid'` their average. Pairs quoted only as a cross rate use that.
   *
   * @default 'buy'
   */
  side?: 'buy' | 'sell' | 'mid';
}

/**
 * @description
 * Monobank's public, unauthenticated rates — the bank's own buy/sell rates, refreshed through the day.
 * Monobank caches the endpoint for 5 minutes and rate-limits it.
 */
export class MonobankExchangeRateSource implements ExchangeRateSource {
  readonly name = 'monobank';
  private readonly apiUrl: string;
  private readonly timeout: number;
  private readonly side: 'buy' | 'sell' | 'mid';

  constructor(options: MonobankExchangeRateSourceOptions = {}) {
    this.apiUrl = options.apiUrl ?? 'https://api.monobank.ua/bank/currency';
    this.timeout = options.timeout ?? DEFAULT_SOURCE_TIMEOUT;
    this.side = options.side ?? 'buy';
  }

  async fetchRates(): Promise<ExchangeRateQuote[]> {
    const pairs = await fetchJsonArray<MonobankPair>(this.name, this.apiUrl, this.timeout);
    return pairs.flatMap((pair) => {
      const currencyCode = currencyCodes.number(String(pair.currencyCodeA))?.code;
      if (pair.currencyCodeB !== UAH_NUMERIC_CODE || !currencyCode) {
        return [];
      }
      return [{ currencyCode: currencyCode as CurrencyCode, rate: this.pick(pair) }];
    });
  }

  private pick({ rateBuy, rateSell, rateCross }: MonobankPair): number {
    if (rateBuy === undefined || rateSell === undefined) return rateCross ?? NaN;
    if (this.side === 'sell') return rateSell;
    if (this.side === 'mid') return (rateBuy + rateSell) / 2;
    return rateBuy;
  }
}
