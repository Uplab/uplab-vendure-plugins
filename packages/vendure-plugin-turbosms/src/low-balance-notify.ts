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
 * or fail a scheduled run. Resolves to whether the alert went out: `false` only when the
 * callback threw, so the scheduled check can retry it next run instead of going quiet.
 */
export async function notifyLowBalance(
  trigger: TurboSmsLowBalanceTrigger,
  injector: Injector,
  onLowBalance?: TurboSmsLowBalanceCallback,
): Promise<boolean> {
  const message = summarize(trigger);
  Logger.warn(message, TURBOSMS_LOGGER_CTX);

  return invokeCallback('onLowBalance', onLowBalance && (() => onLowBalance(toContext(trigger, message, injector))));
}

/**
 * The check-failed counterpart, with the same contract: it always logs, it awaits the
 * callback, and it never throws — the caller rethrows the underlying error itself.
 */
export async function notifyBalanceCheckFailed(
  trigger: { error: TurboSmsError; threshold: number },
  injector: Injector,
  onCheckFailed?: TurboSmsBalanceCheckFailedCallback,
): Promise<boolean> {
  const message = `Could not read the TurboSMS balance, so it is not being monitored: ${trigger.error.message}`;
  Logger.error(message, TURBOSMS_LOGGER_CTX);

  return invokeCallback(
    'onCheckFailed',
    onCheckFailed && (() => onCheckFailed({ error: trigger.error, threshold: trigger.threshold, message, injector })),
  );
}

/**
 * Runs one of the `lowBalanceAlert` callbacks under the shared contract: awaited, and a
 * throw is logged against the option's name rather than propagated. `true` when there was
 * nothing to run or it returned normally.
 */
async function invokeCallback(
  option: 'onLowBalance' | 'onCheckFailed',
  run: (() => void | Promise<void>) | undefined,
): Promise<boolean> {
  if (!run) {
    return true;
  }

  try {
    await run();
    return true;
  } catch (e) {
    Logger.error(
      `The lowBalanceAlert.${option} callback failed: ${e instanceof Error ? e.message : String(e)}`,
      TURBOSMS_LOGGER_CTX,
      e instanceof Error ? e.stack : undefined,
    );
    return false;
  }
}

function summarize(trigger: TurboSmsLowBalanceTrigger): string {
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
