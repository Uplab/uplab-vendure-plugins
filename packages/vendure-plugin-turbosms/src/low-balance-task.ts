import { EventBus, ScheduledTask } from '@vendure/core';
import { DEFAULT_LOW_BALANCE_SCHEDULE, LOW_BALANCE_TASK_ID } from './constants';
import { TurboSmsLowBalanceEvent } from './events';
import { notifyLowBalance } from './low-balance-notify';
import { TurboSmsService } from './turbo-sms.service';
import { type TurboSmsLowBalanceAlertOptions } from './types';

/** The scheduled check only exists when a threshold was configured. */
export type ScheduledBalanceCheckOptions = TurboSmsLowBalanceAlertOptions & { threshold: number };

/**
 * Builds the scheduled task that watches the TurboSMS account balance. Internal: the
 * `lowBalanceAlert` option registers it when a `threshold` is set.
 *
 * When the balance is below the threshold it warns, calls `onLowBalance` and publishes a
 * {@link TurboSmsLowBalanceEvent}. It is skipped in dry-run mode, where the API key is
 * usually a placeholder and there is no real account to check.
 */
export function createLowBalanceTask(options: ScheduledBalanceCheckOptions): ScheduledTask {
  return new ScheduledTask({
    id: LOW_BALANCE_TASK_ID,
    description: 'Warns when the TurboSMS account balance runs low',
    schedule: options.schedule ?? DEFAULT_LOW_BALANCE_SCHEDULE,
    execute: async ({ injector }) => {
      const turboSms = injector.get(TurboSmsService);

      if (turboSms.isDryRun) {
        return { skipped: 'dryRun' };
      }

      const balance = await turboSms.getBalance();
      const low = balance < options.threshold;

      if (low) {
        // Logs, then runs the callback; never throws, so a failing callback cannot fail
        // the scheduled run.
        await notifyLowBalance(
          { reason: 'scheduledCheck', balance, threshold: options.threshold },
          injector,
          options.onLowBalance,
        );
        await injector.get(EventBus).publish(new TurboSmsLowBalanceEvent(balance, options.threshold));
      }

      return { balance, threshold: options.threshold, low };
    },
  });
}
