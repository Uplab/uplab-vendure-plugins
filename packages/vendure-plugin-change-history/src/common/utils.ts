import { DETAIL_CHUNK_SIZE } from '../constants';

/** `items` in slices of `size` (default {@link DETAIL_CHUNK_SIZE}): for chunked inserts and `IN (…)` lists. */
export function chunks<T>(items: readonly T[], size: number = DETAIL_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/** `value` cut to `length` characters. */
export const clip = (value: string, length: number): string => (value.length > length ? value.slice(0, length) : value);

/** Compares ids as strings, numerically where they are numbers (`'2' < '10'`). */
export const byNumericId = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });
