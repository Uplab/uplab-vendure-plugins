import { Inject, Injectable } from '@nestjs/common';
import type { FindOptionsWhere } from 'typeorm';
import {
  ChannelService,
  CurrencyCode,
  EventBus,
  ListQueryBuilder,
  ID,
  ListQueryOptions,
  PaginatedList,
  RequestContext,
  TransactionalConnection,
  UserInputError,
} from '@vendure/core';
import { EXCHANGE_RATES_PLUGIN_OPTIONS, MAX_RATE } from '../constants';
import { round8 } from '../derive-rates';
import { effectiveRate } from '../effective-rate';
import { CurrencyExchangeRate } from '../entities/currency-exchange-rate.entity';
import { CurrencyExchangeRateEvent } from '../events/currency-exchange-rate.event';
import { ResolvedExchangeRatesPluginOptions, UpdateCurrencyExchangeRateInput } from '../types';

@Injectable()
export class CurrencyExchangeRateService {
  constructor(
    @Inject(EXCHANGE_RATES_PLUGIN_OPTIONS) private readonly options: ResolvedExchangeRatesPluginOptions,
    private connection: TransactionalConnection,
    private listQueryBuilder: ListQueryBuilder,
    private eventBus: EventBus,
    private channelService: ChannelService,
  ) {}

  /**
   * The currency every rate is expressed in: the `baseCurrency` option, otherwise the default channel's
   * currency — read on each call, so a change to the channel applies from the next sync.
   */
  async getBaseCurrency(ctx: RequestContext): Promise<CurrencyCode> {
    return this.options.baseCurrency ?? (await this.channelService.getDefaultChannel(ctx)).defaultCurrencyCode;
  }

  /** `where` is applied beneath the list options, so no `filter` or `filterOperator` can widen it. */
  async findAll(
    ctx: RequestContext,
    options?: ListQueryOptions<CurrencyExchangeRate>,
    where?: FindOptionsWhere<CurrencyExchangeRate>,
  ): Promise<PaginatedList<CurrencyExchangeRate>> {
    return this.listQueryBuilder
      .build(CurrencyExchangeRate, options, { ctx, where })
      .getManyAndCount()
      .then(([items, totalItems]) => ({
        items,
        totalItems,
      }));
  }

  async findOne(ctx: RequestContext, id: ID): Promise<CurrencyExchangeRate | null> {
    return this.connection.getRepository(ctx, CurrencyExchangeRate).findOne({ where: { id } });
  }

  /**
   * The {@link effectiveRate} of `currencyCode` — units of the base currency per one unit — or
   * `undefined` when no usable rate in the current base is stored. `requireEnabled` is the caller's policy: whether a currency the admin switched off still
   * counts (`true` for anything a customer is billed in).
   */
  async getRate(
    ctx: RequestContext,
    currencyCode: CurrencyCode,
    { requireEnabled }: { requireEnabled: boolean },
  ): Promise<number | undefined> {
    const row = await this.connection
      .getRepository(ctx, CurrencyExchangeRate)
      .findOne({ where: { code: currencyCode, baseCurrency: await this.getBaseCurrency(ctx) } });
    if (!row || (requireEnabled && !row.enabled)) {
      return undefined;
    }
    return effectiveRate(row);
  }

  async update(ctx: RequestContext, input: UpdateCurrencyExchangeRateInput): Promise<CurrencyExchangeRate> {
    if (input.useCustomRate && input.customRate == null) {
      throw new UserInputError('A custom rate must be a positive number when useCustomRate is on');
    }
    // Stored with 8 decimals: anything that rounds to 0 there would silently stop being a rate.
    const customRate = input.customRate == null ? input.customRate : round8(input.customRate);
    if (customRate != null && !(Number.isFinite(customRate) && customRate > 0 && customRate < MAX_RATE)) {
      throw new UserInputError('A custom rate must be between 0.00000001 and 100000000000');
    }
    await this.connection.getEntityOrThrow(ctx, CurrencyExchangeRate, input.id);
    const repository = this.connection.getRepository(ctx, CurrencyExchangeRate);
    // Only the admin's columns: a sync committed meanwhile keeps its rate and base.
    const changes = Object.fromEntries(
      Object.entries({ enabled: input.enabled, useCustomRate: input.useCustomRate, customRate }).filter(
        ([, value]) => value !== undefined,
      ),
    );
    if (Object.keys(changes).length) {
      await repository.update({ id: input.id }, changes);
    }
    const saved = await this.connection.getEntityOrThrow(ctx, CurrencyExchangeRate, input.id);
    await this.eventBus.publish(new CurrencyExchangeRateEvent(ctx, [saved], 'updated'));
    return saved;
  }
}
