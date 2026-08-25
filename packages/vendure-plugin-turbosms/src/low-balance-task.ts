import { CacheService, EventBus, Injector, ScheduledTask, type ScheduledTaskConfig } from '@vendure/core';
import {
  CHECK_FAILED_ALERTED_CACHE_KEY,
  DEFAULT_LOW_BALANCE_SCHEDULE,
  LOW_BALANCE_ALERTED_CACHE_KEY_PREFIX,
  LOW_BALANCE_CALLBACK_HEADROOM,
  LOW_BALANCE_TASK_ID,
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
  /**
   * What the scheduler would allow if the task set nothing — `DefaultSchedulerPlugin`'s
   * `defaultTimeout`. Left alone when it already clears the request; see {@link taskTimeout}.
   */
  schedulerDefaultTimeout: ScheduledTaskConfig['timeout'];
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
  const interval = alertInterval(options.minIntervalBetweenAlerts);

  return new ScheduledTask({
    id: LOW_BALANCE_TASK_ID,
    description: 'Warns when the TurboSMS account balance runs low',
    schedule: options.schedule ?? DEFAULT_LOW_BALANCE_SCHEDULE,
    timeout: taskTimeout(options.requestTimeout, options.schedulerDefaultTimeout),
    execute: async ({ injector }) => {
      const turboSms = injector.get(TurboSmsService);

      if (turboSms.isDryRun) {
        return { skipped: 'dryRun' };
      }

      const alerts = new AlertGate(injector, interval);

      let balance: number;
      try {
        balance = await turboSms.getBalance();
      } catch (e) {
        // Not knowing the balance is its own emergency: monitoring has gone blind, which the
        // failed-run record alone does not push anywhere. The service wraps every provider
        // failure — including a body without a balance — in a TurboSmsError; anything else
        // is a bug rather than an outage, so it is left alone.
        if (e instanceof TurboSmsError && (await alerts.isOpen(CHECK_FAILED_ALERTED_CACHE_KEY))) {
          const delivered = await notifyBalanceCheckFailed(
            { error: e, threshold: options.threshold },
            injector,
            options.onCheckFailed,
          );
          if (delivered) {
            await alerts.close(CHECK_FAILED_ALERTED_CACHE_KEY);
          }
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

      const notified = await alerts.isOpen(lowBalanceKey);
      if (notified) {
        // Logs, then runs the callback; never throws, so a failing callback cannot fail the
        // scheduled run.
        const delivered = await notifyLowBalance(
          { reason: 'scheduledCheck', balance, threshold: options.threshold },
          injector,
          options.onLowBalance,
        );
        await injector.get(EventBus).publish(new TurboSmsLowBalanceEvent(balance, options.threshold));
        // The interval only starts once the alert actually went out. A callback that threw is
        // retried on the next run instead of being silenced for the whole interval.
        if (delivered) {
          await alerts.close(lowBalanceKey);
        }
      }

      return { balance, threshold: options.threshold, low, notified };
    },
  });
}

/**
 * A non-positive interval means "no interval". A `0` in particular must not reach the cache
 * as a TTL: every Vendure cache strategy reads `ttl: 0` as "never expire", which would turn
 * "alert every run" into "alert once, ever".
 */
function alertInterval(minIntervalBetweenAlerts: number | undefined): number | undefined {
  return minIntervalBetweenAlerts !== undefined && minIntervalBetweenAlerts > 0 ? minIntervalBetweenAlerts : undefined;
}

/**
 * The scheduler's default is left alone when one request plus the callbacks fit inside it,
 * and replaced by that budget when they do not — whether because the request timeout was
 * raised or the scheduler default lowered. Overriding unconditionally would cut a generous
 * host default down to 30s for the default request timeout.
 *
 * A default given as a string (`'2m'`) can only be read by the scheduler's own parser, so it
 * is trusted as is: the task then behaves exactly as it did before it had a timeout of its own.
 */
function taskTimeout(requestTimeout: number, schedulerDefault: ScheduledTaskConfig['timeout']): number | undefined {
  const budget = requestTimeout + LOW_BALANCE_CALLBACK_HEADROOM;
  return typeof schedulerDefault === 'number' && schedulerDefault < budget ? budget : undefined;
}

/**
 * Decides whether this run may alert, given `minIntervalBetweenAlerts`.
 *
 * State lives in Vendure's {@link CacheService}, so it is exactly as durable as the host's
 * cache strategy: Redis or DB survives restarts and is shared between instances, the default
 * in-memory strategy is per process. `DefaultSchedulerPlugin` runs a task on one instance at
 * a time, so read-then-write needs no atomic compare-and-set.
 *
 * Every cache failure fails **open** — a duplicate alert beats a silently dropped one. That
 * is `CacheService`'s own contract: it logs and returns `undefined` on a strategy error
 * rather than throwing, so an unreadable key looks like an open gate.
 */
class AlertGate {
  private readonly store: { cache: CacheService; ttl: number } | undefined;

  constructor(injector: Injector, minIntervalBetweenAlerts: number | undefined) {
    this.store =
      minIntervalBetweenAlerts === undefined
        ? undefined
        : { cache: injector.get(CacheService), ttl: minIntervalBetweenAlerts };
  }

  /** `true` when nothing was reported under `key` within the interval, so this run may alert. */
  async isOpen(key: string): Promise<boolean> {
    if (!this.store) {
      return true;
    }
    return !(await this.store.cache.get<true>(key));
  }

  /** Starts the interval. Called only once the alert went out, so a failed one is retried. */
  async close(key: string): Promise<void> {
    await this.store?.cache.set(key, true, { ttl: this.store.ttl });
  }

  /** Re-arms the alert, because the condition it reported is over. */
  async release(key: string): Promise<void> {
    await this.store?.cache.delete(key);
  }
}
