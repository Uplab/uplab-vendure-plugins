/**
 * The injection token under which the plugin options are provided.
 */
export const TURBOSMS_PLUGIN_OPTIONS = Symbol('TURBOSMS_PLUGIN_OPTIONS');

/**
 * The context string used by this plugin when logging.
 */
export const TURBOSMS_LOGGER_CTX = 'TurboSmsPlugin';

/**
 * The default base URL of the TurboSMS REST API.
 */
export const DEFAULT_TURBOSMS_API_URL = 'https://api.turbosms.ua/';

/**
 * How long a request to TurboSMS may take before it is aborted, in milliseconds.
 */
export const DEFAULT_TURBOSMS_TIMEOUT = 10_000;

/**
 * When the scheduled balance check runs, unless `lowBalanceAlert.schedule` says otherwise.
 */
export const DEFAULT_LOW_BALANCE_SCHEDULE = '0 9 * * *';

/**
 * The id of the scheduled task registered by the `lowBalanceAlert` option.
 */
export const LOW_BALANCE_TASK_ID = 'turbosms-low-balance';
