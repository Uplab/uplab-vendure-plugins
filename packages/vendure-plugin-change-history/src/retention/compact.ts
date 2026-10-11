import { ChangeHistoryFieldChange, ChangeHistoryFieldChanges } from '../types';
import { isDetailStateValue, isDetailValue, valueLength } from './rules';

/** A member count of a batch, snapshotted into the head's `meta.batchCounts` before members are deleted. */
export interface BatchCount {
  entityType: string;
  action: string;
  count: number;
}

/** Counts that compaction keeps on an entry because the rows behind them are deleted. */
export interface CompactionSnapshot {
  derivedCount?: number;
  batchCounts?: BatchCount[];
}

export interface CompactedValues {
  changes: ChangeHistoryFieldChanges | null;
  meta: Record<string, unknown>;
  /** Fields (incl. `lastState` values) replaced by a length marker. */
  strippedFields: number;
  /** `false` when `changes` and `meta` are unchanged: only `compactedAt` needs to be written. */
  changed: boolean;
}

function stripChange(change: ChangeHistoryFieldChange): ChangeHistoryFieldChange {
  const stripped: ChangeHistoryFieldChange = {
    stripped: true,
    fromLength: valueLength(change.from),
    toLength: valueLength(change.to),
  };
  return change.kind ? { kind: change.kind, ...stripped } : stripped;
}

/**
 * The summary-tier form of an entry: detail values replaced by `{ kind, stripped, fromLength, toLength }`,
 * long `meta.lastState` strings by `{ stripped, length }`, the snapshot counts merged into `meta`. Pure and
 * idempotent: an already compacted entry comes back unchanged.
 */
export function compactValues(
  changes: ChangeHistoryFieldChanges | null,
  meta: Record<string, unknown> | null,
  maxBytes: number,
  snapshot: CompactionSnapshot = {},
): CompactedValues {
  let strippedFields = 0;
  let changed = false;

  let nextChanges = changes;
  if (changes) {
    const entries = Object.entries(changes).map(([key, change]) => {
      if (isDetailValue(change, maxBytes)) {
        strippedFields++;
        return [key, stripChange(change)] as const;
      }
      return [key, change] as const;
    });
    if (strippedFields > 0) {
      nextChanges = Object.fromEntries(entries);
      changed = true;
    }
  }

  const nextMeta: Record<string, unknown> = { ...(meta ?? {}) };
  const lastState = nextMeta.lastState;
  if (lastState && typeof lastState === 'object' && !Array.isArray(lastState)) {
    let stateStripped = 0;
    const state = Object.fromEntries(
      Object.entries(lastState as Record<string, unknown>).map(([key, value]) => {
        if (isDetailStateValue(value, maxBytes)) {
          stateStripped++;
          return [key, { stripped: true, length: valueLength(value) }];
        }
        return [key, value];
      }),
    );
    if (stateStripped > 0) {
      nextMeta.lastState = state;
      strippedFields += stateStripped;
      changed = true;
    }
  }
  if (snapshot.derivedCount) {
    nextMeta.derivedCount = snapshot.derivedCount;
    changed = true;
  }
  if (snapshot.batchCounts && snapshot.batchCounts.length > 0) {
    nextMeta.batchCounts = snapshot.batchCounts;
    changed = true;
  }

  return { changes: nextChanges, meta: nextMeta, strippedFields, changed };
}
