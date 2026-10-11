import { describe, expect, it } from 'vitest';
import { ChangeHistoryValueKind } from '../types';
import { changesSummary, diffStates, idsOfChange, stableStringify } from './diff';
import { capState, capValue } from './truncate';

const kinds: Record<string, ChangeHistoryValueKind> = {
  facetValues: 'refs',
  assets: 'assets',
  prices: 'prices',
  'customFields.dims': 'json',
};
const options = { kindOf: (key: string) => kinds[key] ?? 'text', maxValueBytes: 64 };

describe('diffStates', () => {
  it('lists only changed scalars, with from and to', () => {
    expect(
      diffStates(
        { enabled: true, 'name.en': 'Shirt', sku: 'A' },
        { enabled: false, 'name.en': 'Shirt', sku: 'A' },
        options,
      ),
    ).toEqual({ enabled: { kind: 'text', from: true, to: false } });
  });

  it('treats a missing key, null and undefined as the same "no value"', () => {
    expect(diffStates({ a: null, b: undefined }, { c: null }, options)).toEqual({});
    expect(diffStates({}, { 'name.uk': 'Сорочка' }, options)).toEqual({
      'name.uk': { kind: 'text', from: null, to: 'Сорочка' },
    });
    expect(diffStates({ 'name.de': 'Hemd' }, {}, options)).toEqual({
      'name.de': { kind: 'text', from: 'Hemd', to: null },
    });
  });

  it('keeps false and 0 as values', () => {
    expect(diffStates({}, { enabled: false, threshold: 0 }, options)).toEqual({
      enabled: { kind: 'text', from: null, to: false },
      threshold: { kind: 'text', from: null, to: 0 },
    });
  });

  it('compares id sets by membership: added and removed ids only', () => {
    expect(diffStates({ facetValues: ['1', '2'] }, { facetValues: ['2', '1'] }, options)).toEqual({});
    expect(diffStates({ facetValues: ['1', '7'] }, { facetValues: ['1', '12'] }, options)).toEqual({
      facetValues: { kind: 'refs', added: ['12'], removed: ['7'] },
    });
    expect(diffStates({}, { facetValues: ['3'] }, options)).toEqual({
      facetValues: { kind: 'refs', added: ['3'], removed: [] },
    });
    expect(diffStates({ facetValues: null }, { facetValues: [] }, options)).toEqual({});
  });

  it('records the order of ordered id lists', () => {
    expect(diffStates({ assets: ['55', '56'] }, { assets: ['55', '56'] }, options)).toEqual({});
    expect(diffStates({ assets: ['55', '56'] }, { assets: ['56', '55', '91'] }, options)).toEqual({
      assets: {
        kind: 'assets',
        from: ['55', '56'],
        to: ['56', '55', '91'],
        added: ['91'],
        removed: [],
        reordered: true,
      },
    });
    expect(diffStates({ assets: ['55', '56'] }, { assets: ['55'] }, options).assets).toMatchObject({
      removed: ['56'],
      reordered: false,
    });
  });

  it('compares structured values by content, not key order', () => {
    expect(
      diffStates({ 'customFields.dims': { w: 1, h: 2 } }, { 'customFields.dims': { h: 2, w: 1 } }, options),
    ).toEqual({});
    expect(
      diffStates(
        { prices: [{ channelId: '1', currencyCode: 'UAH', price: 100 }] },
        { prices: [{ channelId: '1', currencyCode: 'UAH', price: 120 }] },
        options,
      ),
    ).toEqual({
      prices: {
        kind: 'prices',
        from: [{ channelId: '1', currencyCode: 'UAH', price: 100 }],
        to: [{ channelId: '1', currencyCode: 'UAH', price: 120 }],
      },
    });
  });

  it('caps long values per side and says so', () => {
    const long = 'x'.repeat(200);
    const change = diffStates({ 'description.en': 'short' }, { 'description.en': long }, options)['description.en'];
    expect(change.from).toBe('short');
    expect(change.truncated).toBe(true);
    expect(Buffer.byteLength(change.to as string)).toBeLessThanOrEqual(64);
  });

  it('compares only the included keys', () => {
    expect(
      diffStates(
        { a: 1, facetValues: ['1'] },
        { a: 2, facetValues: [] },
        { ...options, include: (key) => key === 'a' },
      ),
    ).toEqual({ a: { kind: 'text', from: 1, to: 2 } });
  });

  it('sorts the changed keys', () => {
    expect(Object.keys(diffStates({}, { b: 1, a: 1, c: 1 }, options))).toEqual(['a', 'b', 'c']);
  });
});

describe('changesSummary', () => {
  it('names the changed fields', () => {
    expect(changesSummary({ enabled: {}, 'name.en': {}, prices: {} })).toBe('3 fields: enabled, name.en, prices');
    expect(changesSummary({ sku: {} })).toBe('1 field: sku');
  });
});

describe('idsOfChange', () => {
  it('collects every id a change refers to', () => {
    expect(idsOfChange({ added: ['1'], removed: ['2'] }).sort()).toEqual(['1', '2']);
    expect(idsOfChange({ from: '5', to: null })).toEqual(['5']);
    expect(idsOfChange({ from: ['5', '6'], to: ['6', '7'], added: ['7'], removed: ['5'] }).sort()).toEqual([
      '5',
      '6',
      '7',
    ]);
  });
});

describe('stableStringify', () => {
  it('sorts object keys at every level', () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: [{ f: 1, e: 2 }] } })).toBe('{"a":{"c":[{"e":2,"f":1}],"d":1},"b":1}');
  });
});

describe('capValue', () => {
  it('keeps values within the cap', () => {
    expect(capValue('short', 10)).toEqual({ value: 'short', truncated: false });
    expect(capValue(null, 1)).toEqual({ value: null, truncated: false });
    expect(capValue(42, 1)).toEqual({ value: 42, truncated: false });
  });

  it('keeps the head and the tail of a long string without splitting a character', () => {
    const { value, truncated } = capValue(`${'а'.repeat(50)}${'я'.repeat(50)}`, 40);
    expect(truncated).toBe(true);
    expect(value).toMatch(/^а+ … я+$/);
    expect(Buffer.byteLength(value as string)).toBeLessThanOrEqual(40);
  });

  it('shortens a long structured value as JSON', () => {
    const { value, truncated } = capValue({ list: Array.from({ length: 50 }, (_, i) => i) }, 30);
    expect(truncated).toBe(true);
    expect(value).toMatch(/^\{"list":\[0,1.* … .*49\]\}$/);
  });

  it('caps every value of a state', () => {
    expect(capState({ a: 'x'.repeat(100), b: 1 }, 20)).toEqual({ a: expect.stringContaining(' … '), b: 1 });
  });
});
