import { type LanguageCode } from '@vendure/core';

/**
 * A single message template. `{code}` and `{sender}` are interpolated.
 */
export interface TurboSmsTranslations {
  /** Template of the one-time-password message sent by `SmsService.sendOtpCode()`. */
  otpCode: string;
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
   * Base URL of the TurboSMS REST API. Override it to point at a mock server.
   *
   * @default 'https://api.turbosms.ua/'
   */
  apiUrl?: string;
  /**
   * @description
   * Language used when the request context has no translation available.
   *
   * @default LanguageCode.en
   */
  defaultLanguageCode?: LanguageCode;
  /**
   * @description
   * Overrides for the built-in message templates, merged over the defaults per language.
   * Add a language that the plugin does not ship, or reword an existing one.
   *
   * @example
   * ```ts
   * translations: {
   *   [LanguageCode.uk]: { otpCode: 'Код: {code}' },
   * }
   * ```
   */
  translations?: Partial<Record<LanguageCode, Partial<TurboSmsTranslations>>>;
}

/**
 * Resolved options — every optional value has been defaulted.
 */
export type ResolvedTurboSmsPluginOptions = TurboSmsPluginOptions &
  Required<Pick<TurboSmsPluginOptions, 'dryRun' | 'apiUrl' | 'defaultLanguageCode'>>;

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
