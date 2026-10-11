import { Inject, Injectable } from '@nestjs/common';
import {
  Collection,
  CollectionEvent,
  CollectionModificationEvent,
  ID,
  Logger,
  Product,
  ProductVariant,
  RequestContext,
  TransactionalConnection,
} from '@vendure/core';
import { randomUUID } from 'node:crypto';
import { EntityManager, In } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import {
  CHANGE_HISTORY_ACTIONS,
  CHANGE_HISTORY_ENTITY_TYPES,
  CHANGE_HISTORY_PLUGIN_OPTIONS,
  CHANGE_HISTORY_SOURCES,
  DETAIL_CHUNK_SIZE,
  loggerCtx,
} from '../constants';
import { ChangeHistoryCollectionMembers } from '../entities/change-history-collection-members.entity';
import { COLLECTION_POSITION_GROUP } from '../entity-definitions/catalog-definitions';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
import { BASE_GROUP } from '../entity-definitions/entity-definition';
import { labelsOf } from '../entity-definitions/labels';
import { BatchState, ChangeHistoryContextService } from '../services/change-history-context.service';
import { ResolvedChangeHistoryPluginOptions } from '../types';
import { CapturePipeline } from './capture-pipeline';
import { ChangeHistoryWriter, EntryDraft, logFailure } from './entry-writer.service';

/** Drivers where `SELECT … FOR UPDATE` works; TypeORM throws for `pessimistic_write` on the SQLite family. */
const LOCKING_DRIVERS: readonly string[] = ['postgres', 'aurora-postgres', 'mysql', 'aurora-mysql', 'mariadb'];

const MOVE_SCOPE: ReadonlySet<string> = new Set([BASE_GROUP, COLLECTION_POSITION_GROUP]);
const MOVE_FIELDS = ['parent', 'position'] as const;

const byNumericId = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function chunks<T>(items: T[], size = DETAIL_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/**
 * Collections: their own changes (`created` / `updated` / `moved` / `deleted`) and their contents.
 *
 * **Contents.** Vendure announces a change of a collection's products with `CollectionModificationEvent`, which
 * carries no delta and, from the `apply-collection-filters` job, comes after the job committed. The package
 * therefore keeps the last known product ids of every collection (`ChangeHistoryCollectionMembers`) and diffs
 * against it: one `collection_added` / `collection_removed` entry per product (on the Product, under the
 * collection), grouped under one `collection_rules` batch per collection and run whose head carries the counts.
 * The snapshot is seeded on every boot for each collection that has none.
 *
 * **Deletion.** Core deletes a collection's descendants (deepest first) and then the collection, publishing a
 * membership event for each and a single `CollectionEvent deleted` for the collection asked for. Each one found
 * gone by its membership event is remembered with its last state and member count; the `deleted` event then
 * writes the collection first and its descendants derived from it.
 */
@Injectable()
export class CollectionCapture {
  /** The root collection's id (never changes); `null` until looked up. */
  private rootId: string | null = null;
  /** Runs of the filters job, one after the other (see `onModification`). */
  private jobRuns: Promise<void> = Promise.resolve();

  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly connection: TransactionalConnection,
    private readonly context: ChangeHistoryContextService,
    private readonly definitions: ChangeHistoryDefinitions,
    private readonly pipeline: CapturePipeline,
    private readonly writer: ChangeHistoryWriter,
  ) {}

  /** `CollectionEvent`: created / updated / moved (an update without input) / deleted. */
  async onCollectionEvent(event: CollectionEvent): Promise<void> {
    if (!this.options.enabled) {
      return;
    }
    const { ctx } = event;
    const id = String(event.entity.id);
    const definition = this.definitions.collection;
    try {
      if (event.type === 'created') {
        await this.pipeline.run(ctx, definition, [id], {
          mode: 'created',
          action: 'created',
          input: event.input,
          event,
        });
        // An empty snapshot: the job's first fill of the new collection is recorded as one batch.
        await this.writer.inSavepoint(ctx, 'created Collection', (tctx) =>
          insertOrIgnore(this.pipeline.managerOf(tctx), [{ collectionId: id, productIds: [] }]),
        );
      } else if (event.type === 'updated' && event.input === undefined) {
        // Only `moveCollection` publishes an update without input. Siblings it renumbered are not recorded.
        await this.pipeline.run(ctx, definition, [id], {
          mode: 'updated',
          action: CHANGE_HISTORY_ACTIONS.moved,
          event,
          scope: MOVE_SCOPE,
          fields: MOVE_FIELDS,
        });
      } else if (event.type === 'updated') {
        await this.pipeline.run(ctx, definition, [id], {
          mode: 'updated',
          action: 'updated',
          input: event.input,
          event,
        });
      } else {
        await this.onDeleted(event, id);
      }
    } catch (e) {
      logFailure(`${event.type} Collection`, e);
    }
  }

  /**
   * `CollectionModificationEvent`: the contents of one collection may have changed. The filters job publishes
   * one per collection without awaiting it, outside a transaction: those diffs run one after the other, each
   * in its own short transaction, so a job over many collections holds one extra connection, not one per
   * collection. Inside a request's transaction the diff runs at once (it must not wait behind job work that may
   * wait for this transaction's locks).
   */
  async onModification(event: CollectionModificationEvent): Promise<void> {
    if (!this.options.enabled) {
      return;
    }
    if (this.context.transactionOf(event.ctx)) {
      return this.diffContents(event);
    }
    const run = this.jobRuns.then(() => this.diffContents(event));
    this.jobRuns = run;
    return run;
  }

  private async diffContents(event: CollectionModificationEvent): Promise<void> {
    const { ctx } = event;
    const id = String(event.collection.id);
    try {
      const batch: BatchState = {
        kind: CHANGE_HISTORY_SOURCES.collection_rules,
        id: `${CHANGE_HISTORY_SOURCES.collection_rules}:${randomUUID()}`,
      };
      let gone: { memberCount?: number } | undefined;
      await this.writer.write(
        ctx,
        'collection membership',
        async (tctx) => {
          const manager = this.pipeline.managerOf(tctx);
          const snapshot = await this.snapshotOf(manager, id);
          if ((await manager.getRepository(Collection).count({ where: { id } })) === 0) {
            gone = { memberCount: snapshot?.productIds.length };
            if (snapshot) {
              await manager.delete(ChangeHistoryCollectionMembers, { collectionId: id });
            }
            return [];
          }
          const current = (await productIdsOf(manager, [id])).get(id) ?? [];
          if (!snapshot) {
            // Unknown until now (created while capture was off): stored without entries.
            await insertOrIgnore(manager, [{ collectionId: id, productIds: current }]);
            return [];
          }
          const before = new Set(snapshot.productIds);
          const now = new Set(current);
          const added = current.filter((productId) => !before.has(productId));
          const left = snapshot.productIds.filter((productId) => !now.has(productId));
          if (added.length === 0 && left.length === 0) {
            return [];
          }
          await manager.update(ChangeHistoryCollectionMembers, { collectionId: id }, { productIds: current });
          // A product that left because it was deleted gets no entry: its own `deleted` entry says it.
          const removed = await liveProducts(manager, left);
          if (added.length === 0 && removed.length === 0) {
            return [];
          }
          const collectionLabel = (await labelsOf(tctx, manager, Collection, [id]))[id] ?? `Collection ${id}`;
          const productLabels: Record<string, string> = {};
          for (const chunk of chunks([...added, ...removed])) {
            Object.assign(productLabels, await labelsOf(tctx, manager, Product, chunk));
          }
          Object.assign(batch, {
            label: collectionLabel,
            summary: `+${added.length} / −${removed.length}`,
            parent: { type: CHANGE_HISTORY_ENTITY_TYPES.Collection, id },
            meta: { counts: { added: added.length, removed: removed.length } },
          });
          const draft =
            (action: string, summary: string) =>
            (productId: string): EntryDraft => ({
              entityType: CHANGE_HISTORY_ENTITY_TYPES.Product,
              entityId: productId,
              entityLabel: productLabels[productId] ?? `Product ${productId}`,
              action,
              summary,
              parentType: CHANGE_HISTORY_ENTITY_TYPES.Collection,
              parentId: id,
              changes: null,
              meta: { collectionLabel },
            });
          return [
            ...added.map(draft(CHANGE_HISTORY_ACTIONS.collection_added, `added to ${collectionLabel}`)),
            ...removed.map(draft(CHANGE_HISTORY_ACTIONS.collection_removed, `removed from ${collectionLabel}`)),
          ];
        },
        { event, batch },
      );
      if (gone) {
        await this.rememberDeletion(event, id, gone.memberCount);
      }
    } catch (e) {
      logFailure('collection membership', e);
    }
  }

  /**
   * A snapshot for every collection that has none: on every boot, by the server and the worker alike.
   * Idempotent — concurrent seeders insert the same snapshot and the first one wins. Never throws.
   */
  async seedMissing(): Promise<number> {
    if (!this.options.enabled) {
      return 0;
    }
    try {
      const manager = this.connection.rawConnection.manager;
      const known = new Set(
        (
          await manager
            .createQueryBuilder(ChangeHistoryCollectionMembers, 'members')
            .select('members.collectionId', 'collectionId')
            .getRawMany<{ collectionId: string }>()
        ).map((row) => String(row.collectionId)),
      );
      const missing = (await allCollectionIds(manager)).filter((id) => !known.has(id));
      for (const chunk of chunks(missing)) {
        const members = await productIdsOf(manager, chunk);
        await insertOrIgnore(
          manager,
          chunk.map((collectionId) => ({ collectionId, productIds: members.get(collectionId) ?? [] })),
        );
      }
      if (missing.length > 0) {
        Logger.info(`[ChangeHistory] recorded the contents of ${missing.length} collection(s)`, loggerCtx);
      }
      return missing.length;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      Logger.error(
        `[ChangeHistory] recording the contents of the collections failed: ${error.message}`,
        loggerCtx,
        error.stack,
      );
      return 0;
    }
  }

  /** Overwrites every snapshot with the current contents (after a period with capture switched off). */
  async reseed(ctx: RequestContext): Promise<{ collections: number }> {
    return this.context.serialize(ctx, () =>
      this.connection.withTransaction(ctx, async (tctx) => {
        const manager = this.pipeline.managerOf(tctx);
        const ids = await allCollectionIds(manager);
        for (const chunk of chunks(ids)) {
          const members = await productIdsOf(manager, chunk);
          await manager.delete(ChangeHistoryCollectionMembers, { collectionId: In(chunk) });
          await insertOrIgnore(
            manager,
            chunk.map((collectionId) => ({ collectionId, productIds: members.get(collectionId) ?? [] })),
          );
        }
        return { collections: ids.length };
      }),
    );
  }

  /** The snapshot row, locked for this transaction where the driver can lock it. */
  private async snapshotOf(manager: EntityManager, id: string): Promise<ChangeHistoryCollectionMembers | null> {
    const query = manager
      .getRepository(ChangeHistoryCollectionMembers)
      .createQueryBuilder('members')
      .where('members.collectionId = :id', { id });
    if (LOCKING_DRIVERS.includes(manager.connection.options.type)) {
      // Two runs over the same collection must not diff against the same snapshot.
      query.setLock('pessimistic_write');
    }
    return query.getOne();
  }

  /**
   * The collection is gone: its last state (committed row, else the event's entity) and member count wait
   * for core's `CollectionEvent deleted`. Outside a transaction there is nothing to wait in: written now.
   */
  private async rememberDeletion(event: CollectionModificationEvent, id: string, memberCount?: number) {
    const drafts: EntryDraft[] = [];
    await this.pipeline.run(event.ctx, this.definitions.collection, [id], {
      mode: 'deleted',
      action: 'deleted',
      event,
      entities: new Map([[id, await this.withParent(event.ctx, event.collection)]]),
      meta: memberCount !== undefined ? { memberCount } : undefined,
      collect: drafts,
    });
    if (drafts.length === 0) {
      return;
    }
    if (this.context.transactionOf(event.ctx)) {
      this.context.transactionStateOf(event.ctx).deferDeletion(id, drafts[0]);
    } else {
      await this.writer.write(event.ctx, 'deleted Collection', async () => drafts, { event });
    }
  }

  /**
   * The event's collection with its parent's root flag, which its parent link needs: core's events carry the
   * collection without its parent, and without a before-state this object is the last state.
   */
  private async withParent(ctx: RequestContext, collection: Collection): Promise<Collection> {
    if (collection.parent || collection.parentId == null) {
      return collection;
    }
    if (this.rootId === null) {
      // In a savepoint: a failed lookup must not abort the caller's transaction.
      const root = await this.writer.inSavepoint(ctx, 'root collection lookup', (tctx) =>
        this.pipeline
          .managerOf(tctx)
          .getRepository(Collection)
          .findOne({ where: { isRoot: true }, select: { id: true }, loadEagerRelations: false }),
      );
      this.rootId = root ? String(root.id) : null;
    }
    const parent = { id: collection.parentId, isRoot: String(collection.parentId) === this.rootId };
    return Object.assign(new Collection(collection), { parent });
  }

  /** The deleted collection first, then the descendants deleted with it, derived from its entry. */
  private async onDeleted(event: CollectionEvent, id: string): Promise<void> {
    const { ctx } = event;
    const transaction = this.context.transactionStateOf(ctx);
    const pending = transaction.takeDeletions();
    const own = pending.get(id);
    // Core announces the descendants deepest first: reversed, every parent comes before its children.
    const descendants = [...pending.entries()]
      .filter(([key]) => key !== id)
      .map(([, draft]) => draft)
      .reverse();

    let ownEntryId: ID | undefined;
    if (own) {
      ownEntryId = (await this.writer.write(ctx, 'deleted Collection', async () => [own], { event }))?.[0]?.id;
    } else {
      // Deleted without a membership event first (not core's path): the plain way, snapshot included.
      await this.pipeline.run(ctx, this.definitions.collection, [id], {
        mode: 'deleted',
        action: 'deleted',
        event,
        entities: new Map([[id, await this.withParent(ctx, event.entity)]]),
      });
      ownEntryId = transaction.entriesByEntity.get(`${CHANGE_HISTORY_ENTITY_TYPES.Collection}:${id}`);
      await this.writer.write(ctx, 'deleted Collection', async (tctx) => {
        await this.pipeline.managerOf(tctx).delete(ChangeHistoryCollectionMembers, { collectionId: id });
        return [];
      });
    }
    if (descendants.length > 0) {
      await this.writer.write(
        ctx,
        'deleted Collection',
        async () => descendants.map((draft) => ({ ...draft, derivedFromId: ownEntryId ?? null })),
        { event },
      );
    }
  }
}

async function allCollectionIds(manager: EntityManager): Promise<string[]> {
  const rows = await manager
    .createQueryBuilder(Collection, 'collection')
    .select('collection.id', 'id')
    .getRawMany<{ id: ID }>();
  return rows.map((row) => String(row.id));
}

/**
 * The products of each collection: a product is in a collection when one of its variants is. Deleted products
 * and variants are left out. Sorted string ids.
 */
async function productIdsOf(manager: EntityManager, collectionIds: string[]): Promise<Map<string, string[]>> {
  const members = new Map<string, string[]>(collectionIds.map((id) => [id, []]));
  if (collectionIds.length === 0) {
    return members;
  }
  const rows = await manager
    .createQueryBuilder(ProductVariant, 'variant')
    .innerJoin('variant.collections', 'collection')
    .innerJoin('variant.product', 'product')
    .select('collection.id', 'collectionId')
    .addSelect('variant.productId', 'productId')
    .distinct(true)
    .where('collection.id IN (:...collectionIds)', { collectionIds })
    .andWhere('variant.deletedAt IS NULL')
    .andWhere('product.deletedAt IS NULL')
    .getRawMany<{ collectionId: ID; productId: ID }>();
  for (const row of rows) {
    members.get(String(row.collectionId))?.push(String(row.productId));
  }
  for (const ids of members.values()) {
    ids.sort(byNumericId);
  }
  return members;
}

/** The ids among `productIds` whose product still exists and is not deleted. */
async function liveProducts(manager: EntityManager, productIds: string[]): Promise<string[]> {
  const live = new Set<string>();
  for (const chunk of chunks(productIds)) {
    const rows = await manager
      .createQueryBuilder(Product, 'product')
      .select('product.id', 'id')
      .where('product.id IN (:...ids)', { ids: chunk })
      .andWhere('product.deletedAt IS NULL')
      .getRawMany<{ id: ID }>();
    rows.forEach((row) => live.add(String(row.id)));
  }
  return productIds.filter((id) => live.has(id));
}

/** Portable "insert unless present" (`ON CONFLICT DO NOTHING` / `INSERT OR IGNORE` / `INSERT IGNORE`). */
async function insertOrIgnore(
  manager: EntityManager,
  rows: Array<{ collectionId: string; productIds: string[] }>,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await manager
    .createQueryBuilder()
    .insert()
    .into(ChangeHistoryCollectionMembers)
    .values(rows as QueryDeepPartialEntity<ChangeHistoryCollectionMembers>[])
    .orIgnore()
    .execute();
}
