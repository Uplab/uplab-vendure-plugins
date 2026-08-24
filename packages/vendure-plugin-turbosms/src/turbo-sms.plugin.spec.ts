import { getConfigurationFunction, type RuntimeVendureConfig } from '@vendure/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TURBOSMS_API_URL, DEFAULT_TURBOSMS_TIMEOUT, LOW_BALANCE_TASK_ID } from './constants';
import { TurboSmsPlugin } from './turbo-sms.plugin';

/** Applies the plugin's `configuration` hook to a config carrying only what it touches. */
async function configure(): Promise<RuntimeVendureConfig> {
  const config = { schedulerOptions: { tasks: [] } } as unknown as RuntimeVendureConfig;
  return (await getConfigurationFunction(TurboSmsPlugin)?.(config)) ?? config;
}

describe('TurboSmsPlugin.init', () => {
  it('defaults every optional option', () => {
    TurboSmsPlugin.init({ apiKey: 'key', sender: 'Brand' });

    expect(TurboSmsPlugin.options).toEqual({
      apiKey: 'key',
      sender: 'Brand',
      dryRun: false,
      apiUrl: DEFAULT_TURBOSMS_API_URL,
      timeout: DEFAULT_TURBOSMS_TIMEOUT,
    });
  });

  it('keeps a default when the option is passed as undefined', () => {
    TurboSmsPlugin.init({ apiKey: 'key', sender: 'Brand', dryRun: undefined, timeout: undefined });

    expect(TurboSmsPlugin.options).toMatchObject({ dryRun: false, timeout: DEFAULT_TURBOSMS_TIMEOUT });
  });

  it('adds the trailing slash an apiUrl needs to keep its path', () => {
    TurboSmsPlugin.init({ apiKey: 'key', sender: 'Brand', apiUrl: 'http://localhost:3000/turbosms' });

    expect(TurboSmsPlugin.options.apiUrl).toBe('http://localhost:3000/turbosms/');
  });
});

describe('the lowBalanceAlert option', () => {
  it('registers no scheduled task when it is not configured', async () => {
    TurboSmsPlugin.init({ apiKey: 'key', sender: 'Brand' });

    expect((await configure()).schedulerOptions.tasks).toEqual([]);
  });

  it('registers the balance check when it is configured', async () => {
    TurboSmsPlugin.init({ apiKey: 'key', sender: 'Brand', lowBalanceAlert: { threshold: 100 } });

    const { tasks } = (await configure()).schedulerOptions;

    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(LOW_BALANCE_TASK_ID);
    expect(tasks[0].options.schedule).toBe('0 9 * * *');
  });

  it('uses a configured schedule instead of the default', async () => {
    TurboSmsPlugin.init({
      apiKey: 'key',
      sender: 'Brand',
      lowBalanceAlert: { threshold: 100, schedule: '*/30 * * * *' },
    });

    const { tasks } = (await configure()).schedulerOptions;

    expect(tasks[0].options.schedule).toBe('*/30 * * * *');
  });
});
