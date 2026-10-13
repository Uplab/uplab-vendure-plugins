import { Inject, Injectable } from '@nestjs/common';
import {
  Asset,
  AssetChannelEvent,
  Channel,
  ID,
  ProductAsset,
  ProductChannelEvent,
  ProductVariantAsset,
  ProductVariantChannelEvent,
  RequestContext,
} from '@vendure/core';
import { randomUUID } from 'node:crypto';
import { In } from 'typeorm';
import { chunks } from '../common/utils';
import { CHANGE_HISTORY_ACTIONS, CHANGE_HISTORY_ENTITY_TYPES, CHANGE_HISTORY_PLUGIN_OPTIONS } from '../constants';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
import { BASE_GROUP, ChangeHistoryEntityDefinition } from '../entity-definitions/entity-definition';
import { BatchState, ChangeHistoryContextService } from '../services/change-history-context.service';
import { ResolvedChangeHistoryPluginOptions } from '../types';
import { CapturePipeline } from './capture-pipeline';
import { ChangeHistoryWriter, EntryDraft, logFailure } from './entry-writer.service';
import { TransactionState } from './transaction-state';

type ChannelEvent = ProductChannelEvent | ProductVariantChannelEvent | AssetChannelEvent;

/** One channel event heard in a transaction, kept until the transaction commits. */
export interface ChannelEventRecord {
  ctx: RequestContext;
  event: ChannelEvent;
  draft: EntryDraft;
  /** The `runBatch` the event was published in. */
  batch?: BatchState;
}

const BASE_SCOPE: ReadonlySet<string> = new Set([BASE_GROUP]);
const COMMIT_HOOK = 'channel-assignments';
const { Product, ProductVariant, Asset: AssetType } = CHANGE_HISTORY_ENTITY_TYPES;

/** The products and variants an asset belongs to. */
interface AssetOwners {
  products: string[];
  variants: string[];
}

/**
 * A product, variant or asset assigned to or removed from a channel: an action entry (`channel_assigned` /
 * `channel_removed`) with the channel's id and code in `meta`, no diff. Removing an asset from its last channel
 * is the first step of deleting it: that removal is left to the asset's `deleted` entry.
 *
 * One operation is one feed row. Core announces a product's variants and assets **before** the product, so
 * inside a transaction the entries wait for its commit and are then written together, per channel and
 * direction: the products first; their variants and assets derived from them (an asset of a variant that has
 * no product in the operation derived from that variant). When more than one entry is left at the top
 * (several products, or several variants assigned on their own), they form one batch of kind
 * `channel_assigned` / `channel_removed` — unless a `runBatch` around the operation already batches them.
 * Outside a transaction each event is written at once.
 */
@Injectable()
export class ChannelCapture {
  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly definitions: ChangeHistoryDefinitions,
    private readonly pipeline: CapturePipeline,
    private readonly writer: ChangeHistoryWriter,
    private readonly context: ChangeHistoryContextService,
  ) {}

  async record(event: ChannelEvent): Promise<void> {
    if (!this.options.enabled) {
      return;
    }
    const definition = this.definitionOf(event);
    const operation = `${actionOf(event)} ${definition.entityType}`;
    try {
      if (!this.context.transactionOf(event.ctx)) {
        await this.writer.write(event.ctx, operation, async (tctx) => [await this.draft(tctx, event)].flatMap(listed), {
          event,
        });
        return;
      }
      const draft = await this.writer.inSavepoint(event.ctx, operation, (tctx) => this.draft(tctx, event));
      if (!draft) {
        return;
      }
      const transaction = this.context.transactionStateOf(event.ctx);
      transaction.addChannelEvent({ ctx: event.ctx, event, draft, batch: this.context.activeBatch() });
      transaction.beforeCommit(COMMIT_HOOK, () => this.flush(transaction));
    } catch (e) {
      logFailure(operation, e);
    }
  }

  /** Writes the transaction's channel events, one operation (channel, direction and batch) after another. */
  private async flush(transaction: TransactionState): Promise<void> {
    const operations = new Map<string, ChannelEventRecord[]>();
    for (const record of transaction.takeChannelEvents()) {
      const key = [record.draft.action, record.draft.meta?.channelId, record.batch?.id ?? ''].join('|');
      operations.set(key, [...(operations.get(key) ?? []), record]);
    }
    for (const records of operations.values()) {
      try {
        await this.writeOperation(records);
      } catch (e) {
        logFailure(`${records[0].draft.action} (channel operation)`, e);
      }
    }
  }

  private async writeOperation(records: ChannelEventRecord[]): Promise<void> {
    const unique = new Map<string, ChannelEventRecord>();
    for (const record of records) {
      const key = keyOf(record.draft);
      if (!unique.has(key)) {
        unique.set(key, record);
      }
    }
    const all = [...unique.values()];
    const [{ ctx, event, batch: outer, draft: first }] = all;
    const idsOf = (type: string) =>
      new Set(all.filter((record) => record.draft.entityType === type).map((record) => record.draft.entityId));
    const products = idsOf(Product);
    const variants = idsOf(ProductVariant);
    const assets = [...idsOf(AssetType)];
    const owners =
      assets.length > 0
        ? await this.writer.inSavepoint(ctx, `${first.action} Asset`, (tctx) => this.assetOwners(tctx, assets))
        : undefined;

    // The cause of each derived record, as `Type:id`.
    const causes = new Map<string, string>();
    for (const { draft } of all) {
      if (draft.entityType === ProductVariant && draft.parentId && products.has(draft.parentId)) {
        causes.set(keyOf(draft), `${Product}:${draft.parentId}`);
      }
    }
    for (const { draft } of all) {
      if (draft.entityType !== AssetType) {
        continue;
      }
      const owner = owners?.get(draft.entityId);
      const product = owner?.products.find((id) => products.has(id));
      const variant = owner?.variants.find((id) => variants.has(id));
      if (product) {
        causes.set(keyOf(draft), `${Product}:${product}`);
      } else if (variant) {
        const key = `${ProductVariant}:${variant}`;
        causes.set(keyOf(draft), causes.get(key) ?? key);
      }
    }
    const top = all.filter((record) => !causes.has(keyOf(record.draft)));
    const derived = all.filter((record) => causes.has(keyOf(record.draft)));
    const own: BatchState | undefined =
      !outer && top.length > 1
        ? {
            id: `${first.action}:${randomUUID()}`,
            kind: first.action,
            summary: first.summary,
            meta: { channelId: first.meta?.channelId, channelCode: first.meta?.channelCode },
          }
        : undefined;
    const inBatch = <T>(batch: BatchState | undefined, fn: () => Promise<T>) =>
      batch ? this.context.inBatch(batch, fn) : fn();
    const operation = `${first.action} (channel operation)`;
    const saved = await inBatch(outer ?? own, () =>
      this.writer.write(ctx, operation, async () => top.map((record) => record.draft), { event }),
    );
    if (derived.length === 0) {
      return;
    }
    const entryOf = new Map((saved ?? []).map((entry) => [keyOf(entry), entry.id]));
    // The operation's own batch holds its top entries only; the derived ones hang off them.
    await inBatch(outer, () =>
      this.writer.write(
        ctx,
        operation,
        async () =>
          derived.map(({ draft }) => ({ ...draft, derivedFromId: entryOf.get(causes.get(keyOf(draft))!) ?? null })),
        { event },
      ),
    );
  }

  /** The entry of one event; nothing for an asset's removal from its last channel (its deletion follows). */
  private async draft(tctx: RequestContext, event: ChannelEvent): Promise<EntryDraft | undefined> {
    const definition = this.definitionOf(event);
    const action = actionOf(event);
    const manager = this.pipeline.managerOf(tctx);
    const id = String(entityIdOf(event));
    if (event instanceof AssetChannelEvent && event.type === 'removed' && !(await this.inAnyChannel(tctx, id))) {
      return undefined;
    }
    const state = (await definition.load(tctx, [id], manager, BASE_SCOPE)).get(id);
    const channel = await manager.getRepository(Channel).findOne({
      where: { id: event.channelId },
      select: { id: true, code: true },
      loadEagerRelations: false,
    });
    const code = channel?.code ?? String(event.channelId);
    return {
      entityType: definition.entityType,
      entityId: id,
      entityLabel: state?.label ?? id,
      action,
      summary: `${event.type === 'assigned' ? 'assigned to' : 'removed from'} channel ${code}`,
      parentType: parentTypeOf(definition, state?.parentId),
      parentId: state?.parentId ?? null,
      meta: { channelId: String(event.channelId), channelCode: code },
    };
  }

  private definitionOf(event: ChannelEvent): ChangeHistoryEntityDefinition {
    if (event instanceof ProductChannelEvent) {
      return this.definitions.product;
    }
    return event instanceof ProductVariantChannelEvent ? this.definitions.productVariant : this.definitions.asset;
  }

  private async assetOwners(ctx: RequestContext, assetIds: string[]): Promise<Map<string, AssetOwners>> {
    const manager = this.pipeline.managerOf(ctx);
    const owners = new Map<string, AssetOwners>(assetIds.map((id) => [id, { products: [], variants: [] }]));
    for (const chunk of chunks(assetIds)) {
      const productRows = await manager.getRepository(ProductAsset).find({
        select: { assetId: true, productId: true },
        where: { assetId: In(chunk) },
        loadEagerRelations: false,
      });
      const variantRows = await manager.getRepository(ProductVariantAsset).find({
        select: { assetId: true, productVariantId: true },
        where: { assetId: In(chunk) },
        loadEagerRelations: false,
      });
      productRows.forEach((row) => owners.get(String(row.assetId))?.products.push(String(row.productId)));
      variantRows.forEach((row) => owners.get(String(row.assetId))?.variants.push(String(row.productVariantId)));
    }
    return owners;
  }

  private async inAnyChannel(ctx: RequestContext, assetId: ID): Promise<boolean> {
    const count = await this.pipeline
      .managerOf(ctx)
      .createQueryBuilder(Asset, 'asset')
      .innerJoin('asset.channels', 'channel')
      .where('asset.id = :assetId', { assetId })
      .getCount();
    return count > 0;
  }
}

function entityIdOf(event: ChannelEvent): ID {
  if (event instanceof ProductChannelEvent) {
    return event.product.id;
  }
  return event instanceof ProductVariantChannelEvent ? event.productVariant.id : event.asset.id;
}

const actionOf = (event: ChannelEvent) =>
  event.type === 'assigned' ? CHANGE_HISTORY_ACTIONS.channel_assigned : CHANGE_HISTORY_ACTIONS.channel_removed;

const keyOf = (entry: { entityType: string; entityId: string }) => `${entry.entityType}:${entry.entityId}`;

const listed = <T>(value: T | undefined): T[] => (value === undefined ? [] : [value]);

function parentTypeOf(definition: ChangeHistoryEntityDefinition, parentId: string | undefined): string | null {
  return definition.parentType && parentId ? definition.parentType : null;
}
