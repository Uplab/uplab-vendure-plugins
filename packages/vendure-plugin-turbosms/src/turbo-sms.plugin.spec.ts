import { getConfigurationFunction, Logger, type RuntimeVendureConfig } from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
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

  it('registers no task when only a callback is configured, so no scheduler is needed', async () => {
    const onLowBalance = vi.fn();
    TurboSmsPlugin.init({ apiKey: 'key', sender: 'Brand', lowBalanceAlert: { onLowBalance } });

    const { tasks } = (await configure()).schedulerOptions;

    expect(tasks).toEqual([]);
    expect(TurboSmsPlugin.options.lowBalanceAlert?.onLowBalance).toBe(onLowBalance);
  });

  it('registers the task when a threshold accompanies the callback', async () => {
    TurboSmsPlugin.init({
      apiKey: 'key',
      sender: 'Brand',
      lowBalanceAlert: { threshold: 100, onLowBalance: vi.fn() },
    });

    const { tasks } = (await configure()).schedulerOptions;

    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(LOW_BALANCE_TASK_ID);
  });

  it('warns that a schedule without a threshold registers nothing', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    TurboSmsPlugin.init({ apiKey: 'key', sender: 'Brand', lowBalanceAlert: { schedule: '*/5 * * * *' } });

    const { tasks } = (await configure()).schedulerOptions;

    expect(tasks).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('no threshold');
    warn.mockRestore();
  });
});
