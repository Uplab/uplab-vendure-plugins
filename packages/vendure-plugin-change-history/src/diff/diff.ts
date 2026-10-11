import { ChangeHistoryFieldChange, ChangeHistoryFieldChanges, ChangeHistoryValueKind } from '../types';
import { capValue } from './truncate';

/** Kinds whose value is a list of ids compared as a set. */
const SET_KINDS = new Set<string>(['refs']);
/** Kinds whose value is a list of ids where the order matters. */
const ORDERED_KINDS = new Set<string>(['assets']);

export interface DiffOptions {
  kindOf: (key: string) => ChangeHistoryValueKind;
  /** Cap per side of a stored value, in bytes. */
  maxValueBytes: number;
  /** Only these keys are compared (default: every key of either side). */
  include?: (key: string) => boolean;
}

/** A JSON string with sorted object keys: two structurally equal values give the same string. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

function asIdList(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function idListChange(kind: string, from: string[], to: string[]): ChangeHistoryFieldChange | undefined {
  const fromSet = new Set(from);
  const toSet = new Set(to);
  const added = to.filter((id) => !fromSet.has(id));
  const removed = from.filter((id) => !toSet.has(id));
  if (SET_KINDS.has(kind)) {
    return added.length || removed.length ? { kind, added, removed } : undefined;
  }
  const keptFrom = from.filter((id) => toSet.has(id));
  const keptTo = to.filter((id) => fromSet.has(id));
  const reordered = keptFrom.some((id, i) => id !== keptTo[i]);
  return added.length || removed.length || reordered ? { kind, from, to, added, removed, reordered } : undefined;
}

/**
 * The changed fields between two normalised states. Unchanged fields are never listed; a missing key, `null`
 * and `undefined` are the same "no value" (and an empty list for id lists), so a value that is absent on
 * both sides never shows. Id lists give `added` / `removed` (and `reordered` for ordered kinds); every other
 * value gives `from` / `to`, capped at `maxValueBytes` per side.
 */
export function diffStates(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  options: DiffOptions,
): ChangeHistoryFieldChanges {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !options.include || options.include(key))
    .sort();
  const changes: ChangeHistoryFieldChanges = {};
  for (const key of keys) {
    const kind = options.kindOf(key);
    if (SET_KINDS.has(kind) || ORDERED_KINDS.has(kind)) {
      const change = idListChange(kind, asIdList(before[key]), asIdList(after[key]));
      if (change) {
        changes[key] = change;
      }
      continue;
    }
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (stableStringify(from) === stableStringify(to)) {
      continue;
    }
    const cappedFrom = capValue(from, options.maxValueBytes);
    const cappedTo = capValue(to, options.maxValueBytes);
    changes[key] = {
      kind,
      from: cappedFrom.value,
      to: cappedTo.value,
      ...(cappedFrom.truncated || cappedTo.truncated ? { truncated: true } : {}),
    };
  }
  return changes;
}

/** "3 fields: enabled, name.en, prices" — the entry's one-line summary of an update. */
export function changesSummary(changes: ChangeHistoryFieldChanges): string {
  const keys = Object.keys(changes);
  return `${keys.length} ${keys.length === 1 ? 'field' : 'fields'}: ${keys.join(', ')}`;
}

/** Every id a change refers to (for the display labels loaded after the diff). */
export function idsOfChange(change: ChangeHistoryFieldChange): string[] {
  const ids = new Set<string>();
  for (const value of [change.added, change.removed, change.from, change.to]) {
    for (const id of asIdList(value)) {
      ids.add(id);
    }
  }
  return [...ids];
}
