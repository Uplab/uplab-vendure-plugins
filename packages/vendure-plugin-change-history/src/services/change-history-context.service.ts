import { Inject, Injectable } from '@nestjs/common';
import {
  AdministratorService,
  Logger,
  ProcessContext,
  RequestContext,
  TransactionalConnection,
  VendureEvent,
} from '@vendure/core';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';
import {
  collectionRulesResolver,
  sessionAdministratorResolver,
  unknownSystemResolver,
} from '../actors/built-in-resolvers';
import { TransactionState } from '../capture/transaction-state';
import { CHANGE_HISTORY_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import {
  ChangeHistoryActorResolver,
  ChangeHistoryBatchInput,
  ResolvedActor,
  ResolvedChangeHistoryPluginOptions,
} from '../types';

const CHANGE_HISTORY_STATE = Symbol('changeHistoryState');

/** The transactions whose connection the package's work holds in the current async context. */
const held = new AsyncLocalStorage<ReadonlySet<QueryRunner>>();

/** The `runBatch` the current async context runs in. */
const activeBatch = new AsyncLocalStorage<BatchState>();

export interface BatchState extends ChangeHistoryBatchInput {
  /** `<kind>:<uuid>`. */
  id: string;
  /** The head's summary (default: the label). */
  summary?: string;
  /** The entity the head belongs to (a collection-rules batch: its collection). */
  parent?: { type: string; id: string };
}

/** Per-request state, attached to the RequestContext. */
export interface ChangeHistoryState {
  correlationId: string;
  /** The host's or the session's actor; `null` once neither matched (the fallback then depends on the event). */
  actor?: ResolvedActor | null;
}

/** The savepoint depth of a query runner (TypeORM keeps it protected); 1 when the driver does not say. */
function depthOf(queryRunner: QueryRunner): number {
  const depth = (queryRunner as unknown as { transactionDepth?: unknown }).transactionDepth;
  return typeof depth === 'number' ? depth : 1;
}

/**
 * Per-request state, per-transaction state and actor resolution. The request state lives on the
 * RequestContext under a symbol key, which `RequestContext.copy()` carries over — so it survives the context
 * copies of `withTransaction`. What belongs to one transaction (derived links, `lastSeen`, the lock) is kept
 * per query runner, and follows its savepoints through a TypeORM subscriber (see {@link TransactionState}).
 */
@Injectable()
export class ChangeHistoryContextService {
  /** The built-in links after the host's resolvers (Chain of responsibility). */
  private readonly session: ChangeHistoryActorResolver;
  private readonly collectionRules: ChangeHistoryActorResolver;
  private readonly unknown: ChangeHistoryActorResolver;
  private readonly transactions = new WeakMap<QueryRunner, TransactionState>();

  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    administratorService: AdministratorService,
    processContext: ProcessContext,
    private readonly connection: TransactionalConnection,
  ) {
    this.session = sessionAdministratorResolver(administratorService);
    this.collectionRules = collectionRulesResolver();
    this.unknown = unknownSystemResolver(processContext);
  }

  /**
   * Follows the end of every savepoint and transaction, so that a rollback undoes what the package remembered
   * in it, and runs a transaction's `beforeCommit` work just before it commits. Called on bootstrap; idempotent.
   */
  listen(): void {
    const subscribers = this.connection.rawConnection.subscribers;
    if (subscribers.some((subscriber) => (subscriber as { changeHistory?: boolean }).changeHistory)) {
      return;
    }
    const ended = (queryRunner: QueryRunner | undefined, committed: boolean) => {
      const state = queryRunner && this.transactions.get(queryRunner);
      if (!state) {
        return;
      }
      if (queryRunner.isTransactionActive) {
        state.ended(depthOf(queryRunner), committed);
      } else {
        this.transactions.delete(queryRunner);
      }
    };
    const beforeCommit = async (queryRunner: QueryRunner | undefined) => {
      const state = queryRunner && this.transactions.get(queryRunner);
      // Depth 1: the transaction itself commits, not one of its savepoints.
      if (!state || depthOf(queryRunner) !== 1) {
        return;
      }
      try {
        await state.runBeforeCommit();
      } catch (e) {
        // The hooks never reject; a commit must not fail because of the history.
        Logger.error(`work before the commit failed: ${(e as Error)?.message}`, loggerCtx, (e as Error)?.stack);
      }
    };
    subscribers.push({
      changeHistory: true,
      beforeTransactionCommit: (event: { queryRunner?: QueryRunner }) => beforeCommit(event.queryRunner),
      afterTransactionCommit: (event: { queryRunner?: QueryRunner }) => ended(event.queryRunner, true),
      afterTransactionRollback: (event: { queryRunner?: QueryRunner }) => ended(event.queryRunner, false),
    } as never);
  }

  stateOf(ctx: RequestContext): ChangeHistoryState {
    const holder = ctx as unknown as Record<symbol, ChangeHistoryState | undefined>;
    let state = holder[CHANGE_HISTORY_STATE];
    if (!state) {
      state = { correlationId: randomUUID() };
      holder[CHANGE_HISTORY_STATE] = state;
    }
    return state;
  }

  /**
   * The batch of the `runBatch` call the current code runs in, if any. Kept in the async context rather than on
   * the RequestContext: two batches running at once on one context (`Promise.all`) stay apart, and work outside
   * the callback never joins a batch.
   */
  activeBatch(): BatchState | undefined {
    return activeBatch.getStore();
  }

  /** Runs `fn` inside `batch` (see `activeBatch`). */
  inBatch<T>(batch: BatchState, fn: () => Promise<T>): Promise<T> {
    return activeBatch.run(batch, fn);
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
      return new TransactionState();
    }
    let state = this.transactions.get(queryRunner);
    if (!state) {
      state = new TransactionState(() => depthOf(queryRunner));
      this.transactions.set(queryRunner, state);
    }
    return state;
  }

  /**
   * Runs `fn` after every earlier piece of the package's work on the same transaction has finished, so that
   * the package never has two statements — above all two savepoints — in flight on one connection. Core
   * publishes events inside `Promise.all` (deleting several assets, assigning them to a channel, removing
   * collections from a channel): their blocking handlers start concurrently on one transaction, and TypeORM
   * reads the savepoint depth before its `SAVEPOINT` returns — two handlers would open the same savepoint and
   * abort the host's transaction. Outside a transaction, and inside work that already holds the transaction,
   * `fn` runs at once.
   */
  async serialize<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
    const queryRunner = this.transactionOf(ctx);
    const holding = held.getStore();
    if (!queryRunner || holding?.has(queryRunner)) {
      return fn();
    }
    const state = this.transactionStateOf(ctx);
    const previous = state.lock;
    let release!: () => void;
    state.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await held.run(new Set([...(holding ?? []), queryRunner]), fn);
    } finally {
      release();
    }
  }

  /**
   * The chain: a `runBatch` actor override → the host's resolvers → the session's administrator (or the
   * owner of the API key) → the collection rules (a `CollectionModificationEvent` without a user) → an
   * unknown system actor. The host / session result is resolved once per request; the two system fallbacks
   * depend on the event and are decided per write.
   */
  async resolveActor(ctx: RequestContext, event?: VendureEvent): Promise<ResolvedActor> {
    const batchActor = this.activeBatch()?.actor;
    if (batchActor) {
      return batchActor;
    }
    const state = this.stateOf(ctx);
    if (state.actor === undefined) {
      state.actor = (await this.resolveUncached(ctx, event)) ?? null;
    }
    return (
      state.actor ?? ((this.collectionRules.resolve(ctx, event) ?? this.unknown.resolve(ctx, event)) as ResolvedActor)
    );
  }

  private async resolveUncached(ctx: RequestContext, event?: VendureEvent): Promise<ResolvedActor | undefined> {
    for (const resolver of this.options.actorResolvers) {
      try {
        const actor = await resolver.resolve(ctx, event);
        if (actor) {
          return actor;
        }
      } catch (e) {
        Logger.warn(`actor resolver "${resolver.name}" failed: ${(e as Error).message}`, loggerCtx);
      }
    }
    // A failing built-in lookup fails the write instead of attributing the change to an unknown actor.
    return (await this.session.resolve(ctx, event)) as ResolvedActor | undefined;
  }
}
