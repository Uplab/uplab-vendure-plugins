import { Injectable } from '@nestjs/common';
import { ID, Logger, RequestContext, TransactionalConnection, VendureEvent } from '@vendure/core';
import { clip } from '../common/utils';
import { CHANGE_HISTORY_ACTIONS, CHANGE_HISTORY_ENTITY_TYPES, DETAIL_CHUNK_SIZE, loggerCtx } from '../constants';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { BatchState, ChangeHistoryContextService } from '../services/change-history-context.service';
import { ChangeHistoryFieldChanges } from '../types';
import { ENTRY_COLUMN_LENGTHS, fitColumns, warnClipped } from './fit';
import { TransactionState } from './transaction-state';

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
  /** Overrides the derived rule (a cascade names its cause itself). */
  derivedFromId?: ID | null;
}

/** Listens to the entries a write saved (the read side's caches). */
export type SavedEntriesListener = (entries: ChangeHistoryEntry[]) => void;

/**
 * The one place entries are inserted. Runs in `withTransaction(ctx)` — a savepoint inside the caller's
 * transaction, an own short transaction otherwise — so a failed history statement never aborts the
 * caller's work, and an entry commits or rolls back with the change it describes. Never rejects. Inside a
 * transaction the write waits for the package's earlier work on it (`serialize`): two savepoints opened at
 * once on one connection abort it.
 *
 * Adds what every entry gets the same way: the actor (resolved once per request), the batch and its lazily
 * written head, the derived link (§ "derived rule": the parent — or the entity itself, when it was created
 * in this transaction — already has an entry in this transaction), channel and correlation id.
 */
@Injectable()
export class ChangeHistoryWriter {
  private readonly listeners: SavedEntriesListener[] = [];

  constructor(
    private readonly connection: TransactionalConnection,
    private readonly context: ChangeHistoryContextService,
  ) {}

  /** Calls `listener` with the entries of every successful write of this process. */
  onSaved(listener: SavedEntriesListener): void {
    this.listeners.push(listener);
  }

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
      /** A batch of this write only (a collection-rules run); an outer `runBatch` wins over it. */
      batch?: BatchState;
    } = {},
  ): Promise<ChangeHistoryEntry[] | undefined> {
    const state = this.context.stateOf(ctx);
    const active = this.context.activeBatch();
    const batch = active ?? options.batch;
    try {
      return await this.context.serialize(ctx, async () => {
        const transaction = this.context.transactionStateOf(ctx);
        const saved = await this.connection.withTransaction(ctx, async (tctx) => {
          const drafts = await produce(tctx);
          if (drafts.length === 0) {
            return [];
          }
          const actor = await this.context.resolveActor(tctx, options.event);
          const repository = this.connection.getRepository(tctx, ChangeHistoryEntry);
          const clipped = new Set<string>();
          drafts.forEach((draft) => fitColumns(draft, ENTRY_COLUMN_LENGTHS, clipped));
          const build = (draft: EntryDraft, derivedFromId: ID | null) =>
            fitColumns(
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
              }),
              ENTRY_COLUMN_LENGTHS,
              clipped,
            );
          // A batch of this write only has no head yet; a `runBatch` one may have it from an earlier write.
          if (batch && (batch !== active || !(await this.headExists(tctx, transaction, batch)))) {
            const label = batch.label ?? batch.kind;
            await repository.save(
              build(
                {
                  entityType: CHANGE_HISTORY_ENTITY_TYPES.Batch,
                  // The uuid part: `entityId` is varchar(36); the full `<kind>:<uuid>` is in `batchId`.
                  entityId: batch.id.slice(batch.kind.length + 1),
                  entityLabel: label,
                  action: CHANGE_HISTORY_ACTIONS.batch,
                  summary: batch.summary ?? label,
                  parentType: batch.parent?.type,
                  parentId: batch.parent?.id,
                  meta: { ...batch.meta, kind: batch.kind, label: batch.label },
                },
                null,
              ),
            );
          }
          const entries = await repository.save(
            drafts.map((draft) =>
              build(draft, draft.derivedFromId !== undefined ? draft.derivedFromId : derivedFrom(transaction, draft)),
            ),
            { chunk: DETAIL_CHUNK_SIZE },
          );
          warnClipped(operation, clipped);
          await options.afterInsert?.(tctx, entries);
          return entries;
        });
        if (saved.length > 0) {
          // Only now, at the caller's depth: a rolled-back savepoint took the rows with it, and a later
          // rollback of the caller's own savepoint undoes these through the journal.
          if (batch) {
            transaction.markHead(batch.id);
          }
          for (const entry of saved) {
            transaction.remember(`${entry.entityType}:${entry.entityId}`, entry.id);
          }
          this.notify(saved);
        }
        return saved;
      });
    } catch (e) {
      logFailure(operation, e);
      return undefined;
    }
  }

  /**
   * `fn` with the transaction's connection, in a savepoint (an own short transaction outside one), after the
   * package's earlier work on it. Resolves `undefined` when it fails (logged): a failed statement never
   * aborts the caller's transaction.
   */
  async inSavepoint<T>(
    ctx: RequestContext,
    operation: string,
    fn: (tctx: RequestContext) => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await this.context.serialize(ctx, () => this.connection.withTransaction(ctx, fn));
    } catch (e) {
      logFailure(operation, e);
      return undefined;
    }
  }

  /**
   * Whether the batch's head is already written: in this transaction (journaled, so a rolled-back savepoint
   * forgets it), else found in the database — written by an earlier transaction of the same batch that
   * committed. A head written by a transaction that rolled back is gone, and written again.
   */
  private async headExists(tctx: RequestContext, transaction: TransactionState, batch: BatchState): Promise<boolean> {
    if (transaction.batchHeads.has(batch.id)) {
      return true;
    }
    const found = await this.connection.getRepository(tctx, ChangeHistoryEntry).count({
      where: { batchId: batch.id, entityType: CHANGE_HISTORY_ENTITY_TYPES.Batch },
    });
    return found > 0;
  }

  private notify(entries: ChangeHistoryEntry[]): void {
    for (const listener of this.listeners) {
      try {
        listener(entries);
      } catch (e) {
        logFailure('saved entries listener', e);
      }
    }
  }
}

/** Logs a swallowed history failure with the stable prefix ops grep for. */
export function logFailure(operation: string, e: unknown): void {
  const error = e instanceof Error ? e : new Error(String(e));
  Logger.error(`write failed in ${operation}: ${error.message}`, loggerCtx, error.stack);
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
