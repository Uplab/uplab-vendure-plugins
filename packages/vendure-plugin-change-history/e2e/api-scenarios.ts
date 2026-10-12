import { INestApplication } from '@nestjs/common';
import { TransactionalConnection } from '@vendure/core';
import { SimpleGraphQLClient } from '@vendure/testing';
import type { DocumentNode } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import { ChangeHistoryEntry, ChangeHistoryService } from '../src';
import {
  ACTIVE_CHANNEL_ZONES,
  ADD_OPTION_GROUP,
  CHANGE_HISTORY_ENTRY,
  CHANGE_HISTORY_FEED,
  CHANGE_HISTORY_FILTER_OPTIONS,
  CHANGE_HISTORY_RUN_DETAILS,
  CHANGE_HISTORY_TIMELINE,
  CREATE_ADMINISTRATOR,
  CREATE_CHANNEL,
  CREATE_COLLECTION,
  CREATE_FACET,
  CREATE_OPTION_GROUP,
  CREATE_PRODUCT,
  CREATE_PRODUCT_WITH,
  CREATE_ROLE,
  CREATE_VARIANTS,
  DELETE_PRODUCT,
  UPDATE_FACET_VALUES,
  UPDATE_PRODUCT,
  UPDATE_VARIANTS,
} from './graphql';
import { createProduct, decode, entriesWhere, facetFilter, settleJobs, superadminCtx, waitFor } from './helpers';

const DAY_MS = 86_400_000;

interface ApiEnv {
  app: () => INestApplication;
  adminClient: SimpleGraphQLClient;
  /** Postgres: entries of one transaction share `now()` to the microsecond. */
  postgres: boolean;
}

interface Item {
  id: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  action: string;
  [field: string]: any;
}

/** The Admin API id of a database id under the testing id strategy. */
const encode = (id: unknown) => `T_${String(id)}`;

/**
 * The Admin API read side against a real database, shared by the sql.js and the Postgres suites: the feed's
 * filters and per-entry fields, one entry with its derived entries and batch members, entity timelines
 * (keyset paging, children, runs per product), run details, filter options and the permission.
 */
export function apiScenarios(env: ApiEnv): void {
  describe('Admin API', () => {
    const query = (document: DocumentNode, variables: Record<string, unknown> = {}): Promise<any> =>
      env.adminClient.query(document, variables);
    const entries = () => env.app().get(TransactionalConnection).rawConnection.getRepository(ChangeHistoryEntry);
    const history = () => env.app().get(ChangeHistoryService);
    const insert = (input: Partial<ChangeHistoryEntry>) =>
      entries().save(
        Object.assign(new ChangeHistoryEntry(), {
          source: 'admin',
          actorType: 'admin',
          actorId: null,
          actorLabel: null,
          parentType: null,
          parentId: null,
          batchId: null,
          channelId: null,
          summary: 'api test',
          meta: {},
          changes: null,
          derivedFromId: null,
          compactedAt: null,
          ...input,
        }),
      );
    const feed = async (filter: Record<string, unknown>, options: Record<string, unknown> = {}) =>
      (await query(CHANGE_HISTORY_FEED, { options: { filter, ...options } })).changeHistoryEntries as {
        items: Item[];
        totalItems: number;
      };
    const timeline = async (variables: Record<string, unknown>) =>
      (await query(CHANGE_HISTORY_TIMELINE, variables)).changeHistoryEntityTimeline as {
        items: Item[];
        endCursor: string | null;
        hasMore: boolean;
      };

    describe('the feed', () => {
      const seeded: Record<string, ChangeHistoryEntry> = {};
      const base = { entityLabel: { contains: 'p2f-' } };
      const labels = async (filter: Record<string, unknown>) =>
        (await feed({ ...base, ...filter })).items.map((item) => item.entityLabel).sort();

      beforeAll(async () => {
        const admin = { actorId: '901', actorLabel: 'Feed Admin' };
        const bulk = { batchId: 'bulk_edit:p2f', actorId: '902', actorLabel: 'Bulk Admin' };
        seeded.one = await insert({
          entityType: 'Product',
          entityId: 'p2f-1',
          entityLabel: 'p2f-one',
          action: 'updated',
          ...admin,
        });
        seeded.two = await insert({
          entityType: 'ProductVariant',
          entityId: 'p2f-2',
          entityLabel: 'p2f-two (P2F-SKU)',
          action: 'created',
          source: 'api_key',
          actorType: 'api_key',
          actorId: '901',
          actorLabel: 'Feed Admin (API key)',
        });
        seeded.three = await insert({
          entityType: 'Collection',
          entityId: 'p2f-3',
          entityLabel: 'p2f-three',
          action: 'deleted',
          source: 'collection_rules',
          actorType: 'system',
        });
        seeded.four = await insert({
          entityType: 'Run',
          entityId: 'p2f_sync',
          entityLabel: 'p2f-four',
          action: 'run',
          source: 'p2f_sync',
          actorType: 'system',
        });
        seeded.five = await insert({
          entityType: 'ProductVariant',
          entityId: 'p2f-5',
          entityLabel: 'p2f-five',
          action: 'updated',
          derivedFromId: seeded.one.id,
          ...admin,
        });
        seeded.head = await insert({
          entityType: 'Batch',
          entityId: 'p2f',
          entityLabel: 'p2f-batch',
          action: 'batch',
          ...bulk,
        });
        seeded.m1 = await insert({
          entityType: 'Product',
          entityId: 'p2f-m1',
          entityLabel: 'p2f-member-1',
          action: 'updated',
          ...bulk,
        });
        seeded.m2 = await insert({
          entityType: 'Product',
          entityId: 'p2f-m2',
          entityLabel: 'p2f-member-2',
          action: 'updated',
          ...bulk,
        });
        await entries().update({ id: seeded.one.id }, { createdAt: new Date(Date.now() - 2 * DAY_MS) });
      });

      it('lists newest first and leaves derived entries out unless asked for', async () => {
        const { items, totalItems } = await feed(base);
        expect(items.map((item) => item.entityLabel)).toEqual([
          'p2f-member-2',
          'p2f-member-1',
          'p2f-batch',
          'p2f-four',
          'p2f-three',
          'p2f-two (P2F-SKU)',
          'p2f-one',
        ]);
        expect(totalItems).toBe(7);
        expect(await labels({ derivedFromId: { eq: encode(seeded.one.id) } })).toEqual(['p2f-five']);
      });

      it('filters by actor, actor type, period, entity type, action, source, label and batch', async () => {
        expect(await labels({ actorId: { eq: encode(901) } })).toEqual(['p2f-one', 'p2f-two (P2F-SKU)']);
        // "Hide system changes".
        expect(await labels({ actorType: { in: ['admin', 'api_key'] } })).toEqual([
          'p2f-batch',
          'p2f-member-1',
          'p2f-member-2',
          'p2f-one',
          'p2f-two (P2F-SKU)',
        ]);
        const period = {
          between: {
            start: new Date(Date.now() - 3 * DAY_MS).toISOString(),
            end: new Date(Date.now() - DAY_MS).toISOString(),
          },
        };
        expect(await labels({ createdAt: period })).toEqual(['p2f-one']);
        expect(await labels({ entityType: { in: ['Product', 'Collection'] } })).toEqual([
          'p2f-member-1',
          'p2f-member-2',
          'p2f-one',
          'p2f-three',
        ]);
        expect(await labels({ action: { in: ['created', 'deleted'] } })).toEqual(['p2f-three', 'p2f-two (P2F-SKU)']);
        expect(await labels({ source: { in: ['p2f_sync'] } })).toEqual(['p2f-four']);
        // Search: the label snapshot holds a variant's SKU, matched regardless of case.
        expect((await feed({ entityLabel: { contains: 'p2f-sku' } })).items.map((item) => item.entityLabel)).toEqual([
          'p2f-two (P2F-SKU)',
        ]);
        expect(await labels({ batchId: { eq: 'bulk_edit:p2f' } })).toEqual([
          'p2f-batch',
          'p2f-member-1',
          'p2f-member-2',
        ]);
        // "Collapse batches".
        expect(await labels({ _or: [{ batchId: { isNull: true } }, { entityType: { eq: 'Batch' } }] })).toEqual([
          'p2f-batch',
          'p2f-four',
          'p2f-one',
          'p2f-three',
          'p2f-two (P2F-SKU)',
        ]);
      });

      it("says whether an entry's parent is gone", async () => {
        const collection = await insert({
          entityType: 'Batch',
          entityId: 'pd-parent',
          entityLabel: 'pd-gone-parent',
          action: 'batch',
          batchId: 'collection_rules:pd-gone',
          parentType: 'Collection',
          parentId: '999999',
        });
        const host = await insert({
          entityType: 'Product',
          entityId: 'pd-host',
          entityLabel: 'pd-host-parent',
          action: 'updated',
          parentType: 'Wishlist',
          parentId: '999999',
        });
        const read = async (id: unknown) =>
          (await query(CHANGE_HISTORY_ENTRY, { id: encode(id) })).changeHistoryEntry as Item;
        expect(await read(collection.id)).toMatchObject({ parentDeleted: true, entityDeleted: false });
        // A host type is never checked; an entry without a parent has none to lose.
        expect(await read(host.id)).toMatchObject({ parentDeleted: false });
        expect(await read(seeded.one.id)).toMatchObject({ parentDeleted: false });
      });

      it('counts derived entries and batch members, live and from the compaction snapshot', async () => {
        await insert({
          entityType: 'Product',
          entityId: 'p2f-c1',
          entityLabel: 'p2f-compacted-cause',
          action: 'updated',
          compactedAt: new Date(),
          meta: { derivedCount: 3 },
        });
        await insert({
          entityType: 'Batch',
          entityId: 'p2f-c2',
          entityLabel: 'p2f-compacted-batch',
          action: 'batch',
          batchId: 'bulk_edit:p2f-compacted',
          compactedAt: new Date(),
          meta: { batchCounts: [{ entityType: 'Product', action: 'updated', count: 120 }] },
        });
        const { items } = await feed(base);
        const item = (label: string) => items.find((entry) => entry.entityLabel === label);

        expect(item('p2f-one')).toMatchObject({ derivedCount: 1, batchCounts: null, isCompacted: false });
        expect(item('p2f-two (P2F-SKU)')).toMatchObject({ actorType: 'api_key', actorLabel: 'Feed Admin' });
        expect(item('p2f-batch')).toMatchObject({
          derivedCount: 0,
          batchCounts: [{ entityType: 'Product', action: 'updated', count: 2 }],
          entityDeleted: false,
        });
        expect(item('p2f-compacted-cause')).toMatchObject({ derivedCount: 3, isCompacted: true });
        expect(item('p2f-compacted-batch')).toMatchObject({
          batchCounts: [{ entityType: 'Product', action: 'updated', count: 120 }],
          isCompacted: true,
        });
      });

      it('serves one entry with its derived entries and its batch members, paged', async () => {
        const { changeHistoryEntry: cause } = await query(CHANGE_HISTORY_ENTRY, { id: encode(seeded.one.id) });
        expect(cause).toMatchObject({ entityLabel: 'p2f-one', derivedCount: 1 });
        expect(cause.derivedEntries).toEqual({
          items: [{ id: encode(seeded.five.id), entityLabel: 'p2f-five' }],
          totalItems: 1,
        });
        expect(cause.batchMembers).toEqual({ items: [], totalItems: 0 });

        const { changeHistoryEntry: head } = await query(CHANGE_HISTORY_ENTRY, {
          id: encode(seeded.head.id),
          members: { take: 1 },
        });
        expect(head.batchMembers).toEqual({
          items: [{ id: encode(seeded.m2.id), entityLabel: 'p2f-member-2' }],
          totalItems: 2,
        });

        expect((await query(CHANGE_HISTORY_ENTRY, { id: encode(999_999) })).changeHistoryEntry).toBeNull();
      });

      it('lists the actors, sources, actions and entity types of the period, new values at once', async () => {
        const { changeHistoryFilterOptions: options } = await query(CHANGE_HISTORY_FILTER_OPTIONS);
        expect(options.actors).toEqual(
          expect.arrayContaining([
            { id: encode(901), type: 'admin', label: 'Feed Admin' },
            // A row of a pre-release version said "Feed Admin (API key)": read as the plain name.
            { id: encode(901), type: 'api_key', label: 'Feed Admin' },
            { id: encode(902), type: 'admin', label: 'Bulk Admin' },
          ]),
        );
        expect(options.sources).toEqual(expect.arrayContaining(['admin', 'api_key', 'collection_rules', 'p2f_sync']));
        expect(options.actions).toEqual(expect.arrayContaining(['batch', 'created', 'deleted', 'run', 'updated']));
        expect(options.entityTypes).toEqual(expect.arrayContaining(['Batch', 'Collection', 'Product', 'Run']));

        await history().recordAction(await superadminCtx(env.app()), {
          entityType: 'Product',
          entityId: 'p2f-late',
          entityLabel: 'p2f-late',
          action: 'p2f_late_action',
        });
        const { changeHistoryFilterOptions: after } = await query(CHANGE_HISTORY_FILTER_OPTIONS);
        expect(after.actions).toContain('p2f_late_action');
      });
    });

    describe('entity timelines', () => {
      let productId: string;
      let variantS: string;
      let variantM: string;
      let otherVariant: string;
      let facetId: string;
      let tagId: string;
      let collectionId: string;

      beforeAll(async () => {
        const { createFacet } = await query(CREATE_FACET, {
          input: {
            code: 'p2-tag',
            isPrivate: false,
            translations: [{ languageCode: 'en', name: 'Tag' }],
            values: [{ code: 'p2-new', translations: [{ languageCode: 'en', name: 'New' }] }],
          },
        });
        facetId = createFacet.id;
        tagId = createFacet.values[0].id;

        productId = (await query(CREATE_PRODUCT, { name: 'p2-tee' })).createProduct.id;
        const { createProductOptionGroup: sizes } = await query(CREATE_OPTION_GROUP, {
          input: {
            code: 'p2-size',
            translations: [{ languageCode: 'en', name: 'Size' }],
            options: ['s', 'm'].map((size) => ({
              code: `p2-size-${size}`,
              translations: [{ languageCode: 'en', name: size.toUpperCase() }],
            })),
          },
        });
        await query(ADD_OPTION_GROUP, { productId, optionGroupId: sizes.id });
        const { createProductVariants } = await query(CREATE_VARIANTS, {
          input: ['S', 'M'].map((size, index) => ({
            productId,
            sku: `P2-TEE-${size}`,
            price: 1000,
            optionIds: [sizes.options[index].id],
            translations: [{ languageCode: 'en', name: `p2-tee ${size}` }],
          })),
        });
        [variantS, variantM] = createProductVariants.map((variant: { id: string }) => variant.id);
        otherVariant = (await createProduct(env.adminClient, 'p2-other', ['P2-OTHER'])).variantIds[0];

        await query(UPDATE_PRODUCT, { input: { id: productId, facetValueIds: [tagId] } });
        await settleJobs(env.adminClient);
        collectionId = (
          await query(CREATE_COLLECTION, {
            input: {
              translations: [{ languageCode: 'en', name: 'p2-new-in', slug: 'p2-new-in', description: '' }],
              filters: facetFilter([tagId]),
            },
          })
        ).createCollection.id;
        await settleJobs(env.adminClient);
        await waitFor(
          () => entriesWhere(env.app(), { entityId: decode(productId), action: 'collection_added' }),
          (found) => found.length > 0,
        );

        await query(UPDATE_VARIANTS, { input: [{ id: variantM, price: 1200 }] });
        const stock = (variant: string, scope: string, from: number, to: number) => ({
          entityType: 'ProductVariant',
          entityId: decode(variant),
          kind: 'stock',
          scope,
          scopeLabel: scope === 'a' ? 'Kyiv' : 'Lviv',
          from,
          to,
        });
        await history().recordRun(await superadminCtx(env.app()), {
          source: 'p2_stock_sync',
          label: 'p2 stock sync',
          counts: { updated: 4 },
          details: [
            stock(variantM, 'b', 0, 2),
            stock(variantS, 'a', 7, 8),
            stock(otherVariant, 'a', 1, 0),
            stock(variantM, 'a', 19, 17),
          ],
        });
      });

      it("shows a product's own entries, its variants', its collection contents and one item per run", async () => {
        const { items, hasMore } = await timeline({ entityType: 'Product', entityId: decode(productId), first: 50 });
        expect(hasMore).toBe(false);
        expect(items.slice(0, 3).map((item) => [item.entityType, item.action])).toEqual([
          ['Run', 'run'],
          ['ProductVariant', 'updated'],
          ['Product', 'collection_added'],
        ]);
        const [run, variantUpdate, added] = items;
        // Only this product's rows, sorted by SKU, then location.
        expect(run.details.map((d: Item) => [d.sku, d.scopeLabel, d.from, d.to])).toEqual([
          ['P2-TEE-M', 'Kyiv', 19, 17],
          ['P2-TEE-M', 'Lviv', 0, 2],
          ['P2-TEE-S', 'Kyiv', 7, 8],
        ]);
        expect(run).toMatchObject({ detailsTotal: 3, detailsEntityCount: 2 });
        expect(run.details[0]).toMatchObject({
          entityType: 'ProductVariant',
          entityId: decode(variantM),
          entityLabel: 'p2-tee M',
          parentType: 'Product',
          parentId: decode(productId),
          kind: 'stock',
          scope: 'a',
        });
        expect(variantUpdate).toMatchObject({ entityId: decode(variantM), entityLabel: 'p2-tee M (P2-TEE-M)' });
        expect(added).toMatchObject({
          entityId: decode(productId),
          parentType: 'Collection',
          parentId: decode(collectionId),
          source: 'collection_rules',
        });
        expect(items.filter((item) => item.entityType === 'Product').map((item) => item.action)).toEqual(
          expect.arrayContaining(['created', 'updated', 'collection_added']),
        );
        expect(items.filter((item) => item.entityType !== 'Run').every((item) => item.details === null)).toBe(true);
        expect(items.filter((item) => item.entityType !== 'Run').every((item) => item.detailsTotal === null)).toBe(
          true,
        );
        expect(added).toMatchObject({ parentDeleted: false });

        const own = await timeline({ entityType: 'Product', entityId: decode(productId), includeChildren: false });
        expect(own.items.every((item) => item.entityType === 'Product')).toBe(true);
      });

      it("shows a variant's own entries and its rows of each run", async () => {
        const { items } = await timeline({ entityType: 'ProductVariant', entityId: decode(variantM) });
        expect(items.slice(0, 2).map((item) => [item.entityType, item.action])).toEqual([
          ['Run', 'run'],
          ['ProductVariant', 'updated'],
        ]);
        expect(items[0].details.map((d: Item) => [d.scopeLabel, d.from, d.to])).toEqual([
          ['Kyiv', 19, 17],
          ['Lviv', 0, 2],
        ]);
        expect(items.every((item) => ['Run', 'ProductVariant'].includes(item.entityType))).toBe(true);
      });

      it('shows a just-saved change at once', async () => {
        await query(UPDATE_PRODUCT, {
          input: { id: productId, translations: [{ languageCode: 'en', name: 'p2-tee basic' }] },
        });
        const { items, hasMore } = await timeline({ entityType: 'Product', entityId: decode(productId), first: 1 });
        expect(items).toEqual([
          expect.objectContaining({ entityType: 'Product', action: 'updated', entityLabel: 'p2-tee basic' }),
        ]);
        expect(hasMore).toBe(true);
      });

      it("shows a collection's own entries, its rules batches with the members collapsed, and child collections", async () => {
        const childId = (
          await query(CREATE_COLLECTION, {
            input: {
              parentId: collectionId,
              translations: [{ languageCode: 'en', name: 'p2-new-in-kids', slug: 'p2-new-in-kids', description: '' }],
              filters: [],
            },
          })
        ).createCollection.id;
        await settleJobs(env.adminClient);

        const { items } = await timeline({ entityType: 'Collection', entityId: decode(collectionId) });
        expect(items.some((item) => item.entityType === 'Product')).toBe(false);
        expect(items).toContainEqual(
          expect.objectContaining({
            entityType: 'Batch',
            source: 'collection_rules',
            batchCounts: [{ entityType: 'Product', action: 'collection_added', count: 1 }],
          }),
        );
        expect(items).toContainEqual(
          expect.objectContaining({ entityType: 'Collection', entityId: decode(childId), action: 'created' }),
        );
        expect(items.at(-1)).toMatchObject({
          entityType: 'Collection',
          entityId: decode(collectionId),
          action: 'created',
        });
      });

      it("shows a facet's own entries and its values' changes", async () => {
        await query(UPDATE_FACET_VALUES, {
          input: [{ id: tagId, translations: [{ languageCode: 'en', name: 'Newest' }] }],
        });
        const { items } = await timeline({ entityType: 'Facet', entityId: decode(facetId) });
        expect(items[0]).toMatchObject({ entityType: 'FacetValue', entityId: decode(tagId), action: 'updated' });
        expect(items).toContainEqual(expect.objectContaining({ entityType: 'Facet', action: 'created' }));
      });

      it('caps the rows of a large run on a timeline item and counts them all', async () => {
        const rows = [variantS, variantM].flatMap((variant) =>
          Array.from({ length: 30 }, (_, index) => ({
            entityType: 'ProductVariant',
            entityId: decode(variant),
            kind: 'stock',
            scope: `cap-${index}`,
            from: index,
            to: index + 1,
          })),
        );
        await history().recordRun(await superadminCtx(env.app()), {
          source: 'p2_stock_sync',
          label: 'p2 large sync',
          counts: { updated: rows.length },
          details: rows,
        });
        const { items } = await timeline({ entityType: 'Product', entityId: decode(productId), first: 1 });
        expect(items[0]).toMatchObject({ entityType: 'Run', detailsTotal: 60, detailsEntityCount: 2 });
        expect(items[0].details).toHaveLength(50);
        const variant = await timeline({ entityType: 'ProductVariant', entityId: decode(variantS), first: 1 });
        expect(variant.items[0]).toMatchObject({ detailsTotal: 30, detailsEntityCount: 1 });
        expect(variant.items[0].details).toHaveLength(30);
        const [run] = await entriesWhere(env.app(), { entityLabel: 'p2 large sync' });
        const all = (await query(CHANGE_HISTORY_RUN_DETAILS, { entryId: encode(run.id), skip: 50, take: 100 }))
          .changeHistoryRunDetails;
        expect(all).toMatchObject({ totalItems: 60 });
        expect(all.items).toHaveLength(10);
      });

      it("serves a run's rows with current labels, sorted by SKU, paged", async () => {
        const [run] = await entriesWhere(env.app(), { entityLabel: 'p2 stock sync' });
        const page = async (skip: number) =>
          (await query(CHANGE_HISTORY_RUN_DETAILS, { entryId: encode(run.id), skip, take: 2 })).changeHistoryRunDetails;
        const first = await page(0);
        expect(first.totalItems).toBe(4);
        expect(first.items.map((d: Item) => [d.sku, d.scopeLabel])).toEqual([
          ['P2-OTHER', 'Kyiv'],
          ['P2-TEE-M', 'Kyiv'],
        ]);
        expect(first.items[0]).toMatchObject({ entryId: encode(run.id), entityLabel: 'P2-OTHER', from: 1, to: 0 });
        expect((await page(2)).items.map((d: Item) => [d.sku, d.scopeLabel])).toEqual([
          ['P2-TEE-M', 'Lviv'],
          ['P2-TEE-S', 'Kyiv'],
        ]);
      });

      it('marks the entries of a deleted entity', async () => {
        const { productId: gone } = await createProduct(env.adminClient, 'p2-gone', ['P2-GONE']);
        await query(DELETE_PRODUCT, { id: gone });
        const deleted = await feed({ entityLabel: { contains: 'p2-gone' } });
        expect(deleted.items[0]).toMatchObject({ entityType: 'Product', action: 'deleted', entityDeleted: true });
        expect(deleted.items.map((item) => item.entityType)).toContain('ProductVariant');
        expect(deleted.items.every((item) => item.entityDeleted)).toBe(true);
        // Each value's kind and the labels of the ids in it, so the last state renders like a diff.
        const { createProduct: described } = await query(CREATE_PRODUCT_WITH, {
          input: {
            enabled: false,
            facetValueIds: [tagId],
            translations: [
              { languageCode: 'en', name: 'p2-described', slug: 'p2-described', description: '<p>Soft</p>' },
            ],
          },
        });
        await query(DELETE_PRODUCT, { id: described.id });
        const [last] = (await feed({ entityLabel: { eq: 'p2-described' }, action: { eq: 'deleted' } })).items;
        expect(last.meta.lastState).toMatchObject({ 'description.en': '<p>Soft</p>', enabled: false });
        expect(last.meta.lastStateFields).toMatchObject({
          'description.en': { kind: 'richtext' },
          enabled: { kind: 'bool' },
          facetValues: { kind: 'refs', labels: { [decode(tagId)]: expect.stringMatching(/^Tag: /) } },
        });
        expect(last.meta.lastStateFields).not.toHaveProperty('name.en');
        const alive = await feed({ entityType: { eq: 'Product' }, entityId: { eq: decode(productId) } });
        expect(alive.items.length).toBeGreaterThan(0);
        expect(alive.items.every((item) => !item.entityDeleted)).toBe(true);
      });
    });

    it('pages a timeline through entries that share one transaction (R5-2)', async () => {
      const ctx = await superadminCtx(env.app());
      await env
        .app()
        .get(TransactionalConnection)
        .withTransaction(ctx, async (tctx) => {
          for (let step = 0; step < 5; step++) {
            await history().recordAction(tctx, {
              entityType: 'Product',
              entityId: 'p2-tx',
              entityLabel: 'p2-tx',
              action: `step_${step}`,
            });
          }
        });
      if (env.postgres) {
        // One timestamp, to the microsecond: a cursor holding a JS Date would skip the rest of the group.
        const stamps = await env
          .app()
          .get(TransactionalConnection)
          .rawConnection.query(
            `SELECT DISTINCT CAST("createdAt" AS text) AS stamp FROM change_history_entry WHERE "entityId" = 'p2-tx'`,
          );
        expect(stamps).toHaveLength(1);
      }

      const actions: string[] = [];
      let after: string | null = null;
      let pages = 0;
      do {
        const page = await timeline({ entityType: 'Product', entityId: 'p2-tx', first: 2, after });
        actions.push(...page.items.map((item) => item.action));
        after = page.hasMore ? page.endCursor : null;
        pages++;
      } while (after && pages < 10);
      expect(actions).toEqual(['step_4', 'step_3', 'step_2', 'step_1', 'step_0']);
      expect(pages).toBe(3);

      await expect(timeline({ entityType: 'Product', entityId: 'p2-tx', after: 'nonsense' })).rejects.toThrow(
        /Invalid change history cursor/,
      );
    });

    it('pages the members of a batch written in one transaction without a gap or a repeat', async () => {
      const ctx = await superadminCtx(env.app());
      // On Postgres the rows share one timestamp; ordered by it alone, 300 of them paged by 20 came back as
      // 294 distinct ids (the top-N sort orders ties differently per LIMIT). Smaller batches may not show it.
      const size = 300;
      await env
        .app()
        .get(TransactionalConnection)
        .withTransaction(ctx, (tctx) =>
          history().runBatch(tctx, { kind: 'm1_paging', label: 'm1-batch' }, async (bctx) => {
            for (let step = 0; step < size; step++) {
              await history().recordAction(bctx, {
                entityType: 'Product',
                entityId: `m1-${step}`,
                entityLabel: `m1-member-${step}`,
                action: 'm1_step',
              });
            }
          }),
        );
      const [head] = await entriesWhere(env.app(), { entityLabel: 'm1-batch' });
      const pages = async (read: (skip: number) => Promise<{ items: Array<{ id: string }>; totalItems: number }>) => {
        const ids: string[] = [];
        for (let skip = 0; skip < size + 20; skip += 20) {
          const page = await read(skip);
          expect(page.totalItems).toBe(size);
          ids.push(...page.items.map((item) => item.id));
        }
        return ids;
      };
      for (const sort of [{ createdAt: 'ASC' }, { createdAt: 'DESC' }]) {
        const members = await pages(
          async (skip) =>
            (await query(CHANGE_HISTORY_ENTRY, { id: encode(head.id), members: { skip, take: 20, sort } }))
              .changeHistoryEntry.batchMembers,
        );
        expect(members).toHaveLength(size);
        expect(new Set(members).size).toBe(size);
        const feedIds = await pages((skip) =>
          feed({ batchId: { eq: head.batchId }, entityType: { notEq: 'Batch' } }, { skip, take: 20, sort }),
        );
        expect(new Set(feedIds).size).toBe(size);
      }
    });

    it('names no batch recorded without a label: its kind is a key for the client to label', async () => {
      const ctx = await superadminCtx(env.app());
      await history().runBatch(ctx, { kind: 'nolabel_kind' }, (bctx) =>
        history().recordAction(bctx, {
          entityType: 'Product',
          entityId: 'nolabel-1',
          entityLabel: 'nolabel-member',
          action: 'nolabel_action',
        }),
      );
      const [member] = await entriesWhere(env.app(), { entityLabel: 'nolabel-member' });
      const [head] = await entriesWhere(env.app(), { batchId: member.batchId, entityType: 'Batch' });
      // Stored with the kind, for any other reader of the table.
      expect(head).toMatchObject({ entityLabel: 'nolabel_kind', meta: { kind: 'nolabel_kind' } });
      const read = (await query(CHANGE_HISTORY_ENTRY, { id: encode(head.id) })).changeHistoryEntry as Item;
      expect(read).toMatchObject({ entityType: 'Batch', entityLabel: null, meta: { kind: 'nolabel_kind' } });
      // A labelled batch keeps its label.
      expect((await feed({ batchId: { eq: 'bulk_edit:p2f' }, entityType: { eq: 'Batch' } })).items[0]).toMatchObject({
        entityLabel: 'p2f-batch',
      });
    });

    it('serves only the entity types whose read permission the reader holds, in every query', async () => {
      const ctx = await superadminCtx(env.app());
      const channelId = String(ctx.channelId);
      const head = await insert({
        entityType: 'Batch',
        entityId: 'm7-batch',
        entityLabel: 'm7-batch',
        action: 'batch',
        batchId: 'bulk_edit:m7',
        channelId,
        meta: { kind: 'bulk_edit', label: 'm7-batch' },
      });
      const product = await insert({
        entityType: 'Product',
        entityId: 'm7-product',
        entityLabel: 'm7-product',
        action: 'updated',
        batchId: 'bulk_edit:m7',
        channelId,
        actorId: '977',
        actorLabel: 'M7 Cataloguer',
      });
      const promotion = await insert({
        entityType: 'Promotion',
        entityId: 'm7-promotion',
        entityLabel: 'm7-promotion',
        action: 'm7_promotion_action',
        source: 'm7_promotion_source',
        batchId: 'bulk_edit:m7',
        channelId,
        derivedFromId: null,
        changes: { couponCode: { kind: 'text', from: 'OLD', to: 'SECRET' } },
      });
      await insert({
        entityType: 'Promotion',
        entityId: 'm7-promotion-derived',
        entityLabel: 'm7-promotion-derived',
        action: 'updated',
        channelId,
        derivedFromId: product.id,
      });
      await insert({
        entityType: 'E2eSecret',
        entityId: 'm7-s',
        entityLabel: 'm7-secret',
        action: 'updated',
        channelId,
      });
      await insert({ entityType: 'E2eOpen', entityId: 'm7-o', entityLabel: 'm7-open', action: 'updated', channelId });
      await history().recordRun(ctx, {
        source: 'm7_sync',
        label: 'm7-run',
        counts: { updated: 2 },
        details: [
          { entityType: 'Product', entityId: 'm7-product', kind: 'field', from: 1, to: 2 },
          { entityType: 'Promotion', entityId: 'm7-promotion', kind: 'field', from: 'A', to: 'B' },
        ],
      });
      const [run] = await entriesWhere(env.app(), { entityLabel: 'm7-run' });
      const { createRole } = await query(CREATE_ROLE, {
        input: {
          code: 'm7-cataloguer',
          description: 'm7-cataloguer',
          permissions: ['ReadChangeHistory', 'ReadCatalog'],
        },
      });
      await query(CREATE_ADMINISTRATOR, {
        input: {
          firstName: 'M7',
          lastName: 'Cataloguer',
          emailAddress: 'm7-cataloguer@example.com',
          password: 'm7-cataloguer',
          roleIds: [createRole.id],
        },
      });
      const labels = async () =>
        (await feed({ entityLabel: { contains: 'm7-' }, derivedFromId: { isNull: false } }, {})).items
          .concat((await feed({ entityLabel: { contains: 'm7-' } })).items)
          .map((item) => item.entityLabel)
          .sort();
      const readEntry = async (id: unknown) =>
        (await query(CHANGE_HISTORY_ENTRY, { id: encode(id), members: { take: 10 } })).changeHistoryEntry;
      const runRows = async () =>
        (await query(CHANGE_HISTORY_RUN_DETAILS, { entryId: encode(run.id) })).changeHistoryRunDetails.items.map(
          (row: Item) => row.entityType,
        );

      expect(await labels()).toEqual([
        'm7-batch',
        'm7-open',
        'm7-product',
        'm7-promotion',
        'm7-promotion-derived',
        'm7-run',
        'm7-secret',
      ]);
      expect(await runRows()).toEqual(['Product', 'Promotion']);
      try {
        await env.adminClient.asUserWithCredentials('m7-cataloguer@example.com', 'm7-cataloguer');
        // Promotions need ReadPromotion and the host's E2eSecret ReadSettings; batches, runs and unlisted types
        // need ReadChangeHistory only.
        expect(await labels()).toEqual(['m7-batch', 'm7-open', 'm7-product', 'm7-run']);
        expect(await readEntry(promotion.id)).toBeNull();
        const readHead = await readEntry(head.id);
        expect(readHead.batchMembers).toEqual({
          items: [{ id: encode(product.id), entityLabel: 'm7-product' }],
          totalItems: 1,
        });
        expect(readHead.batchCounts).toEqual([{ entityType: 'Product', action: 'updated', count: 1 }]);
        expect((await readEntry(product.id)).derivedCount).toBe(0);
        expect(await runRows()).toEqual(['Product']);
        expect((await timeline({ entityType: 'Promotion', entityId: 'm7-promotion' })).items).toEqual([]);
        const productTimeline = await timeline({ entityType: 'Product', entityId: 'm7-product' });
        expect(productTimeline.items.map((item) => item.entityLabel)).toEqual(['m7-run', 'm7-product']);
        expect(productTimeline.items[0].details.map((row: Item) => row.entityType)).toEqual(['Product']);
        const { changeHistoryFilterOptions: options } = await query(CHANGE_HISTORY_FILTER_OPTIONS);
        expect(options.entityTypes).not.toEqual(expect.arrayContaining(['Promotion']));
        expect(options.entityTypes).not.toContain('E2eSecret');
        expect(options.actions).not.toContain('m7_promotion_action');
        expect(options.sources).not.toContain('m7_promotion_source');
      } finally {
        await env.adminClient.asSuperAdmin();
      }
    });

    it('needs ReadChangeHistory for every query', async () => {
      const administrator = async (code: string, permissions: string[]) => {
        const { createRole } = await query(CREATE_ROLE, { input: { code, description: code, permissions } });
        await query(CREATE_ADMINISTRATOR, {
          input: {
            firstName: code,
            lastName: 'Admin',
            emailAddress: `${code}@example.com`,
            password: code,
            roleIds: [createRole.id],
          },
        });
        return `${code}@example.com`;
      };
      const reader = await administrator('p2-history-reader', ['ReadChangeHistory']);
      const cataloguer = await administrator('p2-catalogue-reader', ['ReadCatalog']);
      const queries: Array<[DocumentNode, Record<string, unknown>]> = [
        [CHANGE_HISTORY_FEED, {}],
        [CHANGE_HISTORY_ENTRY, { id: encode(1) }],
        [CHANGE_HISTORY_TIMELINE, { entityType: 'Product', entityId: '1' }],
        [CHANGE_HISTORY_RUN_DETAILS, { entryId: encode(1) }],
        [CHANGE_HISTORY_FILTER_OPTIONS, {}],
      ];
      try {
        await env.adminClient.asUserWithCredentials(reader, 'p2-history-reader');
        for (const [document, variables] of queries) {
          await expect(query(document, variables)).resolves.toBeDefined();
        }
        await env.adminClient.asUserWithCredentials(cataloguer, 'p2-catalogue-reader');
        for (const [document, variables] of queries) {
          await expect(query(document, variables)).rejects.toThrow(/not currently authorized/);
        }
      } finally {
        await env.adminClient.asSuperAdmin();
      }
    });

    it('serves only the channels in which the reader holds ReadChangeHistory; a SuperAdmin sees all', async () => {
      const ctx = await superadminCtx(env.app());
      const defaultChannelId = String(ctx.channelId);
      const { activeChannel } = await query(ACTIVE_CHANNEL_ZONES);
      const { createChannel } = await query(CREATE_CHANNEL, {
        input: {
          code: 'p3-scope',
          token: 'p3-scope-token',
          defaultLanguageCode: 'en',
          pricesIncludeTax: false,
          defaultCurrencyCode: 'USD',
          defaultShippingZoneId: activeChannel.defaultShippingZone.id,
          defaultTaxZoneId: activeChannel.defaultTaxZone.id,
        },
      });
      const scoped = decode(createChannel.id);
      const subject = { entityType: 'Product', entityId: 'p3s-subject' };
      const own = await insert({ ...subject, entityLabel: 'p3s-own', action: 'updated', channelId: scoped });
      const other = await insert({
        ...subject,
        entityLabel: 'p3s-other',
        action: 'p3s_hidden_action',
        source: 'p3s_hidden_source',
        channelId: defaultChannelId,
      });
      await history().recordRun(ctx, {
        source: 'p3s_sync',
        label: 'p3s-run',
        counts: { updated: 1 },
        details: [{ ...subject, kind: 'stock', from: 1, to: 2 }],
      });
      const [run] = await entriesWhere(env.app(), { entityLabel: 'p3s-run' });
      const { createRole } = await query(CREATE_ROLE, {
        input: {
          code: 'p3-scope-reader',
          description: 'p3-scope-reader',
          permissions: ['ReadChangeHistory', 'ReadCatalog'],
          channelIds: [createChannel.id],
        },
      });
      await query(CREATE_ADMINISTRATOR, {
        input: {
          firstName: 'Scope',
          lastName: 'Reader',
          emailAddress: 'p3-scope-reader@example.com',
          password: 'p3-scope-reader',
          roleIds: [createRole.id],
        },
      });
      const labels = async () =>
        (await feed({ entityLabel: { contains: 'p3s-' } })).items.map((item) => item.entityLabel).sort();
      const timelineLabels = async () => (await timeline(subject)).items.map((item) => item.entityLabel).sort();

      expect(await labels()).toEqual(['p3s-other', 'p3s-own', 'p3s-run']);
      expect(await timelineLabels()).toEqual(['p3s-other', 'p3s-own', 'p3s-run']);
      try {
        // Logging in selects the user's first channel: the one they may read.
        await env.adminClient.asUserWithCredentials('p3-scope-reader@example.com', 'p3-scope-reader');
        expect(await labels()).toEqual(['p3s-own']);
        expect(await timelineLabels()).toEqual(['p3s-own']);
        expect((await query(CHANGE_HISTORY_ENTRY, { id: encode(own.id) })).changeHistoryEntry).toMatchObject({
          entityLabel: 'p3s-own',
        });
        expect((await query(CHANGE_HISTORY_ENTRY, { id: encode(other.id) })).changeHistoryEntry).toBeNull();
        expect((await query(CHANGE_HISTORY_RUN_DETAILS, { entryId: encode(run.id) })).changeHistoryRunDetails).toEqual({
          items: [],
          totalItems: 0,
        });
        const { changeHistoryFilterOptions: options } = await query(CHANGE_HISTORY_FILTER_OPTIONS);
        expect(options.actions).toContain('updated');
        expect(options.actions).not.toContain('p3s_hidden_action');
        expect(options.sources).not.toEqual(expect.arrayContaining(['p3s_hidden_source', 'p3s_sync']));
      } finally {
        await env.adminClient.asSuperAdmin();
      }
    });
  });
}
