import { Inject, Injectable } from '@nestjs/common';
import {
  AdministratorService,
  ID,
  Logger,
  ProcessContext,
  RequestContext,
  TransactionalConnection,
  VendureEvent,
} from '@vendure/core';
import { randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';
import { sessionAdministratorResolver, unknownSystemResolver } from '../actors/built-in-resolvers';
import { Lru } from '../capture/lru';
import { CHANGE_HISTORY_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { LoadedState } from '../entity-definitions/entity-definition';
import {
  ChangeHistoryActorResolver,
  ChangeHistoryBatchInput,
  ResolvedActor,
  ResolvedChangeHistoryPluginOptions,
} from '../types';

const CHANGE_HISTORY_STATE = Symbol('changeHistoryState');

/** Caps of the per-transaction maps: a long bulk operation must not grow them without bound. */
export const LAST_SEEN_CAPACITY = 500;
const ENTRIES_CAPACITY = 10_000;

interface BatchState extends ChangeHistoryBatchInput {
  /** `<kind>:<uuid>`. */
  id: string;
  /** The head entry is written lazily, together with the first member. */
  headWritten: boolean;
}

/**
 * What one database transaction has recorded so far: the derived rule (`entriesByEntity`), the variants
 * created in it (their initial stock is not an adjustment) and the last state of every entity it saved
 * (`lastSeen`: the "before" of a second save of the same entity in the same transaction).
 */
export interface TransactionState {
  /** `'Type:id'` → id of the latest entry written for it. */
  entriesByEntity: Lru<string, ID>;
  createdIds: Lru<string, true>;
  lastSeen: Lru<string, LoadedState>;
}

/** Per-request state, attached to the RequestContext. */
export interface ChangeHistoryState {
  correlationId: string;
  actor?: ResolvedActor;
  batch?: BatchState;
  /** Keyed by the transaction's query runner. */
  transactions: WeakMap<QueryRunner, TransactionState>;
}

function newTransactionState(): TransactionState {
  return {
    entriesByEntity: new Lru(ENTRIES_CAPACITY),
    createdIds: new Lru(ENTRIES_CAPACITY),
    lastSeen: new Lru(LAST_SEEN_CAPACITY),
  };
}

/**
 * Per-request state and actor resolution. The state lives on the RequestContext under a symbol key, which
 * `RequestContext.copy()` carries over — so it survives the context copies of `withTransaction`. What
 * belongs to one transaction (derived links, `lastSeen`) is kept per transaction inside it.
 */
@Injectable()
export class ChangeHistoryContextService {
  /** The built-in links after the host's resolvers (Chain of responsibility). */
  private readonly session: ChangeHistoryActorResolver;
  private readonly unknown: ChangeHistoryActorResolver;

  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    administratorService: AdministratorService,
    processContext: ProcessContext,
    private readonly connection: TransactionalConnection,
  ) {
    this.session = sessionAdministratorResolver(administratorService);
    this.unknown = unknownSystemResolver(processContext);
  }

  stateOf(ctx: RequestContext): ChangeHistoryState {
    const holder = ctx as unknown as Record<symbol, ChangeHistoryState | undefined>;
    let state = holder[CHANGE_HISTORY_STATE];
    if (!state) {
      state = { correlationId: randomUUID(), transactions: new WeakMap() };
      holder[CHANGE_HISTORY_STATE] = state;
    }
    return state;
  }

  /** The open transaction of `ctx`, if any. */
  transactionOf(ctx: RequestContext): QueryRunner | undefined {
    const queryRunner = this.connection.getRepository(ctx, ChangeHistoryEntry).manager.queryRunner;
    return queryRunner && !queryRunner.isReleased && queryRunner.isTransactionActive ? queryRunner : undefined;
  }

  /** The state of the transaction `ctx` runs in; a throw-away one outside a transaction. */
  transactionStateOf(ctx: RequestContext): TransactionState {
    const queryRunner = this.transactionOf(ctx);
    if (!queryRunner) {
      return newTransactionState();
    }
    const { transactions } = this.stateOf(ctx);
    let state = transactions.get(queryRunner);
    if (!state) {
      state = newTransactionState();
      transactions.set(queryRunner, state);
    }
    return state;
  }

  /**
   * The chain: a `runBatch` actor override → the host's resolvers → the session's administrator (or the
   * owner of the API key) → an unknown system actor. Resolved once per request (the override excepted).
   */
  async resolveActor(ctx: RequestContext, event?: VendureEvent): Promise<ResolvedActor> {
    const state = this.stateOf(ctx);
    if (state.batch?.actor) {
      return state.batch.actor;
    }
    if (!state.actor) {
      state.actor = await this.resolveUncached(ctx, event);
    }
    return state.actor;
  }

  private async resolveUncached(ctx: RequestContext, event?: VendureEvent): Promise<ResolvedActor> {
    for (const resolver of this.options.actorResolvers) {
      try {
        const actor = await resolver.resolve(ctx, event);
        if (actor) {
          return actor;
        }
      } catch (e) {
        Logger.warn(`[ChangeHistory] actor resolver "${resolver.name}" failed: ${(e as Error).message}`, loggerCtx);
      }
    }
    // A failing built-in lookup fails the write instead of attributing the change to an unknown actor.
    return (await this.session.resolve(ctx, event)) ?? (this.unknown.resolve(ctx, event) as ResolvedActor);
  }
}
