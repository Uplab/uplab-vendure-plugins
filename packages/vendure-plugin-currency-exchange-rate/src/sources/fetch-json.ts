import { ExchangeRateSourceError } from '../exchange-rate-source-error';

/** GETs the JSON array a rate source answers with, turning every failure into an {@link ExchangeRateSourceError}. */
export async function fetchJsonArray<T>(source: string, url: string, timeout: number): Promise<T[]> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  } catch (cause) {
    const reason = !(cause instanceof Error)
      ? String(cause)
      : cause.name === 'TimeoutError'
        ? `timed out after ${timeout} ms`
        : cause.message;
    throw new ExchangeRateSourceError(`${source} rates request failed: ${reason}`, { source, cause });
  }
  if (!response.ok) {
    throw new ExchangeRateSourceError(`${source} rates request failed: HTTP ${response.status}`, {
      source,
      status: response.status,
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new ExchangeRateSourceError(`${source} answered with invalid JSON`, { source, cause });
  }
  // Monobank, for one, answers some errors with a 200 and `{ errorDescription }`.
  if (!Array.isArray(body)) {
    throw new ExchangeRateSourceError(`${source} answered with an unexpected body`, { source });
  }
  return body as T[];
}
