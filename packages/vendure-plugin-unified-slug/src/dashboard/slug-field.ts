/**
 * The logic behind the dashboard's slug field, free of React so it can be unit-tested.
 */

/** A row of the detail form's `translations` array. */
export interface TranslationRow {
  id?: string | null;
  languageCode?: string | null;
  name?: string | null;
  slug?: string | null;
}

export function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/** react-hook-form marks a nested row dirty as a tree of booleans; any `true` in it counts. */
export function isRowDirty(dirtyRow: unknown): boolean {
  if (dirtyRow != null && typeof dirtyRow === 'object') {
    return Object.values(dirtyRow).some(isRowDirty);
  }
  return dirtyRow === true;
}

/** `translations.2.slug` -> 2. The form engine names the field after the active language tab's row. */
export function indexFromFieldName(fieldName: string | undefined): number {
  const match = /^translations\.(\d+)\./.exec(fieldName ?? '');
  return match ? Number(match[1]) : -1;
}

export function findLanguageIndex(translations: readonly TranslationRow[], languageCode: string | undefined): number {
  return languageCode ? translations.findIndex((row) => row?.languageCode === languageCode) : -1;
}

/** One value for every tab: the channel default language's slug, else the first non-empty one. */
export function displayedSlug(translations: readonly TranslationRow[], defaultLanguageIndex: number): string {
  return (
    nonEmpty(translations[defaultLanguageIndex]?.slug) ??
    translations.map((row) => nonEmpty(row?.slug)).find((slug) => slug !== undefined) ??
    ''
  );
}

/**
 * The name to generate from: the channel default language's, else the tab being edited — an admin
 * often fills their own language before the channel default's.
 */
export function pickNameSource(
  translations: readonly TranslationRow[],
  defaultLanguageIndex: number,
  activeIndex: number,
): { index: number; name: string } {
  const index = nonEmpty(translations[defaultLanguageIndex]?.name) !== undefined ? defaultLanguageIndex : activeIndex;
  return { index, name: nonEmpty(translations[index]?.name) ?? '' };
}

/**
 * Whether the slug is written into a row: the tab being edited, a row saved in the database, or one
 * the admin has typed into. The dashboard drops rows that are neither dirty nor persisted before it
 * submits; writing into one would mark it dirty and save it with an empty name.
 */
export function isRowInPlay(
  row: TranslationRow | undefined,
  index: number,
  activeIndex: number,
  dirtyRow: unknown,
): boolean {
  return index === activeIndex || Boolean(row?.id) || isRowDirty(dirtyRow);
}

/** The watched form values keyed by path, as the strategy receives them in `context`. */
export function buildStrategyContext(
  watchFormFields: readonly string[],
  watchedValues: readonly unknown[] | undefined,
): Record<string, unknown> {
  return Object.fromEntries(watchFormFields.map((path, index) => [path, watchedValues?.[index] ?? null]));
}
