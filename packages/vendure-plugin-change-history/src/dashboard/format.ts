/**
 * Formatting and query helpers of the dashboard, free of React and of the dashboard's modules so that they
 * are unit-tested.
 */
import type { ChangeHistoryBatchCount, ChangeHistoryDetailData, ChangeHistoryFieldChange } from './registry';

/** Tags that end a line of text: shown as a space between the words they separate. */
const BREAKING_TAGS = new Set(['br', '/p', '/div', '/li', '/h1', '/h2', '/h3', '/h4', '/h5', '/h6']);

const ENTITIES: Record<string, string> = { nbsp: ' ', lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' };

/** A tag starts at `<` followed by a letter, `/`, `!` or `?`; any other `<` is text (`a < b`). */
const opensTag = (next: string | undefined) => next !== undefined && /[a-z/!?]/i.test(next);

/**
 * `<p>A&amp;B</p>` → `A&B`: rich text shown as plain text (never as HTML). One pass over the markup, so no tag
 * can be reassembled from the pieces of another (`<scr<b>ipt>`), and each entity is decoded once
 * (`&amp;lt;` → `&lt;`). An unterminated tag at the end is dropped.
 */
export function stripHtml(html: string): string {
  let text = '';
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf('<', i);
    if (open === -1) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, open);
    if (!opensTag(html[open + 1])) {
      text += '<';
      i = open + 1;
      continue;
    }
    const close = html.indexOf('>', open + 1);
    if (close === -1) {
      break;
    }
    // The pattern matches every string (an empty name at worst).
    const name = (/^\/?[a-z0-9]*/i.exec(html.slice(open + 1, close)) as RegExpExecArray)[0].toLowerCase();
    text += BREAKING_TAGS.has(name) ? ' ' : '';
    i = close + 1;
  }
  return text
    .replace(/&(nbsp|lt|gt|quot|#39|amp);/g, (_, entity: string) => ENTITIES[entity])
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

/**
 * How an id of a reference change reads: its label, else `#12` for a numeric id, else the id itself (a tag
 * is its own name).
 */
export function refLabel(labels: Record<string, string> | undefined, id: string): string {
  return labels?.[id] ?? (/^\d+$/.test(id) ? `#${id}` : id);
}

/** A value of a list-of-ids change as a list of strings. */
export function idList(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/** Whether a value is a string, a number, a boolean or null. */
const isScalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

/**
 * `{ "Kyiv": 3, "Lviv": 0 }` → `[['Kyiv', '3'], ['Lviv', '0']]`: a non-empty plain object whose values are all
 * scalars, as key / value text; `undefined` for anything else (shown as JSON).
 */
export function flatEntries(value: unknown): Array<[string, string]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([, inner]) => isScalar(inner))) {
    return undefined;
  }
  return entries.map(([key, inner]) => [key, inner === null ? '—' : String(inner)]);
}

/**
 * The lines of a JSON value: `key: value` per line for an object of scalars, else pretty-printed JSON with the
 * facet value ids of operation arguments replaced by their labels (`"[\"31\"]"` in a `facetValueIds` argument
 * becomes `["Season: Winter"]`), so a filter or condition reads as names.
 */
export function jsonLines(value: unknown, labels: Record<string, string> | undefined): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  const flat = flatEntries(value);
  if (flat) {
    return flat.map(([key, text]) => `${key}: ${text}`);
  }
  return JSON.stringify(withFacetValueLabels(value, labels), null, 2).split('\n');
}

/**
 * Arguments of core's operations that hold facet value ids — the only ids the server labels inside a JSON
 * value. Ids in any other argument (`productIds`, `variantIds`, …) stay as they are, even when a facet value
 * happens to have the same id.
 */
const FACET_VALUE_ARGS = new Set(['facetValueIds', 'facets']);

function labelIds(ids: unknown[], labels: Record<string, string>): string[] | undefined {
  if (ids.length === 0 || !ids.every((id) => (typeof id === 'string' || typeof id === 'number') && labels[id])) {
    return undefined;
  }
  return ids.map((id) => labels[String(id)]);
}

function labelArgument(value: unknown, labels: Record<string, string>): unknown {
  if (Array.isArray(value)) {
    return labelIds(value, labels) ?? value;
  }
  if (typeof value === 'string' && value.startsWith('[')) {
    try {
      // Valid JSON that starts with `[` is a list.
      return labelIds(JSON.parse(value) as unknown[], labels) ?? value;
    } catch {
      // Not a JSON list: shown as it is.
    }
  }
  return value;
}

/** A JSON value with the facet value ids of its operation arguments replaced by their labels. */
export function withFacetValueLabels(value: unknown, labels: Record<string, string> | undefined): unknown {
  return labels && Object.keys(labels).length > 0 ? relabel(value, labels) : value;
}

function relabel(value: unknown, labels: Record<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => relabel(item, labels));
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (typeof object.name === 'string' && FACET_VALUE_ARGS.has(object.name) && 'value' in object) {
      return { ...object, value: labelArgument(object.value, labels) };
    }
    return Object.fromEntries(Object.entries(object).map(([key, inner]) => [key, relabel(inner, labels)]));
  }
  return value;
}

export interface DiffLine {
  text: string;
  changed: boolean;
}

/** A line as the diff compares it: without the comma that separates it from the next element. */
const lineKey = (line: string) => line.replace(/,\s*$/, '');

/** Above this many line pairs the longest common subsequence is not computed (it is O(n·m) in time and memory). */
const MAX_LCS_CELLS = 250_000;

/**
 * Marks the lines of two texts that are not part of their longest common subsequence: what was removed on
 * the left, what was added on the right. Texts too long for that keep only their common head and tail
 * unmarked.
 */
export function diffLines(from: string[], to: string[]): { from: DiffLine[]; to: DiffLine[] } {
  const n = from.length;
  const m = to.length;
  // A JSON line that only gained or lost its trailing comma (an array got a new last element) is unchanged.
  const a = from.map(lineKey);
  const b = to.map(lineKey);
  if (n * m > MAX_LCS_CELLS) {
    return diffEnds(from, to, a, b);
  }
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const keptFrom = new Set<number>();
  const keptTo = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
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

/** The common head and tail unmarked, everything between marked: linear, for texts too long for the LCS. */
function diffEnds(from: string[], to: string[], a: string[], b: string[]): { from: DiffLine[]; to: DiffLine[] } {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }
  const mark = (lines: string[]) =>
    lines.map((text, index) => ({ text, changed: index >= head && index < lines.length - tail }));
  return { from: mark(from), to: mark(to) };
}

const jsonDiffs = new WeakMap<object, { from: DiffLine[]; to: DiffLine[] }>();

/**
 * The line diff of a JSON change, computed once per change object: both sides of a row and every re-render
 * share it (the query cache keeps the object).
 */
export function jsonDiff(change: ChangeHistoryFieldChange): { from: DiffLine[]; to: DiffLine[] } {
  let diff = jsonDiffs.get(change);
  if (!diff) {
    diff = diffLines(jsonLines(change.from, change.labels), jsonLines(change.to, change.labels));
    jsonDiffs.set(change, diff);
  }
  return diff;
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

/**
 * `{ moved: 3, added: 0, total: 12 }` → the non-zero counts to show and the `total`, which reads as «(total 12)»
 * after them.
 */
export function countsLine(counts: unknown): { parts: Array<[string, number]>; total?: number } {
  const entries = countEntries(counts);
  const total = entries.find(([key]) => key === 'total')?.[1];
  return { parts: entries.filter(([key]) => key !== 'total'), ...(total !== undefined ? { total } : {}) };
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

/** What `titleWhenCut` reads and writes of an element. */
interface CuttableElement {
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
  textContent: string | null;
  title: string;
}

/**
 * Gives an element cut by its line clamp or ellipsis its whole text as the tooltip, and takes the tooltip away
 * when the text fits (called on hover, so it follows the column's current width).
 */
export function titleWhenCut(element: CuttableElement): void {
  const cut = element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1;
  element.title = cut ? (element.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
}

// ---------------------------------------------------------------------------------------------------------
// Badges

/** A label as the eye compares it: case and runs of whitespace do not make two labels different. */
function labelKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Whether a text repeats one already on the line: the same words, or the start of a longer one («Scheduled
 * action» next to the title «Scheduled action #3»).
 */
export function repeatsShown(text: string, shown: readonly string[]): boolean {
  const key = labelKey(text);
  return (
    !!key &&
    shown.some((other) => {
      const otherKey = labelKey(other);
      return otherKey === key || otherKey.startsWith(`${key} `);
    })
  );
}

/**
 * One entry's badges with each visible text once (the first kept), and none repeating a text the line already
 * shows. Two labels can name one thing: a scheduled action's source and its batch kind both read «Scheduled
 * action», and the entry would show that badge twice.
 */
export function distinctBadges<T extends { text: string }>(
  badges: ReadonlyArray<T | false | null | undefined>,
  shown: readonly string[] = [],
): T[] {
  const seen = new Set(shown.map(labelKey));
  return badges.filter((badge): badge is T => {
    if (!badge) {
      return false;
    }
    const key = labelKey(badge.text);
    if (!key || seen.has(key) || repeatsShown(badge.text, shown)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------
// A deleted entity's last state

interface LastStateField {
  kind?: unknown;
  labels?: unknown;
}

/** The kind of a value of a last state recorded before kinds were kept: markup is rich text, an object JSON. */
export function guessKind(value: unknown): string {
  if (typeof value === 'boolean') {
    return 'bool';
  }
  if (typeof value === 'string' && /<\/?[a-z][^>]*>/i.test(value)) {
    return 'richtext';
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? 'json' : 'text';
}

/**
 * One value of `meta.lastState` as a change whose «became» side is the value, with the kind and labels the
 * server kept in `meta.lastStateFields` — so the value renderers of a diff render it. Without
 * `lastStateFields` (an older entry) the kind is guessed from the value.
 */
export function lastStateChange(key: string, value: unknown, fields: unknown): ChangeHistoryFieldChange {
  const known =
    fields && typeof fields === 'object' && !Array.isArray(fields)
      ? (fields as Record<string, LastStateField | undefined>)
      : undefined;
  const field = known?.[key];
  const kind = typeof field?.kind === 'string' ? field.kind : known ? 'text' : guessKind(value);
  const labels =
    field?.labels && typeof field.labels === 'object' ? (field.labels as Record<string, string>) : undefined;
  return { kind, to: value, ...(labels ? { labels } : {}) };
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

/** The feed's query key carries this marker, so that the page can find its query's state in the cache. */
export const FEED_QUERY_MARKER = 'change-history-feed';

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

/**
 * A picked period as whole local days: the picker gives local midnights (one click: `to` = `from`), so the
 * last day would be left out — `from` becomes the start of its day, `to` the end of its day.
 */
export function periodBounds(from: Date, to: Date): { from: string; to: string } {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

export interface ListSearch {
  page: number;
  perPage: number;
  filters: Array<{ id: string; value: unknown }>;
}

const MAX_PER_PAGE = 100;

/** The table's state in the URL, made safe: page ≥ 1, 1 ≤ perPage ≤ 100, only `{ id, value }` filters. */
export function parseListSearch(search: Record<string, unknown> | undefined): ListSearch {
  const whole = (value: unknown) => Math.trunc(Number(value));
  const page = whole(search?.page);
  const perPage = whole(search?.perPage);
  const filters = Array.isArray(search?.filters) ? (search.filters as unknown[]) : [];
  return {
    page: page >= 1 ? page : 1,
    perPage: perPage >= 1 ? Math.min(perPage, MAX_PER_PAGE) : 20,
    filters: filters.filter(
      (filter): filter is { id: string; value: unknown } =>
        !!filter &&
        typeof filter === 'object' &&
        !Array.isArray(filter) &&
        typeof (filter as { id?: unknown }).id === 'string' &&
        'value' in filter,
    ),
  };
}

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
export function feedSearchParams(state: FeedSearch): Record<string, string | number | boolean | undefined> {
  return {
    collapse: state.collapseBatches ? undefined : false,
    hideSystem: state.hideSystem ? true : undefined,
    from: state.from && state.to ? state.from : undefined,
    to: state.from && state.to ? state.to : undefined,
    entry: entryParam(state.entry),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Display helpers

/**
 * The name of an API key's owner. Entries recorded before the dashboard added the marker itself stored
 * «Name (API key)»; the English suffix is dropped so that the localized marker is the only one shown.
 */
export function apiKeyOwnerName(label: string): string {
  const text = label.trimEnd();
  const suffix = '(api key)';
  return text.toLowerCase().endsWith(suffix) ? text.slice(0, -suffix.length).trimEnd() : text;
}

/** The name an entry's actor label shows: an API key's owner without the stored English suffix. */
export function actorLabelText(actorType: string, label: string | null | undefined): string | undefined {
  if (label == null || label === '') {
    return undefined;
  }
  return actorType === 'api_key' ? apiKeyOwnerName(label) : label;
}

/** Whether a failed request was refused for lack of permission (Vendure's FORBIDDEN error), not broken. */
export function isForbiddenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const extensions = (error as { response?: { errors?: Array<{ extensions?: { code?: string } }> } } | null)?.response
    ?.errors;
  return (
    /not currently authorized|forbidden/i.test(message) ||
    (Array.isArray(extensions) && extensions.some((item) => item?.extensions?.code === 'FORBIDDEN'))
  );
}

/**
 * An option of the feed's «Who» filter: the name, and for an API key its owner's name with the localized
 * marker (`apiKeyMarker`) — once, whether or not the stored label still has the English suffix.
 */
export function actorOptionLabel(actor: { type: string; label: string }, apiKeyMarker: string): string {
  return actor.type === 'api_key' ? `${apiKeyOwnerName(actor.label)} (${apiKeyMarker})` : actor.label;
}

/** `оновлено` → `Оновлено`: a lowercase label at the start of a title or a badge. */
export function capitalizeFirst(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}

/**
 * `Oversize tee S (TS-OVS-BLK-S)` → name and SKU, so that a narrow cell cuts the name and keeps the SKU, the
 * part that tells the variants apart. A label without a trailing `(…)` comes back as the name.
 */
export function splitTrailingCode(label: string): { name: string; code?: string } {
  const open = label.lastIndexOf('(');
  if (!label.endsWith(')') || open <= 0) {
    return { name: label };
  }
  const code = label.slice(open + 1, -1);
  const name = label.slice(0, open).trimEnd();
  return code && !code.includes('(') && !code.includes(')') && name ? { name, code } : { name: label };
}

/** A whole page number within `1…last page`: a page past the end (a stale `?page=6`) becomes the last one. */
export function clampPage(page: number, perPage: number, totalItems: number): number {
  const last = Math.max(1, Math.ceil(totalItems / Math.max(1, perPage)));
  return Math.min(Math.max(1, page), last);
}

/**
 * The open entry as it goes into the URL: a numeric id as a number, so that the router writes `?entry=65`,
 * not the JSON string `?entry=%2265%22`.
 */
export function entryParam(id: string | undefined): string | number | undefined {
  return id !== undefined && /^[1-9]\d{0,14}$/.test(id) ? Number(id) : id;
}

/** `1536` → `1.5 KB` with the dashboard's number format; bytes below 1 KB as they are. */
export function formatBytes(bytes: number, formatNumber: (value: number) => string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${formatNumber(rounded)} ${units[unit]}`;
}

/** Keys a created entity's values start with: what names it first, then whether it is live. */
const LEADING_KEYS = ['name', 'code', 'sku', 'slug', 'enabled'];

/** `name.uk`, `slug.uk`, `enabled`, … first (in that order), every other key after them as it came. */
export function orderCreatedKeys(keys: string[]): string[] {
  const rank = (key: string) => {
    const index = LEADING_KEYS.indexOf(key.replace(/\.[a-z]{2}(_[A-Za-z]{2,4})?$/, ''));
    return index === -1 ? LEADING_KEYS.length : index;
  };
  return keys
    .map((key, index) => ({ key, index }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.index - b.index)
    .map(({ key }) => key);
}

/** Unchanged tokens between two kept stretches are left out only when there are at least this many. */
const MIN_GAP = 4;

/** One piece of a clipped diff: a token, or the gap of unchanged tokens left out between two changes. */
export type DiffSegment = DiffLine | { gap: true };

/**
 * The changed tokens of one side with `context` unchanged tokens around each change; every longer unchanged
 * run becomes one gap. A side without changes keeps its first `2 × context` tokens.
 */
export function diffWindow(tokens: DiffLine[], context: number): DiffSegment[] {
  const keep = new Array<boolean>(tokens.length).fill(false);
  let anyChange = false;
  tokens.forEach((token, index) => {
    if (token.changed) {
      anyChange = true;
      for (let k = Math.max(0, index - context); k <= Math.min(tokens.length - 1, index + context); k++) {
        keep[k] = true;
      }
    }
  });
  if (!anyChange) {
    keep.fill(true, 0, Math.min(tokens.length, context * 2));
  }
  // A gap between two kept stretches saves nothing when it is shorter than the «…» costs to read.
  let start = 0;
  while (start < tokens.length) {
    if (keep[start]) {
      start++;
      continue;
    }
    let end = start;
    while (end < tokens.length && !keep[end]) {
      end++;
    }
    if (start > 0 && end < tokens.length && end - start < MIN_GAP) {
      keep.fill(true, start, end);
    }
    start = end;
  }
  const segments: DiffSegment[] = [];
  tokens.forEach((token, index) => {
    if (keep[index]) {
      segments.push(token);
    } else if (index === 0 || keep[index - 1]) {
      segments.push({ gap: true });
    }
  });
  return segments;
}

/** The word diff of two texts: each side's words, those outside the common subsequence marked. */
export function wordDiff(from: string, to: string): { from: DiffLine[]; to: DiffLine[] } {
  const words = (text: string) => text.split(/\s+/).filter(Boolean);
  return diffLines(words(from), words(to));
}

const richTextDiffs = new WeakMap<object, { from: DiffLine[]; to: DiffLine[] }>();

/** The word diff of a rich-text change as plain text, computed once per change object. */
export function richTextDiff(change: ChangeHistoryFieldChange): { from: DiffLine[]; to: DiffLine[] } {
  let diff = richTextDiffs.get(change);
  if (!diff) {
    const text = (value: unknown) => (typeof value === 'string' ? stripHtml(value) : '');
    diff = wordDiff(text(change.from), text(change.to));
    richTextDiffs.set(change, diff);
  }
  return diff;
}

// ---------------------------------------------------------------------------------------------------------
// Configurable operations (collection filters, promotion conditions and actions)

export interface OperationValue {
  code: string;
  args: Array<{ name: string; value: unknown }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Whether a JSON value is a list of configurable operations (`[{ code, args: [{ name, value }] }]`). */
export function isOperationList(value: unknown): value is OperationValue[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.code === 'string' &&
        Array.isArray(item.args) &&
        item.args.every((arg) => isRecord(arg) && typeof arg.name === 'string'),
    )
  );
}

/** An operation as it reads: its title, and a label and a text per argument. */
export interface DescribedOperation {
  title: string;
  args: Array<[string, string]>;
}

/**
 * The lines of a list of operations: the title, then one indented `label: value` line per argument — the
 * lines the diff compares, so that a changed argument marks its own line only.
 */
export function operationLines(
  operations: OperationValue[] | null | undefined,
  describe: (operation: OperationValue) => DescribedOperation,
): string[] {
  const lines: string[] = [];
  for (const operation of operations ?? []) {
    const { title, args } = describe(operation);
    lines.push(title);
    for (const [label, text] of args) {
      lines.push(`    ${label}: ${text}`);
    }
  }
  return lines;
}

/**
 * `If order total is greater than { amount }` with the arguments' texts filled in, and the names of the
 * arguments it used (they need no line of their own).
 */
export function fillDescription(description: string, args: Record<string, string>): { text: string; used: string[] } {
  const used: string[] = [];
  const text = description.replace(/\{\s*(\w+)\s*\}/g, (placeholder, name: string) => {
    if (!(name in args)) {
      return placeholder;
    }
    used.push(name);
    return args[name];
  });
  return { text, used };
}

/** An argument's stored value as a list: a JSON list string (`"[\"1\",\"2\"]"`) or a list already. */
export function argumentList(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string' && value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
