import { VendureEvent } from '@vendure/core';
import { type TurboSmsError } from './turbo-sms-error';
import { type TurboSmsSendResult } from './types';

/**
 * @description
 * Published after a send request is accepted by TurboSMS, so metering and audit logging
 * do not have to wrap every call site.
 *
 * Individual recipients may still have been refused — see `result.refused`. A dry-run
 * send publishes this too, with `result.dryRun` set.
 */
export class TurboSmsSentEvent extends VendureEvent {
  constructor(readonly result: TurboSmsSendResult) {
    super();
  }
}

/**
 * @description
 * Published when a send request fails as a whole, just before the error is thrown. The
 * `error` tells you which kind it was: a {@link TurboSmsRejectedError} means TurboSMS
 * refused it, a {@link TurboSmsTransportError} means the outcome is unknown.
 */
export class TurboSmsFailedEvent extends VendureEvent {
  constructor(
    /** The recipients, after normalization. */
    readonly recipients: string[],
    readonly text: string,
    readonly sender: string,
    readonly error: TurboSmsError,
  ) {
    super();
  }
}

/**
 * @description
 * Published by the **scheduled** balance check when the account balance is below the
 * configured threshold, i.e. only when `lowBalanceAlert.threshold` is set.
 *
 * A send that TurboSMS refuses for insufficient funds does **not** publish this — there is
 * no balance figure to report. That case arrives as a {@link TurboSmsFailedEvent} carrying
 * a {@link TurboSmsRejectedError} whose `responseCode` is
 * `INSUFFICIENT_FUNDS_RESPONSE_CODE`, and it calls `lowBalanceAlert.onLowBalance`.
 */
export class TurboSmsLowBalanceEvent extends VendureEvent {
  constructor(
    /** The current balance, in the currency of the account (UAH). */
    readonly balance: number,
    /** The threshold it fell below. */
    readonly threshold: number,
  ) {
    super();
  }
}
