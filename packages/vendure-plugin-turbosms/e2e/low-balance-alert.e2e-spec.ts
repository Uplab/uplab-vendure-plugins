import path from 'path';
import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TurboSmsPlugin, TurboSmsService, type TurboSmsLowBalanceContext } from '../src';
import { initialData } from './fixtures/initial-data';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__sqlite-data__')));

/**
 * The unit tests all hand the service a fake injector, so only a booted server proves the
 * real wiring: that `TurboSmsService` can build a Vendure `Injector` from Nest's
 * `ModuleRef`, and that the callback receives one that resolves the application's own
 * providers.
 *
 * It lives in its own file because `TurboSmsPlugin.options` is static — a second `init()`
 * in the neighbouring spec would clobber that server's options.
 */
describe('lowBalanceAlert', () => {
  const contexts: TurboSmsLowBalanceContext[] = [];

  const { server } = createTestEnvironment(
    mergeConfig(testConfig, {
      // Its own port: vitest runs the e2e files in parallel, and two test servers on the
      // default port collide with EADDRINUSE.
      apiOptions: { port: 3051 },
      plugins: [
        TurboSmsPlugin.init({
          apiKey: 'x',
          sender: 'Test',
          // Not a dry run: the reactive trigger only fires on a real refusal.
          dryRun: false,
          lowBalanceAlert: {
            onLowBalance: (context) => {
              contexts.push(context);
            },
          },
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

  afterEach(() => {
    vi.unstubAllGlobals();
    contexts.length = 0;
  });

  it('registers no scheduled task when only a callback is configured', () => {
    expect(server.app.get(TurboSmsService).isDryRun).toBe(false);
    expect(TurboSmsPlugin.options.lowBalanceAlert?.threshold).toBeUndefined();
  });

  it('calls onLowBalance with a working injector when TurboSMS refuses for insufficient funds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ response_code: 103, response_status: 'NOT_ENOUGH_MONEY', response_result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const turboSms = server.app.get(TurboSmsService);

    await expect(turboSms.send('380501234567', 'Your code is 1234')).rejects.toThrow('NOT_ENOUGH_MONEY');

    expect(contexts).toHaveLength(1);
    const context = contexts[0];
    expect(context.reason).toBe('sendRejected');
    // The injector really resolves out of the running application.
    expect(context.injector.get(TurboSmsService)).toBe(turboSms);
  });

  it('does not call onLowBalance when the refusal is for another reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ response_code: 20, response_status: 'INVALID_NUMBER', response_result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(server.app.get(TurboSmsService).send('380501234567', 'hello')).rejects.toThrow('INVALID_NUMBER');

    expect(contexts).toEqual([]);
  });
});
