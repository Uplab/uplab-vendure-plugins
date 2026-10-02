import { ScheduledTask, ScheduledTaskConfig } from '@vendure/core';
import { SYNC_TASK_ID } from './constants';
import { CurrencyExchangeRateSyncService } from './services/currency-exchange-rate-sync.service';

export function createExchangeRateSyncTask(schedule: ScheduledTaskConfig['schedule']): ScheduledTask {
  return new ScheduledTask({
    id: SYNC_TASK_ID,
    description: 'Refresh currency exchange rates from the configured source',
    schedule,
    async execute({ injector, scheduledContext }) {
      const persisted = await injector.get(CurrencyExchangeRateSyncService).syncRates(scheduledContext);
      return { updated: persisted.length };
    },
  });
}
