import { Logger } from '@vendure/core';
import { loggerCtx } from '../constants';

/** `varchar` lengths of the entry columns a host or an actor resolver can fill. */
export const ENTRY_COLUMN_LENGTHS = {
  entityType: 32,
  entityId: 36,
  parentType: 32,
  parentId: 36,
  action: 32,
  source: 32,
  actorType: 16,
  actorId: 36,
} as const;

/** `varchar` lengths of the detail-row columns `recordRun` fills from its input. */
export const DETAIL_COLUMN_LENGTHS = {
  entityType: 32,
  entityId: 36,
  parentType: 32,
  parentId: 36,
  kind: 32,
  scope: 64,
} as const;

/**
 * Clips the string fields of `row` named in `lengths` to their column, so that one over-long value from a host
 * costs that value's tail instead of the whole entry or run (Postgres and MySQL reject the statement). The
 * names of the clipped fields are added to `clipped`.
 */
export function fitColumns<T extends object>(
  row: T,
  lengths: Readonly<Record<string, number>>,
  clipped: Set<string>,
): T {
  const values = row as Record<string, unknown>;
  for (const [field, length] of Object.entries(lengths)) {
    const value = values[field];
    if (typeof value === 'string' && value.length > length) {
      values[field] = value.slice(0, length);
      clipped.add(field);
    }
  }
  return row;
}

/** One warning per write that had to clip, naming the fields. */
export function warnClipped(operation: string, clipped: ReadonlySet<string>): void {
  if (clipped.size > 0) {
    Logger.warn(
      `${operation}: clipped ${[...clipped].sort().join(', ')} to the column length; ` +
        'shorten these values (they are cut, not rejected)',
      loggerCtx,
    );
  }
}
