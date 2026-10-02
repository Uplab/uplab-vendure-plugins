/**
 * The rule: one slug per entity, identical in every language. A pure function over what the client
 * sent and what the database holds; the interceptor feeds it.
 */

/** The slug-bearing subset of a `ProductTranslationInput` / `CollectionTranslationInput`. */
export interface SlugTranslationInput {
  languageCode: string;
  slug?: string | null;
  [key: string]: unknown;
}

/** One translation row, reduced to the two columns that matter. */
export interface ExistingSlugRow {
  languageCode: string;
  slug?: string | null;
}

/** A translation input appended for a language the client did not send. Only the slug is touched. */
export interface AppendedSlugTranslation extends SlugTranslationInput {
  slug: string;
}

/** Whitespace is not a slug. */
function nonEmpty(slug: string | null | undefined): string | undefined {
  const trimmed = typeof slug === 'string' ? slug.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The one slug the entity will carry, in this order: the input translation for the channel default
 * language; the first input translation with a slug; (update only) the existing row for the channel
 * default language, else the first existing row by `languageCode`; otherwise nothing. A slug is
 * never invented — with no candidate the input passes through and core validation decides.
 */
function pickCanonicalSlug(
  inputTranslations: readonly SlugTranslationInput[],
  existingRows: readonly ExistingSlugRow[],
  channelDefaultLanguageCode: string | undefined,
): string | undefined {
  const fromDefaultLanguageInput = inputTranslations.find((t) => t.languageCode === channelDefaultLanguageCode);
  const fromDefaultLanguageRow = existingRows.find((row) => row.languageCode === channelDefaultLanguageCode);
  const candidates = [
    fromDefaultLanguageInput?.slug,
    ...inputTranslations.map((t) => t.slug),
    fromDefaultLanguageRow?.slug,
    ...[...existingRows].sort((x, y) => x.languageCode.localeCompare(y.languageCode)).map((row) => row.slug),
  ];
  return candidates.map(nonEmpty).find((slug) => slug !== undefined);
}

/**
 * Returns the translations array that should replace the client's, or `null` for "nothing to change".
 *
 * Every input translation gets the canonical slug — including one that arrived with a different
 * non-empty slug: a per-language slug is a mistake to correct, not intent to honour. On update,
 * every existing row the client did not send and whose slug differs gets a slug-only
 * `{ languageCode, slug }` input appended. `existingRows` is empty on create.
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
