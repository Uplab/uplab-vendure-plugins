import { UserInputError } from '@vendure/core';

/**
 * A position in a timeline: the row's `createdAt` as the database's own text (microseconds kept on
 * Postgres) and its id, both as stored.
 */
export interface TimelineKey {
  createdAt: string;
  id: string;
}

/** The opaque `after` cursor of `changeHistoryEntityTimeline`. */
export function encodeCursor(key: TimelineKey): string {
  return Buffer.from(JSON.stringify([key.createdAt, key.id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): TimelineKey {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'string' && part !== '')) {
      return { createdAt: value[0], id: value[1] };
    }
  } catch {
    // Reported below.
  }
  throw new UserInputError(`Invalid change history cursor "${cursor}"`);
}

/** `2026-10-11 06:22:01.5` → `2026-10-11 06:22:01.500000`: Postgres prints no trailing zeros. */
function normalizeTimestamp(value: string): string {
  const [whole, fraction = ''] = value.replace('T', ' ').split('.');
  return `${whole}.${fraction.padEnd(6, '0')}`;
}

function compareIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b) && a.length !== b.length) {
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orders two keys the way the database orders `(createdAt, id)`: as values, or — `textual`, SQLite — as the
 * stored strings. Positive when `a` comes later.
 */
export function compareKeys(a: TimelineKey, b: TimelineKey, textual: boolean): number {
  const left = textual ? a.createdAt : normalizeTimestamp(a.createdAt);
  const right = textual ? b.createdAt : normalizeTimestamp(b.createdAt);
  if (left !== right) {
    return left < right ? -1 : 1;
  }
  return compareIds(a.id, b.id);
}
