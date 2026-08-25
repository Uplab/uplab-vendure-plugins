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
 * @description
 * The TurboSMS response code for "not enough money on the account balance". A send
 * rejected with this code is what triggers `lowBalanceAlert.onLowBalance` with
 * `reason: 'sendRejected'`; it is exported so a `TurboSmsFailedEvent` subscriber can
 * recognise the same case without a magic number.
 */
export const INSUFFICIENT_FUNDS_RESPONSE_CODE = 103;

/**
 * @description
 * The per-recipient code for a number TurboSMS will not deliver to because its country is not
 * enabled on the account. An application that falls back to another channel for those countries
 * treats this as routine rather than as a failure worth alerting on.
 *
 * This is a row in `response_result`, not the request-level `response_code` — a send can be
 * accepted as a whole while an individual number is refused with it.
 */
export const RECIPIENT_COUNTRY_NOT_ALLOWED_CODE = 406;

/**
 * @description
 * The per-recipient code meaning the account cannot pay for this message. It is the row-level
 * counterpart of {@link INSUFFICIENT_FUNDS_RESPONSE_CODE}: TurboSMS reports an empty account
 * either way, and which one you get depends on where it noticed.
 *
 * Unlike {@link RECIPIENT_COUNTRY_NOT_ALLOWED_CODE} this is never routine — every recipient is
 * affected, and it will not resolve itself.
 */
export const RECIPIENT_INSUFFICIENT_FUNDS_CODE = 203;

/**
 * When the scheduled balance check runs, unless `lowBalanceAlert.schedule` says otherwise.
 */
export const DEFAULT_LOW_BALANCE_SCHEDULE = '0 9 * * *';

/**
 * The id of the scheduled task registered by the `lowBalanceAlert` option.
 */
export const LOW_BALANCE_TASK_ID = 'turbosms-low-balance';

/**
 * How much longer than one API request the scheduled check is allowed to take, covering the
 * `onLowBalance` callback. A task that gives up while its only request is still in flight
 * reports a failure that never happened.
 */
export const LOW_BALANCE_CALLBACK_HEADROOM = 20_000;

/**
 * Cache key prefix under which the scheduled check records that it has already alerted. The
 * threshold is appended, so changing it in config re-arms the alert even under a cache that
 * outlives the process.
 */
export const LOW_BALANCE_ALERTED_CACHE_KEY_PREFIX = 'turbosms:low-balance:alerted:';

/**
 * Cache key under which the scheduled check records that it has already reported being unable
 * to read the balance. Not keyed by threshold — a threshold change says nothing about whether
 * monitoring is still blind.
 */
export const CHECK_FAILED_ALERTED_CACHE_KEY = 'turbosms:low-balance:check-failed';
