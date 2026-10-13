import { ScheduledTask } from '@vendure/core';
import { ChangeHistoryRetentionService } from '../services/change-history-retention.service';
import { ResolvedChangeHistoryRetentionOptions } from '../types';

/** Ids of the built-in retention tasks (Vendure's scheduled-tasks list shows them under these ids). */
export const CHANGE_HISTORY_TASK_IDS = {
  compact: 'change-history-compact',
  purge: 'change-history-purge',
} as const;

const TIMEOUT = '30m';

/**
 * The two retention tasks the plugin registers when `retention.schedule` is not `false`. They run on the
 * worker through the host's scheduler (`DefaultSchedulerPlugin` or another `SchedulerStrategy`).
 */
export function createRetentionTasks(
  retention: ResolvedChangeHistoryRetentionOptions & { schedule: { compact: string; purge: string } },
): ScheduledTask[] {
  return [
    new ScheduledTask({
      id: CHANGE_HISTORY_TASK_IDS.compact,
      description: `Archive and compact change-history entries older than ${retention.detailDays} days`,
      schedule: retention.schedule.compact,
      timeout: TIMEOUT,
      preventOverlap: true,
      execute: ({ injector, scheduledContext }) =>
        injector.get(ChangeHistoryRetentionService).compact(scheduledContext, { olderThanDays: retention.detailDays }),
    }),
    new ScheduledTask({
      id: CHANGE_HISTORY_TASK_IDS.purge,
      description: `Delete compacted change-history entries older than ${retention.summaryDays} days`,
      schedule: retention.schedule.purge,
      timeout: TIMEOUT,
      preventOverlap: true,
      execute: ({ injector, scheduledContext }) =>
        injector.get(ChangeHistoryRetentionService).purge(scheduledContext, { olderThanDays: retention.summaryDays }),
    }),
  ];
}
