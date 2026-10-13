import { Inject, Injectable } from '@nestjs/common';
import { ID, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { randomUUID } from 'node:crypto';
import { Brackets, In, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { chunks } from '../common/utils';
import {
  CHANGE_HISTORY_ENTITY_TYPES,
  CHANGE_HISTORY_PLUGIN_OPTIONS,
  MAX_COMPACT_DETAIL_ROWS,
  loggerCtx,
} from '../constants';
import { ChangeHistoryDetail } from '../entities/change-history-detail.entity';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { timestampAsText } from '../read/sql';
import { BatchCount, compactValues } from '../retention/compact';
import {
  ARCHIVE_CONTENT_TYPE,
  ARCHIVE_TABLES,
  archiveKey,
  ChangeHistoryArchiveLine,
  encodeArchive,
} from '../retention/jsonl';
import { isBatchHead, isDetailRow, isKeptDeleted, isMemberRow, isRunLine } from '../retention/rules';
import { ChangeHistoryFieldChanges, ResolvedChangeHistoryPluginOptions, RetentionRunOptions } from '../types';
import { ChangeHistoryContextService } from './change-history-context.service';

/** Result of {@link ChangeHistoryRetentionService.compact}. */
export interface ChangeHistoryCompactResult {
  /** Entries looked at (each one is compacted or deleted). */
  scanned: number;
  /** Entries written to archive objects (0 with `archive: 'none'` and in a dry run). */
  archived: number;
  archiveKeys: string[];
  /** Entries with at least one value replaced by a length marker. */
  stripped: number;
  derivedDeleted: number;
  membersDeleted: number;
  runsDeleted: number;
  detailsDeleted: number;
  batches: number;
  /** `false` when `maxBatches` stopped a non-empty backlog. */
  drained: boolean;
}

/** Result of {@link ChangeHistoryRetentionService.purge}. */
export interface ChangeHistoryPurgeResult {
  scanned: number;
  deleted: number;
  batches: number;
  drained: boolean;
}

/** Result of {@link ChangeHistoryRetentionService.restore}. */
export interface ChangeHistoryRestoreResult {
  /** Entries that still existed: their full `changes` / `meta` are back, `compactedAt` is kept. */
  entriesUpdated: number;
  /** Entries that compaction had deleted: inserted again, marked compacted. */
  entriesInserted: number;
  detailsInserted: number;
}

const DAY_MS = 86_400_000;

type RawRow = Record<string, unknown>;
type EntityClass = typeof ChangeHistoryEntry | typeof ChangeHistoryDetail;

interface CompactionPlan {
  entries: RawRow[];
  details: RawRow[];
  keep: RawRow[];
  deleteIds: { derived: ID[]; members: ID[]; runs: ID[] };
}

/**
 * @description
 * Tiered retention. `compact` archives entries older than the detail window and reduces them to the
 * summary tier, `purge` deletes compacted entries older than the summary window, `preview` counts what the
 * next runs would touch, `restore` puts archived lines back. The plugin runs `compact` / `purge` itself from
 * two `ScheduledTask`s unless `retention.schedule` is `false`; then the host calls them from its own
 * scheduler.
 *
 * `compact` enforces the upload-first invariant: per batch it writes the full record (entries and their
 * detail rows) to the archive storage, requires `exists` to confirm it, and only then strips and deletes,
 * in one transaction. A failed upload or verification rejects the run and leaves that batch untouched (the
 * batches before it stay compacted); the next run picks it up again.
 *
 * @example
 * ```ts
 * const result = await retention.compact(ctx, { olderThanDays: 90, onProgress: (n) => report(n) });
 * ```
 */
@Injectable()
export class ChangeHistoryRetentionService {
  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly connection: TransactionalConnection,
    private readonly context: ChangeHistoryContextService,
  ) {}

  /**
   * Archives, then compacts entries older than `olderThanDays` that are not compacted yet, oldest first, in
   * batches. Idempotent: a compacted entry is never selected again. Rejects when the archive storage fails.
   */
  compact(ctx: RequestContext, opts: RetentionRunOptions): Promise<ChangeHistoryCompactResult> {
    return this.context.serialize(ctx, () => this.compactNow(ctx, opts));
  }

  /**
   * Deletes compacted entries older than `olderThanDays` (and compacted run lines older than
   * `retention.runLineDays`), oldest first, in batches. An entry that was never compacted — whose full record
   * may not be archived — is never deleted, whatever the window.
   */
  purge(ctx: RequestContext, opts: RetentionRunOptions): Promise<ChangeHistoryPurgeResult> {
    return this.context.serialize(ctx, () => this.purgeNow(ctx, opts));
  }

  /**
   * Read-only candidate counts for the given windows (default: `retention.detailDays` / `summaryDays`): what
   * `compact` / `purge` with these windows would touch, without the batch cap.
   */
  preview(
    ctx: RequestContext,
    opts: { compactOlderThanDays?: number; purgeOlderThanDays?: number } = {},
  ): Promise<{ compactable: number; purgeable: number }> {
    return this.context.serialize(ctx, () => this.previewNow(ctx, opts));
  }

  /**
   * Puts archived lines back (see the restore runbook in the README). An entry that still exists gets its
   * archived `changes` and `meta` back and **keeps** its `compactedAt`; an entry or a detail row that no longer
   * exists is inserted with its archived id and, for entries, `compactedAt` set — so the next compaction
   * leaves the restored rows alone instead of archiving and deleting them again. Rejects on failure.
   */
  restore(ctx: RequestContext, lines: ChangeHistoryArchiveLine[]): Promise<ChangeHistoryRestoreResult> {
    return this.context.serialize(ctx, () => this.restoreNow(ctx, lines));
  }

  private async compactNow(ctx: RequestContext, opts: RetentionRunOptions): Promise<ChangeHistoryCompactResult> {
    const before = cutoff(opts?.olderThanDays);
    const runBefore = cutoff(this.options.retention.runLineDays);
    const batchSize = positive('batchSize', opts.batchSize, this.options.retention.compactBatchSize);
    const maxBatches = positive('maxBatches', opts.maxBatches, this.options.retention.maxBatches);
    const maxDetailRows = positive('maxDetailRows', opts.maxDetailRows, MAX_COMPACT_DETAIL_ROWS);
    const { archive } = this.options.retention;
    const dryRun = opts.dryRun === true;
    if (archive === 'none' && !dryRun) {
      Logger.warn('compacting without an archive copy (retention.archive is "none")', loggerCtx);
    }
    const result: ChangeHistoryCompactResult = {
      scanned: 0,
      archived: 0,
      archiveKeys: [],
      stripped: 0,
      derivedDeleted: 0,
      membersDeleted: 0,
      runsDeleted: 0,
      detailsDeleted: 0,
      batches: 0,
      drained: false,
    };
    while (result.batches < maxBatches) {
      // A dry run changes nothing, so it pages; a real run always reads the oldest uncompacted rows.
      const fetched = await this.compactable(ctx, before, batchSize, dryRun ? result.scanned : 0);
      if (fetched.length === 0) {
        result.drained = true;
        break;
      }
      // The rest of `fetched` is the next batch's start.
      const entries = await this.withinDetailCap(ctx, fetched, maxDetailRows);
      const plan = await this.plan(ctx, entries, runBefore);
      if (!dryRun && archive !== 'none') {
        const key = archiveKey(
          this.options.retention.archiveKeyPrefix,
          String(entries[0].createdAt),
          entries[entries.length - 1].id,
          randomUUID(),
        );
        await archive.put(key, await encodeArchive(archiveLines(plan)), ARCHIVE_CONTENT_TYPE);
        if (!(await archive.exists(key))) {
          throw new Error(`ChangeHistoryRetentionService: archive object "${key}" not found after writing it`);
        }
        result.archived += entries.length;
        result.archiveKeys.push(key);
      }
      result.stripped += dryRun ? this.strippedIn(plan.keep) : await this.apply(ctx, plan);
      result.scanned += entries.length;
      result.derivedDeleted += plan.deleteIds.derived.length;
      result.membersDeleted += plan.deleteIds.members.length;
      result.runsDeleted += plan.deleteIds.runs.length;
      result.detailsDeleted += plan.details.length;
      result.batches++;
      await reportProgress(opts.onProgress, result.scanned);
      if (entries.length === fetched.length && fetched.length < batchSize) {
        result.drained = true;
        break;
      }
    }
    if (!result.drained) {
      result.drained = (await this.compactable(ctx, before, 1, dryRun ? result.scanned : 0)).length === 0;
    }
    return result;
  }

  /**
   * The oldest of `entries` whose detail rows stay within `maxRows` together — at least the first one, however
   * many rows it has. Keeps a batch of many large runs from loading and archiving all their rows at once.
   */
  private async withinDetailCap(ctx: RequestContext, entries: RawRow[], maxRows: number): Promise<RawRow[]> {
    const counts = new Map<string, number>();
    for (const chunk of chunks(entries.map((row) => row.id as ID))) {
      const rows = await this.connection
        .getRepository(ctx, ChangeHistoryDetail)
        .createQueryBuilder('detail')
        .select('detail.entryId', 'entryId')
        .addSelect('COUNT(*)', 'count')
        .where({ entryId: In(chunk) })
        .groupBy('detail.entryId')
        .getRawMany<{ entryId: ID; count: string | number }>();
      rows.forEach((row) => counts.set(String(row.entryId), Number(row.count)));
    }
    let total = 0;
    let taken = 0;
    for (const row of entries) {
      const count = counts.get(String(row.id)) ?? 0;
      if (taken > 0 && total + count > maxRows) {
        break;
      }
      total += count;
      taken++;
    }
    return entries.slice(0, taken);
  }

  private async purgeNow(ctx: RequestContext, opts: RetentionRunOptions): Promise<ChangeHistoryPurgeResult> {
    const before = cutoff(opts?.olderThanDays);
    const runBefore = cutoff(this.options.retention.runLineDays);
    const batchSize = positive('batchSize', opts.batchSize, this.options.retention.purgeBatchSize);
    const maxBatches = positive('maxBatches', opts.maxBatches, this.options.retention.maxBatches);
    const dryRun = opts.dryRun === true;
    const result: ChangeHistoryPurgeResult = { scanned: 0, deleted: 0, batches: 0, drained: false };
    const page = (take: number, skip: number) =>
      this.purgeable(ctx, before, runBefore)
        .select('entry.id', 'id')
        .orderBy('entry.createdAt', 'ASC')
        .addOrderBy('entry.id', 'ASC')
        .limit(take)
        .offset(skip)
        .getRawMany<{ id: ID }>();
    while (result.batches < maxBatches) {
      const ids = (await page(batchSize, dryRun ? result.scanned : 0)).map((row) => row.id);
      if (ids.length === 0) {
        result.drained = true;
        break;
      }
      if (!dryRun) {
        await this.connection.withTransaction(ctx, async (tctx) => {
          // Detail rows normally left with their entry at compaction; a restored run may have brought some back.
          await this.deleteIn(tctx, ChangeHistoryDetail, 'entryId', ids);
          await this.deleteIn(tctx, ChangeHistoryEntry, 'id', ids);
        });
        result.deleted += ids.length;
      }
      result.scanned += ids.length;
      result.batches++;
      await reportProgress(opts.onProgress, result.scanned);
      if (ids.length < batchSize) {
        result.drained = true;
        break;
      }
    }
    if (!result.drained) {
      result.drained = (await page(1, dryRun ? result.scanned : 0)).length === 0;
    }
    return result;
  }

  private async previewNow(
    ctx: RequestContext,
    opts: { compactOlderThanDays?: number; purgeOlderThanDays?: number },
  ): Promise<{ compactable: number; purgeable: number }> {
    const compactBefore = cutoff(opts.compactOlderThanDays ?? this.options.retention.detailDays);
    const purgeBefore = cutoff(opts.purgeOlderThanDays ?? this.options.retention.summaryDays);
    const runBefore = cutoff(this.options.retention.runLineDays);
    const [compactable, purgeable] = await Promise.all([
      this.compactableQuery(ctx, compactBefore).getCount(),
      this.purgeable(ctx, purgeBefore, runBefore).getCount(),
    ]);
    return { compactable, purgeable };
  }

  private async restoreNow(
    ctx: RequestContext,
    lines: ChangeHistoryArchiveLine[],
  ): Promise<ChangeHistoryRestoreResult> {
    const result: ChangeHistoryRestoreResult = { entriesUpdated: 0, entriesInserted: 0, detailsInserted: 0 };
    const rowsOf = (table: string) => dedupe(lines.filter((line) => line.table === table).map((line) => line.row));
    await this.connection.withTransaction(ctx, async (tctx) => {
      const entries = rowsOf(ARCHIVE_TABLES.entry);
      const updated = new Set<string>();
      const reinserted = new Map<string, number>();
      for (const chunk of chunks(entries)) {
        const existing = await this.existingIds(tctx, ChangeHistoryEntry, chunk);
        for (const row of chunk) {
          if (existing.has(String(row.id))) {
            updated.add(String(row.id));
            await this.connection.getRepository(tctx, ChangeHistoryEntry).update(
              row.id as ID,
              {
                changes: changesOf(row),
                meta: metaOf(row),
              } as QueryDeepPartialEntity<ChangeHistoryEntry>,
            );
            result.entriesUpdated++;
          } else {
            await this.insertRaw(tctx, ChangeHistoryEntry, row, { compactedAt: row.compactedAt ?? 'now' });
            result.entriesInserted++;
            if (row.derivedFromId != null && !isKeptDeleted(facts(row))) {
              const cause = String(row.derivedFromId);
              reinserted.set(cause, (reinserted.get(cause) ?? 0) + 1);
            }
          }
        }
      }
      // A re-inserted derived row is counted live again: its cause's snapshot gives it back — unless this
      // restore just put the cause's own archived `meta` (from before compaction, without a snapshot) back.
      await this.addToEarlierSnapshots(
        tctx,
        [...reinserted].filter(([causeId]) => !updated.has(causeId)),
        -1,
      );
      const details = rowsOf(ARCHIVE_TABLES.detail);
      for (const chunk of chunks(details)) {
        const existing = await this.existingIds(tctx, ChangeHistoryDetail, chunk);
        for (const row of chunk.filter((r) => !existing.has(String(r.id)))) {
          await this.insertRaw(tctx, ChangeHistoryDetail, row);
          result.detailsInserted++;
        }
      }
    });
    return result;
  }

  private compactableQuery(ctx: RequestContext, before: Date): SelectQueryBuilder<ChangeHistoryEntry> {
    return this.connection
      .getRepository(ctx, ChangeHistoryEntry)
      .createQueryBuilder('entry')
      .where('entry.compactedAt IS NULL')
      .andWhere('entry.createdAt < :before', { before });
  }

  private purgeable(ctx: RequestContext, before: Date, runBefore: Date): SelectQueryBuilder<ChangeHistoryEntry> {
    return this.connection
      .getRepository(ctx, ChangeHistoryEntry)
      .createQueryBuilder('entry')
      .where('entry.compactedAt IS NOT NULL')
      .andWhere(
        new Brackets((qb) =>
          qb
            .where('entry.createdAt < :before', { before })
            .orWhere(
              new Brackets((run) =>
                run
                  .where('entry.entityType = :run', { run: CHANGE_HISTORY_ENTITY_TYPES.Run })
                  .andWhere('entry.createdAt < :runBefore', { runBefore }),
              ),
            ),
        ),
      );
  }

  /** The oldest uncompacted entries, as raw rows (timestamps in the database's own text). */
  private compactable(ctx: RequestContext, before: Date, take: number, skip: number): Promise<RawRow[]> {
    const query = this.rawSelect(this.compactableQuery(ctx, before), ChangeHistoryEntry, 'entry')
      .orderBy('entry.createdAt', 'ASC')
      .addOrderBy('entry.id', 'ASC')
      .limit(take)
      .offset(skip);
    return this.parsed(query, ChangeHistoryEntry);
  }

  private async plan(ctx: RequestContext, entries: RawRow[], runBefore: Date): Promise<CompactionPlan> {
    const ids = entries.map((row) => row.id as ID);
    const details: RawRow[] = [];
    for (const chunk of chunks(ids)) {
      const query = this.rawSelect(
        this.connection
          .getRepository(ctx, ChangeHistoryDetail)
          .createQueryBuilder('detail')
          .where({ entryId: In(chunk) }),
        ChangeHistoryDetail,
        'detail',
      ).orderBy('detail.id', 'ASC');
      details.push(...(await this.parsed(query, ChangeHistoryDetail)));
    }
    // The run-line age is compared in SQL: the raw timestamps are the database's text, not comparable in JS.
    const runIds = entries.filter((row) => isRunLine(facts(row))).map((row) => row.id as ID);
    const oldRuns = new Set<string>();
    for (const chunk of chunks(runIds)) {
      const rows = await this.connection
        .getRepository(ctx, ChangeHistoryEntry)
        .createQueryBuilder('entry')
        .select('entry.id', 'id')
        .where({ id: In(chunk) })
        .andWhere('entry.createdAt < :runBefore', { runBefore })
        .getRawMany<{ id: ID }>();
      rows.forEach((row) => oldRuns.add(String(row.id)));
    }
    const plan: CompactionPlan = { entries, details, keep: [], deleteIds: { derived: [], members: [], runs: [] } };
    for (const row of entries) {
      const entry = facts(row);
      if (oldRuns.has(String(row.id))) {
        plan.deleteIds.runs.push(row.id as ID);
      } else if (isDetailRow(entry)) {
        (isMemberRow(entry) ? plan.deleteIds.members : plan.deleteIds.derived).push(row.id as ID);
      } else {
        plan.keep.push(row);
      }
    }
    return plan;
  }

  private strippedIn(rows: RawRow[]): number {
    const cap = this.options.retention.compactValueBytes;
    return rows.filter((row) => compactValues(changesOf(row), metaOf(row), cap).strippedFields > 0).length;
  }

  /** Step 4 of a batch, in one transaction: snapshot counts, delete, compact. Returns the stripped count. */
  private async apply(ctx: RequestContext, plan: CompactionPlan): Promise<number> {
    const cap = this.options.retention.compactValueBytes;
    return this.connection.withTransaction(ctx, async (tctx) => {
      const repository = this.connection.getRepository(tctx, ChangeHistoryEntry);
      // (a) Counts before anything is deleted. `derivedCount`: the derived rows this batch deletes, added to
      // what the cause kept from earlier batches — a cause and its derived rows share `createdAt`, so a batch
      // (or a run stopped by `maxBatches`) may end between them, and the rest are counted live until a later
      // batch deletes them. A kept cascaded deletion is never deleted and stays counted live.
      const derivedCounts = deletedDerivedCounts(plan);
      const inBatch = new Set([...plan.keep.map((row) => String(row.id)), ...deletedIn(plan)]);
      await this.addToEarlierSnapshots(
        tctx,
        [...derivedCounts].filter(([causeId]) => !inBatch.has(causeId)),
        1,
      );
      const batchIds = [
        ...new Set(plan.keep.filter((row) => isBatchHead(facts(row)) && row.batchId).map((row) => String(row.batchId))),
      ];
      const batchCounts = new Map<string, BatchCount[]>();
      for (const chunk of chunks(batchIds)) {
        const rows = await repository
          .createQueryBuilder('entry')
          .select('entry.batchId', 'batchId')
          .addSelect('entry.entityType', 'entityType')
          .addSelect('entry.action', 'action')
          .addSelect('COUNT(*)', 'count')
          .where({ batchId: In(chunk) })
          .andWhere('entry.entityType != :batch', { batch: CHANGE_HISTORY_ENTITY_TYPES.Batch })
          // The members `batchMembers` lists: a derived entry is counted on its cause (`derivedCount`).
          .andWhere('entry.derivedFromId IS NULL')
          .groupBy('entry.batchId')
          .addGroupBy('entry.entityType')
          .addGroupBy('entry.action')
          .orderBy('entry.entityType', 'ASC')
          .addOrderBy('entry.action', 'ASC')
          .getRawMany<{ batchId: string; entityType: string; action: string; count: string | number }>();
        for (const row of rows) {
          const list = batchCounts.get(row.batchId) ?? [];
          list.push({ entityType: row.entityType, action: row.action, count: Number(row.count) });
          batchCounts.set(row.batchId, list);
        }
      }
      // (b) Detail rows leave with their entries; derived / member rows and old run lines are deleted.
      await this.deleteIn(
        tctx,
        ChangeHistoryDetail,
        'entryId',
        plan.entries.map((row) => row.id as ID),
      );
      await this.deleteIn(tctx, ChangeHistoryEntry, 'id', [
        ...plan.deleteIds.derived,
        ...plan.deleteIds.members,
        ...plan.deleteIds.runs,
      ]);
      // (c) Every remaining entry: values stripped, counts merged into `meta`, `compactedAt` set.
      let stripped = 0;
      const untouched: ID[] = [];
      for (const row of plan.keep) {
        const values = compactValues(changesOf(row), metaOf(row), cap, {
          derivedCount: derivedCounts.get(String(row.id)),
          batchCounts: isBatchHead(facts(row)) && row.batchId ? batchCounts.get(String(row.batchId)) : undefined,
        });
        if (values.strippedFields > 0) {
          stripped++;
        }
        if (values.changed) {
          await repository.update(
            row.id as ID,
            {
              changes: values.changes,
              meta: values.meta,
              compactedAt: () => 'CURRENT_TIMESTAMP',
            } as QueryDeepPartialEntity<ChangeHistoryEntry>,
          );
        } else {
          untouched.push(row.id as ID);
        }
      }
      for (const chunk of chunks(untouched)) {
        await repository.update({ id: In(chunk) }, { compactedAt: () => 'CURRENT_TIMESTAMP' });
      }
      return stripped;
    });
  }

  private async deleteIn(ctx: RequestContext, target: EntityClass, column: string, ids: ID[]): Promise<void> {
    for (const chunk of chunks(ids)) {
      await this.connection
        .getRepository(ctx, target as typeof ChangeHistoryEntry)
        .createQueryBuilder()
        .delete()
        .where({ [column]: In(chunk) })
        .execute();
    }
  }

  /**
   * Selects every column under its database name, timestamps as the database's own text (Postgres keeps
   * microseconds that a JS `Date` would drop).
   */
  private rawSelect<T extends ObjectLiteral>(
    query: SelectQueryBuilder<T>,
    target: EntityClass,
    alias: string,
  ): SelectQueryBuilder<T> {
    const columns = this.connection.rawConnection.getMetadata(target).columns;
    columns.forEach((column, index) => {
      const path = `${alias}.${column.propertyName}`;
      const expression = isTimestamp(column) ? this.asText(path) : path;
      if (index === 0) {
        query.select(expression, column.databaseName);
      } else {
        query.addSelect(expression, column.databaseName);
      }
    });
    return query;
  }

  private async parsed<T extends ObjectLiteral>(query: SelectQueryBuilder<T>, target: EntityClass): Promise<RawRow[]> {
    const json = this.connection.rawConnection
      .getMetadata(target)
      .columns.filter((column) => column.type === 'simple-json')
      .map((column) => column.databaseName);
    const rows = await query.getRawMany<RawRow>();
    for (const row of rows) {
      for (const name of json) {
        const value = row[name];
        row[name] = typeof value === 'string' && value !== '' ? JSON.parse(value) : (value ?? null);
      }
    }
    return rows;
  }

  private asText(path: string): string {
    return timestampAsText(this.connection.rawConnection.options.type, path);
  }

  private async existingIds(ctx: RequestContext, target: EntityClass, rows: RawRow[]): Promise<Set<string>> {
    const found = await this.connection
      .getRepository(ctx, target as typeof ChangeHistoryEntry)
      .createQueryBuilder('row')
      .select('row.id', 'id')
      .where({ id: In(rows.map((row) => row.id as ID)) })
      .getRawMany<{ id: ID }>();
    return new Set(found.map((row) => String(row.id)));
  }

  /**
   * Adds `sign × count` to the `meta.derivedCount` snapshot of each compacted cause (never below 0). A cause
   * that is gone, or not compacted (it has no snapshot yet), is left alone.
   */
  private async addToEarlierSnapshots(ctx: RequestContext, counts: Array<[string, number]>, sign: 1 | -1) {
    const byId = new Map(counts);
    const repository = this.connection.getRepository(ctx, ChangeHistoryEntry);
    for (const chunk of chunks([...byId.keys()])) {
      const causes = await repository.find({
        select: { id: true, meta: true, compactedAt: true },
        where: { id: In(chunk) },
      });
      for (const cause of causes.filter((row) => row.compactedAt != null)) {
        const derivedCount = Math.max(0, snapshotCount(cause.meta) + sign * byId.get(String(cause.id))!);
        await repository.update(cause.id, {
          meta: { ...cause.meta, derivedCount },
        } as QueryDeepPartialEntity<ChangeHistoryEntry>);
      }
    }
  }

  /**
   * A row back under its archived id: a plain `INSERT` (TypeORM leaves generated ids out of its own inserts
   * on Postgres). `overrides` replace archived values; `'now'` is the database's current timestamp.
   */
  private async insertRaw(
    ctx: RequestContext,
    target: EntityClass,
    row: RawRow,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    const { driver } = this.connection.rawConnection;
    const metadata = this.connection.rawConnection.getMetadata(target);
    const names: string[] = [];
    const values: string[] = [];
    const parameters: Record<string, unknown> = {};
    metadata.columns.forEach((column, index) => {
      const name = column.databaseName;
      const value = name in overrides ? overrides[name] : row[name];
      if (value === undefined) {
        return;
      }
      names.push(driver.escape(name));
      if (value === 'now' && name in overrides) {
        values.push('CURRENT_TIMESTAMP');
        return;
      }
      parameters[`p${index}`] =
        column.type === 'simple-json' ? (value === null ? null : JSON.stringify(value)) : (value as unknown);
      values.push(`:p${index}`);
    });
    const table = metadata.tablePath
      .split('.')
      .map((part) => driver.escape(part))
      .join('.');
    const [sql, bound] = driver.escapeQueryWithParameters(
      `INSERT INTO ${table} (${names.join(', ')}) VALUES (${values.join(', ')})`,
      parameters,
      {},
    );
    await this.connection.getRepository(ctx, target as typeof ChangeHistoryEntry).manager.query(sql, bound);
  }
}

/** The JSONL lines of one batch: every entry, then every detail row. */
function* archiveLines(plan: CompactionPlan): Generator<ChangeHistoryArchiveLine> {
  for (const row of plan.entries) {
    yield { table: ARCHIVE_TABLES.entry, row };
  }
  for (const row of plan.details) {
    yield { table: ARCHIVE_TABLES.detail, row };
  }
}

/** The ids of the rows a batch deletes. */
function deletedIn(plan: CompactionPlan): Set<string> {
  const { derived, members, runs } = plan.deleteIds;
  return new Set([...derived, ...members, ...runs].map(String));
}

/** Per cause id, how many of the rows this batch deletes derive from it. */
function deletedDerivedCounts(plan: CompactionPlan): Map<string, number> {
  const deleted = deletedIn(plan);
  const counts = new Map<string, number>();
  for (const row of plan.entries) {
    if (row.derivedFromId != null && deleted.has(String(row.id))) {
      const cause = String(row.derivedFromId);
      counts.set(cause, (counts.get(cause) ?? 0) + 1);
    }
  }
  return counts;
}

/** The `derivedCount` an entry's `meta` already holds (0 without one). */
function snapshotCount(meta: Record<string, unknown>): number {
  // JSON holds no NaN or Infinity: a number is a count.
  const value = meta.derivedCount;
  return typeof value === 'number' ? value : 0;
}

function facts(row: RawRow) {
  return {
    entityType: String(row.entityType),
    action: String(row.action),
    derivedFromId: row.derivedFromId,
  };
}

const changesOf = (row: RawRow) => (row.changes ?? null) as ChangeHistoryFieldChanges | null;
const metaOf = (row: RawRow) => (row.meta ?? {}) as Record<string, unknown>;

function isTimestamp(column: ColumnMetadata): boolean {
  return (
    column.isCreateDate ||
    column.isUpdateDate ||
    column.type === Date ||
    ['timestamp', 'datetime', 'timestamp without time zone', 'timestamptz'].includes(String(column.type))
  );
}

/** The last line per id wins (an object archived twice after a crash between put and commit). */
function dedupe(rows: RawRow[]): RawRow[] {
  return [...new Map(rows.map((row) => [String(row.id), row])).values()];
}

async function reportProgress(onProgress: RetentionRunOptions['onProgress'], affected: number): Promise<void> {
  try {
    await onProgress?.(affected);
  } catch (e) {
    Logger.warn(`retention progress callback failed: ${(e as Error)?.message ?? e}`, loggerCtx);
  }
}

function positive(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ChangeHistoryRetentionService: "${name}" must be a positive integer, got ${value}`);
  }
  return value;
}

/** Age cut-offs are computed here and bound as parameters: no SQL interval arithmetic. */
function cutoff(days: number | undefined): Date {
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
    throw new Error(`ChangeHistoryRetentionService: a window must be a non-negative number of days, got ${days}`);
  }
  return new Date(Date.now() - days * DAY_MS);
}
