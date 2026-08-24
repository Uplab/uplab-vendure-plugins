import { type Injector } from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
import { LOW_BALANCE_TASK_ID } from './constants';
import { TurboSmsLowBalanceEvent } from './events';
import { createLowBalanceTask } from './low-balance-task';
import { TurboSmsService } from './turbo-sms.service';

function run(
  turboSms: Partial<TurboSmsService>,
  options: { threshold: number },
): { result: Promise<unknown>; publish: ReturnType<typeof vi.fn> } {
  const publish = vi.fn();
  const injector = {
    get: (token: unknown) => (token === TurboSmsService ? turboSms : { publish }),
  } as unknown as Injector;

  const task = createLowBalanceTask(options);
  const result = task.options.execute({ injector, scheduledContext: {} as never, params: {} });

  return { result, publish };
}

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
});
