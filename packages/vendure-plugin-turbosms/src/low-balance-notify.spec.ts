import { type Injector, Logger } from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyBalanceCheckFailed, notifyLowBalance } from './low-balance-notify';
import { TurboSmsRejectedError, TurboSmsTransportError } from './turbo-sms-error';

const injector = { get: vi.fn() } as unknown as Injector;

function rejection(text = 'Your code is 1234') {
  return new TurboSmsRejectedError({
    endpoint: 'message/send.json',
    responseCode: 103,
    responseStatus: 'NOT_ENOUGH_MONEY',
    recipients: ['380501234567', '380671234567'],
    text,
  });
}

describe('notifyLowBalance', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('logging', () => {
    it('reports the balance and the threshold for a scheduled check', async () => {
      await notifyLowBalance({ reason: 'scheduledCheck', balance: 42, threshold: 100 }, injector);

      expect(warn).toHaveBeenCalledWith(
        'TurboSMS balance is 42, below the configured threshold of 100',
        'TurboSmsPlugin',
      );
    });

    it('names insufficient funds and the response code for a refused send', async () => {
      await notifyLowBalance({ reason: 'sendRejected', error: rejection() }, injector);

      expect(warn).toHaveBeenCalledWith(
        'TurboSMS refused a send to 2 recipient(s) for insufficient funds: NOT_ENOUGH_MONEY (code 103)',
        'TurboSmsPlugin',
      );
    });

    it('keeps the message body out of the log', async () => {
      await notifyLowBalance({ reason: 'sendRejected', error: rejection('Your secret code is 9999') }, injector);

      expect(warn.mock.calls[0][0]).not.toContain('9999');
    });

    it('counts zero recipients when the refusal carries none', async () => {
      const error = new TurboSmsRejectedError({
        endpoint: 'message/send.json',
        responseCode: 103,
        responseStatus: 'NOT_ENOUGH_MONEY',
      });

      await notifyLowBalance({ reason: 'sendRejected', error }, injector);

      expect(warn).toHaveBeenCalledWith(
        'TurboSMS refused a send to 0 recipient(s) for insufficient funds: NOT_ENOUGH_MONEY (code 103)',
        'TurboSmsPlugin',
      );
    });

    it('logs even when no callback is configured, and counts that as delivered', async () => {
      await expect(notifyLowBalance({ reason: 'scheduledCheck', balance: 1, threshold: 2 }, injector)).resolves.toBe(
        true,
      );
      expect(warn).toHaveBeenCalledOnce();
    });
  });

  describe('the callback', () => {
    it('receives the scheduled-check context, the logged message and the injector', async () => {
      const onLowBalance = vi.fn();

      await notifyLowBalance({ reason: 'scheduledCheck', balance: 42, threshold: 100 }, injector, onLowBalance);

      expect(onLowBalance).toHaveBeenCalledOnce();
      const context = onLowBalance.mock.calls[0][0];
      expect(context).toMatchObject({ reason: 'scheduledCheck', balance: 42, threshold: 100 });
      expect(context.message).toBe(warn.mock.calls[0][0]);
      expect(context.injector).toBe(injector);
    });

    it('receives the refusal itself for a rejected send', async () => {
      const onLowBalance = vi.fn();
      const err = rejection();

      await notifyLowBalance({ reason: 'sendRejected', error: err }, injector, onLowBalance);

      const context = onLowBalance.mock.calls[0][0];
      expect(context.reason).toBe('sendRejected');
      expect(context.error).toBe(err);
      expect(context.message).toBe(warn.mock.calls[0][0]);
    });

    it('is awaited before resolving, and reports success', async () => {
      let finished = false;
      const onLowBalance = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        finished = true;
      };

      await expect(
        notifyLowBalance({ reason: 'scheduledCheck', balance: 1, threshold: 2 }, injector, onLowBalance),
      ).resolves.toBe(true);

      expect(finished).toBe(true);
    });

    it('swallows a synchronous throw, logs it against the option name and reports the failure', async () => {
      const onLowBalance = () => {
        throw new Error('notifier is down');
      };

      await expect(
        notifyLowBalance({ reason: 'scheduledCheck', balance: 1, threshold: 2 }, injector, onLowBalance),
      ).resolves.toBe(false);

      expect(error).toHaveBeenCalledOnce();
      expect(error.mock.calls[0][0]).toBe('The lowBalanceAlert.onLowBalance callback failed: notifier is down');
    });

    it('stringifies a thrown non-Error and logs no stack for it', async () => {
      const onLowBalance = () => Promise.reject('notifier is down');

      await expect(
        notifyLowBalance({ reason: 'scheduledCheck', balance: 1, threshold: 2 }, injector, onLowBalance),
      ).resolves.toBe(false);

      expect(error).toHaveBeenCalledWith(
        'The lowBalanceAlert.onLowBalance callback failed: notifier is down',
        'TurboSmsPlugin',
        undefined,
      );
    });

    it('swallows a rejected promise too', async () => {
      const onLowBalance = () => Promise.reject(new Error('timed out'));

      await expect(
        notifyLowBalance({ reason: 'sendRejected', error: rejection() }, injector, onLowBalance),
      ).resolves.toBe(false);

      expect(error).toHaveBeenCalledOnce();
      expect(error.mock.calls[0][0]).toContain('timed out');
    });
  });
});

describe('notifyBalanceCheckFailed', () => {
  let error: ReturnType<typeof vi.spyOn>;
  const outage = () => new TurboSmsTransportError({ endpoint: 'user/balance.json', cause: new Error('ETIMEDOUT') });

  beforeEach(() => {
    error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs an error naming the cause, with or without a callback', async () => {
    await expect(notifyBalanceCheckFailed({ error: outage(), threshold: 100 }, injector)).resolves.toBe(true);

    expect(error).toHaveBeenCalledExactlyOnceWith(
      'Could not read the TurboSMS balance, so it is not being monitored: The request to user/balance.json failed: ETIMEDOUT',
      'TurboSmsPlugin',
    );
  });

  it('hands the callback the error, the threshold, the logged message and the injector', async () => {
    const onCheckFailed = vi.fn();
    const err = outage();

    await expect(notifyBalanceCheckFailed({ error: err, threshold: 100 }, injector, onCheckFailed)).resolves.toBe(true);

    expect(onCheckFailed).toHaveBeenCalledOnce();
    const context = onCheckFailed.mock.calls[0][0];
    expect(context.error).toBe(err);
    expect(context.threshold).toBe(100);
    expect(context.message).toBe(error.mock.calls[0][0]);
    expect(context.injector).toBe(injector);
  });

  it('swallows a failing callback, logs it against the option name and reports the failure', async () => {
    const onCheckFailed = () => Promise.reject(new Error('notifier is down'));

    await expect(notifyBalanceCheckFailed({ error: outage(), threshold: 100 }, injector, onCheckFailed)).resolves.toBe(
      false,
    );

    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[1][0]).toBe('The lowBalanceAlert.onCheckFailed callback failed: notifier is down');
  });
});
