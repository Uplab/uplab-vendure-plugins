import { Inject, Injectable } from '@nestjs/common';
import { CurrencyCode, EventBus, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { CURRENCY_EXCHANGE_RATE_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { CurrencyExchangeRate } from '../entities/currency-exchange-rate.entity';
import { CurrencyExchangeRateEvent } from '../events/currency-exchange-rate.event';
import { ExchangeRateQuote, ResolvedCurrencyExchangeRatePluginOptions } from '../types';

const vendureCurrencyCodes = new Set<string>(Object.values(CurrencyCode));

function isUsable(quote: ExchangeRateQuote): boolean {
  return vendureCurrencyCodes.has(quote.currencyCode) && Number.isFinite(quote.rate) && quote.rate > 0;
}

/**
 * @description
 * Pulls rates from the configured {@link ExchangeRateSource} into the `CurrencyExchangeRate` table.
 * A fetched rate only ever replaces `rate`: whether a currency is enabled and its custom rate stay as
 * the admin left them. New currencies arrive disabled.
 */
@Injectable()
export class CurrencyExchangeRateSyncService {
  constructor(
    @Inject(CURRENCY_EXCHANGE_RATE_PLUGIN_OPTIONS) private readonly options: ResolvedCurrencyExchangeRatePluginOptions,
    private readonly connection: TransactionalConnection,
    private readonly eventBus: EventBus,
  ) {}

  /** Throws when the source cannot be read; the stored rates are then left as they were. */
  async syncRates(ctx: RequestContext): Promise<CurrencyExchangeRate[]> {
    const { source } = this.options;
    const quotes = await source.fetchRates(ctx);
    const usable = quotes.filter(isUsable);
    if (usable.length < quotes.length) {
      Logger.verbose(`Dropped ${quotes.length - usable.length} ${source.name} rates that are not usable`, loggerCtx);
    }
    if (!usable.length) {
      Logger.warn(`${source.name} returned no usable rates; keeping the stored ones`, loggerCtx);
      return [];
    }

    const repository = this.connection.getRepository(ctx, CurrencyExchangeRate);
    const stored = await repository.find();
    const persisted = await repository.save(
      usable.map(({ currencyCode, rate }) => {
        const existing = stored.find((r) => r.code === currencyCode);
        return existing ? Object.assign(existing, { rate }) : new CurrencyExchangeRate({ code: currencyCode, rate });
      }),
    );
    // Lets the host drop anything that embeds the old rates, such as a cached Shop API response.
    await this.eventBus.publish(new CurrencyExchangeRateEvent(ctx, persisted, 'synced'));
    return persisted;
  }

  /** Fills an empty table, e.g. on the first boot. Never throws: a source outage must not stop the server. */
  async backfillIfEmpty(ctx: RequestContext): Promise<void> {
    if ((await this.connection.getRepository(ctx, CurrencyExchangeRate).count()) > 0) {
      return;
    }
    try {
      const persisted = await this.syncRates(ctx);
      Logger.info(`Loaded ${persisted.length} exchange rates from ${this.options.source.name}`, loggerCtx);
    } catch (e) {
      Logger.error(`Could not load the initial exchange rates: ${(e as Error).message}`, loggerCtx);
    }
  }
}
