import { type Injector, Logger } from '@vendure/core';
import { TURBOSMS_LOGGER_CTX } from './constants';
import { type TurboSmsError, type TurboSmsRejectedError } from './turbo-sms-error';
import {
  type TurboSmsBalanceCheckFailedCallback,
  type TurboSmsLowBalanceCallback,
  type TurboSmsLowBalanceContext,
} from './types';

/**
 * What happened, before the message and the injector are filled in. The two arms mirror
 * {@link TurboSmsLowBalanceContext}.
 */
export type TurboSmsLowBalanceTrigger =
  | { reason: 'scheduledCheck'; balance: number; threshold: number }
  | { reason: 'sendRejected'; error: TurboSmsRejectedError };

/**
 * Both trigger points funnel through here, so the log line and the callback can never
 * drift apart.
 *
 * Contract, relied on by both call sites: it always logs, it awaits the callback, and it
 * **never throws** — a callback that fails is caught and logged, so it cannot break a send
 * or fail a scheduled run.
 */
export async function notifyLowBalance(
  trigger: TurboSmsLowBalanceTrigger,
  injector: Injector,
  onLowBalance?: TurboSmsLowBalanceCallback,
): Promise<void> {
  const message = describe(trigger);
  Logger.warn(message, TURBOSMS_LOGGER_CTX);

  if (!onLowBalance) {
    return;
  }

  try {
    await onLowBalance(toContext(trigger, message, injector));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    Logger.error(
      `The lowBalanceAlert.onLowBalance callback failed: ${reason}`,
      TURBOSMS_LOGGER_CTX,
      e instanceof Error ? e.stack : undefined,
    );
  }
}

/**
 * The check-failed counterpart, with the same contract: it always logs, it awaits the
 * callback, and it never throws — the caller rethrows the underlying error itself.
 */
export async function notifyBalanceCheckFailed(
  trigger: { error: TurboSmsError; threshold: number },
  injector: Injector,
  onCheckFailed?: TurboSmsBalanceCheckFailedCallback,
): Promise<void> {
  const message = `Could not read the TurboSMS balance, so it is not being monitored: ${trigger.error.message}`;
  Logger.error(message, TURBOSMS_LOGGER_CTX);

  if (!onCheckFailed) {
    return;
  }

  try {
    await onCheckFailed({ error: trigger.error, threshold: trigger.threshold, message, injector });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    Logger.error(
      `The lowBalanceAlert.onCheckFailed callback failed: ${reason}`,
      TURBOSMS_LOGGER_CTX,
      e instanceof Error ? e.stack : undefined,
    );
  }
}

function describe(trigger: TurboSmsLowBalanceTrigger): string {
  if (trigger.reason === 'scheduledCheck') {
    return `TurboSMS balance is ${trigger.balance}, below the configured threshold of ${trigger.threshold}`;
  }
  // The message body is deliberately left out: it never belongs in a log line.
  const recipients = trigger.error.recipients?.length ?? 0;
  return (
    `TurboSMS refused a send to ${recipients} recipient(s) for insufficient funds: ` +
    `${trigger.error.responseStatus} (code ${trigger.error.responseCode})`
  );
}

function toContext(trigger: TurboSmsLowBalanceTrigger, message: string, injector: Injector): TurboSmsLowBalanceContext {
  if (trigger.reason === 'scheduledCheck') {
    return { reason: 'scheduledCheck', balance: trigger.balance, threshold: trigger.threshold, message, injector };
  }
  return { reason: 'sendRejected', error: trigger.error, message, injector };
}
