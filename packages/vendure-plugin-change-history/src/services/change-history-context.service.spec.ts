import {
  AdministratorService,
  Collection,
  CollectionModificationEvent,
  ProcessContext,
  RequestContext,
  TransactionalConnection,
} from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
import { plainActorLabel } from '../actors/built-in-resolvers';
import { ChangeHistoryActorResolver, ResolvedActor, ResolvedChangeHistoryPluginOptions } from '../types';
import { LAST_SEEN_CAPACITY } from '../capture/transaction-state';
import { ChangeHistoryContextService } from './change-history-context.service';

const administrator = { id: 7, firstName: 'Olena', lastName: 'Koval' };

type Subscriber = {
  afterTransactionCommit(event: { queryRunner?: unknown }): void;
  afterTransactionRollback(event: { queryRunner?: unknown }): void;
};

/** A connection whose repositories run on `queryRunner` (undefined = outside a transaction). */
function connectionOn(queryRunner: Record<string, unknown> | undefined, subscribers: Subscriber[]) {
  return {
    getRepository: () => ({ manager: { queryRunner } }),
    rawConnection: { subscribers },
  } as unknown as TransactionalConnection;
}

function service(
  actorResolvers: ChangeHistoryActorResolver[] = [],
  admin: unknown = administrator,
  queryRunner?: Record<string, unknown>,
) {
  const administratorService = {
    resolveActorAdministrator: vi.fn(async () => (admin instanceof Error ? Promise.reject(admin) : admin)),
  };
  const options = { actorResolvers } as unknown as ResolvedChangeHistoryPluginOptions;
  const subscribers: Subscriber[] = [];
  return {
    context: new ChangeHistoryContextService(
      options,
      administratorService as unknown as AdministratorService,
      { isWorker: true } as ProcessContext,
      connectionOn(queryRunner, subscribers),
    ),
    administratorService,
    subscribers,
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ctxOf = (session?: { authenticationStrategy?: string }) =>
  ({
    apiType: 'admin',
    session,
    copy() {
      return Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    },
  }) as unknown as RequestContext;

describe('ChangeHistoryContextService', () => {
  it('attaches one state per request context, shared with its copies', () => {
    const { context } = service();
    const ctx = ctxOf();
    const state = context.stateOf(ctx);
    expect(context.stateOf(ctx)).toBe(state);
    expect(context.stateOf(ctx.copy())).toBe(state);
    expect(state.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(context.stateOf(ctxOf())).not.toBe(state);
  });

  it('keeps one transaction state per open transaction, and a throw-away one outside', () => {
    const open = { isTransactionActive: true, isReleased: false };
    const { context } = service([], administrator, open);
    const ctx = ctxOf();
    expect(context.transactionOf(ctx)).toBe(open);
    expect(context.transactionStateOf(ctx)).toBe(context.transactionStateOf(ctx));

    const outside = service().context;
    expect(outside.transactionOf(ctx)).toBeUndefined();
    expect(outside.transactionStateOf(ctx)).not.toBe(outside.transactionStateOf(ctx));

    const released = service([], administrator, { isTransactionActive: true, isReleased: true }).context;
    expect(released.transactionOf(ctx)).toBeUndefined();
  });

  it('caps the lastSeen cache and marks what it evicted', () => {
    const { context } = service([], administrator, { isTransactionActive: true, isReleased: false });
    const state = context.transactionStateOf(ctxOf());
    for (let i = 0; i <= LAST_SEEN_CAPACITY; i++) {
      state.see(`Product:${i}`, { values: {}, groups: new Set(), label: '', deleted: false });
    }
    expect(state.lastSeen.size).toBe(LAST_SEEN_CAPACITY);
    expect(state.lastSeen.has('Product:0')).toBe(false);
    expect(state.evicted.has('Product:0')).toBe(true);
  });

  it("runs the package's work on one transaction one piece after another; nested work at once", async () => {
    const { context } = service([], administrator, { isTransactionActive: true, isReleased: false });
    const ctx = ctxOf();
    const log: string[] = [];
    const step = (name: string, ms: number) =>
      context.serialize(ctx, async () => {
        log.push(`${name}:start`);
        await pause(ms);
        log.push(`${name}:end`);
        return name;
      });

    expect(await Promise.all([step('a', 20), step('b', 0), step('c', 0)])).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);

    expect(await context.serialize(ctx, () => context.serialize(ctx.copy(), async () => 'inner'))).toBe('inner');
    await expect(
      context.serialize(ctx, async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(await context.serialize(ctx, async () => 'after a failure')).toBe('after a failure');
  });

  it('does not hold anything back outside a transaction', async () => {
    const { context } = service();
    const ctx = ctxOf();
    const log: string[] = [];
    const step = (name: string, ms: number) =>
      context.serialize(ctx, async () => {
        log.push(`${name}:start`);
        await pause(ms);
        log.push(`${name}:end`);
      });
    await Promise.all([step('a', 20), step('b', 0)]);
    expect(log).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
  });

  it('follows the savepoints of a transaction through one TypeORM subscriber', () => {
    const runner = { isTransactionActive: true, isReleased: false, transactionDepth: 2 };
    const { context, subscribers } = service([], administrator, runner);
    context.listen();
    context.listen();
    expect(subscribers).toHaveLength(1);
    const [subscriber] = subscribers;

    const state = context.transactionStateOf(ctxOf());
    state.remember('Product:1', 5);
    runner.transactionDepth = 1;
    subscriber.afterTransactionRollback({ queryRunner: runner });
    expect(state.entriesByEntity.has('Product:1')).toBe(false);

    state.remember('Product:2', 6);
    subscriber.afterTransactionCommit({ queryRunner: { isTransactionActive: true } });
    subscriber.afterTransactionCommit({});
    expect(context.transactionStateOf(ctxOf())).toBe(state);

    runner.isTransactionActive = false;
    subscriber.afterTransactionCommit({ queryRunner: runner });
    runner.isTransactionActive = true;
    expect(context.transactionStateOf(ctxOf())).not.toBe(state);
  });

  it("records the session's administrator, resolved once per request", async () => {
    const { context, administratorService } = service();
    const ctx = ctxOf({ authenticationStrategy: 'native' });

    expect(await context.resolveActor(ctx)).toEqual({
      actorType: 'admin',
      actorId: 7,
      actorLabel: 'Olena Koval',
      source: 'admin',
    });
    await context.resolveActor(ctx);
    expect(administratorService.resolveActorAdministrator).toHaveBeenCalledTimes(1);
  });

  it('records the owner of an API key as an api_key actor', async () => {
    const { context } = service();
    expect(await context.resolveActor(ctxOf({ authenticationStrategy: 'apikey' }))).toEqual({
      actorType: 'api_key',
      actorId: 7,
      actorLabel: 'Olena Koval',
      source: 'api_key',
    });
  });

  it('reads a pre-release API-key label ("Name (API key)") as the owner\'s plain name', () => {
    expect(plainActorLabel('api_key', 'Olena Koval (API key)')).toBe('Olena Koval');
    expect(plainActorLabel('api_key', 'Olena Koval')).toBe('Olena Koval');
    expect(plainActorLabel('admin', 'Team (API key)')).toBe('Team (API key)');
    expect(plainActorLabel('api_key', null)).toBeNull();
  });

  it('falls back to an unknown system actor, saying where it ran', async () => {
    const { context } = service([], null);
    expect(await context.resolveActor(ctxOf())).toEqual({
      actorType: 'system',
      source: 'unknown_system',
      meta: { apiType: 'admin', processType: 'worker' },
    });
  });

  it('attributes a change of collection contents without a user to the collection rules, decided per event', async () => {
    const { context, administratorService } = service([], null);
    const ctx = ctxOf();
    const membership = new CollectionModificationEvent(ctx, {} as Collection, []);

    expect(await context.resolveActor(ctx, membership)).toEqual({ actorType: 'system', source: 'collection_rules' });
    expect(await context.resolveActor(ctx)).toMatchObject({ actorType: 'system', source: 'unknown_system' });
    expect(await context.resolveActor(ctx, membership)).toMatchObject({ source: 'collection_rules' });
    expect(administratorService.resolveActorAdministrator).toHaveBeenCalledTimes(1);
  });

  it("keeps the session's administrator for a change of collection contents inside their request", async () => {
    const { context } = service();
    const ctx = ctxOf();
    expect(await context.resolveActor(ctx, new CollectionModificationEvent(ctx, {} as Collection, []))).toMatchObject({
      actorType: 'admin',
      source: 'admin',
    });
  });

  it('fails instead of guessing when the administrator lookup fails', async () => {
    const { context } = service([], new Error('connection lost'));
    await expect(context.resolveActor(ctxOf())).rejects.toThrow('connection lost');
  });

  it("asks the host's resolvers first, with the event, skipping one that throws", async () => {
    const machine: ResolvedActor = { actorType: 'system', actorLabel: 'SSO robot', source: 'sso' };
    const sso = vi.fn(async () => machine);
    const { context, administratorService } = service([
      {
        name: 'broken',
        resolve: () => {
          throw new Error('boom');
        },
      },
      { name: 'none', resolve: () => undefined },
      { name: 'sso', resolve: sso },
    ]);
    const ctx = ctxOf();
    const event = { ctx } as never;
    expect(await context.resolveActor(ctx, event)).toBe(machine);
    expect(sso).toHaveBeenCalledWith(ctx, event);
    expect(administratorService.resolveActorAdministrator).not.toHaveBeenCalled();
  });

  it("prefers a batch's actor override, without caching it", async () => {
    const { context } = service();
    const ctx = ctxOf();
    const override: ResolvedActor = { actorType: 'admin', actorId: 3, source: 'scheduled_action' };
    await context.inBatch({ kind: 'scheduled', id: 'scheduled:1', actor: override }, async () => {
      expect(await context.resolveActor(ctx)).toBe(override);
    });
    expect((await context.resolveActor(ctx)).source).toBe('admin');
  });
});
