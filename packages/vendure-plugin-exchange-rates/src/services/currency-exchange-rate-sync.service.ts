import { Inject, Injectable } from '@nestjs/common';
import { CurrencyCode, EventBus, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { IsNull, Not, Repository } from 'typeorm';
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
 * A row without a base predates the `baseCurrency` column. Its rates are in the base the shop used then,
 * taken to be the current one, so it keeps its custom rate. "Without" is NULL, or `''` where MySQL filled
 * a NOT NULL column added to a filled table. Returns how many rows it adopted.
 */
async function adoptRowsWithoutBase(
  repository: Repository<CurrencyExchangeRate>,
  baseCurrency: CurrencyCode,
): Promise<number> {
  let adopted = 0;
  for (const missing of [IsNull(), '' as CurrencyCode]) {
    adopted += (await repository.update({ baseCurrency: missing }, { baseCurrency })).affected ?? 0;
  }
  if (adopted) {
    Logger.info(`Took ${adopted} stored rates without a base currency to be in ${baseCurrency}`, loggerCtx);
  }
  return adopted;
}

/**
 * @description
 * Pulls rates from the configured {@link ExchangeRateSource} into the `CurrencyExchangeRate` table,
 * re-based onto the shop's base currency. A fetched rate only replaces `rate`: whether a currency is
 * enabled and its custom rate stay as the admin left them, unless the base changed. New currencies arrive
 * disabled.
 */
@Injectable()
export class CurrencyExchangeRateSyncService {
  constructor(
    @Inject(EXCHANGE_RATES_PLUGIN_OPTIONS) private readonly options: ResolvedExchangeRatesPluginOptions,
    private readonly connection: TransactionalConnection,
    private readonly eventBus: EventBus,
    private readonly rateService: CurrencyExchangeRateService,
  ) {}

  /**
   * Returns every rate stored in the current base afterwards, and publishes a `synced` event with them when
   * anything changed — or `[]` when the source returned nothing usable, the stored rates left untouched. Throws when the source cannot be read or cannot be re-based; the stored rates are then
   * left as they were.
   */
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
    const { rows, changed } = await this.connection.withTransaction(ctx, async (txCtx) => {
      const repository = this.connection.getRepository(txCtx, CurrencyExchangeRate);
      const adopted = await adoptRowsWithoutBase(repository, baseCurrency);
      const stored = await repository.find();
      const storedByCode = new Map(stored.map((r) => [r.code, r]));
      const rebased: string[] = [];
      const created: CurrencyExchangeRate[] = [];
      let updated = 0;
      for (const { currencyCode, rate } of derived) {
        const existing = storedByCode.get(currencyCode);
        if (!existing) {
          created.push(new CurrencyExchangeRate({ code: currencyCode, baseCurrency, rate }));
          continue;
        }
        let changes: Partial<Pick<CurrencyExchangeRate, 'baseCurrency' | 'rate' | 'useCustomRate' | 'customRate'>> = {};
        if (existing.baseCurrency !== baseCurrency) {
          // A custom rate in the old base means nothing in the new one.
          changes = { baseCurrency, rate, useCustomRate: false, customRate: null };
          rebased.push(currencyCode);
        } else if (existing.rate !== rate) {
          changes = { rate };
        }
        // Only the columns the sync owns, and only when they change: an admin edit made meanwhile stays.
        if (Object.keys(changes).length) {
          await repository.update({ id: existing.id }, changes);
          updated++;
        }
      }
      await repository.save(created);
      // Rows the new base did not re-quote, the old row for the new base currency itself among them.
      await repository.delete({ baseCurrency: Not(baseCurrency) });
      if (rebased.length) {
        Logger.warn(`Rates are now in ${baseCurrency}: dropped the custom rates of ${rebased.join(', ')}`, loggerCtx);
      }
      const quoted = new Set<string>(derived.map((q) => q.currencyCode));
      const dropped = stored.filter((r) => r.enabled && r.baseCurrency === baseCurrency && !quoted.has(r.code));
      if (dropped.length) {
        const codes = dropped.map((r) => r.code).join(', ');
        Logger.warn(`${source.name} no longer quotes ${codes}; they keep their last rate`, loggerCtx);
      }
      const deleted = stored.some((r) => r.baseCurrency !== baseCurrency);
      return {
        // Read back, so `updatedAt` and the rest are what the database now holds.
        rows: await repository.find({ where: { baseCurrency }, order: { code: 'ASC' } }),
        changed: adopted > 0 || created.length > 0 || updated > 0 || deleted,
      };
    });
    Logger.verbose(`Synced ${rows.length} rates in ${baseCurrency} from ${source.name} (base ${base})`, loggerCtx);
    if (changed) {
      await this.eventBus.publish(new CurrencyExchangeRateEvent(ctx, rows, 'synced'));
    }
    return rows;
  }

  /**
   * Gives rows from before the `baseCurrency` column the current base, then syncs when no rate is stored in
   * it: on the first boot, and after a restart that changed the base. Never throws: neither a source outage
   * nor a database hiccup may stop the server.
   */
  async backfillIfEmpty(ctx: RequestContext): Promise<void> {
    let baseCurrency: CurrencyCode;
    try {
      baseCurrency = await this.rateService.getBaseCurrency(ctx);
      const repository = this.connection.getRepository(ctx, CurrencyExchangeRate);
      if (await adoptRowsWithoutBase(repository, baseCurrency)) {
        // They just became visible on the Shop API: let caches of its earlier, emptier answer go.
        const rows = await repository.find({ where: { baseCurrency }, order: { code: 'ASC' } });
        await this.eventBus.publish(new CurrencyExchangeRateEvent(ctx, rows, 'synced'));
      }
      if ((await repository.count({ where: { baseCurrency } })) > 0) {
        return;
      }
    } catch (e) {
      Logger.warn(`Could not check the stored exchange rates: ${(e as Error).message}`, loggerCtx);
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
