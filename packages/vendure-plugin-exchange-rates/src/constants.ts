export const EXCHANGE_RATES_PLUGIN_OPTIONS = Symbol('EXCHANGE_RATES_PLUGIN_OPTIONS');
export const loggerCtx = 'ExchangeRatesPlugin';

/** Every 3 hours at minute 40. */
export const DEFAULT_SYNC_SCHEDULE = '40 2-23/3 * * *';

export const SYNC_TASK_ID = 'currency-exchange-rate-updater';

/** How long a source request may take before it is aborted, in milliseconds. */
export const DEFAULT_SOURCE_TIMEOUT = 10_000;

/** decimal(19, 8) holds 11 integer digits. */
export const MAX_RATE = 1e11;
