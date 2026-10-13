import {
  AdministratorService,
  API_KEY_AUTH_STRATEGY_NAME,
  CollectionModificationEvent,
  ProcessContext,
  RequestContext,
  VendureEvent,
} from '@vendure/core';
import { CHANGE_HISTORY_ACTOR_TYPES, CHANGE_HISTORY_SOURCES } from '../constants';
import { ChangeHistoryActorResolver, ResolvedActor } from '../types';

/**
 * The session's administrator — or, for a request authenticated with an API key, the key's owner (`api_key`).
 * The label is the administrator's name either way: the actor type says it was a key, and the dashboard marks it.
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
            actorLabel: name,
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
 * Collection contents recomputed by Vendure itself: the `apply-collection-filters` job runs with a context
 * that has no user, after a filter, product or variant change. Matches `CollectionModificationEvent` only.
 */
export function collectionRulesResolver(): ChangeHistoryActorResolver {
  return {
    name: 'collection-rules',
    resolve: (_ctx: RequestContext, event?: VendureEvent): ResolvedActor | undefined =>
      event instanceof CollectionModificationEvent
        ? { actorType: CHANGE_HISTORY_ACTOR_TYPES.system, source: CHANGE_HISTORY_SOURCES.collection_rules }
        : undefined,
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

/** The suffix pre-release versions appended to an API-key actor's label; stripped when such a row is read. */
const LEGACY_API_KEY_SUFFIX = ' (API key)';

/** The administrator's name of a stored actor label: rows of pre-release versions said "Name (API key)". */
export function plainActorLabel(actorType: string, label: string | null): string | null {
  return actorType === CHANGE_HISTORY_ACTOR_TYPES.api_key && label?.endsWith(LEGACY_API_KEY_SUFFIX)
    ? label.slice(0, -LEGACY_API_KEY_SUFFIX.length)
    : label;
}
