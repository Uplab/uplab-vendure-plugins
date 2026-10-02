/**
 * @description
 * A rate source could not be read: a network error or timeout, a non-2xx status, or a body that is
 * not what the source documents.
 */
export class ExchangeRateSourceError extends Error {
  readonly source: string;
  /** The HTTP status, when the source answered with a non-2xx. */
  readonly status?: number;

  constructor(message: string, details: { source: string; status?: number; cause?: unknown }) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ExchangeRateSourceError';
    this.source = details.source;
    this.status = details.status;
  }
}
