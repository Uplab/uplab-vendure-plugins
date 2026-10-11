import { Inject, Injectable } from '@nestjs/common';
import { AdministratorService, API_KEY_AUTH_STRATEGY_NAME, Logger, RequestContext } from '@vendure/core';
import { randomUUID } from 'node:crypto';
import {
  CHANGE_HISTORY_ACTOR_TYPES,
  CHANGE_HISTORY_PLUGIN_OPTIONS,
  CHANGE_HISTORY_SOURCES,
  loggerCtx,
} from '../constants';
import { ChangeHistoryBatchInput, ResolvedActor, ResolvedChangeHistoryPluginOptions } from '../types';

const CHANGE_HISTORY_STATE = Symbol('changeHistoryState');

interface BatchState extends ChangeHistoryBatchInput {
  /** `<kind>:<uuid>`. */
  id: string;
  /** The head entry is written lazily, together with the first member. */
  headWritten: boolean;
}

/** Per-request state, attached to the RequestContext. */
export interface ChangeHistoryState {
  correlationId: string;
  actor?: ResolvedActor;
  batch?: BatchState;
}

/**
 * Per-request state and actor resolution. The state lives on the RequestContext under a symbol key, which
 * `RequestContext.copy()` carries over — so it survives the context copies of `withTransaction`.
 */
@Injectable()
export class ChangeHistoryContextService {
  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly administratorService: AdministratorService,
  ) {}

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
   * The chain: a `runBatch` actor override → the host's resolvers → the session's administrator (or the
   * owner of the API key) → an unknown system actor. Resolved once per request.
   */
  async resolveActor(ctx: RequestContext): Promise<ResolvedActor> {
    const state = this.stateOf(ctx);
    if (state.batch?.actor) {
      return state.batch.actor;
    }
    if (!state.actor) {
      state.actor = await this.resolveUncached(ctx);
    }
    return state.actor;
  }

  private async resolveUncached(ctx: RequestContext): Promise<ResolvedActor> {
    for (const resolver of this.options.actorResolvers) {
      try {
        const actor = await resolver.resolve(ctx);
        if (actor) {
          return actor;
        }
      } catch (e) {
        Logger.warn(`[ChangeHistory] actor resolver "${resolver.name}" failed: ${(e as Error).message}`, loggerCtx);
      }
    }
    const administrator = await this.administratorService.resolveActorAdministrator(ctx);
    if (administrator) {
      const viaApiKey = ctx.session?.authenticationStrategy === API_KEY_AUTH_STRATEGY_NAME;
      const name = `${administrator.firstName} ${administrator.lastName}`.trim();
      return viaApiKey
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
    }
    return {
      actorType: CHANGE_HISTORY_ACTOR_TYPES.system,
      source: CHANGE_HISTORY_SOURCES.unknown_system,
      meta: { apiType: ctx.apiType },
    };
  }
}
