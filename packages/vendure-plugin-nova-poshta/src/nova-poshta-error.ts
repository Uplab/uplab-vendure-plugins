export interface NovaPoshtaErrorDetails {
  /** What Nova Poshta said, on an answer with `success: false`. */
  errors?: string[];
  errorCodes?: string[];
  /** The HTTP status, when Nova Poshta answered with a non-2xx. */
  status?: number;
  cause?: unknown;
}

/**
 * @description
 * Every failure of a Nova Poshta request: no API key, a network error or timeout, a non-2xx status, or
 * an answer with `success: false`.
 */
export class NovaPoshtaError extends Error {
  readonly errors: string[];
  readonly errorCodes: string[];
  readonly status?: number;

  constructor(message: string, details: NovaPoshtaErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'NovaPoshtaError';
    this.errors = details.errors ?? [];
    this.errorCodes = details.errorCodes ?? [];
    this.status = details.status;
  }
}
