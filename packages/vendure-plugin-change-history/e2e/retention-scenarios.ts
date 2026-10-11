import { INestApplication } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ID, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { SimpleGraphQLClient } from '@vendure/testing';
import { In } from 'typeorm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ChangeHistoryArchiveLine,
  ChangeHistoryDetail,
  ChangeHistoryEntry,
  ChangeHistoryRetentionService,
  ChangeHistoryService,
  decodeChangeHistoryArchive,
  FileSystemArchiveStorage,
} from '../src';
import { resolveOptions } from '../src/options';
import { createProduct, decode, systemCtx } from './helpers';

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const LONG_HTML = `<p>${'x'.repeat(2_000)}</p>`;
const LONG_SKU = 'S'.repeat(1_500);

interface RetentionEnv {
  app: () => INestApplication;
  adminClient: SimpleGraphQLClient;
  archive: FileSystemArchiveStorage;
  archiveDir: string;
}

/**
 * Tiered retention against a real database, shared by the sql.js and the Postgres suites. Rows are written
 * directly (or through `recordRun`) and backdated, so nothing else in the suite is old enough to be touched.
 */
export function retentionScenarios(env: RetentionEnv): void {
  describe('retention', () => {
    const connection = () => env.app().get(TransactionalConnection).rawConnection;
    const entries = () => connection().getRepository(ChangeHistoryEntry);
    const details = () => connection().getRepository(ChangeHistoryDetail);
    const retention = () => env.app().get(ChangeHistoryRetentionService);
    const history = () => env.app().get(ChangeHistoryService);
    const byId = async (id: ID) => entries().findOne({ where: { id } });

    let ctx: RequestContext;
    const seeded: Record<string, ID> = {};
    let seededIds: ID[] = [];
    let runDetailCount = 0;
    let archiveKeys: string[] = [];

    const insert = (input: Partial<ChangeHistoryEntry>) =>
      entries().save(
        Object.assign(new ChangeHistoryEntry(), {
          entityLabel: String(input.entityId),
          source: 'admin',
          actorType: 'admin',
          summary: 'retention test',
          meta: {},
          changes: null,
          derivedFromId: null,
          compactedAt: null,
          ...input,
        }),
      );
    const backdate = async (ids: ID[], date: Date) => {
      await entries().update({ id: In(ids) }, { createdAt: date });
      await details().update({ entryId: In(ids) }, { createdAt: date });
    };
    const readArchive = async (keys: string[]): Promise<ChangeHistoryArchiveLine[]> =>
      (await Promise.all(keys.map((key) => readFile(path.join(env.archiveDir, key))))).flatMap((body) =>
        decodeChangeHistoryArchive(body),
      );

    beforeAll(async () => {
      ctx = await systemCtx(env.app());
      const parent = await insert({
        entityType: 'Product',
        entityId: 'rt-parent',
        action: 'updated',
        changes: {
          'description.en': { kind: 'richtext', from: LONG_HTML, to: `${LONG_HTML}!` },
          'name.en': { kind: 'text', from: 'Old', to: 'New' },
          sku: { kind: 'text', from: LONG_SKU, to: 'S' },
          facetValues: { kind: 'refs', added: ['1'], removed: [], labels: { 1: 'Colour: Black' } },
        },
      });
      seeded.parent = parent.id;
      seeded.derivedUpdate = (
        await insert({
          entityType: 'ProductVariant',
          entityId: 'rt-v1',
          parentType: 'Product',
          parentId: 'rt-parent',
          action: 'updated',
          derivedFromId: parent.id,
          changes: { price: { kind: 'money', from: 100, to: 90 } },
        })
      ).id;
      seeded.derivedDeleted = (
        await insert({
          entityType: 'ProductVariant',
          entityId: 'rt-v2',
          parentType: 'Product',
          parentId: 'rt-parent',
          action: 'deleted',
          derivedFromId: parent.id,
          meta: { lastState: { sku: 'V2', description: LONG_HTML } },
        })
      ).id;
      seeded.head = (
        await insert({
          entityType: 'Batch',
          entityId: 'rt-batch',
          action: 'batch',
          batchId: 'collection_rules:rt',
          meta: { kind: 'collection_rules', counts: { added: 2, removed: 0 } },
        })
      ).id;
      for (const member of ['rt-m1', 'rt-m2']) {
        seeded[member] = (
          await insert({
            entityType: 'Product',
            entityId: member,
            parentType: 'Collection',
            parentId: 'rt-c',
            action: 'collection_added',
            batchId: 'collection_rules:rt',
          })
        ).id;
      }
      const { variantIds } = await createProduct(env.adminClient, 'rt-run-product', ['RT-RUN-1']);
      await history().recordRun(ctx, {
        source: 'rt_sync',
        label: 'Retention sync',
        counts: { updated: 3 },
        details: ['1', '2', '3'].map((scope) => ({
          entityType: 'ProductVariant',
          entityId: decode(variantIds[0]),
          kind: 'stock',
          scope,
          from: 1,
          to: 2,
        })),
      });
      const [run] = await entries().find({ where: { source: 'rt_sync' } });
      seeded.run = run.id;
      runDetailCount = await details().count({ where: { entryId: run.id } });
      seededIds = Object.values(seeded);
      await backdate(seededIds, daysAgo(100));
    });

    it('previews and dry-runs a compaction without changing anything', async () => {
      expect(runDetailCount).toBe(3);
      expect((await retention().preview(ctx, { compactOlderThanDays: 90 })).compactable).toBe(seededIds.length);
      const before = await entries().find({ where: { id: In(seededIds) }, order: { id: 'ASC' } });

      const result = await retention().compact(ctx, { olderThanDays: 90, dryRun: true, batchSize: 3 });

      expect(result).toEqual({
        scanned: seededIds.length,
        archived: 0,
        archiveKeys: [],
        stripped: 2,
        derivedDeleted: 1,
        membersDeleted: 2,
        runsDeleted: 1,
        detailsDeleted: 3,
        batches: 3,
        drained: true,
      });
      expect(await entries().find({ where: { id: In(seededIds) }, order: { id: 'ASC' } })).toEqual(before);
      expect(await retention().compact(ctx, { olderThanDays: 90, dryRun: true, batchSize: 3, maxBatches: 1 })).toEqual(
        expect.objectContaining({ scanned: 3, batches: 1, drained: false }),
      );
    });

    it('strips and deletes nothing when the archive cannot be written or verified', async () => {
      const exists = vi.spyOn(env.archive, 'exists').mockResolvedValueOnce(false);
      await expect(retention().compact(ctx, { olderThanDays: 90 })).rejects.toThrow(/not found after writing/);
      exists.mockRestore();
      const put = vi.spyOn(env.archive, 'put').mockRejectedValueOnce(new Error('disk full'));
      await expect(retention().compact(ctx, { olderThanDays: 90 })).rejects.toThrow('disk full');
      put.mockRestore();

      const rows = await entries().find({ where: { id: In(seededIds) } });
      expect(rows).toHaveLength(seededIds.length);
      expect(rows.every((row) => row.compactedAt === null)).toBe(true);
      expect((await byId(seeded.parent))?.changes?.['description.en']).toMatchObject({ from: LONG_HTML });
      expect(await details().count({ where: { entryId: seeded.run } })).toBe(3);
    });

    it('archives the full record first, then compacts: values stripped, child rows deleted, counts kept', async () => {
      const progress: number[] = [];
      const result = await retention().compact(ctx, {
        olderThanDays: 90,
        batchSize: 3,
        onProgress: (n) => {
          progress.push(n);
          throw new Error('a failing progress callback is ignored');
        },
      });

      expect(result).toMatchObject({
        scanned: seededIds.length,
        archived: seededIds.length,
        stripped: 2,
        derivedDeleted: 1,
        membersDeleted: 2,
        runsDeleted: 1,
        detailsDeleted: 3,
        batches: 3,
        drained: true,
      });
      expect(progress).toEqual([3, 6, 7]);
      expect(result.archiveKeys).toHaveLength(3);
      expect(result.archiveKeys[0]).toMatch(
        /^change-history-archive\/\d{4}\/\d{2}\/change-history_\d{8}T\d{6}_\d+_[0-9a-f-]{36}\.jsonl\.gz$/,
      );
      archiveKeys = result.archiveKeys;

      // The archive holds every row as it was before compaction.
      const lines = await readArchive(archiveKeys);
      const entryLines = lines.filter((line) => line.table === 'change_history_entry');
      expect(entryLines.map((line) => String(line.row.id)).sort()).toEqual(seededIds.map(String).sort());
      expect(entryLines.find((line) => String(line.row.id) === String(seeded.parent))?.row).toMatchObject({
        entityId: 'rt-parent',
        compactedAt: null,
        changes: expect.objectContaining({ 'description.en': expect.objectContaining({ from: LONG_HTML }) }),
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/),
      });
      expect(lines.filter((line) => line.table === 'change_history_detail').map((line) => line.row.scope)).toEqual([
        '1',
        '2',
        '3',
      ]);

      // The summary tier.
      const parent = await byId(seeded.parent);
      expect(parent?.compactedAt).toBeInstanceOf(Date);
      expect(parent?.changes).toEqual({
        'description.en': {
          kind: 'richtext',
          stripped: true,
          fromLength: LONG_HTML.length,
          toLength: LONG_HTML.length + 1,
        },
        'name.en': { kind: 'text', from: 'Old', to: 'New' },
        sku: { kind: 'text', stripped: true, fromLength: LONG_SKU.length, toLength: 1 },
        facetValues: { kind: 'refs', added: ['1'], removed: [], labels: { 1: 'Colour: Black' } },
      });
      expect(parent?.meta.derivedCount).toBe(2);
      const kept = await byId(seeded.derivedDeleted);
      expect(kept?.compactedAt).toBeInstanceOf(Date);
      expect(kept?.meta.lastState).toEqual({ sku: 'V2', description: { stripped: true, length: LONG_HTML.length } });
      expect((await byId(seeded.head))?.meta).toMatchObject({
        counts: { added: 2, removed: 0 },
        batchCounts: [{ entityType: 'Product', action: 'collection_added', count: 2 }],
      });
      for (const gone of [seeded.derivedUpdate, seeded['rt-m1'], seeded['rt-m2'], seeded.run]) {
        expect(await byId(gone)).toBeNull();
      }
      expect(await details().count({ where: { entryId: seeded.run } })).toBe(0);
    });

    it('never compacts an entry twice', async () => {
      const before = await byId(seeded.parent);
      expect(await retention().compact(ctx, { olderThanDays: 90 })).toMatchObject({
        scanned: 0,
        archived: 0,
        archiveKeys: [],
        batches: 0,
        drained: true,
      });
      expect(await byId(seeded.parent)).toEqual(before);
    });

    it('restores archived lines without the next compaction undoing it (R3-9)', async () => {
      const lines = await readArchive(archiveKeys);

      expect(await retention().restore(ctx, lines)).toEqual({
        entriesUpdated: 3,
        entriesInserted: 4,
        detailsInserted: 3,
      });

      const parent = await byId(seeded.parent);
      expect(parent?.changes?.['description.en']).toMatchObject({ from: LONG_HTML });
      expect(parent?.compactedAt).toBeInstanceOf(Date);
      const restored = await byId(seeded.derivedUpdate);
      expect(restored).toMatchObject({ entityId: 'rt-v1', derivedFromId: seeded.parent });
      expect(restored?.compactedAt).toBeInstanceOf(Date);
      expect(restored!.createdAt.getTime()).toBeLessThan(daysAgo(99).getTime());
      expect(await details().count({ where: { entryId: seeded.run } })).toBe(3);

      expect((await retention().compact(ctx, { olderThanDays: 90 })).scanned).toBe(0);
      expect(await retention().restore(ctx, lines)).toEqual({
        entriesUpdated: 7,
        entriesInserted: 0,
        detailsInserted: 0,
      });
    });

    it('purges only compacted entries older than the window, with any detail rows left', async () => {
      const uncompacted = await insert({ entityType: 'Product', entityId: 'rt-ancient', action: 'updated' });
      await backdate([...seededIds, uncompacted.id], daysAgo(400));
      expect(await retention().preview(ctx, { purgeOlderThanDays: 365 })).toMatchObject({
        purgeable: seededIds.length,
      });
      expect(await retention().purge(ctx, { olderThanDays: 365, dryRun: true })).toEqual({
        scanned: seededIds.length,
        deleted: 0,
        batches: 1,
        drained: true,
      });
      expect(await entries().count({ where: { id: In(seededIds) } })).toBe(seededIds.length);

      const progress: number[] = [];
      const result = await retention().purge(ctx, {
        olderThanDays: 365,
        batchSize: 4,
        onProgress: (n) => void progress.push(n),
      });

      expect(result).toEqual({ scanned: seededIds.length, deleted: seededIds.length, batches: 2, drained: true });
      expect(progress).toEqual([4, 7]);
      expect(await entries().count({ where: { id: In(seededIds) } })).toBe(0);
      expect(await details().count({ where: { entryId: seeded.run } })).toBe(0);
      // Never compacted, so possibly never archived: kept whatever its age.
      expect(await byId(uncompacted.id)).not.toBeNull();
      expect((await retention().purge(ctx, { olderThanDays: 1 })).deleted).toBe(0);
      await entries().delete({ id: uncompacted.id });
    });

    it('compacts without an archive copy when the host opted out, and says so', async () => {
      const warn = vi.spyOn(Logger, 'warn');
      const row = await insert({ entityType: 'Product', entityId: 'rt-no-archive', action: 'updated' });
      await backdate([row.id], daysAgo(100));
      const service = new ChangeHistoryRetentionService(
        resolveOptions({ retention: { archive: 'none' } }),
        env.app().get(TransactionalConnection),
      );

      expect(await service.compact(ctx, { olderThanDays: 90 })).toMatchObject({
        scanned: 1,
        archived: 0,
        archiveKeys: [],
        drained: true,
      });
      expect((await byId(row.id))?.compactedAt).toBeInstanceOf(Date);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('without an archive copy'), 'ChangeHistory');
      warn.mockRestore();
      await expect(service.compact(ctx, { olderThanDays: -1 })).rejects.toThrow(/non-negative/);
      await expect(service.purge(ctx, { olderThanDays: 1, batchSize: 0 })).rejects.toThrow(/positive integer/);
      await entries().delete({ id: row.id });
    });

    it('records a run of 5,000 rows, pages it, groups it per product, and compacts it', async () => {
      const one = await createProduct(env.adminClient, 'rt-big-one', ['RT-BIG-1']);
      const two = await createProduct(env.adminClient, 'rt-big-two', ['RT-BIG-2']);
      const variants = [decode(one.variantIds[0]), decode(two.variantIds[0])];
      const products = [decode(one.productId), decode(two.productId)];
      const warn = vi.spyOn(Logger, 'warn');
      const row = (i: number) => ({
        entityType: 'ProductVariant',
        entityId: variants[i % 2],
        kind: 'stock',
        scope: String(i),
        from: i,
        to: i + 1,
      });
      await history().recordRun(ctx, { source: 'rt_small', label: 'Small', counts: { updated: 1 }, details: [row(0)] });
      await history().recordRun(ctx, {
        source: 'rt_big',
        label: 'Big',
        counts: { updated: 5_001 },
        durationMs: 42,
        details: Array.from({ length: 5_001 }, (_, i) => row(i)),
      });

      const [small] = await entries().find({ where: { source: 'rt_small' } });
      const [big] = await entries().find({ where: { source: 'rt_big' } });
      expect(big.meta).toMatchObject({
        counts: { updated: 5_001 },
        durationMs: 42,
        detailCount: 5_000,
        detailsOmitted: 1,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('stored the first 5000'), 'ChangeHistory');
      warn.mockRestore();
      const stored = await details().find({ where: { entryId: big.id } });
      expect(stored).toHaveLength(5_000);
      // Equal in the database itself, not only to the millisecond a JS Date keeps (R5-2).
      const differing = await details()
        .createQueryBuilder('detail')
        .innerJoin(ChangeHistoryEntry, 'entry', 'entry.id = detail.entryId')
        .where('detail.entryId = :id', { id: big.id })
        .andWhere('detail.createdAt <> entry.createdAt')
        .getCount();
      expect(differing).toBe(0);

      const page = await history().runDetails(ctx, big.id, { skip: 4_990, take: 100 });
      expect(page.totalItems).toBe(5_000);
      expect(page.items.map((d) => d.scope)).toEqual(Array.from({ length: 10 }, (_, i) => String(4_990 + i)));
      expect((await history().runDetails(ctx, big.id, { take: 10_000 })).items).toHaveLength(500);

      // NQ4b: a product's runs, newest first, each with the rows of that product's variants only.
      const runs = await history().runsForEntity(ctx, { entityType: 'Product', entityId: products[0] });
      expect(runs.totalItems).toBe(2);
      expect(runs.items.map((item) => [item.entry.source, item.details.length])).toEqual([
        ['rt_big', 2_500],
        ['rt_small', 1],
      ]);
      expect(runs.items[0].details.every((d) => d.entityId === variants[0] && d.parentId === products[0])).toBe(true);
      const second = await history().runsForEntity(
        ctx,
        { entityType: 'ProductVariant', entityId: variants[1] },
        { take: 1 },
      );
      expect(second.totalItems).toBe(1);
      expect(second.items[0].details).toHaveLength(2_500);
      expect((await history().runsForEntity(ctx, { entityType: 'Product', entityId: 'none' })).items).toEqual([]);
      const grouped = await history().runDetailsForEntity(ctx, { entityType: 'Product', entityId: products[1] }, [
        small.id,
        big.id,
      ]);
      expect([...grouped.keys()]).toEqual([String(big.id)]);

      await backdate([small.id, big.id], daysAgo(100));
      const result = await retention().compact(ctx, { olderThanDays: 90 });
      expect(result).toMatchObject({ scanned: 2, runsDeleted: 2, detailsDeleted: 5_001, drained: true });
      const lines = await readArchive(result.archiveKeys);
      expect(lines.filter((line) => line.table === 'change_history_detail')).toHaveLength(5_001);
      expect(await details().count({ where: { entryId: In([small.id, big.id]) } })).toBe(0);
    });

    it('rolls a run back with the host transaction that recorded it', async () => {
      const detailCount = await details().count();
      await expect(
        env
          .app()
          .get(TransactionalConnection)
          .withTransaction(ctx, async (tctx) => {
            await history().recordRun(tctx, {
              source: 'rt_rolled_back',
              label: 'Rolled back',
              counts: { updated: 2 },
              details: [
                { entityType: 'Warehouse', entityId: 'w1', kind: 'stock', from: 1, to: 2 },
                { entityType: 'Warehouse', entityId: 'w2', kind: 'stock', from: 3, to: 4 },
              ],
            });
            throw new Error('host rollback');
          }),
      ).rejects.toThrow('host rollback');

      expect(await entries().count({ where: { source: 'rt_rolled_back' } })).toBe(0);
      expect(await details().count()).toBe(detailCount);
    });
  });
}
