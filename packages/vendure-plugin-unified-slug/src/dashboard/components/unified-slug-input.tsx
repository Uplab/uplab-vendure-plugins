import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { Button, DashboardFormComponent, Input, api, useChannel, usePage } from '@vendure/dashboard';
import { Edit, Lock, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';

const AUTO_GENERATE_DEBOUNCE_MS = 500;

/**
 * This plugin's own query, not core's `slugForEntity`: it runs the configured `UnifiedSlugStrategy`
 * before the same core uniqueness suffixing, so the field produces the URL an importer calling
 * `SlugGenerationService` would. Plain strings rather than `graphql()` documents — those are typed
 * against the host's generated schema, which a published package cannot import.
 */
const UNIFIED_SLUG_GENERATE = `
  query UnifiedSlugGenerate($input: UnifiedSlugGenerateInput!) {
    unifiedSlugGenerate(input: $input)
  }
`;

const UNIFIED_SLUG_SETTINGS = `
  query UnifiedSlugSettings {
    unifiedSlugSettings {
      watchFormFields
    }
  }
`;

const NO_WATCH_FIELDS: string[] = [];

interface TranslationRow {
  id?: string | null;
  languageCode?: string | null;
  name?: string | null;
  slug?: string | null;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/** react-hook-form marks a nested row dirty as a tree of booleans; any `true` in it counts. */
function isRowDirty(dirtyRow: unknown): boolean {
  if (dirtyRow != null && typeof dirtyRow === 'object') {
    return Object.values(dirtyRow).some(isRowDirty);
  }
  return dirtyRow === true;
}

/** `translations.2.slug` -> 2. The form engine names the field after the active language tab's row. */
function indexFromFieldName(fieldName: string | undefined): number {
  const match = /^translations\.(\d+)\./.exec(fieldName ?? '');
  return match ? Number(match[1]) : -1;
}

function findLanguageIndex(translations: TranslationRow[], languageCode: string | undefined): number {
  return languageCode ? translations.findIndex((t) => t?.languageCode === languageCode) : -1;
}

/**
 * One slug field for the whole entity, replacing the per-language `SlugInput` on the product and
 * collection detail pages (registered in `../index.tsx`).
 *
 * ## Why not the core component
 *
 * The core `SlugInput` is per-translation by construction, and its auto-generation is
 * `isReadonly && !entityId && watchFieldState.isDirty`
 * (`@vendure/dashboard/src/lib/components/data-input/slug-input.tsx:173`) — **create only**. An admin
 * who opens an existing collection, switches to a language tab that has no row yet and types a name
 * saves that row with `slug: ''`. So this component keeps the shape (readonly toggle, regenerate
 * button, 500 ms debounce) and changes four things: it shows one value for every tab, it writes that
 * value into every translation, it auto-generates on update too, and it asks this plugin's
 * `unifiedSlugGenerate` instead of core's `slugForEntity`, so the configured slug strategy applies.
 *
 * ## Why it writes every row itself
 *
 * The server interceptor already unifies whatever arrives, so this is not where correctness lives —
 * it is where the admin's *view* stops lying. Writing every row also means the value the admin sees
 * before saving is the value that gets saved.
 *
 * ## The one subtlety: which rows it writes
 *
 * `stripUntouchedTranslations` (`@vendure/dashboard/src/lib/framework/form-engine/utils.ts`) drops
 * translation rows that are neither dirty nor persisted, which is the fix for the empty rows of
 * vendure#4885 — rows the form seeds for every channel language and the admin never fills. So the
 * slug is written only into rows already in play: the tab being edited, a row that exists in the
 * database (it carries an `id`), or a row the admin has typed into. An untouched seeded row is not
 * written at all — not even with `shouldDirty: false`: a dirtying `setValue` makes react-hook-form
 * recompute `dirtyFields` for the whole form against the defaults, and a seeded row whose slug no
 * longer matches its default would turn dirty and be saved with an empty name. If such a language
 * is filled in later, the server interceptor gives it the canonical slug at that write.
 */
export const UnifiedSlugInput: DashboardFormComponent = ({ disabled, name, onBlur, ref }) => {
  const { t } = useLingui();
  const form = useFormContext();
  const { activeChannel } = useChannel();
  const page = usePage();
  const defaultLanguageCode = activeChannel?.defaultLanguageCode;
  const entityName = page?.pageId === 'collection-detail' ? 'Collection' : 'Product';
  const entityId = (page?.entity as { id?: string | number } | undefined)?.id;

  // The form values the server's slug strategy asked for. Fetched once per dashboard session: they
  // come from the plugin options, which cannot change without a server restart.
  const { data: settings } = useQuery({
    queryKey: ['unifiedSlugSettings'],
    queryFn: () => api.query<{ unifiedSlugSettings: { watchFormFields: string[] } }>(UNIFIED_SLUG_SETTINGS),
    staleTime: Infinity,
  });
  const watchFormFields = settings?.unifiedSlugSettings.watchFormFields ?? NO_WATCH_FIELDS;
  const watchedValues = useWatch({ control: form.control, name: watchFormFields }) as unknown[] | undefined;
  const strategyContext = useMemo(
    () => Object.fromEntries(watchFormFields.map((path, index) => [path, watchedValues?.[index] ?? null])),
    [watchFormFields, watchedValues],
  );

  const watchedTranslations = useWatch({ control: form.control, name: 'translations' }) as TranslationRow[] | undefined;
  const translations = useMemo(() => watchedTranslations ?? [], [watchedTranslations]);
  const activeIndex = indexFromFieldName(name);
  const defaultLanguageIndex = findLanguageIndex(translations, defaultLanguageCode);

  // One value for every tab: the channel default language's slug, else the first non-empty one.
  const slug =
    nonEmpty(translations[defaultLanguageIndex]?.slug) ??
    translations.map((row) => nonEmpty(row?.slug)).find((value) => value !== undefined) ??
    '';

  // The name to generate from: the channel default language's, falling back to the tab being edited
  // (an admin often fills their own language first, before the channel default's).
  const nameSourceIndex =
    nonEmpty(translations[defaultLanguageIndex]?.name) !== undefined ? defaultLanguageIndex : activeIndex;
  const sourceName = nonEmpty(translations[nameSourceIndex]?.name) ?? '';

  const [isManuallyReadonly, setIsManuallyReadonly] = useState(true);
  const isReadonly = Boolean(disabled) || isManuallyReadonly;

  const [debouncedName, setDebouncedName] = useState(sourceName);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedName(sourceName), AUTO_GENERATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sourceName]);

  // `dirtyFields` must be read during render for react-hook-form's lazily-tracked formState Proxy to
  // populate it — the same requirement `stripUntouchedTranslations` documents.
  const { dirtyFields } = form.formState;
  const dirtyTranslations = (dirtyFields as { translations?: unknown[] } | undefined)?.translations;
  const isNameDirty =
    nameSourceIndex >= 0 &&
    isRowDirty((dirtyTranslations as Array<{ name?: unknown }> | undefined)?.[nameSourceIndex]?.name);

  // Unlike core, `entityId` is deliberately absent from this condition: an existing entity whose
  // slug is empty must auto-generate too. Waiting until the debounce has caught up matters there:
  // `debouncedName` starts as the saved name, and generating from it the moment the admin starts
  // typing would fill the slug from the name they are replacing.
  const isNameSettled = debouncedName === sourceName;
  const shouldAutoGenerate = isReadonly && !slug && isNameDirty && isNameSettled;

  const { data: generatedSlug, isLoading } = useQuery({
    // The strategy context is part of the key on purpose: while the slug is still empty, changing a
    // watched field has to re-generate, because the strategy builds the slug from it.
    queryKey: ['unifiedSlugGenerate', entityName, debouncedName, JSON.stringify(strategyContext), entityId],
    queryFn: async () => {
      const result = await api.query<{ unifiedSlugGenerate: string }>(UNIFIED_SLUG_GENERATE, {
        input: { entityName, name: debouncedName, entityId: entityId?.toString(), context: strategyContext },
      });
      return result.unifiedSlugGenerate;
    },
    // Not before the settings are in: a slug generated without the strategy's form values would be
    // written, and once the slug is non-empty nothing regenerates it with them.
    enabled: settings !== undefined && Boolean(debouncedName) && shouldAutoGenerate,
  });

  /** Writes one slug into every translation row in play, so all languages are saved with the same value. */
  const setSlugEverywhere = useCallback(
    (newValue: string) => {
      const rows = (form.getValues('translations') ?? []) as TranslationRow[];
      const dirtyRows = (form.formState.dirtyFields as { translations?: unknown[] } | undefined)?.translations;
      rows.forEach((row, index) => {
        const inPlay = index === activeIndex || Boolean(row?.id) || isRowDirty(dirtyRows?.[index]);
        if (inPlay) {
          form.setValue(`translations.${index}.slug`, newValue, { shouldDirty: true });
        }
      });
    },
    [form, activeIndex],
  );

  useEffect(() => {
    if (shouldAutoGenerate && generatedSlug && generatedSlug !== slug) {
      setSlugEverywhere(generatedSlug);
    }
  }, [generatedSlug, shouldAutoGenerate, slug, setSlugEverywhere]);

  const handleRegenerate = async () => {
    if (!sourceName) {
      return;
    }
    // Straight from the current name and form values: the query cache is keyed by the debounced
    // name, which may still be the previous one right after an edit.
    const result = await api.query<{ unifiedSlugGenerate: string }>(UNIFIED_SLUG_GENERATE, {
      input: { entityName, name: sourceName, entityId: entityId?.toString(), context: strategyContext },
    });
    if (result.unifiedSlugGenerate) {
      setSlugEverywhere(result.unifiedSlugGenerate);
    }
  };

  const showLoading = isLoading && shouldAutoGenerate;

  return (
    <div className="relative flex items-center gap-2">
      <div className="flex-1 relative">
        <Input
          // `ref`, `onBlur` and `name` come from react-hook-form's `ControllerRenderProps` and must
          // reach the real input, or `setFocus` and the form engine's scroll-to-first-invalid never
          // find this field.
          ref={ref}
          name={name}
          onBlur={onBlur}
          value={slug}
          onChange={(event) => setSlugEverywhere(event.target.value)}
          disabled={isReadonly}
          placeholder={isReadonly ? t`Same slug in every language` : t`Enter slug manually`}
          className={
            showLoading
              ? 'pr-8 bg-muted text-muted-foreground'
              : isReadonly
                ? 'pr-8 bg-muted text-muted-foreground'
                : 'pr-8'
          }
        />
        {showLoading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          </div>
        )}
      </div>
      {!disabled && (
        <>
          {isManuallyReadonly && sourceName && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={handleRegenerate}
              className="shrink-0"
              title={t`Regenerate the slug from the name`}
              aria-label={t`Regenerate the slug from the name`}
              disabled={!sourceName || isLoading}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setIsManuallyReadonly(!isManuallyReadonly)}
            className="shrink-0"
            title={isManuallyReadonly ? t`Edit the slug manually` : t`Generate the slug automatically`}
            aria-label={isManuallyReadonly ? t`Edit the slug manually` : t`Generate the slug automatically`}
          >
            {isManuallyReadonly ? <Edit className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
          </Button>
        </>
      )}
    </div>
  );
};
