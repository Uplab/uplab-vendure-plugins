import { describe, expect, it } from 'vitest';
import { countSegments } from './segments';

describe('countSegments', () => {
  describe('GSM-7', () => {
    it('counts a plain Latin message', () => {
      expect(countSegments('Your code is 1234')).toEqual({
        encoding: 'GSM-7',
        length: 17,
        segments: 1,
        remaining: 143,
      });
    });

    it('fits 160 characters in one segment', () => {
      expect(countSegments('a'.repeat(160))).toMatchObject({ segments: 1, remaining: 0 });
    });

    it('drops to 153 per segment once the message is concatenated', () => {
      expect(countSegments('a'.repeat(161))).toMatchObject({ segments: 2, length: 161, remaining: 145 });
      expect(countSegments('a'.repeat(306))).toMatchObject({ segments: 2, remaining: 0 });
      expect(countSegments('a'.repeat(307))).toMatchObject({ segments: 3 });
    });

    it('bills an extension-table character as two septets', () => {
      expect(countSegments('€')).toMatchObject({ encoding: 'GSM-7', length: 2 });
      expect(countSegments('a'.repeat(159) + '{')).toMatchObject({ length: 161, segments: 2 });
    });

    it('reports an empty message as costing nothing', () => {
      expect(countSegments('')).toEqual({ encoding: 'GSM-7', length: 0, segments: 0, remaining: 160 });
    });
  });

  describe('UCS-2', () => {
    it('switches encoding as soon as one character falls outside GSM-7', () => {
      expect(countSegments('Ваш код 1234')).toEqual({
        encoding: 'UCS-2',
        length: 12,
        segments: 1,
        remaining: 58,
      });
    });

    it('fits only 70 characters in one segment', () => {
      expect(countSegments('я'.repeat(70))).toMatchObject({ segments: 1, remaining: 0 });
      expect(countSegments('я'.repeat(71))).toMatchObject({ segments: 2, remaining: 63 });
    });

    it('makes a mostly-Latin message expensive if it has one Cyrillic character', () => {
      // The whole message is re-encoded, so 75 characters cost two segments, not one.
      expect(countSegments('a'.repeat(74) + 'я')).toMatchObject({ encoding: 'UCS-2', segments: 2 });
    });

    it('bills a character outside the BMP as two code units', () => {
      expect(countSegments('🙂')).toMatchObject({ encoding: 'UCS-2', length: 2 });
    });
  });
});
