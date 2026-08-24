import { Inject, Injectable } from '@nestjs/common';
import { EventBus, Logger } from '@vendure/core';
import { TURBOSMS_LOGGER_CTX, TURBOSMS_PLUGIN_OPTIONS } from './constants';
import { TurboSmsFailedEvent, TurboSmsSentEvent } from './events';
import { normalizePhoneNumber } from './phone';
import { TurboSmsError, TurboSmsRejectedError, TurboSmsTransportError } from './turbo-sms-error';
import {
  type ResolvedTurboSmsPluginOptions,
  type TurboSmsBalanceResponse,
  type TurboSmsRefusedRecipient,
  type TurboSmsResponseResult,
  type TurboSmsSendMessageResponse,
  type TurboSmsSendOptions,
  type TurboSmsSendResult,
} from './types';

const SEND_ENDPOINT = 'message/send.json';
const BALANCE_ENDPOINT = 'user/balance.json';

/**
 * TurboSMS response codes that mean "accepted, nothing went wrong".
 * 0/1 are the generic success codes; 800-803 are per-channel delivery statuses.
 */
function isAcceptedResponseCode(code: number): boolean {
  return code === 0 || code === 1 || (code >= 800 && code <= 803);
}

/**
 * Splits the per-recipient rows of a send response into the numbers TurboSMS took and
 * the ones it would not deliver to.
 */
function splitRecipients(
  recipients: string[],
  results: TurboSmsResponseResult[] | undefined,
): Pick<TurboSmsSendResult, 'accepted' | 'refused'> {
  // TurboSMS answers with one row per recipient. No rows means it reported nothing per
  // number, and the request as a whole was accepted.
  if (!results?.length) {
    return { accepted: recipients, refused: [] };
  }

  const accepted: string[] = [];
  const refused: TurboSmsRefusedRecipient[] = [];

  for (const row of results) {
    if (isAcceptedResponseCode(row.response_code)) {
      accepted.push(row.phone);
    } else {
      refused.push({ phone: row.phone, responseCode: row.response_code, responseStatus: row.response_status });
    }
  }

  return { accepted, refused };
}

/**
 * @description
 * A typed client for the TurboSMS REST API. Injectable and exported by the
 * {@link TurboSmsPlugin}.
 *
 * The service is deliberately message-agnostic: it sends the text you hand it. Composing
 * that text — templates, translations, which language a given customer reads — belongs to
 * the application, which knows its own copy.
 */
@Injectable()
export class TurboSmsService {
  constructor(
    @Inject(TURBOSMS_PLUGIN_OPTIONS)
    private options: ResolvedTurboSmsPluginOptions,
    private eventBus: EventBus,
  ) {}

  /**
   * @description
   * True when sending is stubbed out — no request reaches TurboSMS and there is no real
   * account balance to monitor.
   */
  get isDryRun(): boolean {
    return this.options.dryRun;
  }

  /**
   * @description
   * The number is stripped down to the digits TurboSMS expects, so the shape a storefront
   * happened to collect — `+38 (050) 123-45-67` — is fine. It must already be an
   * international number: see {@link normalizePhoneNumber}.
   *
   * Throws {@link TurboSmsRejectedError} when TurboSMS refuses the request, and
   * {@link TurboSmsTransportError} when the request fails or times out. Both extend
   * {@link TurboSmsError}, so one `catch` covers falling back to another channel.
   */
  async send(recipient: string, text: string, options: TurboSmsSendOptions = {}): Promise<TurboSmsSendResult> {
    return this.sendBulk([recipient], text, options);
  }

  /**
   * @description
   * Sends the same `text` to every recipient in one request.
   *
   * A request can be accepted as a whole while an individual number is refused, so the
   * result splits the recipients into `accepted` and `refused` rather than leaving that
   * in the raw response.
   */
  async sendBulk(recipients: string[], text: string, options: TurboSmsSendOptions = {}): Promise<TurboSmsSendResult> {
    const sender = options.sender ?? this.options.sender;
    const normalized = recipients.map(normalizePhoneNumber);

    if (this.options.dryRun) {
      Logger.info(`[dryRun] SMS from "${sender}" to ${normalized.join(', ')}:\n${text}`, TURBOSMS_LOGGER_CTX);
      return this.published({
        dryRun: true,
        recipients: normalized,
        text,
        sender,
        accepted: normalized,
        refused: [],
      });
    }

    let response: TurboSmsSendMessageResponse;
    try {
      response = await this.post<TurboSmsSendMessageResponse>(SEND_ENDPOINT, {
        recipients: normalized,
        sms: { sender, text },
      });
    } catch (e) {
      if (e instanceof TurboSmsError) {
        await this.eventBus.publish(new TurboSmsFailedEvent(normalized, text, sender, e));
      }
      throw e;
    }

    if (!isAcceptedResponseCode(response.response_code)) {
      const error = new TurboSmsRejectedError({
        endpoint: SEND_ENDPOINT,
        responseCode: response.response_code,
        responseStatus: response.response_status,
        responseResult: response.response_result,
        recipients: normalized,
        text,
      });
      await this.eventBus.publish(new TurboSmsFailedEvent(normalized, text, sender, error));
      throw error;
    }

    return this.published({
      dryRun: false,
      recipients: normalized,
      text,
      sender,
      response,
      ...splitRecipients(normalized, response.response_result),
    });
  }

  /**
   * @description
   * Returns the TurboSMS account balance, in the currency of the account (UAH).
   *
   * This is a live call even in dry-run mode, where the configured API key is usually a
   * placeholder — guard it with {@link TurboSmsService.isDryRun}. To watch the balance
   * without writing the plumbing, use the `lowBalanceAlert` plugin option.
   */
  async getBalance(): Promise<number> {
    const response = await this.post<TurboSmsBalanceResponse>(BALANCE_ENDPOINT, {});

    if (response.response_code !== 0) {
      throw new TurboSmsRejectedError({
        endpoint: BALANCE_ENDPOINT,
        responseCode: response.response_code,
        responseStatus: response.response_status,
      });
    }

    return response.response_result.balance;
  }

  private async published(result: TurboSmsSendResult): Promise<TurboSmsSendResult> {
    await this.eventBus.publish(new TurboSmsSentEvent(result));
    return result;
  }

  private async post<T>(endpoint: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(endpoint, this.options.apiUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeout),
      });
    } catch (cause) {
      throw new TurboSmsTransportError({ endpoint, cause });
    }

    if (!response.ok) {
      throw new TurboSmsTransportError({ endpoint, status: response.status });
    }

    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new TurboSmsTransportError({ endpoint, status: response.status, cause });
    }
  }
}
