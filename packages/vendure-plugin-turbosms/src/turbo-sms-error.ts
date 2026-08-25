import { type TurboSmsResponseResult } from './types';

/**
 * @description
 * Base class for every failure raised by this plugin. Catch it to handle both a refusal
 * from TurboSMS and a request that never produced a usable answer.
 */
export class TurboSmsError extends Error {
  constructor(
    message: string,
    /** The TurboSMS endpoint the failed request was made to, e.g. `message/send.json`. */
    readonly endpoint: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TurboSmsError';
  }
}

/**
 * The data carried by a {@link TurboSmsRejectedError}.
 */
export interface TurboSmsRejectedErrorDetails {
  endpoint: string;
  responseCode: number;
  responseStatus: string;
  /** The per-recipient results, for a send request. */
  responseResult?: TurboSmsResponseResult[];
  /** The recipients of a send request. */
  recipients?: string[];
  /** The body of a send request. Never included in `message`, so it stays out of logs. */
  text?: string;
}

/**
 * @description
 * TurboSMS answered, and the answer was a refusal — an unknown alpha name, an empty
 * balance, a malformed number. The raw response is carried along so a caller can decide
 * what to do per recipient.
 */
export class TurboSmsRejectedError extends TurboSmsError {
  readonly responseCode: number;
  readonly responseStatus: string;
  readonly responseResult?: TurboSmsResponseResult[];
  readonly recipients?: string[];
  readonly text?: string;

  constructor(details: TurboSmsRejectedErrorDetails) {
    super(
      `TurboSMS rejected the request to ${details.endpoint}: ${details.responseStatus} (code ${details.responseCode})`,
      details.endpoint,
    );
    this.name = 'TurboSmsRejectedError';
    this.responseCode = details.responseCode;
    this.responseStatus = details.responseStatus;
    this.responseResult = details.responseResult;
    this.recipients = details.recipients;
    this.text = details.text;
  }
}

/**
 * The data carried by a {@link TurboSmsTransportError}.
 */
export interface TurboSmsTransportErrorDetails {
  endpoint: string;
  /** The HTTP status, when TurboSMS answered but not with a 2xx. */
  status?: number;
  /** The underlying network, timeout or JSON parsing failure. */
  cause?: unknown;
}

/**
 * @description
 * The request never produced a usable answer: a network failure, the configured timeout
 * elapsing, a non-2xx HTTP status, or a body that was not the JSON the API documents.
 * Whether the message was sent is unknown — retrying may deliver it twice.
 */
export class TurboSmsTransportError extends TurboSmsError {
  readonly status?: number;

  constructor(details: TurboSmsTransportErrorDetails) {
    super(
      `The request to ${details.endpoint} failed: ${describe(details)}`,
      details.endpoint,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = 'TurboSmsTransportError';
    this.status = details.status;
  }
}

function describe({ status, cause }: TurboSmsTransportErrorDetails): string {
  const reason = cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : undefined;
  if (status !== undefined) {
    return reason ? `HTTP ${status} (${reason})` : `HTTP ${status}`;
  }
  return reason ?? 'unknown error';
}
