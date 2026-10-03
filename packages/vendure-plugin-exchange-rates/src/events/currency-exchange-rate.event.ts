import { RequestContext, VendureEvent } from '@vendure/core';
import { CurrencyExchangeRate } from '../entities/currency-exchange-rate.entity';

/**
 * `synced`: a sync changed something; `entities` are then every rate stored in the current base.
 * `updated`: an admin changed one rate, which is `entities[0]`.
 */
export type CurrencyExchangeRateEventType = 'synced' | 'updated';

/**
 * Published whenever the stored rates change, so the host can drop caches that embed them. It carries
 * `ctx`, so Vendure emits it only after the surrounding transaction commits.
 */
export class CurrencyExchangeRateEvent extends VendureEvent {
  constructor(
    public readonly ctx: RequestContext,
    public readonly entities: CurrencyExchangeRate[],
    public readonly type: CurrencyExchangeRateEventType,
  ) {
    super();
  }
}
