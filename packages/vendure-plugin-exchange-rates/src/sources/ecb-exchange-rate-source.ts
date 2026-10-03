import { CurrencyCode } from '@vendure/core';
import { DEFAULT_SOURCE_TIMEOUT } from '../constants';
import { ExchangeRateSource, ExchangeRateSourceResult } from '../types';
import { fetchText, unexpectedBody } from './fetch-body';

export interface EcbExchangeRateSourceOptions {
  /** @default 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml' */
  apiUrl?: string;
  /** @default 10000 */
  timeout?: number;
}

/** `<Cube currency='USD' rate='1.1225'/>`, tolerant of quoting, attribute order and a closing tag. */
const CUBE = /<Cube\b(?=[^>]*\bcurrency=['"]([A-Z]{3})['"])(?=[^>]*\brate=['"]([\d.]+)['"])[^>]*>/g;

/**
 * @description
 * The European Central Bank's euro reference rates: about 30 currencies, published every working day
 * around 16:00 CET. Free, no key. Base EUR.
 */
export class EcbExchangeRateSource implements ExchangeRateSource {
  readonly name = 'ecb';
  private readonly apiUrl: string;
  private readonly timeout: number;

  constructor(options: EcbExchangeRateSourceOptions = {}) {
    this.apiUrl = options.apiUrl ?? 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
    this.timeout = options.timeout ?? DEFAULT_SOURCE_TIMEOUT;
  }

  async fetchRates(): Promise<ExchangeRateSourceResult> {
    const xml = await fetchText(this.name, this.apiUrl, this.timeout);
    // `rate` is "1 EUR = rate units", the inverse of a quote.
    const quotes = [...xml.matchAll(CUBE)].map(([, code, rate]) => ({
      currencyCode: code as CurrencyCode,
      rate: 1 / Number(rate),
    }));
    if (!quotes.length) throw unexpectedBody(this.name);
    return { base: CurrencyCode.EUR, quotes };
  }
}
