import { describe, expect, it } from 'vitest';
import {
  runSubjectOf,
  actorLabelText,
  actorOptionLabel,
  apiKeyOwnerName,
  argumentList,
  batchTotal,
  capitalizeFirst,
  changedEntries,
  clampPage,
  diffWindow,
  entryParam,
  fillDescription,
  formatBytes,
  isForbiddenError,
  isOperationList,
  operationLines,
  orderCreatedKeys,
  refLabel,
  repeatsShown,
  richTextDiff,
  soleEntry,
  splitTrailingCode,
  withFacetValueLabels,
  wordDiff,
  builtInRoute,
  clipText,
  COLLAPSE_BATCHES_FILTER,
  countEntries,
  countsLine,
  diffLines,
  distinctBadges,
  durationSeconds,
  encodeActor,
  feedFilter,
  searchFilter,
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
  titleWhenCut,
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
    expect(jsonLines({ Kyiv: 3, Lviv: 0 }, undefined)).toEqual(['Kyiv:\u00A03', 'Lviv:\u00A00']);
  });

  it('reads a change of a map of scalars as the keys that changed, a missing side as a dash', () => {
    expect(changedEntries({ Kyiv: 0, Lviv: 1 }, { Kyiv: 13, Lviv: 1, Odesa: 2 })).toEqual([
      ['Kyiv', '0', '13'],
      ['Odesa', '—', '2'],
    ]);
    expect(changedEntries({ Kyiv: 1, Lviv: 2 }, { Kyiv: 1 })).toEqual([['Lviv', '2', '—']]);
    expect(changedEntries(null, { Kyiv: 2 })).toEqual([['Kyiv', '—', '2']]);
    expect(changedEntries({ Kyiv: 2 }, undefined)).toEqual([['Kyiv', '2', '—']]);
    expect(changedEntries(null, null)).toBeUndefined();
    expect(changedEntries(['a'], { Kyiv: 2 })).toBeUndefined();
    expect(changedEntries({ Kyiv: 2 }, 'text')).toBeUndefined();
  });

  it('finds the one key two sides of a map of scalars hold between them, a missing value as null', () => {
    expect(soleEntry({ Kyiv: null }, { Kyiv: 13 })).toEqual({ key: 'Kyiv', from: null, to: 13 });
    expect(soleEntry(null, { Kyiv: 13 })).toEqual({ key: 'Kyiv', from: null, to: 13 });
    expect(soleEntry({ Kyiv: 'a' }, undefined)).toEqual({ key: 'Kyiv', from: 'a', to: null });
    expect(soleEntry({ Kyiv: 1 }, { Lviv: 1 })).toBeUndefined();
    expect(soleEntry({ Kyiv: 1, Lviv: 2 }, { Kyiv: 3, Lviv: 2 })).toBeUndefined();
    expect(soleEntry({ Kyiv: { a: 1 } }, { Kyiv: 2 })).toBeUndefined();
    expect(soleEntry(null, null)).toBeUndefined();
    expect(soleEntry(3, 4)).toBeUndefined();
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

  it('does not mark a line that only gained the comma before a new last element', () => {
    const change = {
      kind: 'json',
      from: [{ code: 'f', args: [{ name: 'ids', value: ['Color: Black'] }] }],
      to: [{ code: 'f', args: [{ name: 'ids', value: ['Color: Black', 'Color: White'] }] }],
    };
    const diff = jsonDiff(change);
    expect(diff.from.filter((line) => line.changed)).toEqual([]);
    expect(diff.to.filter((line) => line.changed).map((line) => line.text.trim())).toEqual(['"Color: White"']);
    // A structural line that only gained a comma is unchanged too.
    const objects = diffLines(['  {', '    "a": 1', '  }'], ['  {', '    "a": 1', '  },', '  {', '    "a": 2', '  }']);
    expect(objects.from.some((line) => line.changed)).toBe(false);
    expect(objects.to.map((line) => line.changed)).toEqual([false, false, false, true, true, true]);
    // The same in the linear fallback for long texts.
    const long = Array.from({ length: 600 }, (_, i) => `"${i}",`);
    const ends = diffLines([...long, '"last"'], [...long, '"last",', '"new"']);
    expect(ends.from.some((line) => line.changed)).toBe(false);
    expect(ends.to.filter((line) => line.changed).map((line) => line.text)).toEqual(['"new"']);
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

  it("searches an entry's name and a run's subject; an empty term adds nothing", () => {
    expect(searchFilter('SO-1042')).toEqual({
      _or: [{ entityLabel: { contains: 'SO-1042' } }, { subjectLabel: { contains: 'SO-1042' } }],
    });
    expect(searchFilter('')).toEqual({});
    // Next to the table's own clauses.
    expect(
      feedFilter(
        { ...searchFilter('tee'), _and: [{ entityType: { in: ['Run'] } }] },
        { collapseBatches: false, hideSystem: false },
      ),
    ).toEqual({
      _or: [{ entityLabel: { contains: 'tee' } }, { subjectLabel: { contains: 'tee' } }],
      _and: [{ entityType: { in: ['Run'] } }],
    });
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
      // A number, so that the router writes `?entry=3`, not `?entry=%223%22`.
      entry: 3,
    });
    expect(feedSearchParams({ collapseBatches: true, hideSystem: false, entry: 'a1b2' }).entry).toBe('a1b2');
  });

  it('writes a numeric entry id as a number and any other id as it is', () => {
    expect(entryParam('65')).toBe(65);
    expect(entryParam('065')).toBe('065');
    expect(entryParam('6f9c2a7e-1b2c')).toBe('6f9c2a7e-1b2c');
    expect(entryParam('12345678901234567890')).toBe('12345678901234567890');
    expect(entryParam(undefined)).toBeUndefined();
  });

  it('moves a page past the end to the last page', () => {
    expect(clampPage(6, 20, 57)).toBe(3);
    expect(clampPage(2, 20, 57)).toBe(2);
    expect(clampPage(4, 20, 0)).toBe(1);
    expect(clampPage(0, 0, 10)).toBe(1);
  });
});

describe('runSubjectOf', () => {
  it("reads a run's subject", () => {
    expect(runSubjectOf({ subject: { label: 'SO-1042', type: 'Order', id: 42 } })).toEqual({
      label: 'SO-1042',
      type: 'Order',
      id: '42',
    });
    expect(runSubjectOf({ subject: { label: 'Nightly', type: '', id: '' } })).toEqual({ label: 'Nightly' });
    expect(runSubjectOf({ subject: { label: '' } })).toBeUndefined();
    expect(runSubjectOf({ subject: ['x'] })).toBeUndefined();
    expect(runSubjectOf({})).toBeUndefined();
    expect(runSubjectOf(null)).toBeUndefined();
  });
});

describe('builtInRoute', () => {
  it('links the core detail pages', () => {
    expect(builtInRoute('Order', '42')).toBe('/orders/42');
    expect(builtInRoute('Product', '1')).toBe('/products/1');
    expect(builtInRoute('ProductVariant', '2')).toBe('/product-variants/2');
    expect(builtInRoute('FacetValue', '5', '1')).toBe('/facets/1/values/5');
    expect(builtInRoute('FacetValue', '5', null)).toBeUndefined();
    expect(builtInRoute('Batch', 'x')).toBeUndefined();
  });
});

describe('distinctBadges', () => {
  it('keeps the first badge of each visible text, whatever its case and spacing', () => {
    const badges = distinctBadges([
      { key: 'actor', text: 'Scheduled action' },
      false,
      null,
      undefined,
      { key: 'derived', text: 'derived' },
      { key: 'batch', text: '  scheduled   ACTION ' },
      { key: 'deleted', text: 'deleted' },
    ]);
    expect(badges.map((badge) => badge.key)).toEqual(['actor', 'derived', 'deleted']);
  });

  it('drops a badge repeating a text the line already shows, and a blank one', () => {
    const badges = distinctBadges(
      [
        { key: 'actor', text: 'Scheduled action' },
        { key: 'blank', text: '  ' },
        { key: 'batch', text: 'archiving' },
      ],
      ['scheduled action'],
    );
    expect(badges.map((badge) => badge.key)).toEqual(['batch']);
  });
});

describe('titleWhenCut', () => {
  const element = (size: { scrollHeight?: number; scrollWidth?: number }, textContent: string | null) => ({
    clientHeight: 60,
    clientWidth: 300,
    scrollHeight: 60,
    scrollWidth: 300,
    ...size,
    textContent,
    title: 'stale',
  });

  it('puts the whole text in the tooltip when the clamp cuts lines or the ellipsis cuts the line', () => {
    const clamped = element({ scrollHeight: 100 }, '  Name (uk):\n  Tee → Oversized   tee ');
    titleWhenCut(clamped);
    expect(clamped.title).toBe('Name (uk): Tee → Oversized tee');
    const ellipsis = element({ scrollWidth: 420 }, null);
    titleWhenCut(ellipsis);
    expect(ellipsis.title).toBe('');
  });

  it('takes the tooltip away when the text fits, a pixel of rounding included', () => {
    const fits = element({ scrollHeight: 61, scrollWidth: 301 }, 'Price');
    titleWhenCut(fits);
    expect(fits.title).toBe('');
  });
});

describe('display helpers', () => {
  it("shows an API key owner's name without the English suffix older entries stored", () => {
    expect(apiKeyOwnerName('Feed Admin (API key)')).toBe('Feed Admin');
    expect(apiKeyOwnerName('Feed Admin (api KEY) ')).toBe('Feed Admin');
    expect(apiKeyOwnerName('Feed Admin')).toBe('Feed Admin');
    expect(actorLabelText('api_key', 'Feed Admin (API key)')).toBe('Feed Admin');
    // Only an API key's label loses it: a person may be called anything.
    expect(actorLabelText('admin', 'Bot (API key)')).toBe('Bot (API key)');
    expect(actorLabelText('admin', null)).toBeUndefined();
    expect(actorLabelText('admin', '')).toBeUndefined();
  });

  it("marks an API key's owner in the «Who» filter once, in the dashboard's language", () => {
    expect(actorOptionLabel({ type: 'api_key', label: 'Feed Admin (API key)' }, 'API-ключ')).toBe(
      'Feed Admin (API-ключ)',
    );
    expect(actorOptionLabel({ type: 'api_key', label: 'Feed Admin' }, 'API key')).toBe('Feed Admin (API key)');
    expect(actorOptionLabel({ type: 'admin', label: 'Іван Петренко' }, 'API-ключ')).toBe('Іван Петренко');
  });

  it('capitalizes the first letter only', () => {
    expect(capitalizeFirst('оновлено')).toBe('Оновлено');
    expect(capitalizeFirst('collection contents updated')).toBe('Collection contents updated');
    expect(capitalizeFirst('')).toBe('');
  });

  it('splits a trailing code off a label', () => {
    expect(splitTrailingCode('Oversize tee S (TS-OVS-BLK-S)')).toEqual({
      name: 'Oversize tee S',
      code: 'TS-OVS-BLK-S',
    });
    expect(splitTrailingCode('Oversize tee')).toEqual({ name: 'Oversize tee' });
    expect(splitTrailingCode('(only code)')).toEqual({ name: '(only code)' });
    expect(splitTrailingCode('Tee ()')).toEqual({ name: 'Tee ()' });
    expect(splitTrailingCode('Tee (a (b))')).toEqual({ name: 'Tee (a (b))' });
  });

  it('formats a file size', () => {
    const plain = (value: number) => String(value);
    expect(formatBytes(70, plain)).toBe('70 B');
    expect(formatBytes(1536, plain)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024, plain)).toBe('5 MB');
  });

  it('puts what names a created entity first', () => {
    expect(orderCreatedKeys(['assets', 'enabled', 'description.en', 'slug.en', 'name.en', 'sku'])).toEqual([
      'name.en',
      'sku',
      'slug.en',
      'enabled',
      'assets',
      'description.en',
    ]);
  });

  it('labels the ids of a reference change', () => {
    expect(refLabel({ 2: 'Color: White' }, '2')).toBe('Color: White');
    expect(refLabel(undefined, '12')).toBe('#12');
    expect(refLabel({}, 'lookbook')).toBe('lookbook');
  });

  it('tells a missing permission from a broken request', () => {
    expect(isForbiddenError(new Error('You are not currently authorized to perform this action'))).toBe(true);
    expect(isForbiddenError({ response: { errors: [{ extensions: { code: 'FORBIDDEN' } }] } })).toBe(true);
    expect(isForbiddenError(new Error('Failed to fetch'))).toBe(false);
    expect(isForbiddenError(undefined)).toBe(false);
  });

  it('finds a text the line already shows, whole or as the start of a longer one', () => {
    expect(repeatsShown('Відкладена дія', ['Відкладена дія #3'])).toBe(true);
    expect(repeatsShown('відкладена  дія', ['Відкладена дія'])).toBe(true);
    expect(repeatsShown('Super Admin', ['Відкладена дія #3'])).toBe(false);
    expect(repeatsShown('Відкладена', ['Відкладенадія'])).toBe(false);
    expect(repeatsShown(' ', ['x'])).toBe(false);
  });
});

describe('the rich-text diff', () => {
  it('marks the changed words', () => {
    const { from, to } = wordDiff('dense 220 g cotton', 'dense 240 g cotton. Pre-shrunk');
    expect(from.filter((word) => word.changed).map((word) => word.text)).toEqual(['220', 'cotton']);
    expect(to.filter((word) => word.changed).map((word) => word.text)).toEqual(['240', 'cotton.', 'Pre-shrunk']);
  });

  it('reads a change of markup as plain text, once per change', () => {
    const change = { kind: 'richtext', from: '<p>A <b>220</b> tee</p>', to: '<p>A 240 tee</p>' };
    const diff = richTextDiff(change);
    expect(richTextDiff(change)).toBe(diff);
    expect(diff.to.filter((word) => word.changed).map((word) => word.text)).toEqual(['240']);
    expect(richTextDiff({ kind: 'richtext', from: null, to: '<p>New</p>' }).to).toEqual([
      { text: 'New', changed: true },
    ]);
  });

  it('keeps the words around each change and leaves long unchanged stretches out', () => {
    const words = (marks: string) => [...marks].map((mark, index) => ({ text: String(index), changed: mark === 'x' }));
    const texts = (segments: ReturnType<typeof diffWindow>) =>
      segments.map((segment) => ('gap' in segment ? '…' : segment.text)).join(' ');
    expect(texts(diffWindow(words('.........x.........'), 2))).toBe('… 7 8 9 10 11 …');
    // A gap shorter than four words is not worth a «…».
    expect(texts(diffWindow(words('x....x'), 1))).toBe('0 1 2 3 4 5');
    expect(texts(diffWindow(words('x......x'), 1))).toBe('0 1 … 6 7');
    // Without a change: the start.
    expect(texts(diffWindow(words('......'), 1))).toBe('0 1 …');
    expect(diffWindow([], 3)).toEqual([]);
  });
});

describe('configurable operations', () => {
  const filters = [
    {
      code: 'facet-value-filter',
      args: [
        { name: 'facetValueIds', value: '["1","2"]' },
        { name: 'containsAny', value: 'true' },
      ],
    },
  ];

  it('recognises a list of operations', () => {
    expect(isOperationList(filters)).toBe(true);
    expect(isOperationList([])).toBe(false);
    expect(isOperationList([{ code: 'x' }])).toBe(false);
    expect(isOperationList([{ code: 'x', args: [{ value: 1 }] }])).toBe(false);
    expect(isOperationList({ code: 'x', args: [] })).toBe(false);
  });

  it('reads as a title and an indented line per argument', () => {
    const labelled = withFacetValueLabels(filters, { 1: 'Color: Black', 2: 'Color: White' });
    expect(isOperationList(labelled)).toBe(true);
    const lines = operationLines(isOperationList(labelled) ? labelled : [], (op) => ({
      title: op.code,
      args: op.args.map((arg): [string, string] => [arg.name, String(arg.value)]),
    }));
    expect(lines).toEqual([
      'facet-value-filter',
      '    facetValueIds: Color: Black,Color: White',
      '    containsAny: true',
    ]);
    expect(operationLines(null, () => ({ title: '', args: [] }))).toEqual([]);
  });

  it('fills the placeholders of a description', () => {
    expect(fillDescription('If order total is greater than { amount }', { amount: '1 500,00 ₴', tax: 'No' })).toEqual({
      text: 'If order total is greater than 1 500,00 ₴',
      used: ['amount'],
    });
    expect(fillDescription('Buy {minimum} of {other}', { minimum: '2' })).toEqual({
      text: 'Buy 2 of {other}',
      used: ['minimum'],
    });
  });

  it('reads a list argument', () => {
    expect(argumentList('["1","2"]')).toEqual(['1', '2']);
    expect(argumentList(['a'])).toEqual(['a']);
    expect(argumentList('[oops')).toBeUndefined();
    expect(argumentList('{"a":1}')).toBeUndefined();
    expect(argumentList('[1')).toBeUndefined();
    expect(argumentList(3)).toBeUndefined();
  });
});
