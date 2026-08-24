import { EventBus, Logger, ScheduledTask } from '@vendure/core';
import { DEFAULT_LOW_BALANCE_SCHEDULE, LOW_BALANCE_TASK_ID, TURBOSMS_LOGGER_CTX } from './constants';
import { TurboSmsLowBalanceEvent } from './events';
import { TurboSmsService } from './turbo-sms.service';
import { type TurboSmsLowBalanceAlertOptions } from './types';

/**
 * @description
 * Builds the scheduled task that watches the TurboSMS account balance. The
 * `lowBalanceAlert` plugin option registers it for you; call this directly only if you
 * want to register it yourself, on your own schedule.
 *
 * When the balance is below the threshold it logs a warning and publishes a
 * {@link TurboSmsLowBalanceEvent}. It is skipped in dry-run mode, where the API key is
 * usually a placeholder and there is no real account to check.
 */
export function createLowBalanceTask(options: TurboSmsLowBalanceAlertOptions): ScheduledTask {
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
        Logger.warn(
          `TurboSMS balance is ${balance}, below the configured threshold of ${options.threshold}`,
          TURBOSMS_LOGGER_CTX,
        );
        await injector.get(EventBus).publish(new TurboSmsLowBalanceEvent(balance, options.threshold));
      }

      return { balance, threshold: options.threshold, low };
    },
  });
}
