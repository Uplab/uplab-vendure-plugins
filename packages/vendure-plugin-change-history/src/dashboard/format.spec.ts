import { describe, expect, it } from 'vitest';
import {
  batchTotal,
  builtInRoute,
  clipText,
  COLLAPSE_BATCHES_FILTER,
  countEntries,
  diffLines,
  durationSeconds,
  encodeActor,
  feedFilter,
  feedSearchParams,
  formatDelta,
  groupByKind,
  HIDE_SYSTEM_FILTER,
  idList,
  isStripped,
  jsonLines,
  numericDelta,
  parseFeedSearch,
  rowEntities,
  stripHtml,
} from './format';
import type { ChangeHistoryDetailData } from './registry';

const row = (over: Partial<ChangeHistoryDetailData>): ChangeHistoryDetailData => ({
  id: '1',
  entryId: '9',
  entityType: 'ProductVariant',
  entityId: '1',
  entityLabel: null,
  sku: null,
  parentType: null,
  parentId: null,
  kind: 'stock',
  scope: null,
  scopeLabel: null,
  from: 0,
  to: 1,
  ...over,
});

describe('text helpers', () => {
  it('shows rich text as plain text', () => {
    expect(stripHtml('<p>Cotton &amp; linen</p><p>Fits&nbsp;<b>well</b></p>')).toBe('Cotton & linen Fits well');
    expect(stripHtml('<p>&lt;3 &quot;tee&quot; &#39;s</p>')).toBe(`<3 "tee" 's`);
  });

  it('clips long text on a word boundary', () => {
    expect(clipText('short', 10)).toEqual({ text: 'short', clipped: false });
    expect(clipText('An oversized tee of dense cotton', 20)).toEqual({ text: 'An oversized tee of…', clipped: true });
    expect(clipText('abcdefghijklmnopqrstuvwxyz', 10)).toEqual({ text: 'abcdefghij…', clipped: true });
  });
});

describe('numbers', () => {
  it('computes a delta of numeric values only', () => {
    expect(numericDelta(12, 20)).toBe(8);
    expect(numericDelta(null, 2)).toBe(2);
    expect(numericDelta(3, undefined)).toBe(-3);
    expect(numericDelta('a', 'b')).toBeUndefined();
    expect(numericDelta(1, 'b')).toBeUndefined();
  });

  it('formats a delta with a sign and a real minus', () => {
    expect(formatDelta(8)).toBe('+8');
    expect(formatDelta(-2)).toBe('−2');
    expect(formatDelta(0)).toBe('0');
  });

  it('turns a duration into seconds', () => {
    expect(durationSeconds(4200)).toBe(4);
    expect(durationSeconds(120)).toBe(1);
    expect(durationSeconds(-1)).toBeUndefined();
    expect(durationSeconds('4s')).toBeUndefined();
  });

  it('lists the counts of a run in their order', () => {
    const counts = { updated: 37, zeroed: 2, failed: 0, note: 'x' };
    expect(countEntries(counts)).toEqual([
      ['updated', 37],
      ['zeroed', 2],
    ]);
    expect(countEntries(counts, true)).toContainEqual(['failed', 0]);
    expect(countEntries(null)).toEqual([]);
    expect(countEntries([1, 2])).toEqual([]);
  });

  it('sums the members of a batch', () => {
    expect(
      batchTotal([
        { entityType: 'Product', action: 'updated', count: 120 },
        { entityType: 'ProductVariant', action: 'updated', count: 3 },
      ]),
    ).toBe(123);
    expect(batchTotal(null)).toBe(0);
  });
});

describe('values', () => {
  it('reads id lists', () => {
    expect(idList(['1', 2])).toEqual(['1', '2']);
    expect(idList('7')).toEqual(['7']);
    expect(idList(null)).toEqual([]);
  });

  it('knows a compacted value', () => {
    expect(isStripped({ kind: 'richtext', stripped: true, fromLength: 3412, toLength: 3587 })).toBe(true);
    expect(isStripped({ from: 'a', to: 'b' })).toBe(false);
  });

  it('pretty-prints JSON with id lists replaced by their labels', () => {
    const filters = [{ code: 'facet-value-filter', args: [{ name: 'facetValueIds', value: '["31","4"]' }] }];
    const lines = jsonLines(filters, { 31: 'Season: Winter', 4: 'Promo: Yes' });
    expect(lines.join('\n')).toContain('"Season: Winter"');
    expect(lines.join('\n')).not.toContain('facetValueIds": "[');
    // A list with an unlabelled id, and a string that only looks like a list, stay as they are.
    expect(jsonLines({ ids: ['31', '99'], text: '[not json' }, { 31: 'X' }).join('')).toContain('"99"');
    expect(jsonLines({ text: '[not json' }, { 31: 'X' }).join('')).toContain('[not json');
    expect(jsonLines(null, undefined)).toEqual([]);
    expect(jsonLines({ a: 1 }, {})).toEqual(['{', '  "a": 1', '}']);
  });

  it('marks the lines outside the common subsequence', () => {
    const { from, to } = diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
    expect(from.map((line) => line.changed)).toEqual([false, true, false]);
    expect(to.map((line) => line.changed)).toEqual([false, true, false, true]);
    expect(diffLines([], ['a']).to).toEqual([{ text: 'a', changed: true }]);
  });
});

describe('detail rows', () => {
  it('groups by kind in first-seen order', () => {
    const rows = [row({ id: '1', kind: 'stock' }), row({ id: '2', kind: 'price' }), row({ id: '3', kind: 'stock' })];
    expect(groupByKind(rows).map(([kind, group]) => [kind, group.map((r) => r.id)])).toEqual([
      ['stock', ['1', '3']],
      ['price', ['2']],
    ]);
  });

  it('counts the entities the rows touch', () => {
    expect(rowEntities([row({ entityId: '1' }), row({ entityId: '1', scope: '2' }), row({ entityId: '2' })])).toEqual({
      count: 2,
      type: 'ProductVariant',
    });
    expect(rowEntities([row({}), row({ entityType: 'Product' })]).type).toBeUndefined();
  });
});

describe('the feed filter', () => {
  it('adds the switches and the period to the table filters', () => {
    const filter = feedFilter(
      { _and: [{ entityType: { in: ['Product'] } }], entityLabel: { contains: 'tee' } },
      { collapseBatches: true, hideSystem: true, from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
    );
    expect(filter).toEqual({
      entityLabel: { contains: 'tee' },
      _and: [
        { entityType: { in: ['Product'] } },
        COLLAPSE_BATCHES_FILTER,
        HIDE_SYSTEM_FILTER,
        { createdAt: { between: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' } } },
      ],
    });
  });

  it('turns the actor filter into id and type pairs', () => {
    const filter = feedFilter(
      { _and: [{ actorId: { in: [encodeActor('api_key', '3'), '5'] } }] },
      { collapseBatches: false, hideSystem: false },
    );
    expect(filter).toEqual({
      _and: [
        {
          _or: [{ _and: [{ actorId: { eq: '3' } }, { actorType: { eq: 'api_key' } }] }, { actorId: { eq: '5' } }],
        },
      ],
    });
  });

  it('is empty without filters, and ignores half a period', () => {
    expect(feedFilter(undefined, { collapseBatches: false, hideSystem: false, from: '2026-10-01' })).toBeUndefined();
  });
});

describe('the feed URL', () => {
  it('reads the switches with their defaults, a period and the open entry', () => {
    expect(parseFeedSearch(undefined)).toEqual({ collapseBatches: true, hideSystem: false });
    expect(
      parseFeedSearch({
        collapse: false,
        hideSystem: 'true',
        from: '2026-10-01T00:00:00Z',
        to: '2026-10-02T00:00:00Z',
        entry: 15,
      }),
    ).toEqual({
      collapseBatches: false,
      hideSystem: true,
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-02T00:00:00Z',
      entry: '15',
    });
    expect(parseFeedSearch({ collapse: '0', hideSystem: 1, from: 'yesterday', to: '2026-10-02' })).toEqual({
      collapseBatches: false,
      hideSystem: true,
    });
    expect(parseFeedSearch({ collapse: 'maybe' }).collapseBatches).toBe(true);
  });

  it('writes only what differs from the defaults', () => {
    expect(feedSearchParams({ collapseBatches: true, hideSystem: false })).toEqual({
      collapse: undefined,
      hideSystem: undefined,
      from: undefined,
      to: undefined,
      entry: undefined,
    });
    expect(feedSearchParams({ collapseBatches: false, hideSystem: true, from: 'a', to: 'b', entry: '3' })).toEqual({
      collapse: false,
      hideSystem: true,
      from: 'a',
      to: 'b',
      entry: '3',
    });
  });
});

describe('builtInRoute', () => {
  it('links the core detail pages', () => {
    expect(builtInRoute('Product', '1')).toBe('/products/1');
    expect(builtInRoute('ProductVariant', '2')).toBe('/product-variants/2');
    expect(builtInRoute('FacetValue', '5', '1')).toBe('/facets/1/values/5');
    expect(builtInRoute('FacetValue', '5', null)).toBeUndefined();
    expect(builtInRoute('Batch', 'x')).toBeUndefined();
  });
});
