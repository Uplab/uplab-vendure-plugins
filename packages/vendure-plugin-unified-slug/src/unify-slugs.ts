/**
 * The rule this plugin holds: **one slug per entity, identical in every language**.
 *
 * This is the whole decision, isolated from Nest, GraphQL and TypeORM so it can be read and tested as
 * what it is — a pure function over "what the client sent" and "what the database already holds".
 * The plumbing that feeds it lives in `unified-slug.interceptor.ts`.
 */

/** The slug-bearing subset of a `ProductTranslationInput` / `CollectionTranslationInput`. */
export interface SlugTranslationInput {
  languageCode: string;
  slug?: string | null;
  [key: string]: unknown;
}

/** One `product_translation` / `collection_translation` row, reduced to the two columns that matter. */
export interface ExistingSlugRow {
  languageCode: string;
  slug?: string | null;
}

/** A translation input appended for a language the client did not send. Only the slug is touched. */
export interface AppendedSlugTranslation extends SlugTranslationInput {
  slug: string;
}

/** Whitespace is not a slug. `'  '` is as empty as `''` and `null`. */
function nonEmpty(slug: string | null | undefined): string | undefined {
  const trimmed = typeof slug === 'string' ? slug.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Picks the one slug the entity will carry, in this order:
 *
 * - **(a)** the input translation for the channel default language, if it carries a non-empty slug;
 * - **(b)** the first input translation with a non-empty slug, in input order;
 * - **(c)** *update only* — the existing row for the channel default language, else the first
 *   non-empty existing row in `languageCode` order;
 * - **(d)** nothing → `undefined`.
 *
 * Never invents a slug. When every candidate is empty the input is handed to the core resolver
 * untouched, and core validation decides what an empty slug means.
 */
function pickCanonicalSlug(
  inputTranslations: readonly SlugTranslationInput[],
  existingRows: readonly ExistingSlugRow[],
  channelDefaultLanguageCode: string | undefined,
): string | undefined {
  const fromDefaultLanguageInput = inputTranslations.find((t) => t.languageCode === channelDefaultLanguageCode);
  const a = nonEmpty(fromDefaultLanguageInput?.slug);
  if (a) {
    return a;
  }
  for (const translation of inputTranslations) {
    const b = nonEmpty(translation.slug);
    if (b) {
      return b;
    }
  }
  const fromDefaultLanguageRow = existingRows.find((row) => row.languageCode === channelDefaultLanguageCode);
  const c = nonEmpty(fromDefaultLanguageRow?.slug);
  if (c) {
    return c;
  }
  for (const row of [...existingRows].sort((x, y) => x.languageCode.localeCompare(y.languageCode))) {
    const fallback = nonEmpty(row.slug);
    if (fallback) {
      return fallback;
    }
  }
  return undefined;
}

/**
 * Returns the translations array that should replace the client's, or `null` for "nothing to change".
 *
 * Two things happen, both driven by the single canonical slug:
 *
 * 1. **Every** input translation is given `slug = canonical` — including ones that arrived with a
 *    *different* non-empty slug. The invariant is one slug, always; a per-language slug is not a
 *    feature this plugin supports, so a divergent one is a mistake to correct, not intent to honour.
 * 2. *Update only* — for every existing row whose language the client did not send and whose slug
 *    differs from the canonical one, a `{ languageCode, slug }` translation is appended. That is a
 *    slug-only patch of an existing row (see the interceptor's doc comment for why it cannot blank
 *    the row's other columns).
 *
 * `existingRows` is empty on create, which is exactly what makes rule (c) "update only" without a
 * separate flag.
 */
export function unifySlugs<T extends SlugTranslationInput>(
  inputTranslations: readonly T[] | null | undefined,
  existingRows: readonly ExistingSlugRow[],
  channelDefaultLanguageCode: string | undefined,
): Array<T | AppendedSlugTranslation> | null {
  if (!inputTranslations) {
    return null;
  }
  const canonical = pickCanonicalSlug(inputTranslations, existingRows, channelDefaultLanguageCode);
  if (!canonical) {
    return null;
  }

  let changed = false;
  const result: Array<T | AppendedSlugTranslation> = inputTranslations.map((translation) => {
    if (translation.slug === canonical) {
      return translation;
    }
    changed = true;
    return { ...translation, slug: canonical };
  });

  const inputLanguages = new Set(inputTranslations.map((t) => t.languageCode));
  for (const row of existingRows) {
    if (inputLanguages.has(row.languageCode) || row.slug === canonical) {
      continue;
    }
    changed = true;
    result.push({ languageCode: row.languageCode, slug: canonical });
  }

  return changed ? result : null;
}
