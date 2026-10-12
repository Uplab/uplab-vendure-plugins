import { SimpleGraphQLClient } from '@vendure/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ACTIVE_CHANNEL_ZONES,
  ADD_OPTION_GROUP,
  ASSIGN_PRODUCTS_TO_CHANNEL,
  CHANGE_HISTORY_ENTRY,
  CHANGE_HISTORY_FEED,
  CHANGE_HISTORY_TIMELINE,
  CREATE_ASSETS,
  CREATE_CHANNEL,
  CREATE_OPTION_GROUP,
  CREATE_PRODUCT,
  CREATE_VARIANTS,
  REMOVE_PRODUCTS_FROM_CHANNEL,
  UPDATE_PRODUCT,
  UPDATE_VARIANTS,
} from './graphql';
import { decode, pngFile, settleJobs } from './helpers';

interface ChannelEnv {
  adminClient: SimpleGraphQLClient;
  /** Keeps channel codes apart between the suites' databases. */
  prefix: string;
}

interface FeedItem {
  id: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  action: string;
  batchId: string | null;
  derivedCount: number;
  meta: Record<string, unknown>;
  batchCounts: Array<{ entityType: string; action: string; count: number }> | null;
}

const COLLAPSED = { _or: [{ batchId: { isNull: true } }, { entityType: { eq: 'Batch' } }] };

/**
 * One channel operation is one feed row (US-2, Q8): core announces a product's variants and assets before the
 * product, the package writes them at the commit, derived from the product; several products of one call
 * form one batch. Run by both e2e suites.
 */
export function channelScenarios(env: ChannelEnv): void {
  describe('channel operations', () => {
    const { adminClient, prefix } = env;
    let channelId: string;
    const code = `${prefix}-ops`;

    const feed = async (filter: Record<string, unknown> = {}): Promise<FeedItem[]> =>
      (
        await adminClient.query(CHANGE_HISTORY_FEED, {
          options: { filter: { summary: { contains: `channel ${code}` }, ...filter }, sort: { createdAt: 'DESC' } },
        })
      ).changeHistoryEntries.items;

    const uploadAsset = async (name: string): Promise<string> =>
      (
        (
          await adminClient.fileUploadMutation({
            mutation: CREATE_ASSETS,
            filePaths: [pngFile(name)],
            mapVariables: () => ({ input: [{ file: null }] }),
          })
        ).createAssets as Array<{ id: string }>
      )[0].id;

    /** A product with one variant per SKU (sizes), two product images and an image on its first variant. */
    const productWithAssets = async (name: string, skus: string[]) => {
      const productId: string = (await adminClient.query(CREATE_PRODUCT, { name })).createProduct.id;
      const { createProductOptionGroup: sizes } = await adminClient.query(CREATE_OPTION_GROUP, {
        input: {
          code: `${name}-size`,
          translations: [{ languageCode: 'en', name: 'Size' }],
          options: skus.map((sku) => ({ code: `${name}-${sku}`, translations: [{ languageCode: 'en', name: sku }] })),
        },
      });
      await adminClient.query(ADD_OPTION_GROUP, { productId, optionGroupId: sizes.id });
      const { createProductVariants } = await adminClient.query(CREATE_VARIANTS, {
        input: skus.map((sku, index) => ({
          productId,
          sku,
          price: 1000,
          optionIds: [sizes.options[index].id],
          translations: [{ languageCode: 'en', name: `${name} ${sku}` }],
        })),
      });
      const product = { productId, variantIds: createProductVariants.map((variant: { id: string }) => variant.id) };
      const productAssets = [await uploadAsset(`${name}-a`), await uploadAsset(`${name}-b`)];
      const variantAsset = await uploadAsset(`${name}-v`);
      await adminClient.query(UPDATE_PRODUCT, {
        input: { id: product.productId, assetIds: productAssets, featuredAssetId: productAssets[0] },
      });
      await adminClient.query(UPDATE_VARIANTS, { input: [{ id: product.variantIds[0], assetIds: [variantAsset] }] });
      return product;
    };

    beforeAll(async () => {
      const { activeChannel } = await adminClient.query(ACTIVE_CHANNEL_ZONES);
      const { createChannel } = await adminClient.query(CREATE_CHANNEL, {
        input: {
          code,
          token: `${code}-token`,
          defaultLanguageCode: 'en',
          pricesIncludeTax: false,
          defaultCurrencyCode: 'USD',
          defaultShippingZoneId: activeChannel.defaultShippingZone.id,
          defaultTaxZoneId: activeChannel.defaultTaxZone.id,
        },
      });
      channelId = createChannel.id;
    });

    it('records one product assigned with its 3 variants and 3 images as one row, the rest derived from it', async () => {
      const { productId, variantIds } = await productWithAssets(`${prefix}-ch-one`, ['CH1-S', 'CH1-M', 'CH1-L']);
      await adminClient.query(ASSIGN_PRODUCTS_TO_CHANNEL, { input: { productIds: [productId], channelId } });

      const rows = await feed({ action: { eq: 'channel_assigned' } });
      expect(rows).toEqual([
        expect.objectContaining({
          entityType: 'Product',
          entityId: decode(productId),
          batchId: null,
          derivedCount: 6,
          meta: expect.objectContaining({ channelCode: code }),
        }),
      ]);
      const { changeHistoryEntry } = await adminClient.query(CHANGE_HISTORY_ENTRY, {
        id: rows[0].id,
        derived: { take: 10 },
      });
      expect(changeHistoryEntry.derivedEntries.totalItems).toBe(6);

      // The product's history: one item for the assignment, none for its variants.
      const { changeHistoryEntityTimeline } = await adminClient.query(CHANGE_HISTORY_TIMELINE, {
        entityType: 'Product',
        entityId: decode(productId),
        first: 50,
      });
      const assignments = changeHistoryEntityTimeline.items.filter(
        (item: FeedItem) => item.action === 'channel_assigned',
      );
      expect(assignments).toEqual([expect.objectContaining({ entityType: 'Product', derivedCount: 6 })]);

      // The variant's own history still shows its assignment.
      const variantTimeline = await adminClient.query(CHANGE_HISTORY_TIMELINE, {
        entityType: 'ProductVariant',
        entityId: decode(variantIds[0]),
      });
      expect(variantTimeline.changeHistoryEntityTimeline.items[0]).toMatchObject({
        action: 'channel_assigned',
        derivedFromId: rows[0].id,
      });
      // It names its cause: the product's assignment.
      const variantEntry = await adminClient.query(CHANGE_HISTORY_ENTRY, {
        id: variantTimeline.changeHistoryEntityTimeline.items[0].id,
      });
      expect(variantEntry.changeHistoryEntry.derivedFrom).toEqual({
        id: rows[0].id,
        entityType: 'Product',
        entityLabel: rows[0].entityLabel,
        action: 'channel_assigned',
      });

      await adminClient.query(REMOVE_PRODUCTS_FROM_CHANNEL, { input: { productIds: [productId], channelId } });
      expect(await feed({ action: { eq: 'channel_removed' } })).toEqual([
        expect.objectContaining({ entityType: 'Product', entityId: decode(productId), derivedCount: 3 }),
      ]);
      await settleJobs(adminClient);
    });

    it('records the bulk assignment and removal of several products as one batch row each', async () => {
      const products = [
        await productWithAssets(`${prefix}-ch-bulk-1`, ['CHB1-S', 'CHB1-M']),
        await productWithAssets(`${prefix}-ch-bulk-2`, ['CHB2-S']),
        await productWithAssets(`${prefix}-ch-bulk-3`, ['CHB3-S', 'CHB3-M']),
      ];
      const productIds = products.map((product) => product.productId);
      const ids = new Set(productIds.map(decode));
      const before = await feed({ _and: [COLLAPSED] });

      await adminClient.query(ASSIGN_PRODUCTS_TO_CHANNEL, { input: { productIds, channelId } });
      const after = await feed({ _and: [COLLAPSED] });
      const assigned = after.slice(0, after.length - before.length);
      expect(assigned).toEqual([
        expect.objectContaining({
          entityType: 'Batch',
          meta: expect.objectContaining({ kind: 'channel_assigned', channelCode: code }),
          batchCounts: [{ entityType: 'Product', action: 'channel_assigned', count: 3 }],
        }),
      ]);
      // Expanded: one row per product, its variants and images derived from it.
      const members = (await feed({ batchId: { eq: assigned[0].batchId } })).filter(
        (item) => item.entityType !== 'Batch',
      );
      expect(members.map((item) => item.entityId).sort()).toEqual([...ids].sort());
      expect(members.map((item) => item.derivedCount).sort()).toEqual([4, 5, 5]);

      await adminClient.query(REMOVE_PRODUCTS_FROM_CHANNEL, { input: { productIds, channelId } });
      const removed = await feed({ _and: [COLLAPSED], action: { in: ['batch', 'channel_removed'] } });
      expect(removed[0]).toMatchObject({
        entityType: 'Batch',
        meta: expect.objectContaining({ kind: 'channel_removed' }),
        batchCounts: [{ entityType: 'Product', action: 'channel_removed', count: 3 }],
      });
      await settleJobs(adminClient);
    });
  });
}
