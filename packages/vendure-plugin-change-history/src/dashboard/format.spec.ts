import { describe, expect, it } from 'vitest';
import {
  batchTotal,
  builtInRoute,
  clipText,
  COLLAPSE_BATCHES_FILTER,
  countEntries,
  countsLine,
  diffLines,
  durationSeconds,
  encodeActor,
  feedFilter,
  feedSearchParams,
  flatEntries,
  formatDelta,
  groupByKind,
  guessKind,
  HIDE_SYSTEM_FILTER,
  idList,
  isStripped,
  jsonDiff,
  jsonLines,
  lastStateChange,
  numericDelta,
  parseFeedSearch,
  parseListSearch,
  periodBounds,
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

  it('separates the words of lines and blocks', () => {
    expect(stripHtml('One<br>two<br/>three<BR />four')).toBe('One two three four');
    expect(stripHtml('<ul><li>a</li><li>b</li></ul><h2>c</h2><div>d</div>e')).toBe('a b c d e');
    expect(stripHtml('<b>bo</b>ld <span class="x">sp</span>an')).toBe('bold span');
  });

  it('leaves no tag behind, however the markup nests or ends', () => {
    // A regex pass removing `<b>` would reassemble `<script>` out of `<scr<b>ipt>`; one scan does not.
    expect(stripHtml('<scr<b>ipt>alert(1)</script>')).toBe('ipt>alert(1)');
    expect(stripHtml('<sc<script>ript>x</sc</script>ript>')).toBe('ript>xript>');
    expect(stripHtml('text <img src=x onerror=alert(1)')).toBe('text');
    expect(stripHtml('<!-- note --><p>kept</p><?xml x?>')).toBe('kept');
  });

  it('keeps a < that does not open a tag', () => {
    expect(stripHtml('a < b and 3<4')).toBe('a < b and 3<4');
    expect(stripHtml('ends with <')).toBe('ends with <');
  });

  it('decodes each entity once', () => {
    expect(stripHtml('&amp;lt;b&amp;gt; is &lt;b&gt;')).toBe('&lt;b&gt; is <b>');
    expect(stripHtml('&copy; &unknown; & alone')).toBe('&copy; &unknown; & alone');
  });

  it('strips long markup in linear time', () => {
    const html = `${'<b>x</b>'.repeat(50_000)}${'<'.repeat(50_000)}${'<a'.repeat(50_000)}`;
    const started = performance.now();
    expect(stripHtml(html)).toBe(`${'x'.repeat(50_000)}${'<'.repeat(50_000)}`);
    expect(performance.now() - started).toBeLessThan(1_000);
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

  it('puts the total of a count line last', () => {
    expect(countsLine({ moved: 3, added: 0, removed: 1, total: 12 })).toEqual({
      parts: [
        ['moved', 3],
        ['removed', 1],
      ],
      total: 12,
    });
    expect(countsLine({ total: 4 })).toEqual({ parts: [], total: 4 });
    expect(countsLine({ moved: 2 })).toEqual({ parts: [['moved', 2]] });
    expect(countsLine(undefined)).toEqual({ parts: [] });
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
    expect(jsonLines({ a: [1] }, {})).toEqual(['{', '  "a": [', '    1', '  ]', '}']);
  });

  it('leaves a facet value argument as it is unless every id has a label', () => {
    const arg = (value: unknown) => ({ name: 'facetValueIds', value });
    const labels = { 31: 'Season: Winter' };
    expect(jsonLines([arg(['31', '99'])], labels).join('')).toContain('"99"');
    expect(jsonLines([arg([])], labels).join('')).toContain('"value": []');
    expect(jsonLines([arg([{ id: '31' }])], labels).join('')).toContain('"id": "31"');
    expect(jsonLines([arg('["31","99"]')], labels).join('')).toContain('[\\"31\\",\\"99\\"]');
    expect(jsonLines([arg('[31')], labels).join('')).toContain('"value": "[31"');
    expect(jsonLines([arg('31')], labels).join('')).toContain('"value": "31"');
    expect(jsonLines([arg(31)], labels).join('')).toContain('"value": 31');
    expect(jsonLines([arg(['31'])], labels).join('')).toContain('"Season: Winter"');
  });

  it('labels the ids of facet value arguments only', () => {
    const conditions = [
      {
        code: 'buy_x_get_y',
        args: [
          { name: 'productIds', value: '["12"]' },
          { name: 'facetValueIds', value: '["12"]' },
          { name: 'facets', value: ['12'] },
        ],
      },
    ];
    const text = jsonLines(conditions, { 12: 'Color: Red' }).join('\n');
    // A product id that collides with a facet value id is not shown as that facet value.
    expect(text).toContain('"value": "[\\"12\\"]"');
    expect(text.match(/Color: Red/g)).toHaveLength(2);
    expect(jsonLines({ productIds: ['12'] }, { 12: 'Color: Red' }).join('')).not.toContain('Color');
  });

  it('shows an object of scalars as key: value lines', () => {
    expect(flatEntries({ Kyiv: 3, Lviv: null, open: true })).toEqual([
      ['Kyiv', '3'],
      ['Lviv', '—'],
      ['open', 'true'],
    ]);
    expect(flatEntries({ nested: { a: 1 } })).toBeUndefined();
    expect(flatEntries({})).toBeUndefined();
    expect(flatEntries(['a'])).toBeUndefined();
    expect(flatEntries('text')).toBeUndefined();
    expect(jsonLines({ Kyiv: 3, Lviv: 0 }, undefined)).toEqual(['Kyiv: 3', 'Lviv: 0']);
  });

  it('marks the lines outside the common subsequence', () => {
    const { from, to } = diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
    expect(from.map((line) => line.changed)).toEqual([false, true, false]);
    expect(to.map((line) => line.changed)).toEqual([false, true, false, true]);
    expect(diffLines([], ['a']).to).toEqual([{ text: 'a', changed: true }]);
  });

  it('keeps only the common head and tail of texts too long for the subsequence', () => {
    const from = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    const to = [...from.slice(0, 10), 'new', ...from.slice(11)];
    const diff = diffLines(from, to);
    expect(diff.from.filter((line) => line.changed).map((line) => line.text)).toEqual(['line 10']);
    expect(diff.to.filter((line) => line.changed).map((line) => line.text)).toEqual(['new']);
    // One side a prefix of the other: only the extra lines are marked.
    const longer = diffLines(from, [...from, 'tail']);
    expect(longer.from.some((line) => line.changed)).toBe(false);
    expect(longer.to.filter((line) => line.changed).map((line) => line.text)).toEqual(['tail']);
  });

  it('computes the diff of a JSON change once per change', () => {
    const change = { kind: 'json', from: { a: [1] }, to: { a: [2] } };
    const first = jsonDiff(change);
    expect(jsonDiff(change)).toBe(first);
    expect(first.to.filter((line) => line.changed).map((line) => line.text.trim())).toEqual(['2']);
    expect(jsonDiff({ ...change })).not.toBe(first);
  });
});

describe("a deleted entity's last state", () => {
  it('reads the kind and labels the server kept', () => {
    const fields = { price: { kind: 'money' }, facetValues: { kind: 'refs', labels: { 3: 'Color: Red' } } };
    expect(lastStateChange('price', 1250, fields)).toEqual({ kind: 'money', to: 1250 });
    expect(lastStateChange('facetValues', ['3'], fields)).toEqual({
      kind: 'refs',
      to: ['3'],
      labels: { 3: 'Color: Red' },
    });
    // A key the server left out is text, whatever it looks like.
    expect(lastStateChange('sku', '<b>A</b>', fields)).toEqual({ kind: 'text', to: '<b>A</b>' });
  });

  it('guesses the kind of an older entry without kinds', () => {
    expect(lastStateChange('description.en', '<p>Soft</p>', undefined).kind).toBe('richtext');
    expect(lastStateChange('enabled', false, null).kind).toBe('bool');
    expect(lastStateChange('focalPoint', { x: 1 }, 'odd').kind).toBe('json');
    expect(guessKind(['1', '2'])).toBe('text');
    expect(guessKind('a < b')).toBe('text');
    expect(lastStateChange('x', 1, { x: { kind: 3, labels: 'no' } })).toEqual({ kind: 'text', to: 1 });
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

  it('turns a picked period into whole local days', () => {
    const day = new Date(2026, 9, 11);
    const { from, to } = periodBounds(day, day);
    expect(new Date(from)).toEqual(new Date(2026, 9, 11, 0, 0, 0, 0));
    expect(new Date(to)).toEqual(new Date(2026, 9, 11, 23, 59, 59, 999));
    const range = periodBounds(new Date(2026, 9, 1, 13, 30), new Date(2026, 9, 3));
    expect(new Date(range.from)).toEqual(new Date(2026, 9, 1));
    expect(new Date(range.to)).toEqual(new Date(2026, 9, 3, 23, 59, 59, 999));
  });

  it('keeps the table state of the URL within bounds', () => {
    expect(parseListSearch(undefined)).toEqual({ page: 1, perPage: 20, filters: [] });
    expect(parseListSearch({ page: '-3', perPage: '0' })).toEqual({ page: 1, perPage: 20, filters: [] });
    expect(parseListSearch({ page: '2.7', perPage: 5000 })).toMatchObject({ page: 2, perPage: 100 });
    expect(parseListSearch({ page: 'x', perPage: '50' })).toMatchObject({ page: 1, perPage: 50 });
    expect(
      parseListSearch({
        filters: [null, 'x', [], { id: 3, value: 1 }, { id: 'action' }, { id: 'action', value: { in: ['deleted'] } }],
      }).filters,
    ).toEqual([{ id: 'action', value: { in: ['deleted'] } }]);
    expect(parseListSearch({ filters: 'oops' }).filters).toEqual([]);
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
