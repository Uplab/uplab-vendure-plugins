import { Inject, Injectable } from '@nestjs/common';
import { CurrencyCode, EventBus, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { Not } from 'typeorm';
import { CurrencyExchangeRateService } from './currency-exchange-rate.service';
import { EXCHANGE_RATES_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { deriveRates } from '../derive-rates';
import { CurrencyExchangeRate } from '../entities/currency-exchange-rate.entity';
import { CurrencyExchangeRateEvent } from '../events/currency-exchange-rate.event';
import { ExchangeRateQuote, ResolvedExchangeRatesPluginOptions } from '../types';

const vendureCurrencyCodes = new Set<string>(Object.values(CurrencyCode));

function isUsable(quote: ExchangeRateQuote): boolean {
  return vendureCurrencyCodes.has(quote.currencyCode) && Number.isFinite(quote.rate) && quote.rate > 0;
}

/** One quote per code: the last one wins, so a combining source can override another. */
function lastPerCode(quotes: ExchangeRateQuote[]): ExchangeRateQuote[] {
  return [...new Map(quotes.map((q) => [q.currencyCode, q]))].map(([, q]) => q);
}

/**
 * @description
 * Pulls rates from the configured {@link ExchangeRateSource} into the `CurrencyExchangeRate` table,
 * re-based onto the shop's base currency. A fetched rate only replaces `rate`: whether a currency is
 * enabled and its custom rate stay as the admin left them. New currencies arrive disabled.
 */
@Injectable()
export class CurrencyExchangeRateSyncService {
  constructor(
    @Inject(EXCHANGE_RATES_PLUGIN_OPTIONS) private readonly options: ResolvedExchangeRatesPluginOptions,
    private readonly connection: TransactionalConnection,
    private readonly eventBus: EventBus,
    private readonly rateService: CurrencyExchangeRateService,
  ) {}

  /** Throws when the source cannot be read or cannot be re-based; the stored rates are then left as they were. */
  async syncRates(ctx: RequestContext): Promise<CurrencyExchangeRate[]> {
    const { source } = this.options;
    const baseCurrency = await this.rateService.getBaseCurrency(ctx);
    const { base, quotes } = await source.fetchRates(ctx);
    const usable = lastPerCode(quotes.filter(isUsable));
    if (usable.length < quotes.length) {
      Logger.verbose(`Dropped ${quotes.length - usable.length} ${source.name} rates that are not usable`, loggerCtx);
    }
    const derived = usable.length ? deriveRates(source.name, baseCurrency, base, usable) : [];
    if (!derived.length) {
      Logger.warn(`${source.name} returned no usable rates; keeping the stored ones`, loggerCtx);
      return [];
    }

    // One transaction: a failure part-way leaves every rate as it was, not half of them refreshed.
    const persisted = await this.connection.withTransaction(ctx, async (txCtx) => {
      const repository = this.connection.getRepository(txCtx, CurrencyExchangeRate);
      const stored = await repository.find();
      const rebased: string[] = [];
      const saved = await repository.save(
        derived.map(({ currencyCode, rate }) => {
          const existing = stored.find((r) => r.code === currencyCode);
          if (!existing) {
            return new CurrencyExchangeRate({ code: currencyCode, baseCurrency, rate });
          }
          if (existing.baseCurrency !== baseCurrency) {
            // A custom rate in the old base means nothing in the new one.
            rebased.push(currencyCode);
            return Object.assign(existing, { baseCurrency, rate, useCustomRate: false, customRate: null });
          }
          return Object.assign(existing, { rate });
        }),
      );
      // Rows the new base did not re-quote, the old row for the new base currency itself among them.
      await repository.delete({ baseCurrency: Not(baseCurrency) });
      if (rebased.length) {
        Logger.warn(`Rates are now in ${baseCurrency}: dropped the custom rates of ${rebased.join(', ')}`, loggerCtx);
      }
      return saved;
    });
    Logger.verbose(`Stored ${persisted.length} rates in ${baseCurrency} from ${source.name} (base ${base})`, loggerCtx);
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
      // Also what a second instance booting at the same time sees: the first one already inserted them.
      Logger.warn(`Could not load the initial exchange rates: ${(e as Error).message}`, loggerCtx);
    }
  }
}
