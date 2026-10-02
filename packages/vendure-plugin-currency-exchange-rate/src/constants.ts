export const CURRENCY_EXCHANGE_RATE_PLUGIN_OPTIONS = Symbol('CURRENCY_EXCHANGE_RATE_PLUGIN_OPTIONS');
export const loggerCtx = 'CurrencyExchangeRatePlugin';

/** Every 3 hours at minute 40 — the schedule the sync has always run on. */
export const DEFAULT_SYNC_SCHEDULE = '40 2-23/3 * * *';

/** Kept from the first release: the scheduler stores each task's last run under its id. */
export const SYNC_TASK_ID = 'currency-exchange-rate-updater';

/** How long a source request may take before it is aborted, in milliseconds. */
export const DEFAULT_SOURCE_TIMEOUT = 10_000;
