import { Inject, Injectable } from '@nestjs/common';
import { RequestContext, TransactionalConnection } from '@vendure/core';
import { IsNull, LessThan, Not } from 'typeorm';
import { CHANGE_HISTORY_PLUGIN_OPTIONS } from '../constants';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { ResolvedChangeHistoryPluginOptions, RetentionRunOptions } from '../types';

/** Result of {@link ChangeHistoryRetentionService.compact}. */
export interface ChangeHistoryCompactResult {
  scanned: number;
  archived: number;
  archiveKeys: string[];
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

const DAY_MS = 86_400_000;

/**
 * @description
 * Tiered retention for hosts that run it from their own scheduler (`retention.schedule: false`):
 * `compact` archives entries older than the detail window and strips them, `purge` deletes compacted
 * entries older than the summary window, `preview` counts what the next run would touch.
 *
 * `compact` and `purge` are not implemented in this pre-release and reject.
 */
@Injectable()
export class ChangeHistoryRetentionService {
  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly connection: TransactionalConnection,
  ) {}

  async compact(_ctx: RequestContext, _opts: RetentionRunOptions): Promise<ChangeHistoryCompactResult> {
    throw new Error('ChangeHistoryRetentionService.compact() is not implemented in this pre-release');
  }

  async purge(_ctx: RequestContext, _opts: RetentionRunOptions): Promise<ChangeHistoryPurgeResult> {
    throw new Error('ChangeHistoryRetentionService.purge() is not implemented in this pre-release');
  }

  /** Read-only candidate counts for the given windows (default: the configured ones). */
  async preview(
    ctx: RequestContext,
    opts: { compactOlderThanDays?: number; purgeOlderThanDays?: number } = {},
  ): Promise<{ compactable: number; purgeable: number }> {
    const repository = this.connection.getRepository(ctx, ChangeHistoryEntry);
    const [compactable, purgeable] = await Promise.all([
      repository.count({
        where: {
          compactedAt: IsNull(),
          createdAt: LessThan(cutoff(opts.compactOlderThanDays ?? this.options.retention.detailDays)),
        },
      }),
      repository.count({
        where: {
          compactedAt: Not(IsNull()),
          createdAt: LessThan(cutoff(opts.purgeOlderThanDays ?? this.options.retention.summaryDays)),
        },
      }),
    ]);
    return { compactable, purgeable };
  }
}

/** Age cut-offs are computed here and bound as parameters: no SQL interval arithmetic. */
function cutoff(days: number): Date {
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(`ChangeHistoryRetentionService: a window must be a non-negative number of days, got ${days}`);
  }
  return new Date(Date.now() - days * DAY_MS);
}
