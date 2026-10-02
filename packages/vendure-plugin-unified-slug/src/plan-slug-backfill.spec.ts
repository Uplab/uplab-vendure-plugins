import { describe, expect, it, vi } from 'vitest';
import { type BackfillEntity, planSlugBackfill } from './plan-slug-backfill';

const EN = 'en';

let nextRowId = 1;
const entity = (id: number, slugs: Record<string, string>, names: Record<string, string> = {}): BackfillEntity => ({
  id,
  rows: Object.entries(slugs).map(([languageCode, slug]) => ({
    id: nextRowId++,
    languageCode,
    slug,
    name: names[languageCode] ?? null,
  })),
});
const noGeneration = vi.fn(async () => '');

describe('planSlugBackfill', () => {
  it('skips entities already on one slug', async () => {
    await expect(planSlugBackfill([entity(1, { en: 'dress', uk: 'dress' })], EN, noGeneration)).resolves.toEqual([]);
  });

  it('fills empty slugs from a sibling, touching only those rows', async () => {
    const e = entity(1, { en: 'dress', uk: '' });
    const [entry] = await planSlugBackfill([e], EN, noGeneration);

    expect(entry).toMatchObject({ outcome: 'FILLED', slug: 'dress', rowIds: [e.rows[1].id], conflictsWith: [] });
    expect(entry.previousSlugs).toEqual([
      { languageCode: 'en', slug: 'dress' },
      { languageCode: 'uk', slug: '' },
    ]);
  });

  it('rewrites a divergent slug to the channel default language’s, the interceptor’s rule', async () => {
    const e = entity(1, { en: 'dress', uk: 'sukni' });
    const [entry] = await planSlugBackfill([e], EN, noGeneration);

    expect(entry).toMatchObject({ outcome: 'REWRITTEN', slug: 'dress', rowIds: [e.rows[1].id] });
  });

  it('generates a slug from the default-language name when no row has one', async () => {
    const generate = vi.fn(async () => 'summer-dress');
    const e = entity(7, { uk: '', en: '' }, { uk: 'Сукня', en: 'Summer dress' });
    const [entry] = await planSlugBackfill([e], EN, generate);

    expect(generate).toHaveBeenCalledWith(7, e.rows[1]);
    expect(entry).toMatchObject({ outcome: 'GENERATED', slug: 'summer-dress', rowIds: e.rows.map((r) => r.id) });
  });

  it('falls back to any name, and reports NO_SLUG when nothing can be generated', async () => {
    const e = entity(7, { en: '', uk: '' }, { uk: '***' });
    const [entry] = await planSlugBackfill([e], EN, noGeneration);

    expect(noGeneration).toHaveBeenCalledWith(7, e.rows[1]);
    expect(entry).toMatchObject({ outcome: 'NO_SLUG', slug: null, rowIds: [] });
  });

  it('reports a conflict when another entity keeps the slug in that language, and writes nothing', async () => {
    const [entry] = await planSlugBackfill(
      [entity(1, { en: 'dress', uk: '' }), entity(2, { uk: 'dress' })],
      EN,
      noGeneration,
    );

    expect(entry).toMatchObject({ entityId: 1, outcome: 'CONFLICT', slug: 'dress', conflictsWith: ['2'], rowIds: [] });
  });

  it('does not count a slug the run rewrites away, even when its owner comes later', async () => {
    const one = entity(1, { en: 'dress', uk: '' });
    const two = entity(2, { en: 'gown', uk: 'dress' });
    const entries = await planSlugBackfill([one, two], EN, noGeneration);

    expect(entries.map((e) => [e.entityId, e.outcome, e.rowIds])).toEqual([
      [1, 'FILLED', [one.rows[1].id]],
      [2, 'REWRITTEN', [two.rows[1].id]],
    ]);
  });

  it('reports both sides when two entities block each other', async () => {
    const entries = await planSlugBackfill(
      [entity(1, { en: 'dress', uk: '' }), entity(2, { en: '', uk: 'dress' })],
      EN,
      noGeneration,
    );

    expect(entries.map((e) => [e.outcome, e.conflictsWith])).toEqual([
      ['CONFLICT', ['2']],
      ['CONFLICT', ['1']],
    ]);
  });

  it('lets the first entity claim a slug two entities would both write in the same run', async () => {
    const entries = await planSlugBackfill(
      [entity(1, { en: '', uk: 'hat' }), entity(2, { en: '', pl: 'hat' })],
      EN,
      noGeneration,
    );

    expect(entries.map((e) => [e.entityId, e.outcome, e.conflictsWith])).toEqual([
      [1, 'FILLED', []],
      [2, 'CONFLICT', ['1']],
    ]);
  });

  it('checks a generated slug against slugs planned in the same run', async () => {
    const entries = await planSlugBackfill(
      [entity(1, { en: '', uk: 'dress' }), entity(2, { en: '' }, { en: 'Dress' })],
      EN,
      async () => 'dress',
    );

    expect(entries[1]).toMatchObject({ outcome: 'CONFLICT', conflictsWith: ['1'] });
  });
});
