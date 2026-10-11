import { AdministratorService, ProcessContext, RequestContext, TransactionalConnection } from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
import { ChangeHistoryActorResolver, ResolvedActor, ResolvedChangeHistoryPluginOptions } from '../types';
import { ChangeHistoryContextService, LAST_SEEN_CAPACITY } from './change-history-context.service';

const administrator = { id: 7, firstName: 'Olena', lastName: 'Koval' };

/** A connection whose repositories run on `queryRunner` (undefined = outside a transaction). */
function connectionOn(queryRunner?: Record<string, unknown>) {
  return {
    getRepository: () => ({ manager: { queryRunner } }),
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
  return {
    context: new ChangeHistoryContextService(
      options,
      administratorService as unknown as AdministratorService,
      { isWorker: true } as ProcessContext,
      connectionOn(queryRunner),
    ),
    administratorService,
  };
}

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

  it('caps the lastSeen cache', () => {
    const { context } = service([], administrator, { isTransactionActive: true, isReleased: false });
    const { lastSeen } = context.transactionStateOf(ctxOf());
    for (let i = 0; i <= LAST_SEEN_CAPACITY; i++) {
      lastSeen.set(`Product:${i}`, { values: {}, groups: new Set(), label: '', deleted: false });
    }
    expect(lastSeen.size).toBe(LAST_SEEN_CAPACITY);
    expect(lastSeen.has('Product:0')).toBe(false);
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
      actorLabel: 'Olena Koval (API key)',
      source: 'api_key',
    });
  });

  it('falls back to an unknown system actor, saying where it ran', async () => {
    const { context } = service([], null);
    expect(await context.resolveActor(ctxOf())).toEqual({
      actorType: 'system',
      source: 'unknown_system',
      meta: { apiType: 'admin', processType: 'worker' },
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
    context.stateOf(ctx).batch = { kind: 'scheduled', id: 'scheduled:1', headWritten: false, actor: override };
    expect(await context.resolveActor(ctx)).toBe(override);
    context.stateOf(ctx).batch = undefined;
    expect((await context.resolveActor(ctx)).source).toBe('admin');
  });
});
