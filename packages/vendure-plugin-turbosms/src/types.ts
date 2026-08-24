import { type ScheduledTaskConfig } from '@vendure/core';

/**
 * @description
 * Turns on the scheduled TurboSMS balance check. See the `lowBalanceAlert` option.
 */
export interface TurboSmsLowBalanceAlertOptions {
  /**
   * @description
   * Warn when the account balance drops below this figure, in the currency of the
   * TurboSMS account (UAH).
   */
  threshold: number;
  /**
   * @description
   * When to check, as a cron expression or a `cron-time-generator` callback.
   *
   * @default '0 9 * * *' (every day at 09:00)
   */
  schedule?: ScheduledTaskConfig['schedule'];
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
   * Registers a scheduled task that checks the account balance and warns when it runs
   * low, publishing a {@link TurboSmsLowBalanceEvent}. Omit it and no task is registered.
   *
   * Requires a scheduler plugin (such as Vendure's `DefaultSchedulerPlugin`) to be
   * configured, since that is what runs scheduled tasks.
   *
   * @example
   * ```ts
   * lowBalanceAlert: { threshold: 100 },
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
