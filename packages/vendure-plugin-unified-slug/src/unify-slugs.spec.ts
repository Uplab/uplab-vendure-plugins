import { describe, expect, it } from 'vitest';
import { unifySlugs } from './unify-slugs';

// The channel default language.
const EN = 'en';

const t = (languageCode: string, slug?: string | null, name = `name-${languageCode}`) => ({ languageCode, slug, name });

describe('unifySlugs', () => {
  describe('picking the canonical slug', () => {
    it('(a) prefers the input translation for the channel default language', () => {
      const result = unifySlugs([t('uk', 'sukni'), t('en', 'dresses'), t('pl', 'sukienki')], [], EN);
      expect(result?.map((r) => r.slug)).toEqual(['dresses', 'dresses', 'dresses']);
    });

    it('(b) falls back to the first non-empty input slug, in input order', () => {
      // The real create path: the admin fills the `uk` tab, `en` is seeded empty.
      const result = unifySlugs([t('en', ''), t('uk', 'sukni'), t('pl', 'sukienki')], [], EN);
      expect(result?.map((r) => r.slug)).toEqual(['sukni', 'sukni', 'sukni']);
    });

    it('(c) falls back to the existing default-language row, then to the first existing row by language', () => {
      // `en` is the default language, so its row wins over the `uk` row that comes first in the list.
      const fromDefaultRow = unifySlugs(
        [t('pl', '')],
        [
          { languageCode: 'uk', slug: 'sukni' },
          { languageCode: 'en', slug: 'dresses' },
        ],
        EN,
      );
      expect(fromDefaultRow?.map((r) => r.slug)).toEqual(['dresses', 'dresses']);

      // No `en` row at all: `languageCode` order, so `pl` wins over `uk`.
      const fromFirstRow = unifySlugs(
        [t('en', '')],
        [
          { languageCode: 'uk', slug: 'sukni' },
          { languageCode: 'pl', slug: 'sukienki' },
        ],
        EN,
      );
      expect(fromFirstRow?.map((r) => r.slug)).toEqual(['sukienki', 'sukienki']);
    });

    it('(d) leaves the input alone when nothing anywhere carries a slug — never invents one', () => {
      expect(unifySlugs([t('en', ''), t('uk', null)], [{ languageCode: 'pl', slug: '' }], EN)).toBeNull();
    });

    it('ignores the default-language preference when the request has no channel context', () => {
      const result = unifySlugs([t('uk', 'sukni'), t('en', 'dresses')], [], undefined);
      expect(result?.map((r) => r.slug)).toEqual(['sukni', 'sukni']);
    });
  });

  describe('applying it', () => {
    it('overwrites a translation that carried a different non-empty slug', () => {
      const result = unifySlugs([t('en', 'dresses'), t('uk', 'plattya')], [], EN);
      expect(result?.map((r) => r.slug)).toEqual(['dresses', 'dresses']);
    });

    it('keeps every other field of the input translations', () => {
      const result = unifySlugs([t('en', 'dresses'), t('uk', '', 'Сукні')], [], EN);
      expect(result?.[1]).toEqual({ languageCode: 'uk', slug: 'dresses', name: 'Сукні' });
    });

    it('appends a slug-only translation for each existing row the client did not send', () => {
      // `uk` created first, `pl` added later with an empty slug.
      const result = unifySlugs(
        [t('uk', 'sukni')],
        [
          { languageCode: 'uk', slug: 'sukni' },
          { languageCode: 'pl', slug: '' },
        ],
        EN,
      );
      expect(result).toEqual([
        { languageCode: 'uk', slug: 'sukni', name: 'name-uk' },
        { languageCode: 'pl', slug: 'sukni' },
      ]);
    });

    it('does not append a row that already carries the canonical slug', () => {
      const result = unifySlugs([t('uk', 'sukni')], [{ languageCode: 'en', slug: 'sukni' }], EN);
      expect(result).toBeNull();
    });

    it('returns null when every input translation already carries the canonical slug', () => {
      expect(
        unifySlugs([t('en', 'dresses'), t('uk', 'dresses')], [{ languageCode: 'en', slug: 'dresses' }], EN),
      ).toBeNull();
    });

    it('returns null for an absent translations array', () => {
      expect(unifySlugs(undefined, [{ languageCode: 'en', slug: 'dresses' }], EN)).toBeNull();
      expect(unifySlugs(null, [], EN)).toBeNull();
    });

    it('does not mutate the input', () => {
      const input = [t('en', 'dresses'), t('uk', 'plattya')];
      unifySlugs(input, [], EN);
      expect(input.map((r) => r.slug)).toEqual(['dresses', 'plattya']);
    });
  });

  describe('whitespace', () => {
    it('treats a whitespace-only slug as empty, on both sides', () => {
      const result = unifySlugs([t('en', '   '), t('uk', 'sukni')], [{ languageCode: 'pl', slug: '  ' }], EN);
      expect(result).toEqual([
        { languageCode: 'en', slug: 'sukni', name: 'name-en' },
        { languageCode: 'uk', slug: 'sukni', name: 'name-uk' },
        { languageCode: 'pl', slug: 'sukni' },
      ]);
    });

    it('trims the canonical slug it adopts', () => {
      const result = unifySlugs([t('en', '  dresses  '), t('uk', '')], [], EN);
      expect(result?.map((r) => r.slug)).toEqual(['dresses', 'dresses']);
    });
  });
});
