import {
  Asset,
  AssetChannelEvent,
  ID,
  Logger,
  Product,
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
import { CapturePipeline } from './capture-pipeline';
import { ChangeHistoryWriter, EntryDraft } from './entry-writer.service';
import { ChannelCapture } from './channel-capture';

const ctx = { languageCode: 'en' } as unknown as RequestContext;

function setup(
  options: {
    enabled?: boolean;
    channel?: { id: ID; code: string } | null;
    states?: Record<string, Partial<LoadedState>>;
    assetChannels?: number;
    failWrite?: boolean;
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
    getRepository: () => ({ findOne: vi.fn(async () => options.channel ?? null) }),
    createQueryBuilder: () => builder,
  };
  const drafts: EntryDraft[] = [];
  const write = vi.fn(
    async (_ctx: RequestContext, _operation: string, produce: (tctx: RequestContext) => Promise<EntryDraft[]>) => {
      if (options.failWrite) {
        throw new Error('insert failed');
      }
      drafts.push(...(await produce(ctx)));
      return [];
    },
  );
  const capture = new ChannelCapture(
    resolveOptions({ retention: { archive: 'none' }, enabled: options.enabled }),
    definitions as unknown as ChangeHistoryDefinitions,
    { managerOf: () => manager } as unknown as CapturePipeline,
    { write } as unknown as ChangeHistoryWriter,
  );
  return { capture, write, drafts, definitions, getCount };
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
      expect.stringContaining(`write failed in ${CHANGE_HISTORY_ACTIONS.channel_assigned}: insert failed`),
      expect.anything(),
      expect.anything(),
    );
  });
});
