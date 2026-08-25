import { CacheService, type Injector, Logger } from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_FAILED_ALERTED_CACHE_KEY,
  LOW_BALANCE_ALERTED_CACHE_KEY_PREFIX,
  LOW_BALANCE_CALLBACK_HEADROOM,
  LOW_BALANCE_TASK_ID,
} from './constants';
import { TurboSmsLowBalanceEvent } from './events';
import { createLowBalanceTask, type ScheduledBalanceCheckOptions } from './low-balance-task';
import { TurboSmsTransportError } from './turbo-sms-error';
import { TurboSmsService } from './turbo-sms.service';

const REQUEST_TIMEOUT = 10_000;
const SCHEDULER_DEFAULT_TIMEOUT = 60_000;
const DAY = 86_400_000;

type TaskOptions = Omit<ScheduledBalanceCheckOptions, 'requestTimeout' | 'schedulerDefaultTimeout'> &
  Partial<Pick<ScheduledBalanceCheckOptions, 'requestTimeout' | 'schedulerDefaultTimeout'>>;

function task(options: TaskOptions) {
  return createLowBalanceTask({
    requestTimeout: REQUEST_TIMEOUT,
    schedulerDefaultTimeout: SCHEDULER_DEFAULT_TIMEOUT,
    ...options,
  });
}

/**
 * A cache double over a plain Map. TTL expiry is not simulated — the tests drive the
 * interval by clearing keys explicitly, which is the behaviour under test.
 */
function createCacheMock() {
  const store = new Map<string, unknown>();

  return {
    store,
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  };
}

/**
 * Builds the task once and lets a test execute it repeatedly against the same cache, which
 * is what the alert interval is about.
 */
function harness(turboSms: Partial<TurboSmsService>, options: TaskOptions, cache = createCacheMock()) {
  const publish = vi.fn();
  const injector = {
    get: (token: unknown) => {
      if (token === TurboSmsService) return turboSms;
      if (token === CacheService) return cache;
      return { publish };
    },
  } as unknown as Injector;

  const built = task(options);
  const execute = () => built.options.execute({ injector, scheduledContext: {} as never, params: {} });

  return { task: built, execute, publish, injector, cache };
}

function run(turboSms: Partial<TurboSmsService>, options: TaskOptions) {
  const { execute, publish, injector, cache } = harness(turboSms, options);
  return { result: execute(), publish, injector, cache };
}

const outage = () => new TurboSmsTransportError({ endpoint: 'user/balance.json', cause: new Error('ETIMEDOUT') });

// The task logs through notifyLowBalance; keep the test output clean.
beforeEach(() => {
  vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
});

describe('createLowBalanceTask', () => {
  it('has a stable id, so an operator can find it in the admin UI', () => {
    expect(task({ threshold: 100 }).id).toBe(LOW_BALANCE_TASK_ID);
  });

  describe('timeout', () => {
    it("leaves the scheduler's default alone when a request and the callbacks fit inside it", () => {
      expect(task({ threshold: 100 }).options.timeout).toBeUndefined();
    });

    it('sets its own when the request timeout was raised past what the scheduler allows', () => {
      const requestTimeout = SCHEDULER_DEFAULT_TIMEOUT - LOW_BALANCE_CALLBACK_HEADROOM + 1;

      expect(task({ threshold: 100, requestTimeout }).options.timeout).toBe(
        requestTimeout + LOW_BALANCE_CALLBACK_HEADROOM,
      );
    });

    it('sets its own when the scheduler default was lowered below one request plus the callbacks', () => {
      expect(task({ threshold: 100, schedulerDefaultTimeout: 15_000 }).options.timeout).toBe(
        REQUEST_TIMEOUT + LOW_BALANCE_CALLBACK_HEADROOM,
      );
    });

    it('does not override a scheduler default that is exactly enough', () => {
      const requestTimeout = SCHEDULER_DEFAULT_TIMEOUT - LOW_BALANCE_CALLBACK_HEADROOM;

      expect(task({ threshold: 100, requestTimeout }).options.timeout).toBeUndefined();
    });

    it.each(['5s', undefined])('trusts a scheduler default it cannot compare (%s), as before it had one', (value) => {
      expect(task({ threshold: 100, schedulerDefaultTimeout: value }).options.timeout).toBeUndefined();
    });
  });

  it('warns and publishes an event when the balance is below the threshold', async () => {
    const { result, publish } = run({ isDryRun: false, getBalance: async () => 42 }, { threshold: 100 });

    await expect(result).resolves.toEqual({ balance: 42, threshold: 100, low: true, notified: true });

    expect(publish).toHaveBeenCalledOnce();
    const event = publish.mock.calls[0][0] as TurboSmsLowBalanceEvent;
    expect(event).toBeInstanceOf(TurboSmsLowBalanceEvent);
    expect(event).toMatchObject({ balance: 42, threshold: 100 });
  });

  it('stays quiet when the balance is healthy', async () => {
    const { result, publish } = run({ isDryRun: false, getBalance: async () => 500 }, { threshold: 100 });

    await expect(result).resolves.toEqual({ balance: 500, threshold: 100, low: false, notified: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it('treats the threshold itself as healthy', async () => {
    const { result } = run({ isDryRun: false, getBalance: async () => 100 }, { threshold: 100 });

    await expect(result).resolves.toMatchObject({ low: false });
  });

  it('skips the check in dry-run mode, where there is no real account', async () => {
    const getBalance = vi.fn();
    const { result, publish } = run({ isDryRun: true, getBalance }, { threshold: 100 });

    await expect(result).resolves.toEqual({ skipped: 'dryRun' });
    expect(getBalance).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('lets a failed balance call surface, so the task is recorded as failed', async () => {
    const { result } = run(
      {
        isDryRun: false,
        getBalance: async () => {
          throw new Error('nope');
        },
      },
      { threshold: 100 },
    );

    await expect(result).rejects.toThrow('nope');
  });

  it('never touches the cache when no interval is configured', async () => {
    const { result, cache } = run({ isDryRun: false, getBalance: async () => 42 }, { threshold: 100 });

    await result;

    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    expect(cache.delete).not.toHaveBeenCalled();
  });

  describe('the onLowBalance callback', () => {
    it("is called with the scheduled-check context and the task's own injector", async () => {
      const onLowBalance = vi.fn();
      const { result, injector } = run(
        { isDryRun: false, getBalance: vi.fn().mockResolvedValue(42) },
        { threshold: 100, onLowBalance },
      );

      await result;

      expect(onLowBalance).toHaveBeenCalledOnce();
      expect(onLowBalance.mock.calls[0][0]).toMatchObject({ reason: 'scheduledCheck', balance: 42, threshold: 100 });
      expect(onLowBalance.mock.calls[0][0].injector).toBe(injector);
    });

    it('is not called when the balance is healthy', async () => {
      const onLowBalance = vi.fn();
      const { result } = run(
        { isDryRun: false, getBalance: vi.fn().mockResolvedValue(500) },
        { threshold: 100, onLowBalance },
      );

      await result;

      expect(onLowBalance).not.toHaveBeenCalled();
    });

    it('is not called in dry-run mode', async () => {
      const onLowBalance = vi.fn();
      const { result } = run({ isDryRun: true, getBalance: vi.fn() }, { threshold: 100, onLowBalance });

      await expect(result).resolves.toEqual({ skipped: 'dryRun' });
      expect(onLowBalance).not.toHaveBeenCalled();
    });

    it('cannot fail the run, and the event is still published, when it throws', async () => {
      const onLowBalance = vi.fn().mockRejectedValue(new Error('notifier is down'));
      const { result, publish } = run(
        { isDryRun: false, getBalance: vi.fn().mockResolvedValue(42) },
        { threshold: 100, onLowBalance },
      );

      await expect(result).resolves.toEqual({ balance: 42, threshold: 100, low: true, notified: true });
      expect(publish).toHaveBeenCalledOnce();
      expect(publish.mock.calls[0][0]).toBeInstanceOf(TurboSmsLowBalanceEvent);
    });
  });

  describe('minIntervalBetweenAlerts', () => {
    it('alerts on every run when it is not set, which is the default', async () => {
      const onLowBalance = vi.fn();
      const { execute, publish } = harness(
        { isDryRun: false, getBalance: vi.fn().mockResolvedValue(42) },
        { threshold: 100, onLowBalance },
      );

      await execute();
      await execute();

      expect(onLowBalance).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledTimes(2);
    });

    it.each([0, -1, Number.NaN])(
      'treats %s as no interval, rather than as a TTL that never expires',
      async (interval) => {
        const onLowBalance = vi.fn();
        const { execute, cache } = harness(
          { isDryRun: false, getBalance: vi.fn().mockResolvedValue(42) },
          { threshold: 100, onLowBalance, minIntervalBetweenAlerts: interval },
        );

        await execute();
        await execute();

        expect(onLowBalance).toHaveBeenCalledTimes(2);
        expect(cache.set).not.toHaveBeenCalled();
      },
    );

    it('alerts once while the balance stays low', async () => {
      const onLowBalance = vi.fn();
      const { execute, publish } = harness(
        { isDryRun: false, getBalance: vi.fn().mockResolvedValue(42) },
        { threshold: 100, onLowBalance, minIntervalBetweenAlerts: DAY },
      );

      await expect(execute()).resolves.toMatchObject({ notified: true });
      await expect(execute()).resolves.toMatchObject({ low: true, notified: false });

      expect(onLowBalance).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledOnce();
    });

    it('records the alert under a threshold-specific key with the interval as its TTL, in milliseconds', async () => {
      const { execute, cache } = harness(
        { isDryRun: false, getBalance: vi.fn().mockResolvedValue(42) },
        { threshold: 100, minIntervalBetweenAlerts: DAY },
      );

      await execute();

      expect(cache.set).toHaveBeenCalledExactlyOnceWith(`${LOW_BALANCE_ALERTED_CACHE_KEY_PREFIX}100`, true, {
        ttl: DAY,
      });
    });

    it('only starts the interval once the callback went through, so a failed alert is retried next run', async () => {
      const onLowBalance = vi.fn().mockRejectedValueOnce(new Error('notifier is down')).mockResolvedValue(undefined);
      const { execute, cache } = harness(
        { isDryRun: false, getBalance: vi.fn().mockResolvedValue(42) },
        { threshold: 100, onLowBalance, minIntervalBetweenAlerts: DAY },
      );

      await expect(execute()).resolves.toMatchObject({ notified: true });
      expect(cache.set).not.toHaveBeenCalled();

      await expect(execute()).resolves.toMatchObject({ notified: true });
      expect(cache.set).toHaveBeenCalledOnce();

      await expect(execute()).resolves.toMatchObject({ notified: false });
      expect(onLowBalance).toHaveBeenCalledTimes(2);
    });

    it('re-arms when the balance recovers, so a second drop is not swallowed', async () => {
      const onLowBalance = vi.fn();
      const getBalance = vi.fn().mockResolvedValueOnce(42).mockResolvedValueOnce(500).mockResolvedValueOnce(42);
      const { execute } = harness(
        { isDryRun: false, getBalance },
        { threshold: 100, onLowBalance, minIntervalBetweenAlerts: DAY },
      );

      await execute(); // low   → alerts
      await execute(); // topped up → clears the marker
      await execute(); // low again → alerts, even though the interval is still running

      expect(onLowBalance).toHaveBeenCalledTimes(2);
    });

    it('re-arms when the threshold changes, because the key carries it', async () => {
      const cache = createCacheMock();
      const turboSms = { isDryRun: false, getBalance: vi.fn().mockResolvedValue(42) };
      const interval = { minIntervalBetweenAlerts: DAY };

      await harness(turboSms, { threshold: 100, ...interval }, cache).execute();
      const second = await harness(turboSms, { threshold: 50, ...interval }, cache).execute();

      expect(second).toMatchObject({ notified: true });
    });

    it('alerts anyway when the cache is unavailable, since a duplicate beats silence', async () => {
      // CacheService never throws: on a strategy failure it logs, `get` resolves undefined
      // and `set` is a no-op. That is the shape a Redis outage actually takes.
      const cache = createCacheMock();
      cache.get.mockResolvedValue(undefined);
      cache.set.mockResolvedValue(undefined);
      const onLowBalance = vi.fn();
      const { execute } = harness(
        { isDryRun: false, getBalance: vi.fn().mockResolvedValue(42) },
        { threshold: 100, onLowBalance, minIntervalBetweenAlerts: DAY },
        cache,
      );

      await execute();
      await execute();

      expect(onLowBalance).toHaveBeenCalledTimes(2);
    });
  });

  describe('the onCheckFailed callback', () => {
    it('reports that monitoring is blind, and still fails the run', async () => {
      const onCheckFailed = vi.fn();
      const { result, injector } = run(
        {
          isDryRun: false,
          getBalance: async () => {
            throw outage();
          },
        },
        { threshold: 100, onCheckFailed },
      );

      await expect(result).rejects.toBeInstanceOf(TurboSmsTransportError);

      expect(onCheckFailed).toHaveBeenCalledOnce();
      expect(onCheckFailed.mock.calls[0][0]).toMatchObject({ threshold: 100 });
      expect(onCheckFailed.mock.calls[0][0].error).toBeInstanceOf(TurboSmsTransportError);
      expect(onCheckFailed.mock.calls[0][0].injector).toBe(injector);
    });

    it('still logs the outage and fails the run when no callback is configured', async () => {
      const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
      const { result } = run(
        {
          isDryRun: false,
          getBalance: async () => {
            throw outage();
          },
        },
        { threshold: 100 },
      );

      await expect(result).rejects.toBeInstanceOf(TurboSmsTransportError);
      expect(error.mock.calls[0][0]).toContain('Could not read the TurboSMS balance');
    });

    it('is not called for a failure that is not the provider, which is a bug not an outage', async () => {
      const onCheckFailed = vi.fn();
      const { result } = run(
        {
          isDryRun: false,
          getBalance: async () => {
            throw new RangeError('a bug in the host application');
          },
        },
        { threshold: 100, onCheckFailed },
      );

      await expect(result).rejects.toBeInstanceOf(RangeError);
      expect(onCheckFailed).not.toHaveBeenCalled();
    });

    it('cannot fail the run any harder than the check already did', async () => {
      const onCheckFailed = vi.fn().mockRejectedValue(new Error('notifier is down'));
      const { result } = run(
        {
          isDryRun: false,
          getBalance: async () => {
            throw outage();
          },
        },
        { threshold: 100, onCheckFailed },
      );

      await expect(result).rejects.toBeInstanceOf(TurboSmsTransportError);
    });

    it('shares the alert interval, under its own key', async () => {
      const onCheckFailed = vi.fn();
      const { execute, cache } = harness(
        {
          isDryRun: false,
          getBalance: async () => {
            throw outage();
          },
        },
        { threshold: 100, onCheckFailed, minIntervalBetweenAlerts: DAY },
      );

      await expect(execute()).rejects.toThrow();
      await expect(execute()).rejects.toThrow();

      expect(onCheckFailed).toHaveBeenCalledOnce();
      expect(cache.set).toHaveBeenCalledExactlyOnceWith(CHECK_FAILED_ALERTED_CACHE_KEY, true, { ttl: DAY });
    });

    it('retries next run when the callback itself failed, instead of going quiet for the interval', async () => {
      const onCheckFailed = vi.fn().mockRejectedValueOnce(new Error('notifier is down')).mockResolvedValue(undefined);
      const { execute } = harness(
        {
          isDryRun: false,
          getBalance: async () => {
            throw outage();
          },
        },
        { threshold: 100, onCheckFailed, minIntervalBetweenAlerts: DAY },
      );

      await expect(execute()).rejects.toThrow();
      await expect(execute()).rejects.toThrow();
      await expect(execute()).rejects.toThrow();

      expect(onCheckFailed).toHaveBeenCalledTimes(2);
    });

    it('re-arms once a check succeeds again', async () => {
      const onCheckFailed = vi.fn();
      let broken = true;
      const { execute, cache } = harness(
        {
          isDryRun: false,
          getBalance: async () => {
            if (broken) throw outage();
            return 500;
          },
        },
        { threshold: 100, onCheckFailed, minIntervalBetweenAlerts: DAY },
      );

      await expect(execute()).rejects.toThrow();
      expect(cache.store.has(CHECK_FAILED_ALERTED_CACHE_KEY)).toBe(true);

      broken = false;
      await execute();
      expect(cache.store.has(CHECK_FAILED_ALERTED_CACHE_KEY)).toBe(false);

      broken = true;
      await expect(execute()).rejects.toThrow();
      expect(onCheckFailed).toHaveBeenCalledTimes(2);
    });
  });
});
