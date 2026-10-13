import { CHANGE_HISTORY_ACTIONS, CHANGE_HISTORY_ENTITY_TYPES } from '../constants';
import { ChangeHistoryFieldChange } from '../types';

/**
 * The tiered retention policy as named predicates (Specification pattern). `compact()` composes them; they
 * are not overridable — the thresholds are options, the rules are not.
 *
 * Detail tier (until the compaction window): long values, derived rows, collection-rules member rows,
 * external-run detail rows. Summary tier (until the purge window): everything else, compacted.
 */

/** The columns of an entry the rules look at. */
interface RetentionEntryFacts {
  entityType: string;
  action: string;
  derivedFromId?: unknown;
}

/** Value kinds that are small and high-value: never stripped (filters, conditions, refs, stock). */
const NEVER_STRIPPED_KINDS: ReadonlySet<string> = new Set(['json', 'refs', 'prices', 'assets', 'stock']);

const MEMBER_ACTIONS: ReadonlySet<string> = new Set([
  CHANGE_HISTORY_ACTIONS.collection_added,
  CHANGE_HISTORY_ACTIONS.collection_removed,
]);

/** Size of a stored value as compaction measures it: characters of a string, else of its JSON. */
export function valueLength(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  return typeof value === 'string' ? Array.from(value).length : Array.from(JSON.stringify(value)).length;
}

function longerThan(value: unknown, bytes: number): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)) > bytes;
}

/**
 * A field change whose values belong to the detail tier: rich text, or a side longer than `maxBytes`.
 * `json` / `refs` / `prices` / `assets` / `stock` are kept whatever their size; an already stripped change
 * is not a detail value any more (compaction is idempotent).
 */
export function isDetailValue(change: ChangeHistoryFieldChange, maxBytes: number): boolean {
  if (!change || typeof change !== 'object' || change.stripped) {
    return false;
  }
  const kind = typeof change.kind === 'string' ? change.kind : undefined;
  if (kind && NEVER_STRIPPED_KINDS.has(kind)) {
    return false;
  }
  if (!('from' in change) && !('to' in change)) {
    return false;
  }
  return kind === 'richtext' || longerThan(change.from, maxBytes) || longerThan(change.to, maxBytes);
}

/** A value of a flat state (`meta.lastState`) that belongs to the detail tier: a string longer than `maxBytes`. */
export function isDetailStateValue(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) > maxBytes;
}

/**
 * A cascaded deletion: derived, but the only record that the child (a variant, a facet value, a descendant
 * collection) was deleted. Kept in the summary tier.
 */
export function isKeptDeleted(entry: RetentionEntryFacts): boolean {
  return entry.derivedFromId != null && entry.action === CHANGE_HISTORY_ACTIONS.deleted;
}

/** A collection-rules member row (a product entering / leaving a collection); its batch head keeps the counts. */
export function isMemberRow(entry: RetentionEntryFacts): boolean {
  return MEMBER_ACTIONS.has(entry.action);
}

/** A derived row that only exists in the detail tier (its cause keeps `derivedCount`). */
export function isDerivedDetailRow(entry: RetentionEntryFacts): boolean {
  return entry.derivedFromId != null && !isKeptDeleted(entry);
}

/** An entry deleted at compaction: a derived row (except a kept deletion) or a member row. */
export function isDetailRow(entry: RetentionEntryFacts): boolean {
  return isMemberRow(entry) || isDerivedDetailRow(entry);
}

/** An external run line (counts + duration). Deleted at compaction once older than `runLineDays` (NQ3). */
export function isRunLine(entry: RetentionEntryFacts): boolean {
  return entry.entityType === CHANGE_HISTORY_ENTITY_TYPES.Run;
}

/** A batch head: compaction snapshots its member counts before members are deleted. */
export function isBatchHead(entry: RetentionEntryFacts): boolean {
  return entry.entityType === CHANGE_HISTORY_ENTITY_TYPES.Batch;
}
