/**
 * Formatting and query helpers of the dashboard, free of React and of the dashboard's modules so that they
 * are unit-tested.
 */
import type { ChangeHistoryBatchCount, ChangeHistoryDetailData, ChangeHistoryFieldChange } from './registry';

/** `<p>A&amp;B</p>` → `A&B`: rich text shown as plain text (never as HTML). */
export function stripHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first `max` characters (on a word boundary when one is near), with an ellipsis when cut. */
export function clipText(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) {
    return { text, clipped: false };
  }
  const head = text.slice(0, max);
  const space = head.lastIndexOf(' ');
  return { text: `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`, clipped: true };
}

/** A whole-number difference of two numeric values, for «(+8)» / «(−2)»; `undefined` when not numbers. */
export function numericDelta(from: unknown, to: unknown): number | undefined {
  const a = typeof from === 'number' ? from : from == null ? 0 : Number.NaN;
  const b = typeof to === 'number' ? to : to == null ? 0 : Number.NaN;
  if (typeof from !== 'number' && typeof to !== 'number') {
    return undefined;
  }
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : undefined;
}

/** `8` → `+8`, `-2` → `−2` (a real minus sign), `0` → `0`. */
export function formatDelta(delta: number): string {
  if (delta > 0) {
    return `+${delta}`;
  }
  return delta < 0 ? `−${Math.abs(delta)}` : '0';
}

/** A value of a list-of-ids change as a list of strings. */
export function idList(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/**
 * Pretty-printed JSON lines of a value, with id lists replaced by their labels (`"[\"31\"]"` inside an
 * operation argument becomes `["Season: Winter"]`), so a filter or condition reads as names.
 */
export function jsonLines(value: unknown, labels: Record<string, string> | undefined): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  const withLabels = labels && Object.keys(labels).length > 0 ? relabel(value, labels) : value;
  return JSON.stringify(withLabels, null, 2).split('\n');
}

function labelIds(ids: unknown[], labels: Record<string, string>): string[] | undefined {
  if (ids.length === 0 || !ids.every((id) => (typeof id === 'string' || typeof id === 'number') && labels[id])) {
    return undefined;
  }
  return ids.map((id) => labels[String(id)]);
}

function relabel(value: unknown, labels: Record<string, string>): unknown {
  if (Array.isArray(value)) {
    return labelIds(value, labels) ?? value.map((item) => relabel(item, labels));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, relabel(inner, labels)]));
  }
  if (typeof value === 'string' && value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return labelIds(parsed, labels) ?? value;
      }
    } catch {
      // Not a JSON list: shown as it is.
    }
  }
  return value;
}

export interface DiffLine {
  text: string;
  changed: boolean;
}

/**
 * Marks the lines of two texts that are not part of their longest common subsequence: what was removed on
 * the left, what was added on the right.
 */
export function diffLines(from: string[], to: string[]): { from: DiffLine[]; to: DiffLine[] } {
  const n = from.length;
  const m = to.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = from[i] === to[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const keptFrom = new Set<number>();
  const keptTo = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (from[i] === to[j]) {
      keptFrom.add(i++);
      keptTo.add(j++);
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return {
    from: from.map((text, index) => ({ text, changed: !keptFrom.has(index) })),
    to: to.map((text, index) => ({ text, changed: !keptTo.has(index) })),
  };
}

/** Whether a change's values were replaced by their lengths at compaction (shown as one «changed» line). */
export function isStripped(change: ChangeHistoryFieldChange): boolean {
  return change.stripped === true;
}

/** Sum of a batch head's member counts. */
export function batchTotal(counts: ChangeHistoryBatchCount[] | null | undefined): number {
  return (counts ?? []).reduce((sum, count) => sum + count.count, 0);
}

/** `{ updated: 37, zeroed: 2, failed: 0 }` → the entries to show, in their recorded order (zeros dropped unless asked). */
export function countEntries(counts: unknown, includeZero = false): Array<[string, number]> {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    return [];
  }
  return Object.entries(counts as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .filter(([, count]) => includeZero || count !== 0);
}

/** Milliseconds as whole seconds (at least 1 for a run that took any time), or `undefined`. */
export function durationSeconds(ms: unknown): number | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return undefined;
  }
  return Math.max(1, Math.round(ms / 1000));
}

/** Detail rows grouped by `kind`, in the order the kinds first appear. */
export function groupByKind(rows: ChangeHistoryDetailData[]): Array<[string, ChangeHistoryDetailData[]]> {
  const groups = new Map<string, ChangeHistoryDetailData[]>();
  for (const row of rows) {
    const group = groups.get(row.kind) ?? [];
    group.push(row);
    groups.set(row.kind, group);
  }
  return [...groups];
}

/** How many distinct entities the rows touch, and of which type when they share one. */
export function rowEntities(rows: ChangeHistoryDetailData[]): { count: number; type?: string } {
  const keys = new Set(rows.map((row) => `${row.entityType}:${row.entityId}`));
  const types = new Set(rows.map((row) => row.entityType));
  return { count: keys.size, type: types.size === 1 ? rows[0]?.entityType : undefined };
}

// ---------------------------------------------------------------------------------------------------------
// The feed's filters

/** The actor filter's option value: an API key is recorded under its owner's id, so the type is part of it. */
export function encodeActor(type: string, id: string): string {
  return `${type}:${id}`;
}

function decodeActor(value: unknown): { type?: string; id: string } {
  const text = String(value);
  const colon = text.indexOf(':');
  return colon > 0 ? { type: text.slice(0, colon), id: text.slice(colon + 1) } : { id: text };
}

type Filter = Record<string, unknown>;

/** `{ actorId: { in: ['admin:1', 'api_key:1'] } }` → one `_and` of id and type per selected actor. */
function actorClause(values: unknown[]): Filter {
  return {
    _or: values.map((value) => {
      const { type, id } = decodeActor(value);
      return type ? { _and: [{ actorId: { eq: id } }, { actorType: { eq: type } }] } : { actorId: { eq: id } };
    }),
  };
}

export interface FeedSwitches {
  /** «Collapse bulk operations»: members of a batch are left out, the head stays. */
  collapseBatches: boolean;
  /** «Hide system changes»: only people's changes (incl. API keys and scheduled actions). */
  hideSystem: boolean;
  /** ISO timestamps of the period, both or neither. */
  from?: string;
  to?: string;
}

export const COLLAPSE_BATCHES_FILTER: Filter = {
  _or: [{ batchId: { isNull: true } }, { entityType: { eq: 'Batch' } }],
};
export const HIDE_SYSTEM_FILTER: Filter = { actorType: { in: ['admin', 'api_key'] } };

/**
 * The feed's list filter: the table's column filters (with the actor filter rewritten to id + type), the
 * search, and the switches and period kept in the URL.
 */
export function feedFilter(tableFilter: Filter | undefined, switches: FeedSwitches): Filter | undefined {
  const { _and, ...rest } = tableFilter ?? {};
  const clauses: Filter[] = [];
  for (const clause of Array.isArray(_and) ? (_and as Filter[]) : []) {
    const actor = clause.actorId as { in?: unknown[] } | undefined;
    clauses.push(actor && Array.isArray(actor.in) ? actorClause(actor.in) : clause);
  }
  if (switches.collapseBatches) {
    clauses.push(COLLAPSE_BATCHES_FILTER);
  }
  if (switches.hideSystem) {
    clauses.push(HIDE_SYSTEM_FILTER);
  }
  if (switches.from && switches.to) {
    clauses.push({ createdAt: { between: { start: switches.from, end: switches.to } } });
  }
  const filter: Filter = { ...rest };
  if (clauses.length > 0) {
    filter._and = clauses;
  }
  return Object.keys(filter).length > 0 ? filter : undefined;
}

/** The URL state of the feed: `?collapse=false&hideSystem=true&from=…&to=…&entry=…`. */
export interface FeedSearch extends FeedSwitches {
  entry?: string;
}

const flag = (value: unknown, fallback: boolean): boolean => {
  if (value === true || value === 'true' || value === '1' || value === 1) {
    return true;
  }
  if (value === false || value === 'false' || value === '0' || value === 0) {
    return false;
  }
  return fallback;
};

const isoDate = (value: unknown): string | undefined =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined;

export function parseFeedSearch(search: Record<string, unknown> | undefined): FeedSearch {
  const from = isoDate(search?.from);
  const to = isoDate(search?.to);
  const entry = search?.entry;
  return {
    collapseBatches: flag(search?.collapse, true),
    hideSystem: flag(search?.hideSystem, false),
    ...(from && to ? { from, to } : {}),
    ...(typeof entry === 'string' || typeof entry === 'number' ? { entry: String(entry) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Links

const DETAIL_ROUTES: Record<string, string> = {
  Product: '/products/',
  ProductVariant: '/product-variants/',
  Collection: '/collections/',
  Facet: '/facets/',
  Asset: '/assets/',
  Promotion: '/promotions/',
};

/** The dashboard page of a core entity, or `undefined` (batches, runs, host types without a route). */
export function builtInRoute(entityType: string, entityId: string, parentId?: string | null): string | undefined {
  if (entityType === 'FacetValue') {
    return parentId ? `/facets/${parentId}/values/${entityId}` : undefined;
  }
  const base = DETAIL_ROUTES[entityType];
  return base ? `${base}${entityId}` : undefined;
}

/** The URL search params of a feed state, defaults left out. */
export function feedSearchParams(state: FeedSearch): Record<string, string | boolean | undefined> {
  return {
    collapse: state.collapseBatches ? undefined : false,
    hideSystem: state.hideSystem ? true : undefined,
    from: state.from && state.to ? state.from : undefined,
    to: state.from && state.to ? state.to : undefined,
    entry: state.entry,
  };
}
