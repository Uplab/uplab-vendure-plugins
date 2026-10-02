import { Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  EventBus,
  ListQueryBuilder,
  ListQueryOptions,
  PaginatedList,
  RequestContext,
  TransactionalConnection,
  UserInputError,
  patchEntity,
} from '@vendure/core';
import { findEffectiveRate } from '../effective-rate';
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

  async findAll(
    ctx: RequestContext,
    options?: ListQueryOptions<CurrencyExchangeRate>,
  ): Promise<PaginatedList<CurrencyExchangeRate>> {
    return this.listQueryBuilder
      .build(CurrencyExchangeRate, options, { ctx })
      .getManyAndCount()
      .then(([items, totalItems]) => ({
        items,
        totalItems,
      }));
  }

  async findOne(ctx: RequestContext, id: string): Promise<CurrencyExchangeRate | null> {
    return this.connection.getRepository(ctx, CurrencyExchangeRate).findOne({ where: { id } });
  }

  /** See {@link findEffectiveRate}. */
  getRate(
    ctx: RequestContext,
    currencyCode: CurrencyCode,
    options: { requireEnabled: boolean },
  ): Promise<number | undefined> {
    return findEffectiveRate(this.connection, ctx, currencyCode, options);
  }

  async update(ctx: RequestContext, input: UpdateCurrencyExchangeRateInput): Promise<CurrencyExchangeRate> {
    if (input.useCustomRate && !(Number(input.customRate) > 0)) {
      throw new UserInputError('A custom rate must be a positive number when useCustomRate is on');
    }
    const entity = await this.connection.getEntityOrThrow(ctx, CurrencyExchangeRate, input.id);
    const updated = patchEntity(entity, input);
    const saved = await this.connection.getRepository(ctx, CurrencyExchangeRate).save(updated);
    // The mutation runs inside a transaction; because the event carries `ctx`, Vendure holds it back
    // until that transaction commits.
    await this.eventBus.publish(new CurrencyExchangeRateEvent(ctx, [saved], 'updated'));
    return saved;
  }
}
