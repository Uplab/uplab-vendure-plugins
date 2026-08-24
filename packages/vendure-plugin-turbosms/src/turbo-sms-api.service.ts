import { Inject, Injectable } from '@nestjs/common';
import { Logger } from '@vendure/core';
import axios, { type AxiosInstance } from 'axios';
import { TurboSmsError } from './classes';
import { loggerCtx, TURBOSMS_PLUGIN_OPTIONS } from './constants';
import {
  type ResolvedTurboSmsPluginOptions,
  type TurboSmsBalanceResponse,
  type TurboSmsSendMessageResponse,
} from './types';

/**
 * TurboSMS response codes that mean "accepted, nothing went wrong".
 * 0/1 are the generic success codes; 800-803 are per-channel delivery statuses.
 */
function isAcceptedResponseCode(code: number): boolean {
  return code <= 1 || (code >= 800 && code <= 803);
}

/**
 * @description
 * A thin typed client for the TurboSMS REST API. Injectable and exported by the
 * {@link TurboSmsPlugin}, so a host application can talk to TurboSMS directly.
 */
@Injectable()
export class TurboSmsApiService {
  private readonly client: AxiosInstance;

  constructor(
    @Inject(TURBOSMS_PLUGIN_OPTIONS)
    private options: ResolvedTurboSmsPluginOptions,
  ) {
    this.client = axios.create({
      baseURL: this.options.apiUrl,
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

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
   * Sends `text` to every recipient. Phone numbers are in international format without a
   * leading `+`, e.g. `380501234567`.
   *
   * Returns `undefined` in dry-run mode. Throws {@link TurboSmsError} when TurboSMS
   * rejects the request.
   */
  async sendMessage(recipients: string[], text: string): Promise<TurboSmsSendMessageResponse | undefined> {
    if (this.options.dryRun) {
      Logger.info(`[dryRun] SMS to ${recipients.join(', ')}:\n${text}`, loggerCtx);
      return undefined;
    }

    const { data } = await this.client.post<TurboSmsSendMessageResponse>('message/send.json', {
      recipients,
      sms: {
        sender: this.options.sender,
        text,
      },
    });

    if (isAcceptedResponseCode(data.response_code)) {
      return data;
    }

    throw new TurboSmsError(text, data.response_code, data.response_status, data.response_result, recipients);
  }

  /**
   * @description
   * Returns the TurboSMS account balance, in the currency of the account (UAH).
   */
  async getBalance(): Promise<number> {
    const { data } = await this.client.post<TurboSmsBalanceResponse>('user/balance.json', {});

    if (data.response_code !== 0) {
      throw new Error(`Failed to fetch TurboSMS balance: ${JSON.stringify(data)}`);
    }

    return data.response_result.balance;
  }
}
