import { describe, expect, it } from 'vitest';
import { TurboSmsError, TurboSmsRejectedError, TurboSmsTransportError } from './turbo-sms-error';
import { type TurboSmsResponseResult } from './types';

function result(phone: string, response_code: number): TurboSmsResponseResult {
  return { phone, response_code, response_status: 'OK', message_id: null };
}

describe('TurboSmsRejectedError', () => {
  it('is a TurboSmsError, so one catch covers both failure kinds', () => {
    const error = new TurboSmsRejectedError({
      endpoint: 'message/send.json',
      responseCode: 103,
      responseStatus: 'NOT_ENOUGH_MONEY',
    });

    expect(error).toBeInstanceOf(TurboSmsError);
    expect(error.name).toBe('TurboSmsRejectedError');
    expect(error.message).toBe('TurboSMS rejected the request to message/send.json: NOT_ENOUGH_MONEY (code 103)');
  });

  describe('recipientCodes', () => {
    it('returns the response_code of every per-recipient result', () => {
      const error = new TurboSmsRejectedError({
        endpoint: 'message/send.json',
        responseCode: 0,
        responseStatus: 'OK',
        responseResult: [result('380501234567', 0), result('380671234567', 800)],
      });

      expect(error.recipientCodes).toEqual([0, 800]);
    });

    it('returns an empty array when the response carried no per-recipient results', () => {
      const error = new TurboSmsRejectedError({
        endpoint: 'user/balance.json',
        responseCode: 1,
        responseStatus: 'ERROR',
      });

      expect(error.recipientCodes).toEqual([]);
    });
  });
});

describe('TurboSmsTransportError', () => {
  it('is a TurboSmsError', () => {
    expect(new TurboSmsTransportError({ endpoint: 'message/send.json' })).toBeInstanceOf(TurboSmsError);
  });

  it('describes an HTTP status', () => {
    const error = new TurboSmsTransportError({ endpoint: 'message/send.json', status: 502 });

    expect(error.message).toBe('The request to message/send.json failed: HTTP 502');
    expect(error.status).toBe(502);
  });

  it('describes and keeps the underlying cause', () => {
    const cause = new Error('The operation was aborted due to timeout');
    const error = new TurboSmsTransportError({ endpoint: 'message/send.json', cause });

    expect(error.message).toBe('The request to message/send.json failed: The operation was aborted due to timeout');
    expect(error.cause).toBe(cause);
  });

  it('falls back to a generic reason when there is neither a status nor a cause', () => {
    expect(new TurboSmsTransportError({ endpoint: 'message/send.json' }).message).toBe(
      'The request to message/send.json failed: unknown error',
    );
  });
});
