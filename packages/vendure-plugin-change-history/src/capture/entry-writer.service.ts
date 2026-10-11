import { Injectable } from '@nestjs/common';
import { ID, Logger, RequestContext, TransactionalConnection, VendureEvent } from '@vendure/core';
import { CHANGE_HISTORY_ACTIONS, CHANGE_HISTORY_ENTITY_TYPES, loggerCtx } from '../constants';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { ChangeHistoryContextService, TransactionState } from '../services/change-history-context.service';
import { ChangeHistoryFieldChanges } from '../types';

/** An entry before the writer adds the actor, batch, channel, derived link and correlation id. */
export interface EntryDraft {
  entityType: string;
  entityId: string;
  entityLabel: string;
  action: string;
  summary: string;
  parentType?: string | null;
  parentId?: string | null;
  changes?: ChangeHistoryFieldChanges | null;
  /** Overrides the actor's source (an external run names its own). */
  source?: string;
  meta?: Record<string, unknown>;
}

const clip = (value: string, length: number) => (value.length > length ? value.slice(0, length) : value);

/**
 * The one place entries are inserted. Runs in `withTransaction(ctx)` — a savepoint inside the caller's
 * transaction, an own short transaction otherwise — so a failed history statement never aborts the
 * caller's work, and an entry commits or rolls back with the change it describes. Never rejects.
 *
 * Adds what every entry gets the same way: the actor (resolved once per request), the batch and its lazily
 * written head, the derived link (§ "derived rule": the parent — or the entity itself, when it was created
 * in this transaction — already has an entry in this transaction), channel and correlation id.
 */
@Injectable()
export class ChangeHistoryWriter {
  constructor(
    private readonly connection: TransactionalConnection,
    private readonly context: ChangeHistoryContextService,
  ) {}

  /**
   * `produce` builds the drafts inside the savepoint (it may read with the transaction's manager);
   * `afterInsert` writes rows that hang off the new entries in the same savepoint. Resolves the saved
   * entries, or `undefined` when the write failed (logged).
   */
  async write(
    ctx: RequestContext,
    operation: string,
    produce: (tctx: RequestContext) => Promise<EntryDraft[]>,
    options: {
      event?: VendureEvent;
      afterInsert?: (tctx: RequestContext, entries: ChangeHistoryEntry[]) => Promise<void>;
    } = {},
  ): Promise<ChangeHistoryEntry[] | undefined> {
    const state = this.context.stateOf(ctx);
    const transaction = this.context.transactionStateOf(ctx);
    const { batch } = state;
    try {
      const saved = await this.connection.withTransaction(ctx, async (tctx) => {
        const drafts = await produce(tctx);
        if (drafts.length === 0) {
          return [];
        }
        const actor = await this.context.resolveActor(tctx, options.event);
        const repository = this.connection.getRepository(tctx, ChangeHistoryEntry);
        const build = (draft: EntryDraft, derivedFromId: ID | null) =>
          Object.assign(new ChangeHistoryEntry(), {
            ...draft,
            entityLabel: clip(draft.entityLabel || draft.entityId, 255),
            summary: clip(draft.summary, 512),
            parentType: draft.parentType ?? null,
            parentId: draft.parentId ?? null,
            changes: draft.changes ?? null,
            source: draft.source ?? actor.source,
            actorType: actor.actorType,
            actorId: actor.actorId != null ? String(actor.actorId) : null,
            actorLabel: actor.actorLabel ? clip(actor.actorLabel, 255) : null,
            batchId: batch?.id ?? null,
            channelId: tctx.channel?.id != null ? String(tctx.channel.id) : null,
            derivedFromId,
            compactedAt: null,
            meta: { correlationId: state.correlationId, ...actor.meta, ...draft.meta },
          });
        if (batch && !batch.headWritten) {
          const label = batch.label ?? batch.kind;
          await repository.save(
            build(
              {
                entityType: CHANGE_HISTORY_ENTITY_TYPES.Batch,
                // The uuid part: `entityId` is varchar(36); the full `<kind>:<uuid>` is in `batchId`.
                entityId: batch.id.slice(batch.kind.length + 1),
                entityLabel: label,
                action: CHANGE_HISTORY_ACTIONS.batch,
                summary: label,
                meta: { ...batch.meta, kind: batch.kind, label: batch.label },
              },
              null,
            ),
          );
        }
        const entries = await repository.save(drafts.map((draft) => build(draft, derivedFrom(transaction, draft))));
        await options.afterInsert?.(tctx, entries);
        return entries;
      });
      if (saved.length > 0) {
        if (batch) {
          // Only now: a rolled-back savepoint took the head with it.
          batch.headWritten = true;
        }
        for (const entry of saved) {
          transaction.entriesByEntity.set(`${entry.entityType}:${entry.entityId}`, entry.id);
        }
      }
      return saved;
    } catch (e) {
      logFailure(operation, e);
      return undefined;
    }
  }
}

/** Logs a swallowed history failure with the stable prefix ops grep for. */
export function logFailure(operation: string, e: unknown): void {
  const error = e instanceof Error ? e : new Error(String(e));
  Logger.error(`[ChangeHistory] write failed in ${operation}: ${error.message}`, loggerCtx, error.stack);
}

function derivedFrom(transaction: TransactionState, draft: EntryDraft): ID | null {
  if (draft.parentType && draft.parentId) {
    const parentEntry = transaction.entriesByEntity.get(`${draft.parentType}:${draft.parentId}`);
    if (parentEntry !== undefined) {
      return parentEntry;
    }
  }
  const self = `${draft.entityType}:${draft.entityId}`;
  return transaction.createdIds.has(self) ? (transaction.entriesByEntity.get(self) ?? null) : null;
}
