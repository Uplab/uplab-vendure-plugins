import { describe, expect, it } from 'vitest';
import { compactValues } from './compact';
import {
  isBatchHead,
  isDerivedDetailRow,
  isDetailRow,
  isDetailStateValue,
  isDetailValue,
  isKeptDeleted,
  isMemberRow,
  isRunLine,
  valueLength,
} from './rules';

const CAP = 16;
const long = 'x'.repeat(CAP + 1);

describe('retention rules', () => {
  describe('isDetailValue', () => {
    it('strips rich text whatever its length', () => {
      expect(isDetailValue({ kind: 'richtext', from: '<p>a</p>', to: '<p>b</p>' }, CAP)).toBe(true);
    });

    it('strips a text over the cap on either side and keeps one under it', () => {
      expect(isDetailValue({ kind: 'text', from: 'short', to: long }, CAP)).toBe(true);
      expect(isDetailValue({ from: long, to: null }, CAP)).toBe(true);
      expect(isDetailValue({ kind: 'text', from: 'short', to: 'also short' }, CAP)).toBe(false);
      expect(isDetailValue({ kind: 'text', from: null, to: 'short' }, CAP)).toBe(false);
      expect(isDetailValue({ kind: 'text', to: 'short' }, CAP)).toBe(false);
      expect(isDetailValue({ kind: 'text', from: 'short' }, CAP)).toBe(false);
    });

    it('measures bytes, not characters', () => {
      expect(isDetailValue({ kind: 'text', from: 'ї'.repeat(9), to: '' }, CAP)).toBe(true);
    });

    it('never strips json, refs, prices, assets or stock (NQ2)', () => {
      for (const kind of ['json', 'refs', 'prices', 'assets', 'stock']) {
        expect(isDetailValue({ kind, from: long, to: long }, CAP)).toBe(false);
      }
    });

    it('leaves a stripped change and a change without values alone', () => {
      expect(isDetailValue({ kind: 'richtext', stripped: true, fromLength: 3, toLength: 4 }, CAP)).toBe(false);
      expect(isDetailValue({ kind: 'refs', added: ['1'], removed: [] }, CAP)).toBe(false);
      expect(isDetailValue({ kind: 'richtext' }, CAP)).toBe(false);
      expect(isDetailValue(null as never, CAP)).toBe(false);
    });

    it('strips a long non-string value of a scalar kind by its JSON length', () => {
      expect(isDetailValue({ kind: 'text', from: { a: long }, to: null }, CAP)).toBe(true);
    });
  });

  it('isDetailStateValue: only strings over the cap', () => {
    expect(isDetailStateValue(long, CAP)).toBe(true);
    expect(isDetailStateValue('short', CAP)).toBe(false);
    expect(isDetailStateValue([long], CAP)).toBe(false);
  });

  it('valueLength counts characters of a string, else of its JSON', () => {
    expect(valueLength('Футболка')).toBe(8);
    expect(valueLength({ a: 1 })).toBe(7);
    expect(valueLength(null)).toBe(0);
    expect(valueLength(undefined)).toBe(0);
  });

  describe('row rules', () => {
    const derivedUpdate = { entityType: 'ProductVariant', action: 'updated', derivedFromId: 1 };
    const derivedDeletion = { entityType: 'ProductVariant', action: 'deleted', derivedFromId: 1 };
    const member = { entityType: 'Product', action: 'collection_added', derivedFromId: null };
    const own = { entityType: 'Product', action: 'updated', derivedFromId: null };

    it('keeps cascaded deletions, deletes other derived rows and member rows', () => {
      expect(isKeptDeleted(derivedDeletion)).toBe(true);
      expect(isKeptDeleted({ ...own, action: 'deleted' })).toBe(false);
      expect(isDerivedDetailRow(derivedUpdate)).toBe(true);
      expect(isDerivedDetailRow(derivedDeletion)).toBe(false);
      expect(isMemberRow(member)).toBe(true);
      expect(isMemberRow({ ...member, action: 'collection_removed' })).toBe(true);
      expect([derivedUpdate, derivedDeletion, member, own].map(isDetailRow)).toEqual([true, false, true, false]);
    });

    it('recognises run lines and batch heads', () => {
      expect(isRunLine({ entityType: 'Run', action: 'run' })).toBe(true);
      expect(isRunLine(own)).toBe(false);
      expect(isBatchHead({ entityType: 'Batch', action: 'batch' })).toBe(true);
      expect(isBatchHead(own)).toBe(false);
    });
  });
});

describe('compactValues', () => {
  it('replaces detail values by their lengths and keeps everything else', () => {
    const result = compactValues(
      {
        'description.en': { kind: 'richtext', from: '<p>old</p>', to: '<p>newer</p>', truncated: false },
        'name.en': { kind: 'text', from: 'A', to: 'B' },
        filters: { kind: 'json', from: [long], to: [] },
        sku: { from: long, to: 'S' },
      },
      { correlationId: 'c' },
      CAP,
    );
    expect(result).toEqual({
      changes: {
        'description.en': { kind: 'richtext', stripped: true, fromLength: 10, toLength: 12 },
        'name.en': { kind: 'text', from: 'A', to: 'B' },
        filters: { kind: 'json', from: [long], to: [] },
        sku: { stripped: true, fromLength: CAP + 1, toLength: 1 },
      },
      meta: { correlationId: 'c' },
      strippedFields: 2,
      changed: true,
    });
  });

  it('strips long strings of a deleted entity’s last state', () => {
    const result = compactValues(null, { lastState: { name: 'Sock', description: long, tags: [long] } }, CAP);
    expect(result.changes).toBeNull();
    expect(result.meta.lastState).toEqual({
      name: 'Sock',
      description: { stripped: true, length: CAP + 1 },
      tags: [long],
    });
    expect(result.strippedFields).toBe(1);
  });

  it('merges the count snapshot into meta', () => {
    const batchCounts = [{ entityType: 'Product', action: 'collection_added', count: 3 }];
    const result = compactValues(null, { kind: 'collection_rules' }, CAP, { derivedCount: 4, batchCounts });
    expect(result).toMatchObject({
      changed: true,
      strippedFields: 0,
      meta: { kind: 'collection_rules', derivedCount: 4, batchCounts },
    });
  });

  it('changes nothing on an entry without detail values, and is idempotent', () => {
    const plain = compactValues({ enabled: { kind: 'bool', from: true, to: false } }, {}, CAP, {
      derivedCount: 0,
      batchCounts: [],
    });
    expect(plain.changed).toBe(false);

    const once = compactValues({ d: { kind: 'richtext', from: long, to: long } }, { lastState: { d: long } }, CAP);
    const twice = compactValues(once.changes, once.meta, CAP);
    expect(twice).toEqual({ changes: once.changes, meta: once.meta, strippedFields: 0, changed: false });
    expect(compactValues(null, null, CAP).meta).toEqual({});
  });
});
