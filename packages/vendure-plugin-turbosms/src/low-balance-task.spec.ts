import { CacheService, type Injector, Logger } from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_FAILED_ALERTED_CACHE_KEY, LOW_BALANCE_CALLBACK_HEADROOM, LOW_BALANCE_TASK_ID } from './constants';
import { TurboSmsLowBalanceEvent } from './events';
import { createLowBalanceTask, type ScheduledBalanceCheckOptions } from './low-balance-task';
import { TurboSmsTransportError } from './turbo-sms-error';
import { TurboSmsService } from './turbo-sms.service';

const REQUEST_TIMEOUT = 10_000;

type TaskOptions = Omit<ScheduledBalanceCheckOptions, 'requestTimeout'> & { requestTimeout?: number };

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

  const task = createLowBalanceTask({ requestTimeout: REQUEST_TIMEOUT, ...options });
  const execute = () => task.options.execute({ injector, scheduledContext: {} as never, params: {} });

  return { task, execute, publish, injector, cache };
}

function run(turboSms: Partial<TurboSmsService>, options: TaskOptions) {
  const { execute, publish, injector, cache } = harness(turboSms, options);
  return { result: execute(), publish, injector, cache };
}

// The task logs through notifyLowBalance; keep the test output clean.
beforeEach(() => {
  vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
});

describe('createLowBalanceTask', () => {
  it('has a stable id, so an operator can find it in the admin UI', () => {
    expect(createLowBalanceTask({ threshold: 100, requestTimeout: REQUEST_TIMEOUT }).id).toBe(LOW_BALANCE_TASK_ID);
  });

  it('allows longer than one API request, so a slow response is not reported as a task failure', () => {
    const task = createLowBalanceTask({ threshold: 100, requestTimeout: REQUEST_TIMEOUT });

    expect(task.options.timeout).toBe(REQUEST_TIMEOUT + LOW_BALANCE_CALLBACK_HEADROOM);
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

    it('alerts once while the balance stays low', async () => {
      const onLowBalance = vi.fn();
      const { execute, publish } = harness(
        { isDryRun: false, getBalance: vi.fn().mockResolvedValue(42) },
        { threshold: 100, onLowBalance, minIntervalBetweenAlerts: 86_400_000 },
      );

      await expect(execute()).resolves.toMatchObject({ notified: true });
      await expect(execute()).resolves.toMatchObject({ low: true, notified: false });

      expect(onLowBalance).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledOnce();
    });

    it('re-arms when the balance recovers, so a second drop is not swallowed', async () => {
      const onLowBalance = vi.fn();
      const getBalance = vi.fn().mockResolvedValueOnce(42).mockResolvedValueOnce(500).mockResolvedValueOnce(42);
      const { execute } = harness(
        { isDryRun: false, getBalance },
        { threshold: 100, onLowBalance, minIntervalBetweenAlerts: 86_400_000 },
      );

      await execute(); // low   → alerts
      await execute(); // topped up → clears the marker
      await execute(); // low again → alerts, even though the interval is still running

      expect(onLowBalance).toHaveBeenCalledTimes(2);
    });

    it('re-arms when the threshold changes, because the key carries it', async () => {
      const cache = createCacheMock();
      const turboSms = { isDryRun: false, getBalance: vi.fn().mockResolvedValue(42) };
      const interval = { minIntervalBetweenAlerts: 86_400_000 };

      await harness(turboSms, { threshold: 100, ...interval }, cache).execute();
      const second = await harness(turboSms, { threshold: 50, ...interval }, cache).execute();

      expect(second).toMatchObject({ notified: true });
    });

    it('alerts anyway when the cache cannot be read, since a duplicate beats silence', async () => {
      const cache = createCacheMock();
      cache.get.mockRejectedValue(new Error('redis is down'));
      const onLowBalance = vi.fn();
      const { execute } = harness(
        { isDryRun: false, getBalance: vi.fn().mockResolvedValue(42) },
        { threshold: 100, onLowBalance, minIntervalBetweenAlerts: 86_400_000 },
        cache,
      );

      await execute();
      await execute();

      expect(onLowBalance).toHaveBeenCalledTimes(2);
    });
  });

  describe('the onCheckFailed callback', () => {
    const outage = () => new TurboSmsTransportError({ endpoint: 'user/balance.json', cause: new Error('ETIMEDOUT') });

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

    it('is not called for a failure that is not the provider, which is a bug not an outage', async () => {
      const onCheckFailed = vi.fn();
      const { result } = run(
        {
          isDryRun: false,
          getBalance: async () => {
            throw new TypeError('turboSms.getBalance is not a function');
          },
        },
        { threshold: 100, onCheckFailed },
      );

      await expect(result).rejects.toBeInstanceOf(TypeError);
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
      const { execute } = harness(
        {
          isDryRun: false,
          getBalance: async () => {
            throw outage();
          },
        },
        { threshold: 100, onCheckFailed, minIntervalBetweenAlerts: 86_400_000 },
      );

      await expect(execute()).rejects.toThrow();
      await expect(execute()).rejects.toThrow();

      expect(onCheckFailed).toHaveBeenCalledOnce();
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
        { threshold: 100, onCheckFailed, minIntervalBetweenAlerts: 86_400_000 },
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
