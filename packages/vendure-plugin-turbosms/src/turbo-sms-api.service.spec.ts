import { LanguageCode } from '@vendure/core';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TurboSmsError } from './classes';
import { DEFAULT_TURBOSMS_API_URL } from './constants';
import { TurboSmsApiService } from './turbo-sms-api.service';
import { type ResolvedTurboSmsPluginOptions } from './types';

vi.mock('axios');

function makeService(options: Partial<ResolvedTurboSmsPluginOptions> = {}) {
  const post = vi.fn();
  vi.mocked(axios.create).mockReturnValue({ post } as any);

  const service = new TurboSmsApiService({
    apiKey: 'key',
    sender: 'Brand',
    dryRun: false,
    apiUrl: DEFAULT_TURBOSMS_API_URL,
    defaultLanguageCode: LanguageCode.en,
    ...options,
  });
  return { service, post };
}

describe('TurboSmsApiService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('sendMessage', () => {
    it('does not call the API in dryRun mode', async () => {
      const { service, post } = makeService({ dryRun: true });

      await expect(service.sendMessage(['380501234567'], 'hello')).resolves.toBeUndefined();
      expect(post).not.toHaveBeenCalled();
    });

    it('posts the sender and text and returns the response on success', async () => {
      const { service, post } = makeService();
      post.mockResolvedValue({ data: { response_code: 0, response_status: 'OK', response_result: [] } });

      const result = await service.sendMessage(['380501234567'], 'hello');

      expect(post).toHaveBeenCalledWith('message/send.json', {
        recipients: ['380501234567'],
        sms: { sender: 'Brand', text: 'hello' },
      });
      expect(result).toEqual({ response_code: 0, response_status: 'OK', response_result: [] });
    });

    it('throws a TurboSmsError when the response code is not an accepted one', async () => {
      const { service, post } = makeService();
      post.mockResolvedValue({
        data: {
          response_code: 103,
          response_status: 'NOT_ENOUGH_MONEY',
          response_result: [{ phone: '380501234567', response_code: 103, response_status: 'FAIL', message_id: null }],
        },
      });

      await expect(service.sendMessage(['380501234567'], 'hello')).rejects.toBeInstanceOf(TurboSmsError);
    });
  });

  describe('getBalance', () => {
    it('returns the balance in UAH on a successful response', async () => {
      const { service, post } = makeService();
      post.mockResolvedValue({
        data: { response_code: 0, response_status: 'OK', response_result: { balance: 150.5 } },
      });

      const balance = await service.getBalance();

      expect(balance).toBe(150.5);
      expect(post).toHaveBeenCalledWith('user/balance.json', {});
    });

    it('throws a plain Error (not TurboSmsError) when the response is not a success code', async () => {
      const { service, post } = makeService();
      post.mockResolvedValue({ data: { response_code: 1, response_status: 'ERROR', response_result: {} } });

      await expect(service.getBalance()).rejects.toThrow(/Failed to fetch TurboSMS balance/);

      let caught: unknown;
      try {
        await service.getBalance();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(TurboSmsError);
    });
  });
});
