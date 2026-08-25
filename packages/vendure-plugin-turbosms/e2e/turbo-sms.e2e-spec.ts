import path from 'path';
import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TurboSmsPlugin, TurboSmsService } from '../src';
// Internal constants: not part of the package's public API, imported directly.
import { DEFAULT_TURBOSMS_API_URL, DEFAULT_TURBOSMS_TIMEOUT } from '../src/constants';
import { initialData } from './fixtures/initial-data';

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

  it('resolves the exported service from the injector', () => {
    expect(server.app.get(TurboSmsService)).toBeInstanceOf(TurboSmsService);
  });

  it('applies the option defaults', () => {
    expect(TurboSmsPlugin.options).toEqual({
      apiKey: 'x',
      sender: 'Test',
      dryRun: true,
      apiUrl: DEFAULT_TURBOSMS_API_URL,
      timeout: DEFAULT_TURBOSMS_TIMEOUT,
    });
    expect(server.app.get(TurboSmsService).isDryRun).toBe(true);
  });

  it('sends without making any HTTP request in dryRun mode', async () => {
    // The plugin talks to TurboSMS with the global `fetch`, so a real call would land
    // here. Only stubbed for this test, since the test server itself boots on `fetch`.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      const result = await server.app.get(TurboSmsService).send('+38 (050) 123-45-67', 'Your code is 1234');

      expect(result).toEqual({
        dryRun: true,
        recipients: ['380501234567'],
        text: 'Your code is 1234',
        sender: 'Test',
        accepted: ['380501234567'],
        refused: [],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
