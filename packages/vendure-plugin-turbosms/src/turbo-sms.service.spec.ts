import { type ModuleRef } from '@nestjs/core';
import { type EventBus, Logger } from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TURBOSMS_API_URL, DEFAULT_TURBOSMS_TIMEOUT } from './constants';
import { TurboSmsFailedEvent, TurboSmsSentEvent } from './events';
import { TurboSmsError, TurboSmsRejectedError, TurboSmsTransportError } from './turbo-sms-error';
import { TurboSmsService } from './turbo-sms.service';
import { type ResolvedTurboSmsPluginOptions } from './types';

const fetchMock = vi.fn();
const publish = vi.fn();
/** Stands in for Nest's ModuleRef; the Injector the service builds delegates to it. */
const moduleRefGet = vi.fn();

function makeService(options: Partial<ResolvedTurboSmsPluginOptions> = {}): TurboSmsService {
  return new TurboSmsService(
    {
      apiKey: 'key',
      sender: 'Brand',
      dryRun: false,
      apiUrl: DEFAULT_TURBOSMS_API_URL,
      timeout: DEFAULT_TURBOSMS_TIMEOUT,
      ...options,
    },
    { publish } as unknown as EventBus,
    { get: moduleRefGet } as unknown as ModuleRef,
  );
}

/** A successful `fetch` returning `body` as JSON. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** A per-recipient row of a send response. */
function row(phone: string, response_code: number, response_status = 'OK') {
  return { phone, response_code, response_status, message_id: null };
}

const accepted = { response_code: 0, response_status: 'OK', response_result: [] };

/** The single event published during a call. */
function publishedEvent<T>(): T {
  expect(publish).toHaveBeenCalledOnce();
  return publish.mock.calls[0][0] as T;
}

describe('TurboSmsService', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    publish.mockReset();
    moduleRefGet.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    // The insufficient-funds path logs through notifyLowBalance; keep the output clean.
    vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('send', () => {
    it('posts the recipient, sender and text to the send endpoint', async () => {
      fetchMock.mockResolvedValue(jsonResponse(accepted));

      const result = await makeService().send('380501234567', 'hello');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url.toString()).toBe('https://api.turbosms.ua/message/send.json');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer key' });
      expect(JSON.parse(init.body)).toEqual({
        recipients: ['380501234567'],
        sms: { sender: 'Brand', text: 'hello' },
      });
      expect(result).toEqual({
        dryRun: false,
        recipients: ['380501234567'],
        text: 'hello',
        sender: 'Brand',
        accepted: ['380501234567'],
        refused: [],
        response: accepted,
      });
    });

    it('lets a per-call sender override the configured alpha name', async () => {
      fetchMock.mockResolvedValue(jsonResponse(accepted));

      const result = await makeService().send('380501234567', 'hello', { sender: 'OtherBrand' });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).sms.sender).toBe('OtherBrand');
      expect(result.sender).toBe('OtherBrand');
    });

    it('aborts the request after the configured timeout', async () => {
      fetchMock.mockResolvedValue(jsonResponse(accepted));

      await makeService({ timeout: 250 }).send('380501234567', 'hello');

      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('resolves endpoints against a custom apiUrl, keeping its path', async () => {
      fetchMock.mockResolvedValue(jsonResponse(accepted));

      await makeService({ apiUrl: 'http://localhost:3000/turbosms/' }).send('380501234567', 'hello');

      expect(fetchMock.mock.calls[0][0].toString()).toBe('http://localhost:3000/turbosms/message/send.json');
    });

    it('accepts the per-channel delivery status codes', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ...accepted, response_code: 801, response_status: 'QUEUED' }));

      await expect(makeService().send('380501234567', 'hello')).resolves.toMatchObject({ dryRun: false });
    });

    it('rejects a negative response code rather than reading it as success', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ...accepted, response_code: -1, response_status: 'UNKNOWN' }));

      await expect(makeService().send('380501234567', 'hello')).rejects.toBeInstanceOf(TurboSmsRejectedError);
    });
  });

  describe('recipient normalization', () => {
    it('strips the separators a storefront collects before sending', async () => {
      fetchMock.mockResolvedValue(jsonResponse(accepted));

      const result = await makeService().send('+38 (050) 123-45-67', 'hello');

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).recipients).toEqual(['380501234567']);
      expect(result.recipients).toEqual(['380501234567']);
    });

    it('sends a national number as it was stored rather than guessing a country', async () => {
      fetchMock.mockResolvedValue(jsonResponse(accepted));

      await makeService().send('0501234567', 'hello');

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).recipients).toEqual(['0501234567']);
    });

    it('normalizes in dry-run mode too, so the log shows what would go out', async () => {
      const result = await makeService({ dryRun: true }).send('+38 (050) 123-45-67', 'hi');

      expect(result.recipients).toEqual(['380501234567']);
    });
  });

  describe('accepted and refused recipients', () => {
    it('splits the per-recipient rows of an accepted request', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          response_code: 0,
          response_status: 'OK',
          response_result: [row('380501234567', 0), row('380671234567', 20, 'INVALID_NUMBER')],
        }),
      );

      const result = await makeService().sendBulk(['380501234567', '380671234567'], 'hello');

      expect(result.accepted).toEqual(['380501234567']);
      expect(result.refused).toEqual([{ phone: '380671234567', responseCode: 20, responseStatus: 'INVALID_NUMBER' }]);
    });

    it('treats every recipient as accepted when the response reports no per-number rows', async () => {
      fetchMock.mockResolvedValue(jsonResponse(accepted));

      const result = await makeService().sendBulk(['380501234567', '380671234567'], 'hello');

      expect(result.accepted).toEqual(['380501234567', '380671234567']);
      expect(result.refused).toEqual([]);
    });
  });

  describe('errors', () => {
    it('throws a TurboSmsRejectedError carrying the per-recipient codes', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          response_code: 103,
          response_status: 'NOT_ENOUGH_MONEY',
          response_result: [row('380501234567', 103, 'FAIL')],
        }),
      );

      const error = await makeService()
        .send('380501234567', 'hello')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TurboSmsRejectedError);
      expect(error).toBeInstanceOf(TurboSmsError);
      expect(error).toMatchObject({
        endpoint: 'message/send.json',
        responseCode: 103,
        responseStatus: 'NOT_ENOUGH_MONEY',
        recipients: ['380501234567'],
        text: 'hello',
      });
      expect((error as TurboSmsRejectedError).responseResult?.map((r) => r.response_code)).toEqual([103]);
    });

    it('keeps the message body out of the error message', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ response_code: 103, response_status: 'NOT_ENOUGH_MONEY', response_result: [] }),
      );

      const error = (await makeService()
        .send('380501234567', 'Your login code is 1234')
        .catch((e: unknown) => e)) as TurboSmsRejectedError;

      expect(error.message).not.toContain('1234');
      expect(error.text).toBe('Your login code is 1234');
    });

    it('wraps a network failure in a TurboSmsTransportError', async () => {
      const cause = new Error('socket hang up');
      fetchMock.mockRejectedValue(cause);

      const error = await makeService()
        .send('380501234567', 'hello')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TurboSmsTransportError);
      expect(error).toBeInstanceOf(TurboSmsError);
      expect((error as TurboSmsTransportError).cause).toBe(cause);
      expect((error as Error).message).toContain('socket hang up');
    });

    it('wraps a non-2xx response in a TurboSmsTransportError carrying the status', async () => {
      fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

      const error = await makeService()
        .send('380501234567', 'hello')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TurboSmsTransportError);
      expect((error as TurboSmsTransportError).status).toBe(401);
    });

    it('wraps a body that is not JSON in a TurboSmsTransportError', async () => {
      fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }));

      await expect(makeService().send('380501234567', 'hello')).rejects.toBeInstanceOf(TurboSmsTransportError);
    });
  });

  describe('events', () => {
    it('publishes a TurboSmsSentEvent with the result', async () => {
      fetchMock.mockResolvedValue(jsonResponse(accepted));

      const result = await makeService().send('380501234567', 'hello');
      const event = publishedEvent<TurboSmsSentEvent>();

      expect(event).toBeInstanceOf(TurboSmsSentEvent);
      expect(event.result).toBe(result);
    });

    it('publishes a TurboSmsSentEvent in dry-run mode, flagged as such', async () => {
      const result = await makeService({ dryRun: true }).send('380501234567', 'hello');
      const event = publishedEvent<TurboSmsSentEvent>();

      expect(event).toBeInstanceOf(TurboSmsSentEvent);
      expect(event.result).toBe(result);
      expect(result.dryRun).toBe(true);
    });

    it('publishes a TurboSmsFailedEvent when TurboSMS refuses the request', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ response_code: 103, response_status: 'NOT_ENOUGH_MONEY', response_result: [] }),
      );

      await makeService().send('380501234567', 'hello').catch(noop);
      const event = publishedEvent<TurboSmsFailedEvent>();

      expect(event).toBeInstanceOf(TurboSmsFailedEvent);
      expect(event.recipients).toEqual(['380501234567']);
      expect(event.text).toBe('hello');
      expect(event.sender).toBe('Brand');
      expect(event.error).toBeInstanceOf(TurboSmsRejectedError);
    });

    it('publishes a TurboSmsFailedEvent when the request never gets through', async () => {
      fetchMock.mockRejectedValue(new Error('socket hang up'));

      await makeService().send('380501234567', 'hello').catch(noop);
      const event = publishedEvent<TurboSmsFailedEvent>();

      expect(event.error).toBeInstanceOf(TurboSmsTransportError);
    });
  });

  describe('sendBulk', () => {
    it('sends one request for every recipient', async () => {
      fetchMock.mockResolvedValue(jsonResponse(accepted));

      const result = await makeService().sendBulk(['380501234567', '380671234567'], 'hello');

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).recipients).toEqual(['380501234567', '380671234567']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.recipients).toEqual(['380501234567', '380671234567']);
    });
  });

  describe('dryRun', () => {
    it('does not call the API and reports what it would have sent', async () => {
      const result = await makeService({ dryRun: true }).send('380501234567', 'hello');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        dryRun: true,
        recipients: ['380501234567'],
        text: 'hello',
        sender: 'Brand',
        accepted: ['380501234567'],
        refused: [],
      });
    });

    it('is exposed as isDryRun', () => {
      expect(makeService({ dryRun: true }).isDryRun).toBe(true);
      expect(makeService().isDryRun).toBe(false);
    });
  });

  describe('getBalance', () => {
    it('returns the balance in UAH on a successful response', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ response_code: 0, response_status: 'OK', response_result: { balance: 150.5 } }),
      );

      await expect(makeService().getBalance()).resolves.toBe(150.5);
      expect(fetchMock.mock.calls[0][0].toString()).toBe('https://api.turbosms.ua/user/balance.json');
    });

    it('throws a TurboSmsRejectedError when the response is not a success code', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ response_code: 1, response_status: 'ERROR', response_result: {} }));

      const error = await makeService()
        .getBalance()
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TurboSmsRejectedError);
      expect(error).toMatchObject({ endpoint: 'user/balance.json', responseCode: 1 });
    });

    it('calls the API even in dryRun mode', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ response_code: 0, response_status: 'OK', response_result: { balance: 0 } }),
      );

      await makeService({ dryRun: true }).getBalance();

      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe('insufficient funds', () => {
    const outOfCredit = { response_code: 103, response_status: 'NOT_ENOUGH_MONEY', response_result: [] };

    it('calls onLowBalance with the refusal that is about to be thrown', async () => {
      const onLowBalance = vi.fn();
      fetchMock.mockResolvedValue(jsonResponse(outOfCredit));

      const error = await makeService({ lowBalanceAlert: { onLowBalance } })
        .send('380501234567', 'hello')
        .catch((e: unknown) => e);

      expect(onLowBalance).toHaveBeenCalledOnce();
      const context = onLowBalance.mock.calls[0][0];
      expect(context.reason).toBe('sendRejected');
      // The very same instance: the callback cannot substitute or swallow it.
      expect(context.error).toBe(error);
      expect((error as TurboSmsRejectedError).responseCode).toBe(103);
    });

    it('still publishes TurboSmsFailedEvent as well as calling the callback', async () => {
      const onLowBalance = vi.fn();
      fetchMock.mockResolvedValue(jsonResponse(outOfCredit));

      await makeService({ lowBalanceAlert: { onLowBalance } }).send('380501234567', 'hello').catch(noop);

      expect(publishedEvent<TurboSmsFailedEvent>()).toBeInstanceOf(TurboSmsFailedEvent);
      expect(onLowBalance).toHaveBeenCalledOnce();
    });

    it('hands the callback an injector that resolves through the module ref', async () => {
      const onLowBalance = vi.fn();
      const token = Symbol('SomeService');
      fetchMock.mockResolvedValue(jsonResponse(outOfCredit));

      await makeService({ lowBalanceAlert: { onLowBalance } }).send('380501234567', 'hello').catch(noop);

      onLowBalance.mock.calls[0][0].injector.get(token);
      expect(moduleRefGet).toHaveBeenCalledWith(token, { strict: false });
    });

    it('is not called for a refusal with any other response code', async () => {
      const onLowBalance = vi.fn();
      fetchMock.mockResolvedValue(
        jsonResponse({ response_code: 20, response_status: 'INVALID_NUMBER', response_result: [] }),
      );

      await makeService({ lowBalanceAlert: { onLowBalance } }).send('380501234567', 'hello').catch(noop);

      expect(onLowBalance).not.toHaveBeenCalled();
    });

    it('is not called when the request never reached TurboSMS', async () => {
      const onLowBalance = vi.fn();
      fetchMock.mockRejectedValue(new Error('network down'));

      const error = await makeService({ lowBalanceAlert: { onLowBalance } })
        .send('380501234567', 'hello')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TurboSmsTransportError);
      expect(onLowBalance).not.toHaveBeenCalled();
    });

    it('rejects with the TurboSMS refusal even when the callback throws', async () => {
      const onLowBalance = vi.fn().mockRejectedValue(new Error('notifier is down'));
      fetchMock.mockResolvedValue(jsonResponse(outOfCredit));

      const error = await makeService({ lowBalanceAlert: { onLowBalance } })
        .send('380501234567', 'hello')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TurboSmsRejectedError);
      expect((error as Error).message).not.toContain('notifier is down');
    });

    it('rejects as usual when no lowBalanceAlert is configured', async () => {
      fetchMock.mockResolvedValue(jsonResponse(outOfCredit));

      await expect(makeService().send('380501234567', 'hello')).rejects.toBeInstanceOf(TurboSmsRejectedError);
    });
  });
});

function noop(): void {
  // Swallows a rejection whose error the assertions read off the published event instead.
}
