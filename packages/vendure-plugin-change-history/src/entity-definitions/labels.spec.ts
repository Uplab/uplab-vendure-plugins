import { FacetValue, LanguageCode, RequestContext } from '@vendure/core';
import type { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { labelsOf, pickTranslation } from './labels';

const ctx = { languageCode: 'uk', channel: { defaultLanguageCode: 'en' } } as unknown as RequestContext;

const translation = (languageCode: string, name: string) => ({ languageCode: languageCode as LanguageCode, name });

/** A manager whose repository returns `rows`, with the given relations on the entity and on its parent. */
function fakeManager(
  rows: Array<Record<string, unknown>>,
  metadata: { translated?: boolean; parent?: 'translated' | 'plain' | 'missing' } = {},
) {
  const find = vi.fn(async () => structuredClone(rows));
  const manager = {
    getRepository: () => ({ find }),
    connection: {
      getMetadata: () => ({
        relations: metadata.translated === false ? [] : [{ propertyName: 'translations' }],
        findRelationWithPropertyPath: () =>
          metadata.parent === 'missing'
            ? undefined
            : {
                inverseEntityMetadata: {
                  relations: metadata.parent === 'plain' ? [] : [{ propertyName: 'translations' }],
                },
              },
      }),
    },
  } as unknown as EntityManager;
  return { manager, find };
}

describe('pickTranslation', () => {
  it("prefers the request language, then the channel's default language, then the first one", () => {
    const uk = translation('uk', 'Сорочка');
    const en = translation('en', 'Shirt');
    const de = translation('de', 'Hemd');
    expect(pickTranslation([en, uk], ctx)).toBe(uk);
    expect(pickTranslation([de, en], ctx)).toBe(en);
    expect(pickTranslation([de], ctx)).toBe(de);
    expect(pickTranslation([de], { languageCode: 'fr' } as unknown as RequestContext)).toBe(de);
    expect(pickTranslation([], ctx)).toBeUndefined();
    expect(pickTranslation(undefined, ctx)).toBeUndefined();
  });
});

describe('labelsOf', () => {
  it('queries nothing for no ids', async () => {
    const { manager, find } = fakeManager([]);
    expect(await labelsOf(ctx, manager, FacetValue, [])).toEqual({});
    expect(find).not.toHaveBeenCalled();
  });

  it('labels by the translated name, else name / code / identifier / sku, and skips rows without any', async () => {
    const { manager, find } = fakeManager(
      [
        { id: 1, translations: [translation('en', 'Red')] },
        { id: 2, translations: [translation('en', '')], name: 'Blue' },
        { id: 3, code: 'green' },
        { id: 4, identifier: 'img.png' },
        { id: 5, sku: 'SH-1' },
        { id: 6, name: '', code: 42 },
      ],
      { translated: false },
    );
    expect(await labelsOf(ctx, manager, FacetValue, ['1', '2', '3', '4', '5', '6', '1'])).toEqual({
      '1': 'Red',
      '2': 'Blue',
      '3': 'green',
      '4': 'img.png',
      '5': 'SH-1',
    });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ relations: [] }));
  });

  it("prefixes the parent's name, or leaves it off when the parent is missing or nameless", async () => {
    const { manager, find } = fakeManager(
      [
        { id: 1, name: 'Red', facet: { id: 9, translations: [translation('uk', 'Колір')] } },
        { id: 2, name: 'Blue' },
        { id: 3, name: 'Green', facet: { id: 9 } },
      ],
      { parent: 'plain' },
    );
    expect(await labelsOf(ctx, manager, FacetValue, ['1', '2', '3'], 'facet')).toEqual({
      '1': 'Колір: Red',
      '2': 'Blue',
      '3': 'Green',
    });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ relations: ['translations', 'facet'] }));
  });

  it('loads no parent translations for an unknown parent relation', async () => {
    const { manager, find } = fakeManager([{ id: 1, name: 'Red' }], { parent: 'missing' });
    expect(await labelsOf(ctx, manager, FacetValue, ['1'], 'facet')).toEqual({ '1': 'Red' });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ relations: ['translations', 'facet'] }));
  });
});
