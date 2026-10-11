import { AdministratorService, RequestContext } from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
import { ChangeHistoryActorResolver, ResolvedActor, ResolvedChangeHistoryPluginOptions } from '../types';
import { ChangeHistoryContextService } from './change-history-context.service';

const administrator = { id: 7, firstName: 'Olena', lastName: 'Koval' };

function service(actorResolvers: ChangeHistoryActorResolver[] = [], admin: unknown = administrator) {
  const administratorService = { resolveActorAdministrator: vi.fn().mockResolvedValue(admin) };
  const options = { actorResolvers } as unknown as ResolvedChangeHistoryPluginOptions;
  return {
    context: new ChangeHistoryContextService(options, administratorService as unknown as AdministratorService),
    administratorService,
  };
}

const ctxOf = (session?: { authenticationStrategy?: string }) =>
  ({ apiType: 'admin', session }) as unknown as RequestContext;

describe('ChangeHistoryContextService', () => {
  it('attaches one state per request context', () => {
    const { context } = service();
    const ctx = ctxOf();
    const state = context.stateOf(ctx);
    expect(context.stateOf(ctx)).toBe(state);
    expect(state.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(context.stateOf(ctxOf())).not.toBe(state);
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

  it('falls back to an unknown system actor', async () => {
    const { context } = service([], null);
    expect(await context.resolveActor(ctxOf())).toEqual({
      actorType: 'system',
      source: 'unknown_system',
      meta: { apiType: 'admin' },
    });
  });

  it("asks the host's resolvers first, skipping one that throws", async () => {
    const machine: ResolvedActor = { actorType: 'system', actorLabel: 'SSO robot', source: 'sso' };
    const { context, administratorService } = service([
      {
        name: 'broken',
        resolve: () => {
          throw new Error('boom');
        },
      },
      { name: 'none', resolve: () => undefined },
      { name: 'sso', resolve: async () => machine },
    ]);
    expect(await context.resolveActor(ctxOf())).toBe(machine);
    expect(administratorService.resolveActorAdministrator).not.toHaveBeenCalled();
  });

  it("prefers a batch's actor override", async () => {
    const { context } = service();
    const ctx = ctxOf();
    const override: ResolvedActor = { actorType: 'admin', actorId: 3, source: 'scheduled_action' };
    context.stateOf(ctx).batch = { kind: 'scheduled', id: 'scheduled:1', headWritten: false, actor: override };
    expect(await context.resolveActor(ctx)).toBe(override);
  });
});
