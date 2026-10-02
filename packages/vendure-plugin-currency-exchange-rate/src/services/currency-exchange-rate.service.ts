import { Injectable } from '@nestjs/common';
import type { FindOptionsWhere } from 'typeorm';
import {
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
import { effectiveRate } from '../effective-rate';
import { CurrencyExchangeRate } from '../entities/currency-exchange-rate.entity';
import { CurrencyExchangeRateEvent } from '../events/currency-exchange-rate.event';
import { UpdateCurrencyExchangeRateInput } from '../types';

@Injectable()
export class CurrencyExchangeRateService {
  constructor(
    private connection: TransactionalConnection,
    private listQueryBuilder: ListQueryBuilder,
    private eventBus: EventBus,
  ) {}

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
   * The {@link effectiveRate} of `currencyCode` — UAH per one unit — or `undefined` when no usable rate
   * is stored. `requireEnabled` is the caller's policy: whether a currency the admin switched off still
   * counts (`true` for anything a customer is billed in).
   */
  async getRate(
    ctx: RequestContext,
    currencyCode: CurrencyCode,
    { requireEnabled }: { requireEnabled: boolean },
  ): Promise<number | undefined> {
    const row = await this.connection
      .getRepository(ctx, CurrencyExchangeRate)
      .findOne({ where: { code: currencyCode } });
    if (!row || (requireEnabled && !row.enabled)) {
      return undefined;
    }
    const rate = effectiveRate(row);
    return Number.isFinite(rate) && rate > 0 ? rate : undefined;
  }

  async update(ctx: RequestContext, input: UpdateCurrencyExchangeRateInput): Promise<CurrencyExchangeRate> {
    if (input.useCustomRate && !(Number(input.customRate) > 0)) {
      throw new UserInputError('A custom rate must be a positive number when useCustomRate is on');
    }
    const entity = await this.connection.getEntityOrThrow(ctx, CurrencyExchangeRate, input.id);
    const updated = patchEntity(entity, input);
    const saved = await this.connection.getRepository(ctx, CurrencyExchangeRate).save(updated);
    await this.eventBus.publish(new CurrencyExchangeRateEvent(ctx, [saved], 'updated'));
    return saved;
  }
}
