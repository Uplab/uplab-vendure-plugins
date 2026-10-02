export const CURRENCY_EXCHANGE_RATE_PLUGIN_OPTIONS = Symbol('CURRENCY_EXCHANGE_RATE_PLUGIN_OPTIONS');
export const loggerCtx = 'CurrencyExchangeRatePlugin';

/** Every 3 hours at minute 40. */
export const DEFAULT_SYNC_SCHEDULE = '40 2-23/3 * * *';

export const SYNC_TASK_ID = 'currency-exchange-rate-updater';

/** How long a source request may take before it is aborted, in milliseconds. */
export const DEFAULT_SOURCE_TIMEOUT = 10_000;
