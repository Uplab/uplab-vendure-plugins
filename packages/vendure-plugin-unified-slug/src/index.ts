/**
 * The public API of this package. Every export here is a deliberate commitment: adding
 * one later is a minor release, removing one is a breaking change. Anything not listed
 * is internal and may change at any time.
 */
export { backfillUnifiedSlugs, runSlugBackfill, type BackfillUnifiedSlugsOptions } from './backfill-unified-slugs';
export { UNIFIED_SLUG_PLUGIN_OPTIONS } from './constants';
export { DefaultUnifiedSlugStrategy } from './default-unified-slug-strategy';
export { type SlugBackfillEntry, type SlugBackfillOutcome } from './plan-slug-backfill';
export { type SlugBackfillReport } from './slug-backfill.service';
export { SlugGenerationService } from './slug-generation.service';
export {
  type ResolvedUnifiedSlugPluginOptions,
  type UnifiedSlugBaseInput,
  type UnifiedSlugEntityName,
  type UnifiedSlugPluginOptions,
  type UnifiedSlugStrategy,
} from './types';
export {
  unifySlugs,
  type AppendedSlugTranslation,
  type ExistingSlugRow,
  type SlugTranslationInput,
} from './unify-slugs';
export { UnifiedSlugPlugin } from './unified-slug.plugin';
