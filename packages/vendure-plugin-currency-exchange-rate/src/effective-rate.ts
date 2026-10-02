import { CurrencyCode, RequestContext, TransactionalConnection } from '@vendure/core';
import { CurrencyExchangeRate } from './entities/currency-exchange-rate.entity';

/**
 * @description
 * The rate prices are converted with: the admin's custom rate when it is switched on, otherwise the
 * fetched one. Postgres returns decimal columns as strings, hence the `Number()`.
 */
export function effectiveRate(rate: Pick<CurrencyExchangeRate, 'rate' | 'useCustomRate' | 'customRate'>): number {
  return Number(rate.useCustomRate ? rate.customRate : rate.rate);
}

/**
 * @description
 * The {@link effectiveRate} of `currencyCode` — UAH per one unit — or `undefined` when no usable rate
 * is stored. `requireEnabled` is the caller's policy: whether a currency the admin switched off may
 * still be converted with.
 */
export async function findEffectiveRate(
  connection: TransactionalConnection,
  ctx: RequestContext,
  currencyCode: CurrencyCode,
  { requireEnabled }: { requireEnabled: boolean },
): Promise<number | undefined> {
  const row = await connection.getRepository(ctx, CurrencyExchangeRate).findOne({ where: { code: currencyCode } });
  if (!row || (requireEnabled && !row.enabled)) {
    return undefined;
  }
  const rate = effectiveRate(row);
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}
