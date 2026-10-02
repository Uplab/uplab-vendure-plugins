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
  patchEntity,
} from '@vendure/core';
import { EXCHANGE_RATES_PLUGIN_OPTIONS, MAX_RATE } from '../constants';
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
    if (
      input.customRate != null &&
      !(Number.isFinite(input.customRate) && input.customRate > 0 && input.customRate < MAX_RATE)
    ) {
      throw new UserInputError('A custom rate must be a positive number below 100000000000');
    }
    const entity = await this.connection.getEntityOrThrow(ctx, CurrencyExchangeRate, input.id);
    const updated = patchEntity(entity, input);
    const saved = await this.connection.getRepository(ctx, CurrencyExchangeRate).save(updated);
    await this.eventBus.publish(new CurrencyExchangeRateEvent(ctx, [saved], 'updated'));
    return saved;
  }
}
