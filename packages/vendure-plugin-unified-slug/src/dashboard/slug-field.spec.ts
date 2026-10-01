import { describe, expect, it } from 'vitest';
import {
  buildStrategyContext,
  displayedSlug,
  findLanguageIndex,
  indexFromFieldName,
  isRowDirty,
  isRowInPlay,
  nonEmpty,
  pickNameSource,
} from './slug-field';

describe('slug-field', () => {
  describe('nonEmpty', () => {
    it('trims, and treats blank and non-string values as empty', () => {
      expect(nonEmpty('  dresses ')).toBe('dresses');
      expect(nonEmpty('   ')).toBeUndefined();
      expect(nonEmpty('')).toBeUndefined();
      expect(nonEmpty(null)).toBeUndefined();
      expect(nonEmpty(undefined)).toBeUndefined();
    });
  });

  describe('isRowDirty', () => {
    it('finds a true anywhere in the dirty tree', () => {
      expect(isRowDirty({ name: true })).toBe(true);
      expect(isRowDirty({ customFields: { brand: true } })).toBe(true);
      expect(isRowDirty({ name: false, customFields: { brand: false } })).toBe(false);
      expect(isRowDirty({})).toBe(false);
      expect(isRowDirty(undefined)).toBe(false);
      expect(isRowDirty(true)).toBe(true);
    });
  });

  describe('indexFromFieldName', () => {
    it('reads the translation row index the form engine put in the field name', () => {
      expect(indexFromFieldName('translations.2.slug')).toBe(2);
      expect(indexFromFieldName('translations.0.slug')).toBe(0);
    });

    it('answers -1 for a field outside the translations array', () => {
      expect(indexFromFieldName('slug')).toBe(-1);
      expect(indexFromFieldName('customFields.translations.1.slug')).toBe(-1);
      expect(indexFromFieldName(undefined)).toBe(-1);
    });
  });

  describe('findLanguageIndex', () => {
    const rows = [{ languageCode: 'uk' }, { languageCode: 'en' }];

    it('finds the row of a language', () => {
      expect(findLanguageIndex(rows, 'en')).toBe(1);
    });

    it('answers -1 for an unknown or absent language', () => {
      expect(findLanguageIndex(rows, 'pl')).toBe(-1);
      expect(findLanguageIndex(rows, undefined)).toBe(-1);
    });
  });

  describe('displayedSlug', () => {
    it('prefers the channel default language’s slug', () => {
      expect(displayedSlug([{ slug: 'sukni' }, { slug: 'dresses' }], 1)).toBe('dresses');
    });

    it('falls back to the first non-empty slug, trimmed', () => {
      expect(displayedSlug([{ slug: '' }, { slug: ' sukni ' }, { slug: 'dresses' }], 0)).toBe('sukni');
      expect(displayedSlug([{ slug: '' }, { slug: 'sukni' }], -1)).toBe('sukni');
    });

    it('answers an empty string when no row carries a slug', () => {
      expect(displayedSlug([{ slug: '' }, { slug: null }], 0)).toBe('');
      expect(displayedSlug([], -1)).toBe('');
    });
  });

  describe('pickNameSource', () => {
    it('takes the channel default language’s name', () => {
      expect(pickNameSource([{ name: 'Сукні' }, { name: 'Dresses' }], 1, 0)).toEqual({ index: 1, name: 'Dresses' });
    });

    it('falls back to the tab being edited when the default language has no name yet', () => {
      expect(pickNameSource([{ name: 'Сукні' }, { name: '' }], 1, 0)).toEqual({ index: 0, name: 'Сукні' });
      expect(pickNameSource([{ name: 'Сукні' }], -1, 0)).toEqual({ index: 0, name: 'Сукні' });
    });

    it('answers an empty name when neither has one', () => {
      expect(pickNameSource([{ name: '  ' }, { name: null }], 1, 0)).toEqual({ index: 0, name: '' });
      expect(pickNameSource([], -1, -1)).toEqual({ index: -1, name: '' });
    });
  });

  describe('isRowInPlay', () => {
    it('includes the tab being edited', () => {
      expect(isRowInPlay({ languageCode: 'uk' }, 0, 0, undefined)).toBe(true);
    });

    it('includes a row saved in the database', () => {
      expect(isRowInPlay({ id: '7', languageCode: 'en' }, 1, 0, undefined)).toBe(true);
    });

    it('includes a row the admin has typed into', () => {
      expect(isRowInPlay({ languageCode: 'pl' }, 2, 0, { name: true })).toBe(true);
    });

    it('leaves an untouched seeded row alone', () => {
      expect(isRowInPlay({ languageCode: 'pl', id: null }, 2, 0, { name: false })).toBe(false);
      expect(isRowInPlay(undefined, 2, 0, undefined)).toBe(false);
    });
  });

  describe('buildStrategyContext', () => {
    it('keys the watched values by their form path', () => {
      expect(buildStrategyContext(['customFields.brand', 'customFields.colour'], ['acme', 'red'])).toEqual({
        'customFields.brand': 'acme',
        'customFields.colour': 'red',
      });
    });

    it('sends null for a value the form does not have yet', () => {
      expect(buildStrategyContext(['customFields.brand'], undefined)).toEqual({ 'customFields.brand': null });
      expect(buildStrategyContext(['customFields.brand'], [undefined])).toEqual({ 'customFields.brand': null });
    });

    it('is empty when nothing is watched', () => {
      expect(buildStrategyContext([], undefined)).toEqual({});
    });
  });
});
