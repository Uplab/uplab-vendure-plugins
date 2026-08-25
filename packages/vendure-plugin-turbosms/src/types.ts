import { type Injector, type ScheduledTaskConfig } from '@vendure/core';
import { type TurboSmsError, type TurboSmsRejectedError } from './turbo-sms-error';

/**
 * @description
 * Why {@link TurboSmsLowBalanceCallback} was called. Narrow on `reason` to reach the
 * details — or read `message`, which is populated on both, so a callback that only
 * forwards text does not have to narrow at all.
 */
export type TurboSmsLowBalanceContext =
  | {
      /** A scheduled balance check found the balance below the configured threshold. */
      reason: 'scheduledCheck';
      /** The current balance, in the currency of the account (UAH). */
      balance: number;
      /** The threshold it fell below. */
      threshold: number;
      /** A one-line summary — the same text the plugin logs. Written for humans; do not parse it. */
      message: string;
      /** Vendure's injector, for reaching your own services from the callback. */
      injector: Injector;
    }
  | {
      /** TurboSMS refused a send for insufficient funds: the account is already empty. */
      reason: 'sendRejected';
      /** The refusal, carrying the recipients and the response code. */
      error: TurboSmsRejectedError;
      /** A one-line summary — the same text the plugin logs. Written for humans; do not parse it. */
      message: string;
      /** Vendure's injector, for reaching your own services from the callback. */
      injector: Injector;
    };

/**
 * @description
 * Called when the TurboSMS account is running out of credit, from either trigger. Errors
 * it throws are caught and logged: a failing callback never breaks a send or a scheduled
 * run. It is awaited, so keep it quick and queue anything slow.
 */
export type TurboSmsLowBalanceCallback = (context: TurboSmsLowBalanceContext) => void | Promise<void>;

/**
 * @description
 * Handed to {@link TurboSmsBalanceCheckFailedCallback} when a scheduled check could not read
 * the balance at all.
 */
export interface TurboSmsBalanceCheckFailedContext {
  /** What went wrong: a refusal from TurboSMS, or a request that never got an answer. */
  error: TurboSmsError;
  /** The threshold the check would have compared against. */
  threshold: number;
  /** A one-line summary — the same text the plugin logs. Written for humans; do not parse it. */
  message: string;
  /** Vendure's injector, for reaching your own services from the callback. */
  injector: Injector;
}

/**
 * @description
 * Called when a scheduled balance check fails outright — balance monitoring has gone blind,
 * which is a different emergency from a low balance. Errors it throws are caught and logged,
 * and the check's own error is rethrown afterwards, so the scheduler still records the run as
 * failed. It is awaited, so keep it quick and queue anything slow.
 */
export type TurboSmsBalanceCheckFailedCallback = (context: TurboSmsBalanceCheckFailedContext) => void | Promise<void>;

/**
 * @description
 * Low-balance alerting: a callback, a scheduled balance check, or both. See the
 * `lowBalanceAlert` option.
 */
export interface TurboSmsLowBalanceAlertOptions {
  /**
   * @description
   * Warn when the account balance drops below this figure, in the currency of the
   * TurboSMS account (UAH).
   *
   * Omit it and no scheduled task is registered — `onLowBalance` still fires when TurboSMS
   * refuses a send for insufficient funds, which needs neither a threshold nor a scheduler.
   */
  threshold?: number;
  /**
   * @description
   * When to check, as a cron expression or a `cron-time-generator` callback. Ignored
   * unless a `threshold` is set, since that is what registers the scheduled task.
   *
   * @default '0 9 * * *' (every day at 09:00)
   */
  schedule?: ScheduledTaskConfig['schedule'];
  /**
   * @description
   * What to do about a low balance. See {@link TurboSmsLowBalanceCallback}.
   *
   * @example
   * ```ts
   * onLowBalance: ({ message }) => notifySlack(message),
   * ```
   */
  onLowBalance?: TurboSmsLowBalanceCallback;
  /**
   * @description
   * Once the scheduled check has alerted, stay quiet for this many milliseconds — unless the
   * balance recovers to the threshold or above first, which re-arms the alert immediately. A
   * top-up followed by another drop is therefore reported, however short the interval was.
   * Only the check itself sees the healthy runs, which is why this cannot be built around the
   * plugin from a callback.
   *
   * State lives in Vendure's `CacheService`, so it is exactly as durable as the configured
   * cache strategy: Redis or DB survives restarts and is shared between instances, while the
   * default in-memory strategy resets on restart. Cache failures fail open — a duplicate alert
   * beats a silently dropped one.
   *
   * Gates the scheduled check only, including its {@link TurboSmsLowBalanceEvent} and
   * `onCheckFailed` (each under its own key). `onLowBalance` with `reason: 'sendRejected'` is
   * never gated: its rate is bounded by your own send volume, and each one is a customer
   * message that actually failed.
   *
   * Omit it for the raw behaviour — an alert on every scheduled run while the balance is low.
   *
   * @example
   * ```ts
   * minIntervalBetweenAlerts: 24 * 60 * 60 * 1000,
   * ```
   */
  minIntervalBetweenAlerts?: number;
  /**
   * @description
   * What to do when a scheduled check fails outright. The task rethrows either way, so the
   * scheduler records the failed run; without this callback that record is the only signal,
   * and a prolonged TurboSMS outage leaves balance monitoring blind with nobody told.
   *
   * @example
   * ```ts
   * onCheckFailed: ({ message }) => notifySlack(message),
   * ```
   */
  onCheckFailed?: TurboSmsBalanceCheckFailedCallback;
}

/**
 * @description
 * Configuration options for the {@link TurboSmsPlugin}.
 */
export interface TurboSmsPluginOptions {
  /**
   * @description
   * The TurboSMS API key (the "Bearer" token from your TurboSMS account).
   */
  apiKey: string;
  /**
   * @description
   * The registered alphanumeric sender name ("alpha name") that messages are sent from.
   * This is the identifier registered with TurboSMS, not display copy — it can be
   * overridden per call.
   */
  sender: string;
  /**
   * @description
   * When `true`, no request is made to TurboSMS — the message is written to the Vendure
   * log instead. Use this in local development and in tests.
   *
   * @default false
   */
  dryRun?: boolean;
  /**
   * @description
   * Base URL of the TurboSMS REST API. Override it to point at a mock server. A trailing
   * slash is added if you leave it off.
   *
   * @default 'https://api.turbosms.ua/'
   */
  apiUrl?: string;
  /**
   * @description
   * How long a request to TurboSMS may take before it is aborted, in milliseconds.
   *
   * @default 10000
   */
  timeout?: number;
  /**
   * @description
   * Alerting for an account that is running out of credit. There are two triggers, and
   * both call `onLowBalance`:
   *
   * - **A refused send.** TurboSMS rejects a send for insufficient funds — immediate,
   *   exact, and needs neither a threshold nor a scheduler.
   * - **A scheduled check.** Set a `threshold` and the plugin registers a task that polls
   *   the balance and warns *before* sends start failing, also publishing a
   *   {@link TurboSmsLowBalanceEvent}. It needs a scheduler plugin (such as Vendure's
   *   `DefaultSchedulerPlugin`) to be configured, since that is what runs scheduled tasks.
   *
   * Omit the option entirely and neither trigger does anything.
   *
   * @example
   * ```ts
   * lowBalanceAlert: {
   *   threshold: 100,
   *   onLowBalance: ({ message }) => notifySlack(message),
   * },
   * ```
   */
  lowBalanceAlert?: TurboSmsLowBalanceAlertOptions;
}

/**
 * Resolved options — the values that have a default have been filled in.
 */
export type ResolvedTurboSmsPluginOptions = TurboSmsPluginOptions &
  Required<Pick<TurboSmsPluginOptions, 'dryRun' | 'apiUrl' | 'timeout'>>;

/**
 * @description
 * Per-call overrides for {@link TurboSmsService.send} and
 * {@link TurboSmsService.sendBulk}.
 */
export interface TurboSmsSendOptions {
  /**
   * @description
   * The alpha name to send from, overriding the plugin-level `sender` for this message.
   * It must be registered with your TurboSMS account.
   */
  sender?: string;
}

/**
 * @description
 * A recipient TurboSMS would not deliver to, and the code it gave for that number.
 */
export interface TurboSmsRefusedRecipient {
  phone: string;
  responseCode: number;
  responseStatus: string;
}

/**
 * @description
 * What a send call did. In dry-run mode nothing reached TurboSMS, so `response` is
 * absent — check `dryRun` before reading it.
 */
export interface TurboSmsSendResult {
  /** `true` when the plugin is in dry-run mode and the message was only logged. */
  dryRun: boolean;
  /** The recipients the message was addressed to, after normalization. */
  recipients: string[];
  /** The message body. */
  text: string;
  /** The alpha name the message was sent from. */
  sender: string;
  /**
   * The recipients TurboSMS took for delivery. A request can be accepted as a whole while
   * an individual number is refused, so this is not always every recipient.
   */
  accepted: string[];
  /** The recipients TurboSMS refused, with the code it gave for each. Usually empty. */
  refused: TurboSmsRefusedRecipient[];
  /** The raw TurboSMS response. Absent in dry-run mode. */
  response?: TurboSmsSendMessageResponse;
}

export interface TurboSmsResponseResult {
  phone: string;
  response_code: number;
  response_status: string;
  message_id: string | null;
}

export interface TurboSmsSendMessageResponse {
  response_code: number;
  response_status: string;
  response_result: TurboSmsResponseResult[];
}

export interface TurboSmsBalanceResponse {
  response_code: number;
  response_status: string;
  response_result: {
    balance: number;
  };
}
