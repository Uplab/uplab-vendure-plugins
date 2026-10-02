import { ExchangeRateSourceError } from '../exchange-rate-source-error';

async function request(source: string, url: string, timeout: number): Promise<Response> {
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
  return response;
}

async function fetchJson(source: string, url: string, timeout: number): Promise<unknown> {
  const response = await request(source, url, timeout);
  try {
    return await response.json();
  } catch (cause) {
    throw new ExchangeRateSourceError(`${source} answered with invalid JSON`, { source, cause });
  }
}

export function unexpectedBody(source: string): ExchangeRateSourceError {
  return new ExchangeRateSourceError(`${source} answered with an unexpected body`, { source });
}

/** GETs a JSON array. Monobank, for one, answers some errors with a 200 and `{ errorDescription }`. */
export async function fetchJsonArray<T>(source: string, url: string, timeout: number): Promise<T[]> {
  const body = await fetchJson(source, url, timeout);
  if (!Array.isArray(body)) throw unexpectedBody(source);
  return body as T[];
}

/** GETs a JSON object. */
export async function fetchJsonObject<T>(source: string, url: string, timeout: number): Promise<T> {
  const body = await fetchJson(source, url, timeout);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw unexpectedBody(source);
  return body as T;
}

/** GETs a text body, e.g. XML. */
export async function fetchText(source: string, url: string, timeout: number): Promise<string> {
  return (await request(source, url, timeout)).text();
}
