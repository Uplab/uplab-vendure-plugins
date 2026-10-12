import {
  Asset,
  AssetChannelEvent,
  ID,
  Logger,
  Product,
  ProductAsset,
  ProductChannelEvent,
  ProductVariant,
  ProductVariantChannelEvent,
  RequestContext,
} from '@vendure/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANGE_HISTORY_ACTIONS } from '../constants';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
import { LoadedState } from '../entity-definitions/entity-definition';
import { resolveOptions } from '../options';
import { BatchState, ChangeHistoryContextService } from '../services/change-history-context.service';
import { CapturePipeline } from './capture-pipeline';
import { ChangeHistoryWriter, EntryDraft } from './entry-writer.service';
import { ChannelCapture } from './channel-capture';
import { TransactionState } from './transaction-state';

const ctx = { languageCode: 'en' } as unknown as RequestContext;

interface Saved extends EntryDraft {
  id: number;
  batchId: string | null;
}

function setup(
  options: {
    enabled?: boolean;
    channel?: { id: ID; code: string } | null;
    states?: Record<string, Partial<LoadedState>>;
    assetChannels?: number;
    failWrite?: boolean;
    /** Inside a transaction: the entries wait for its commit. */
    transaction?: boolean;
    outerBatch?: BatchState;
    productAssets?: Array<{ assetId: number; productId: number }>;
    variantAssets?: Array<{ assetId: number; productVariantId: number }>;
    /** The first write (the operation's top entries) fails. */
    failFirstWrite?: boolean;
  } = {},
) {
  const definitionOf = (entityType: string, parentType?: string) => ({
    entityType,
    parentType,
    load: vi.fn(
      async (_ctx: RequestContext, ids: ID[]) =>
        new Map(
          ids
            .map(String)
            .filter((id) => options.states?.[id])
            .map((id) => [id, options.states![id] as LoadedState]),
        ),
    ),
  });
  const definitions = {
    product: definitionOf('Product'),
    productVariant: definitionOf('ProductVariant', 'Product'),
    asset: definitionOf('Asset'),
  };
  const getCount = vi.fn(async () => options.assetChannels ?? 0);
  const builder = { innerJoin: () => builder, where: () => builder, getCount };
  const manager = {
    getRepository: (entity: unknown) => ({
      findOne: vi.fn(async () => options.channel ?? null),
      find: vi.fn(async () =>
        entity === ProductAsset ? (options.productAssets ?? []) : (options.variantAssets ?? []),
      ),
    }),
    createQueryBuilder: () => builder,
  };
  const transactionState = new TransactionState();
  const drafts: EntryDraft[] = [];
  const saved: Saved[] = [];
  let active: BatchState | undefined;
  let writes = 0;
  const write = vi.fn(
    async (_ctx: RequestContext, _operation: string, produce: (tctx: RequestContext) => Promise<EntryDraft[]>) => {
      writes++;
      if (options.failWrite) {
        throw new Error('insert failed');
      }
      const produced = await produce(ctx);
      drafts.push(...produced);
      if (options.failFirstWrite && writes === 1) {
        return undefined;
      }
      const entries = produced.map((draft) => ({ ...draft, id: 100 + saved.length, batchId: active?.id ?? null }));
      saved.push(...entries);
      return entries;
    },
  );
  const inSavepoint = vi.fn(async (_ctx: RequestContext, _operation: string, fn: (tctx: RequestContext) => unknown) =>
    fn(ctx),
  );
  const context = {
    transactionOf: () => (options.transaction ? {} : undefined),
    transactionStateOf: () => transactionState,
    activeBatch: () => options.outerBatch,
    inBatch: async <T>(batch: BatchState, fn: () => Promise<T>) => {
      const previous = active;
      active = batch;
      try {
        return await fn();
      } finally {
        active = previous;
      }
    },
  };
  const capture = new ChannelCapture(
    resolveOptions({ retention: { archive: 'none' }, enabled: options.enabled }),
    definitions as unknown as ChangeHistoryDefinitions,
    { managerOf: () => manager } as unknown as CapturePipeline,
    { write, inSavepoint } as unknown as ChangeHistoryWriter,
    context as unknown as ChangeHistoryContextService,
  );
  const commit = () => transactionState.runBeforeCommit();
  return { capture, write, drafts, saved, definitions, getCount, commit, transactionState };
}

describe('ChannelCapture', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records nothing with the kill switch off', async () => {
    const { capture, write } = setup({ enabled: false });
    await capture.record(new ProductChannelEvent(ctx, { id: 3 } as Product, 2, 'assigned'));
    expect(write).not.toHaveBeenCalled();
  });

  it('records the assignment with the channel code, under the parent of a variant', async () => {
    const { capture, write, drafts } = setup({
      channel: { id: 2, code: 'wholesale' },
      states: { '21': { label: 'Shirt S', parentId: '3' } },
    });
    await capture.record(new ProductVariantChannelEvent(ctx, { id: 21 } as ProductVariant, 2, 'assigned'));
    expect(write.mock.calls[0][1]).toBe(`${CHANGE_HISTORY_ACTIONS.channel_assigned} ProductVariant`);
    expect(drafts).toEqual([
      {
        entityType: 'ProductVariant',
        entityId: '21',
        entityLabel: 'Shirt S',
        action: CHANGE_HISTORY_ACTIONS.channel_assigned,
        summary: 'assigned to channel wholesale',
        parentType: 'Product',
        parentId: '3',
        meta: { channelId: '2', channelCode: 'wholesale' },
      },
    ]);
  });

  it('falls back to the channel id and the entity id when their rows are gone', async () => {
    const { capture, drafts } = setup();
    await capture.record(new ProductChannelEvent(ctx, { id: 3 } as Product, 7, 'removed'));
    expect(drafts).toEqual([
      {
        entityType: 'Product',
        entityId: '3',
        entityLabel: '3',
        action: CHANGE_HISTORY_ACTIONS.channel_removed,
        summary: 'removed from channel 7',
        parentType: null,
        parentId: null,
        meta: { channelId: '7', channelCode: '7' },
      },
    ]);
  });

  it("leaves an asset's removal from its last channel to its deletion", async () => {
    const last = setup({ assetChannels: 0 });
    await last.capture.record(new AssetChannelEvent(ctx, { id: 55 } as Asset, 2, 'removed'));
    expect(last.getCount).toHaveBeenCalledTimes(1);
    expect(last.drafts).toEqual([]);

    const other = setup({ assetChannels: 1, channel: { id: 2, code: 'b2b' } });
    await other.capture.record(new AssetChannelEvent(ctx, { id: 55 } as Asset, 2, 'removed'));
    expect(other.drafts).toEqual([
      expect.objectContaining({ entityType: 'Asset', summary: 'removed from channel b2b' }),
    ]);
  });

  it('logs a failed write instead of failing the assignment', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { capture } = setup({ failWrite: true });
    await expect(
      capture.record(new ProductChannelEvent(ctx, { id: 3 } as Product, 2, 'assigned')),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`write failed in ${CHANGE_HISTORY_ACTIONS.channel_assigned} Product: insert failed`),
      expect.anything(),
      expect.anything(),
    );
  });

  describe('inside a transaction', () => {
    const product = (id: number) => new ProductChannelEvent(ctx, { id } as Product, 2, 'assigned');
    const variant = (id: number, type: 'assigned' | 'removed' = 'assigned') =>
      new ProductVariantChannelEvent(ctx, { id } as ProductVariant, 2, type);
    const asset = (id: number) => new AssetChannelEvent(ctx, { id } as Asset, 2, 'assigned');
    const states = {
      '3': { label: 'Shirt' },
      '4': { label: 'Cap' },
      '21': { label: 'Shirt S', parentId: '3' },
      '22': { label: 'Shirt M', parentId: '3' },
      '41': { label: 'Cap one', parentId: '4' },
    };
    const byKey = (saved: Saved[]) => new Map(saved.map((entry) => [`${entry.entityType}:${entry.entityId}`, entry]));

    it('writes nothing before the commit, then the product with its variants and assets derived from it', async () => {
      const { capture, write, saved, commit } = setup({
        transaction: true,
        channel: { id: 2, code: 'uk-store' },
        states,
        productAssets: [{ assetId: 70, productId: 3 }],
        variantAssets: [{ assetId: 71, productVariantId: 21 }],
      });
      // Core's order: the variants' assets, the variants, the product's assets, the product.
      for (const event of [asset(71), variant(21), variant(22), asset(70), asset(72), product(3)]) {
        await capture.record(event);
      }
      expect(write).not.toHaveBeenCalled();

      await commit();
      const entries = byKey(saved);
      const shirt = entries.get('Product:3')!;
      // An asset of nothing in the operation is an entry of its own: with the product, two at the top, one batch.
      expect(shirt.batchId).toMatch(/^channel_assigned:/);
      expect(entries.get('Asset:72')).toMatchObject({ batchId: shirt.batchId });
      expect(entries.get('Asset:72')).not.toHaveProperty('derivedFromId');
      expect(saved.indexOf(shirt)).toBeLessThan(saved.indexOf(entries.get('ProductVariant:21')!));
      for (const key of ['ProductVariant:21', 'ProductVariant:22', 'Asset:70', 'Asset:71']) {
        expect(entries.get(key)).toMatchObject({ derivedFromId: shirt.id, batchId: null });
      }
    });

    it('writes one product with its variants as one top entry, without a batch', async () => {
      const { capture, saved, commit } = setup({ transaction: true, states });
      for (const event of [variant(21), variant(22), product(3)]) {
        await capture.record(event);
      }
      await commit();
      expect(saved.map((entry) => [entry.entityId, entry.batchId, entry.derivedFromId])).toEqual([
        ['3', null, undefined],
        ['21', null, saved[0].id],
        ['22', null, saved[0].id],
      ]);
    });

    it('batches several products of one operation; their variants hang off them, outside the batch', async () => {
      const { capture, saved, commit } = setup({ transaction: true, channel: { id: 2, code: 'uk-store' }, states });
      for (const event of [variant(21), variant(41), product(3), product(4), product(3)]) {
        await capture.record(event);
      }
      await commit();
      const products = saved.filter((entry) => entry.entityType === 'Product');
      expect(products).toHaveLength(2);
      expect(products[0].batchId).toMatch(/^channel_assigned:/);
      expect(products[1].batchId).toBe(products[0].batchId);
      expect(byKey(saved).get('ProductVariant:41')).toMatchObject({ derivedFromId: products[1].id, batchId: null });
    });

    it('batches several variants assigned on their own', async () => {
      const { capture, saved, commit } = setup({ transaction: true, states });
      for (const event of [variant(21, 'removed'), variant(22, 'removed')]) {
        await capture.record(event);
      }
      await commit();
      expect(saved.map((entry) => entry.batchId)).toEqual([
        expect.stringMatching(/^channel_removed:/),
        saved[0].batchId,
      ]);
    });

    it('derives an asset of a variant from the variant when its product is not in the operation', async () => {
      const { capture, saved, commit } = setup({
        transaction: true,
        states,
        variantAssets: [{ assetId: 71, productVariantId: 22 }],
      });
      for (const event of [asset(71), variant(22)]) {
        await capture.record(event);
      }
      await commit();
      const [variantEntry, assetEntry] = saved;
      expect(variantEntry).toMatchObject({ entityId: '22', batchId: null });
      expect(assetEntry).toMatchObject({ entityId: '71', derivedFromId: variantEntry.id });
    });

    it('leaves the batching to a runBatch around the operation', async () => {
      const outerBatch: BatchState = { id: 'bulk_edit:1', kind: 'bulk_edit' };
      const { capture, saved, commit } = setup({ transaction: true, states, outerBatch });
      for (const event of [variant(21), product(3), product(4)]) {
        await capture.record(event);
      }
      await commit();
      expect(saved.map((entry) => entry.batchId)).toEqual(['bulk_edit:1', 'bulk_edit:1', 'bulk_edit:1']);
    });

    it("writes the derived entries on their own when the operation's top entries failed", async () => {
      const { capture, saved, commit } = setup({ transaction: true, states, failFirstWrite: true });
      for (const event of [variant(21), product(3)]) {
        await capture.record(event);
      }
      await commit();
      expect(saved).toEqual([expect.objectContaining({ entityId: '21', derivedFromId: null })]);
    });

    it('logs a failed operation and goes on with the next one', async () => {
      const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
      const { capture, write, saved, commit } = setup({ transaction: true, states });
      await capture.record(product(3));
      await capture.record(variant(21, 'removed'));
      write.mockRejectedValueOnce(new Error('boom'));
      await expect(commit()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('write failed in channel_assigned (channel operation): boom'),
        expect.anything(),
        expect.anything(),
      );
      expect(saved).toEqual([expect.objectContaining({ entityId: '21', action: 'channel_removed' })]);
    });

    it('forgets the events of a rolled-back savepoint', async () => {
      const { capture, write, transactionState, commit } = setup({ transaction: true, states });
      await capture.record(product(3));
      transactionState.ended(0, false);
      await commit();
      expect(write).not.toHaveBeenCalled();
    });

    it('logs a failed read of an event instead of keeping it', async () => {
      const { capture, write, commit, definitions } = setup({ transaction: true, states });
      definitions.product.load.mockRejectedValueOnce(new Error('read failed'));
      const writer = (capture as unknown as { writer: { inSavepoint: ReturnType<typeof vi.fn> } }).writer;
      writer.inSavepoint.mockResolvedValueOnce(undefined);
      await capture.record(product(3));
      await commit();
      expect(write).not.toHaveBeenCalled();
    });
  });
});
