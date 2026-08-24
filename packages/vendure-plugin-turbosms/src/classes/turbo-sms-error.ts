import { type TurboSmsResponseResult } from '../types';

/**
 * @description
 * Thrown when TurboSMS rejects a send request. Carries the raw response so callers can
 * decide what to do per recipient.
 */
export class TurboSmsError extends Error {
  constructor(
    readonly smsMessage: string,
    readonly responseCode: number,
    readonly responseStatus: string,
    readonly responseResult: TurboSmsResponseResult[],
    readonly recipients: string[],
  ) {
    super(
      `Error sending SMS message: ${JSON.stringify({
        smsMessage,
        responseCode,
        responseStatus,
        responseResult,
        recipients,
      })}`,
    );
    this.name = 'TurboSmsError';
  }

  /** The per-recipient `response_code` values, in the order returned by the API. */
  get recipientCodes(): number[] {
    return this.responseResult.map((r) => r.response_code);
  }
}
