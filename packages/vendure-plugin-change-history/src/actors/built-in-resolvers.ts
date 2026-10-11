import { AdministratorService, API_KEY_AUTH_STRATEGY_NAME, ProcessContext, RequestContext } from '@vendure/core';
import { CHANGE_HISTORY_ACTOR_TYPES, CHANGE_HISTORY_SOURCES } from '../constants';
import { ChangeHistoryActorResolver, ResolvedActor } from '../types';

/**
 * The session's administrator — or, for a request authenticated with an API key, the key's owner
 * (`api_key`, label "… (API key)").
 */
export function sessionAdministratorResolver(administratorService: AdministratorService): ChangeHistoryActorResolver {
  return {
    name: 'session-administrator',
    async resolve(ctx: RequestContext): Promise<ResolvedActor | undefined> {
      const administrator = await administratorService.resolveActorAdministrator(ctx);
      if (!administrator) {
        return undefined;
      }
      const name = `${administrator.firstName} ${administrator.lastName}`.trim();
      return ctx.session?.authenticationStrategy === API_KEY_AUTH_STRATEGY_NAME
        ? {
            actorType: CHANGE_HISTORY_ACTOR_TYPES.api_key,
            actorId: administrator.id,
            actorLabel: `${name} (API key)`,
            source: CHANGE_HISTORY_SOURCES.api_key,
          }
        : {
            actorType: CHANGE_HISTORY_ACTOR_TYPES.admin,
            actorId: administrator.id,
            actorLabel: name,
            source: CHANGE_HISTORY_SOURCES.admin,
          };
    },
  };
}

/**
 * The end of the chain: a system actor nobody declared. Should stay rare in a configured shop; `meta` says
 * where it came from.
 */
export function unknownSystemResolver(processContext: ProcessContext): ChangeHistoryActorResolver {
  return {
    name: 'unknown-system',
    resolve: (ctx: RequestContext): ResolvedActor => ({
      actorType: CHANGE_HISTORY_ACTOR_TYPES.system,
      source: CHANGE_HISTORY_SOURCES.unknown_system,
      meta: { apiType: ctx.apiType, processType: processContext.isWorker ? 'worker' : 'server' },
    }),
  };
}
