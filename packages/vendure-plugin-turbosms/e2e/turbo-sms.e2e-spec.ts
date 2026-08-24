import path from 'path';
import { LanguageCode, mergeConfig, RequestContextService } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import type axios from 'axios';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SmsService, TurboSmsApiService, TurboSmsPlugin } from '../src';
import { initialData } from './fixtures/initial-data';

/**
 * Every axios instance the plugin creates is this stub, so a real HTTP call would show up
 * here. Nothing in dry-run mode should ever reach it.
 */
const post = vi.fn();
vi.mock('axios', async () => {
  const actual = await vi.importActual<{ default: typeof axios }>('axios');
  return {
    ...actual,
    default: { ...actual.default, create: vi.fn(() => ({ post })) },
  };
});

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__sqlite-data__')));

describe('TurboSmsPlugin', () => {
  const { server } = createTestEnvironment(
    mergeConfig(testConfig, {
      plugins: [
        TurboSmsPlugin.init({
          apiKey: 'x',
          dryRun: true,
          sender: 'Test',
        }),
      ],
    }),
  );

  beforeAll(async () => {
    await server.init({ initialData, customerCount: 1 });
  }, 120_000);

  afterAll(async () => {
    await server.destroy();
  });

  it('resolves the exported services from the injector', () => {
    expect(server.app.get(SmsService)).toBeInstanceOf(SmsService);
    expect(server.app.get(TurboSmsApiService)).toBeInstanceOf(TurboSmsApiService);
  });

  it('applies the option defaults', () => {
    expect(TurboSmsPlugin.options).toMatchObject({
      apiKey: 'x',
      sender: 'Test',
      dryRun: true,
      apiUrl: 'https://api.turbosms.ua/',
      defaultLanguageCode: LanguageCode.en,
    });
    expect(server.app.get(TurboSmsApiService).isDryRun).toBe(true);
  });

  it('sends an OTP code without making any HTTP request in dryRun mode', async () => {
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'shop', languageCode: LanguageCode.uk });

    const result = await server.app.get(SmsService).sendOtpCode(ctx, '380501234567', '1234');

    expect(result).toEqual({ isCodeSent: true });
    expect(post).not.toHaveBeenCalled();
  });

  it('renders the Ukrainian template for a Ukrainian number', () => {
    expect(server.app.get(SmsService).template(LanguageCode.uk).otpCode).toBe('Ваш код входу {sender} – {code}');
  });
});
