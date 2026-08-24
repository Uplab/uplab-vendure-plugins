import { LanguageCode, type RequestContext } from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TURBOSMS_API_URL } from './constants';
import { SmsService } from './sms.service';
import { type TurboSmsApiService } from './turbo-sms-api.service';
import { type ResolvedTurboSmsPluginOptions } from './types';

function makeService(options: Partial<ResolvedTurboSmsPluginOptions> = {}) {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const api = { sendMessage } as unknown as TurboSmsApiService;
  const service = new SmsService(api, {
    apiKey: 'key',
    sender: 'Brand',
    dryRun: false,
    apiUrl: DEFAULT_TURBOSMS_API_URL,
    defaultLanguageCode: LanguageCode.en,
    ...options,
  });
  return { service, sendMessage };
}

const ctx = (languageCode: LanguageCode) => ({ languageCode }) as RequestContext;

describe('SmsService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('sendOtpCode', () => {
    it('always uses the Ukrainian template for 380 numbers, whatever the context language', async () => {
      const { service, sendMessage } = makeService();

      const result = await service.sendOtpCode(ctx(LanguageCode.en), '380501234567', '1234');

      expect(result).toEqual({ isCodeSent: true });
      expect(sendMessage).toHaveBeenCalledWith(['380501234567'], 'Ваш код входу Brand – 1234');
    });

    it('uses the context language for non-Ukrainian numbers', async () => {
      const { service, sendMessage } = makeService();

      await service.sendOtpCode(ctx(LanguageCode.pl), '48501234567', '1234');

      expect(sendMessage).toHaveBeenCalledWith(['48501234567'], 'Twój kod logowania Brand – 1234');
    });

    it('lets a configured resolveLanguage override the built-in rule, even for 380 numbers', async () => {
      const { service, sendMessage } = makeService({ resolveLanguage: () => LanguageCode.en });

      await service.sendOtpCode(ctx(LanguageCode.uk), '380501234567', '1234');

      expect(sendMessage).toHaveBeenCalledWith(['380501234567'], 'Your Brand login code – 1234');
    });
  });

  describe('resolveLanguage', () => {
    it('pins Ukrainian numbers to Ukrainian whatever the context language', () => {
      const { service } = makeService();

      expect(service.resolveLanguage(ctx(LanguageCode.en), '380501234567')).toBe(LanguageCode.uk);
    });

    it('falls back to the context language for every other number', () => {
      const { service } = makeService();

      expect(service.resolveLanguage(ctx(LanguageCode.pl), '48501234567')).toBe(LanguageCode.pl);
    });

    it('delegates entirely to the configured resolver, which sees the recipient', () => {
      const resolveLanguage = vi.fn().mockReturnValue(LanguageCode.de);
      const { service } = makeService({ resolveLanguage });

      expect(service.resolveLanguage(ctx(LanguageCode.uk), '380501234567')).toBe(LanguageCode.de);
      expect(resolveLanguage).toHaveBeenCalledWith('380501234567');
    });
  });

  describe('template', () => {
    it('prefers a caller-supplied override over the shipped template', () => {
      const { service } = makeService({
        translations: { [LanguageCode.uk]: { otpCode: 'Код {code}' } },
      });

      expect(service.template(LanguageCode.uk).otpCode).toBe('Код {code}');
    });

    it('falls back to the configured default language for an unsupported language', () => {
      const { service } = makeService({ defaultLanguageCode: LanguageCode.uk });

      expect(service.template(LanguageCode.de).otpCode).toBe('Ваш код входу {sender} – {code}');
    });

    it('falls back to English when the default language has no template either', () => {
      const { service } = makeService({ defaultLanguageCode: LanguageCode.de });

      expect(service.template(LanguageCode.fr).otpCode).toBe('Your {sender} login code – {code}');
    });
  });
});
