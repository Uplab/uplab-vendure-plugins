import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { Button, DashboardFormComponent, Input, api, toast, useChannel, usePage } from '@vendure/dashboard';
import { Edit, Lock, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import {
  buildStrategyContext,
  displayedSlug,
  findLanguageIndex,
  indexFromFieldName,
  isRowDirty,
  isRowInPlay,
  pickNameSource,
  type TranslationRow,
} from '../slug-field';

const AUTO_GENERATE_DEBOUNCE_MS = 500;

// Plain strings rather than `graphql()` documents: those are typed against the host's generated
// schema, which a published package cannot import.
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
const NO_TRANSLATIONS: TranslationRow[] = [];

interface DirtyFields {
  translations?: unknown[];
}

/**
 * One slug field for the whole entity, replacing core's per-language `SlugInput` on the product and
 * collection detail pages. It shows one value on every language tab and writes it into every
 * translation in play (see `isRowInPlay`); it auto-generates on update as well as on create, where
 * core's field is create-only and leaves a language added later with an empty slug; and it asks this
 * plugin's `unifiedSlugGenerate` instead of `slugForEntity`, so the configured slug strategy applies.
 */
export const UnifiedSlugInput: DashboardFormComponent = ({ disabled, name, onBlur, ref }) => {
  const { t } = useLingui();
  const form = useFormContext();
  const { activeChannel } = useChannel();
  const page = usePage();
  const defaultLanguageCode = activeChannel?.defaultLanguageCode;
  const entityName = page?.pageId === 'collection-detail' ? 'Collection' : 'Product';
  const entityId = (page?.entity as { id?: string | number } | undefined)?.id;

  // The form values the strategy asked for. Fetched once per session: plugin options cannot change
  // without a server restart. A failed fetch means no watched fields, not a field that never generates.
  const { data: settings, isError: settingsFailed } = useQuery({
    queryKey: ['unifiedSlugSettings'],
    queryFn: () => api.query<{ unifiedSlugSettings: { watchFormFields: string[] } }>(UNIFIED_SLUG_SETTINGS),
    staleTime: Infinity,
  });
  const settingsReady = settings !== undefined || settingsFailed;
  const watchFormFields = settings?.unifiedSlugSettings.watchFormFields ?? NO_WATCH_FIELDS;
  const watchedValues = useWatch({ control: form.control, name: watchFormFields }) as unknown[] | undefined;
  const strategyContext = useMemo(
    () => buildStrategyContext(watchFormFields, watchedValues),
    [watchFormFields, watchedValues],
  );

  const translations =
    (useWatch({ control: form.control, name: 'translations' }) as TranslationRow[] | undefined) ?? NO_TRANSLATIONS;
  const activeIndex = indexFromFieldName(name);
  const defaultLanguageIndex = findLanguageIndex(translations, defaultLanguageCode);
  const slug = displayedSlug(translations, defaultLanguageIndex);
  const { index: nameSourceIndex, name: sourceName } = pickNameSource(translations, defaultLanguageIndex, activeIndex);

  const [isManuallyReadonly, setIsManuallyReadonly] = useState(true);
  const isReadonly = Boolean(disabled) || isManuallyReadonly;

  const [debouncedName, setDebouncedName] = useState(sourceName);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedName(sourceName), AUTO_GENERATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sourceName]);

  // Read during render: react-hook-form's formState is a lazily-tracked Proxy.
  const dirtyTranslations = (form.formState.dirtyFields as DirtyFields | undefined)?.translations;
  const isNameDirty =
    nameSourceIndex >= 0 && isRowDirty((dirtyTranslations?.[nameSourceIndex] as { name?: unknown } | undefined)?.name);

  // No `entityId` here, unlike core: an existing entity with an empty slug must generate too. Waiting
  // for the debounce matters there — `debouncedName` starts as the saved name, and generating from it
  // the moment the admin starts typing would fill the slug from the name they are replacing.
  const isNameSettled = debouncedName === sourceName;
  const shouldAutoGenerate = isReadonly && !slug && isNameDirty && isNameSettled;

  const { data: generatedSlug, isLoading } = useQuery({
    // The context is part of the key: while the slug is empty, a changed watched field regenerates.
    queryKey: ['unifiedSlugGenerate', entityName, debouncedName, JSON.stringify(strategyContext), entityId],
    queryFn: async () => {
      const result = await api.query<{ unifiedSlugGenerate: string }>(UNIFIED_SLUG_GENERATE, {
        input: { entityName, name: debouncedName, entityId: entityId?.toString(), context: strategyContext },
      });
      return result.unifiedSlugGenerate;
    },
    // Not before the settings are in: a slug generated without the strategy's form values would stick.
    enabled: settingsReady && Boolean(debouncedName) && shouldAutoGenerate,
  });

  const setSlugEverywhere = useCallback(
    (newValue: string) => {
      const rows = (form.getValues('translations') ?? []) as TranslationRow[];
      const dirtyRows = (form.formState.dirtyFields as DirtyFields | undefined)?.translations;
      rows.forEach((row, index) => {
        if (isRowInPlay(row, index, activeIndex, dirtyRows?.[index])) {
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
    // Straight from the current name: the query cache is keyed by the debounced one.
    try {
      const result = await api.query<{ unifiedSlugGenerate: string }>(UNIFIED_SLUG_GENERATE, {
        input: { entityName, name: sourceName, entityId: entityId?.toString(), context: strategyContext },
      });
      if (result.unifiedSlugGenerate) {
        setSlugEverywhere(result.unifiedSlugGenerate);
      }
    } catch {
      toast.error(t`Could not generate the slug`);
    }
  };

  const showLoading = isLoading && shouldAutoGenerate;

  return (
    <div className="relative flex items-center gap-2">
      <div className="flex-1 relative">
        <Input
          // `ref`, `onBlur` and `name` must reach the real input, or `setFocus` and the form
          // engine's scroll-to-first-invalid never find this field.
          ref={ref}
          name={name}
          onBlur={onBlur}
          value={slug}
          onChange={(event) => setSlugEverywhere(event.target.value)}
          disabled={isReadonly}
          placeholder={isReadonly ? t`Same slug in every language` : t`Enter slug manually`}
          className={isReadonly ? 'pr-8 bg-muted text-muted-foreground' : 'pr-8'}
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
              disabled={isLoading}
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
