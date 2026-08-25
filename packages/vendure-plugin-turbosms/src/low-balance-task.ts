import { CacheService, EventBus, Injector, Logger, ScheduledTask } from '@vendure/core';
import {
  CHECK_FAILED_ALERTED_CACHE_KEY,
  DEFAULT_LOW_BALANCE_SCHEDULE,
  LOW_BALANCE_ALERTED_CACHE_KEY_PREFIX,
  LOW_BALANCE_CALLBACK_HEADROOM,
  LOW_BALANCE_TASK_ID,
  TURBOSMS_LOGGER_CTX,
} from './constants';
import { TurboSmsLowBalanceEvent } from './events';
import { notifyBalanceCheckFailed, notifyLowBalance } from './low-balance-notify';
import { TurboSmsError } from './turbo-sms-error';
import { TurboSmsService } from './turbo-sms.service';
import { type TurboSmsLowBalanceAlertOptions } from './types';

/** The scheduled check only exists when a threshold was configured. */
export type ScheduledBalanceCheckOptions = TurboSmsLowBalanceAlertOptions & {
  threshold: number;
  /**
   * The resolved HTTP timeout, so the task's own timeout can be set to clear it. A task that
   * gives up while its only request is still in flight reports a failure that never happened.
   */
  requestTimeout: number;
};

/**
 * Builds the scheduled task that watches the TurboSMS account balance. Internal: the
 * `lowBalanceAlert` option registers it when a `threshold` is set.
 *
 * When the balance is below the threshold it warns, calls `onLowBalance` and publishes a
 * {@link TurboSmsLowBalanceEvent}. It is skipped in dry-run mode, where the API key is
 * usually a placeholder and there is no real account to check.
 *
 * With `minIntervalBetweenAlerts` set it stays quiet after alerting until the interval is up
 * — or until the balance recovers, whichever comes first. See {@link AlertGate}.
 */
export function createLowBalanceTask(options: ScheduledBalanceCheckOptions): ScheduledTask {
  const lowBalanceKey = `${LOW_BALANCE_ALERTED_CACHE_KEY_PREFIX}${options.threshold}`;

  return new ScheduledTask({
    id: LOW_BALANCE_TASK_ID,
    description: 'Warns when the TurboSMS account balance runs low',
    schedule: options.schedule ?? DEFAULT_LOW_BALANCE_SCHEDULE,
    timeout: options.requestTimeout + LOW_BALANCE_CALLBACK_HEADROOM,
    execute: async ({ injector }) => {
      const turboSms = injector.get(TurboSmsService);

      if (turboSms.isDryRun) {
        return { skipped: 'dryRun' };
      }

      const alerts = new AlertGate(injector, options.minIntervalBetweenAlerts);

      let balance: number;
      try {
        balance = await turboSms.getBalance();
      } catch (e) {
        // Not knowing the balance is its own emergency: monitoring has gone blind, which the
        // failed-run record alone does not push anywhere. Anything that is not a TurboSMS
        // failure is a bug rather than an outage, so it is left alone.
        if (e instanceof TurboSmsError && (await alerts.claim(CHECK_FAILED_ALERTED_CACHE_KEY))) {
          await notifyBalanceCheckFailed({ error: e, threshold: options.threshold }, injector, options.onCheckFailed);
        }
        // Rethrown either way: the scheduler records the failed run, callback or no callback.
        throw e;
      }

      await alerts.release(CHECK_FAILED_ALERTED_CACHE_KEY);

      const low = balance < options.threshold;

      if (!low) {
        // Recovery re-arms the alert, so a top-up followed by another drop is not swallowed by
        // an interval that is still running. Only this task sees the healthy ticks, which is
        // why a consumer cannot implement this from the outside.
        await alerts.release(lowBalanceKey);
        return { balance, threshold: options.threshold, low, notified: false };
      }

      const notified = await alerts.claim(lowBalanceKey);
      if (notified) {
        // Logs, then runs the callback; never throws, so a failing callback cannot fail the
        // scheduled run.
        await notifyLowBalance(
          { reason: 'scheduledCheck', balance, threshold: options.threshold },
          injector,
          options.onLowBalance,
        );
        await injector.get(EventBus).publish(new TurboSmsLowBalanceEvent(balance, options.threshold));
      }

      return { balance, threshold: options.threshold, low, notified };
    },
  });
}

/**
 * Decides whether this run may alert, given `minIntervalBetweenAlerts`.
 *
 * State lives in Vendure's {@link CacheService}, so it is exactly as durable as the host's
 * cache strategy: Redis or DB survives restarts and is shared between instances, the default
 * in-memory strategy resets on restart. `DefaultSchedulerPlugin` runs a task on one instance
 * at a time, so read-then-write needs no atomic compare-and-set.
 *
 * Every cache failure fails **open** — a duplicate alert beats a silently dropped one.
 */
class AlertGate {
  constructor(
    private readonly injector: Injector,
    private readonly minIntervalBetweenAlerts?: number,
  ) {}

  /** `true` when this run owns the alert and should send it. */
  async claim(key: string): Promise<boolean> {
    if (this.minIntervalBetweenAlerts === undefined) {
      return true;
    }

    try {
      const cache = this.injector.get(CacheService);
      if (await cache.get<true>(key)) {
        return false;
      }
      await cache.set(key, true, { ttl: this.minIntervalBetweenAlerts });
    } catch (e) {
      Logger.warn(
        `Could not read the low-balance alert interval, alerting anyway: ${describe(e)}`,
        TURBOSMS_LOGGER_CTX,
      );
    }

    return true;
  }

  /** Re-arms the alert, because the condition it reported is over. */
  async release(key: string): Promise<void> {
    if (this.minIntervalBetweenAlerts === undefined) {
      return;
    }

    try {
      await this.injector.get(CacheService).delete(key);
    } catch (e) {
      Logger.warn(`Could not clear the low-balance alert interval: ${describe(e)}`, TURBOSMS_LOGGER_CTX);
    }
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
