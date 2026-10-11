import { Inject, Injectable } from '@nestjs/common';
import { ID, Logger, RequestContext, TransactionalConnection, VendureEvent } from '@vendure/core';
import { EntityManager, In } from 'typeorm';
import { NoBeforeState } from '../before-state/before-state-strategy';
import { CHANGE_HISTORY_ACTIONS, CHANGE_HISTORY_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { ChangeHistoryEntityDefinition, LoadedState } from '../entity-definitions/entity-definition';
import { changesSummary, diffStates } from '../diff/diff';
import { capState } from '../diff/truncate';
import { ChangeHistoryContextService } from '../services/change-history-context.service';
import { ChangeHistoryStrategies } from '../services/change-history-strategies.service';
import { ResolvedChangeHistoryPluginOptions } from '../types';
import { ChangeHistoryWriter, EntryDraft, logFailure } from './entry-writer.service';

/**
 * `created`: the before-state is empty, nothing committed is read. `updated`: before = what this
 * transaction saw last, else the committed row. `deleted`: no diff; the last state goes to `meta.lastState`.
 */
type CaptureMode = 'created' | 'updated' | 'deleted';

export interface CaptureRequest {
  mode: CaptureMode;
  /** The entry's action: the event type, or a host action of `capture()`. */
  action: string;
  /** The mutation input of an `updated` event: limits the loading to what it could have changed. */
  input?: unknown;
  event?: VendureEvent;
  meta?: Record<string, unknown>;
}

type CommittedRead = Map<string, LoadedState> | NoBeforeState;

const EMPTY_GROUPS: ReadonlySet<string> = new Set();

/**
 * The capture pipeline (Template method): the fixed order of operations every captured entity goes
 * through; a {@link ChangeHistoryEntityDefinition} supplies the per-entity steps.
 *
 * 1. Start the before-read — the transaction's `lastSeen` state, else the committed row through the
 *    before-state strategy on its own connection — without awaiting it.
 * 2. In a savepoint: load the after-state with the transaction's manager (concurrently with 1), diff,
 *    look up display labels for the changed references only, insert (actor, batch, derived link).
 * 3. Remember the after-state as this transaction's `lastSeen`.
 *
 * Never rejects: a failure is logged and the host's work goes on.
 */
@Injectable()
export class CapturePipeline {
  private readonly warnedNoTransaction = new Set<string>();

  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly connection: TransactionalConnection,
    private readonly context: ChangeHistoryContextService,
    private readonly strategies: ChangeHistoryStrategies,
    private readonly writer: ChangeHistoryWriter,
  ) {}

  async run(
    ctx: RequestContext,
    def: ChangeHistoryEntityDefinition,
    ids: ID[],
    request: CaptureRequest,
  ): Promise<void> {
    if (!this.options.enabled || ids.length === 0) {
      return;
    }
    try {
      await this.capture(ctx, def, [...new Set(ids.map(String))], request);
    } catch (e) {
      logFailure(`${request.action} ${def.entityType}`, e);
    }
  }

  /** The transaction's manager of `ctx` (the plain manager outside a transaction). */
  managerOf(ctx: RequestContext): EntityManager {
    return this.connection.getRepository(ctx, ChangeHistoryEntry).manager;
  }

  private async capture(
    ctx: RequestContext,
    def: ChangeHistoryEntityDefinition,
    ids: string[],
    request: CaptureRequest,
  ): Promise<void> {
    const transaction = this.context.transactionStateOf(ctx);
    const key = (id: string) => `${def.entityType}:${id}`;
    const scope =
      request.mode === 'updated' && request.input !== undefined ? def.scopeFor(request.input) : new Set(def.fullScope);

    // 1. Before: what this transaction saw last, completed by a committed read of whatever it does not cover.
    const seen = new Map<string, LoadedState>();
    const toRead: string[] = [];
    const missing = new Set<string>();
    if (request.mode !== 'created') {
      for (const id of ids) {
        const hit = transaction.lastSeen.get(key(id));
        const gaps = [...scope].filter((group) => !hit?.groups.has(group));
        if (hit) {
          seen.set(id, hit);
        }
        if (gaps.length > 0) {
          toRead.push(id);
          gaps.forEach((group) => missing.add(group));
        }
      }
    }
    const committed = this.readCommitted(ctx, def, toRead, missing);

    // 2. After, diff, insert — in a savepoint.
    const loaded: { after?: Map<string, LoadedState> } = {};
    await this.writer.write(
      ctx,
      `${request.action} ${def.entityType}`,
      async (tctx) => {
        const manager = this.managerOf(tctx);
        const after = await def.load(tctx, ids, manager, scope);
        loaded.after = after;
        const read = await committed;
        const drafts: EntryDraft[] = [];
        for (const id of ids) {
          const draft = this.draft(def, id, request, {
            seen: seen.get(id),
            read: read instanceof Map ? read.get(id) : undefined,
            noBefore: read instanceof Map || !toRead.includes(id) ? undefined : read.noBefore,
            after: after.get(id),
          });
          if (draft) {
            drafts.push(draft);
          }
        }
        for (const draft of drafts) {
          if (draft.changes) {
            await def.addLabels(tctx, manager, draft.changes);
          }
        }
        return request.mode === 'deleted' ? this.withoutEarlierDeletions(manager, def, drafts) : drafts;
      },
      { event: request.event },
    );

    // 3. Remember.
    for (const id of ids) {
      if (request.mode === 'deleted') {
        transaction.lastSeen.delete(key(id));
        continue;
      }
      const state = loaded.after?.get(id);
      if (state) {
        transaction.lastSeen.set(key(id), merge(def, transaction.lastSeen.get(key(id)), state));
        if (request.mode === 'created') {
          transaction.createdIds.set(key(id), true);
        }
      }
    }
  }

  private readCommitted(
    ctx: RequestContext,
    def: ChangeHistoryEntityDefinition,
    ids: string[],
    scope: ReadonlySet<string>,
  ): Promise<CommittedRead> {
    if (ids.length === 0) {
      return Promise.resolve(new Map());
    }
    if (!this.context.transactionOf(ctx)) {
      // The save has auto-committed: a committed read would return the after-state (an empty diff).
      if (!this.warnedNoTransaction.has(def.entityType)) {
        this.warnedNoTransaction.add(def.entityType);
        Logger.warn(
          `[ChangeHistory] a ${def.entityType} change was saved outside a transaction: recorded without its before-state (meta.noBefore = "no_transaction")`,
          loggerCtx,
        );
      }
      return Promise.resolve({ noBefore: 'no_transaction' });
    }
    // Started now, awaited inside the savepoint; the catch is attached at once, else an early failure would
    // be an unhandled rejection.
    return this.strategies.beforeState
      .withCommittedReader(ctx, (manager) => def.load(ctx, ids, manager, scope))
      .catch((e: unknown) => {
        Logger.warn(`[ChangeHistory] before-state read failed: ${(e as Error)?.message}`, loggerCtx);
        return { noBefore: 'error' as const };
      });
  }

  private draft(
    def: ChangeHistoryEntityDefinition,
    id: string,
    request: CaptureRequest,
    sides: { seen?: LoadedState; read?: LoadedState; noBefore?: NoBeforeState['noBefore']; after?: LoadedState },
  ): EntryDraft | undefined {
    const { after, noBefore } = sides;
    const before = sides.seen ? merge(def, sides.read, sides.seen) : sides.read;
    const base = (state: LoadedState) => ({
      entityType: def.entityType,
      entityId: id,
      entityLabel: state.label,
      action: request.action,
      parentType: def.parentType && state.parentId ? def.parentType : null,
      parentId: def.parentType ? (state.parentId ?? null) : null,
    });
    const diffOptions = (groups: ReadonlySet<string>) => ({
      kindOf: (k: string) => def.kindOf(k),
      maxValueBytes: this.options.maxValueBytes,
      include: (k: string) => groups.has(def.groupOf(k)),
    });

    if (request.mode === 'created') {
      if (!after) {
        return undefined;
      }
      return {
        ...base(after),
        summary: CHANGE_HISTORY_ACTIONS.created,
        changes: diffStates({}, after.values, diffOptions(after.groups)),
        meta: request.meta,
      };
    }

    if (request.mode === 'deleted') {
      // Already soft-deleted before this transaction (core re-deletes a product's deleted variants).
      if (before?.deleted && !sides.seen) {
        return undefined;
      }
      const last = before ?? after;
      if (!last) {
        return undefined;
      }
      return {
        ...base(last),
        summary: CHANGE_HISTORY_ACTIONS.deleted,
        changes: null,
        meta: {
          ...request.meta,
          lastState: capState(last.values, this.options.maxValueBytes),
          ...(before ? {} : { noBefore: noBefore ?? 'no_row' }),
        },
      };
    }

    if (!after) {
      return undefined;
    }
    if (noBefore) {
      return {
        ...base(after),
        summary: `${request.action} (details unavailable)`,
        changes: null,
        meta: { ...request.meta, noBefore },
      };
    }
    const beforeState: LoadedState = before ?? { values: {}, groups: after.groups, label: after.label, deleted: false };
    const changes = diffStates(
      beforeState.values,
      after.values,
      diffOptions(new Set([...after.groups].filter((group) => beforeState.groups.has(group)))),
    );
    if (Object.keys(changes).length === 0) {
      return undefined;
    }
    return {
      ...base(after),
      summary: changesSummary(changes),
      changes,
      meta: { ...request.meta, ...(before ? {} : { noBefore: 'no_row' }) },
    };
  }

  /**
   * Without a before-state the package cannot see that a row was already soft-deleted; an earlier
   * `deleted` entry says so instead.
   */
  private async withoutEarlierDeletions(
    manager: EntityManager,
    def: ChangeHistoryEntityDefinition,
    drafts: EntryDraft[],
  ): Promise<EntryDraft[]> {
    const unknown = drafts.filter((draft) => draft.meta?.noBefore).map((draft) => draft.entityId);
    if (unknown.length === 0) {
      return drafts;
    }
    const earlier = await manager.getRepository(ChangeHistoryEntry).find({
      select: { entityId: true },
      where: { entityType: def.entityType, action: CHANGE_HISTORY_ACTIONS.deleted, entityId: In(unknown) },
    });
    const deleted = new Set(earlier.map((entry) => entry.entityId));
    return drafts.filter((draft) => !deleted.has(draft.entityId));
  }
}

/** `next` completed by the values of `previous` for the groups `next` did not load. */
function merge(def: ChangeHistoryEntityDefinition, previous: LoadedState | undefined, next: LoadedState): LoadedState {
  if (!previous) {
    return next;
  }
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(previous.values)) {
    if (!next.groups.has(def.groupOf(key))) {
      values[key] = value;
    }
  }
  return {
    ...next,
    values: { ...values, ...next.values },
    groups: new Set([...(previous.groups ?? EMPTY_GROUPS), ...next.groups]),
  };
}
