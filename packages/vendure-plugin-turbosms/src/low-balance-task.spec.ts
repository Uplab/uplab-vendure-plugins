import { type Injector, Logger } from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOW_BALANCE_TASK_ID } from './constants';
import { TurboSmsLowBalanceEvent } from './events';
import { createLowBalanceTask, type ScheduledBalanceCheckOptions } from './low-balance-task';
import { TurboSmsService } from './turbo-sms.service';

function run(
  turboSms: Partial<TurboSmsService>,
  options: ScheduledBalanceCheckOptions,
): { result: Promise<unknown>; publish: ReturnType<typeof vi.fn>; injector: Injector } {
  const publish = vi.fn();
  const injector = {
    get: (token: unknown) => (token === TurboSmsService ? turboSms : { publish }),
  } as unknown as Injector;

  const task = createLowBalanceTask(options);
  const result = task.options.execute({ injector, scheduledContext: {} as never, params: {} });

  return { result, publish, injector };
}

// The task logs through notifyLowBalance; keep the test output clean.
beforeEach(() => {
  vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
});

describe('createLowBalanceTask', () => {
  it('has a stable id, so an operator can find it in the admin UI', () => {
    expect(createLowBalanceTask({ threshold: 100 }).id).toBe(LOW_BALANCE_TASK_ID);
  });

  it('warns and publishes an event when the balance is below the threshold', async () => {
    const { result, publish } = run({ isDryRun: false, getBalance: async () => 42 }, { threshold: 100 });

    await expect(result).resolves.toEqual({ balance: 42, threshold: 100, low: true });

    expect(publish).toHaveBeenCalledOnce();
    const event = publish.mock.calls[0][0] as TurboSmsLowBalanceEvent;
    expect(event).toBeInstanceOf(TurboSmsLowBalanceEvent);
    expect(event).toMatchObject({ balance: 42, threshold: 100 });
  });

  it('stays quiet when the balance is healthy', async () => {
    const { result, publish } = run({ isDryRun: false, getBalance: async () => 500 }, { threshold: 100 });

    await expect(result).resolves.toEqual({ balance: 500, threshold: 100, low: false });
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

      await expect(result).resolves.toEqual({ balance: 42, threshold: 100, low: true });
      expect(publish).toHaveBeenCalledOnce();
      expect(publish.mock.calls[0][0]).toBeInstanceOf(TurboSmsLowBalanceEvent);
    });
  });
});
