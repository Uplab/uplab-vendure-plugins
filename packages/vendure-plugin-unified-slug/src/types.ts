import type { ID, InjectableStrategy, RequestContext } from '@vendure/core';
import type { UNIFIED_SLUG_ENTITY_NAMES } from './constants';

/**
 * @description
 * An entity whose translations this plugin keeps on one slug.
 */
export type UnifiedSlugEntityName = (typeof UNIFIED_SLUG_ENTITY_NAMES)[number];

/**
 * @description
 * What a {@link UnifiedSlugStrategy} gets to build a slug from.
 */
export interface UnifiedSlugBaseInput {
  entityName: UnifiedSlugEntityName;
  /**
   * The name to build the slug from. The dashboard field sends the channel default language's name,
   * falling back to the name on the tab being edited.
   */
  name: string;
  /** The entity being updated. Absent on create. */
  entityId?: ID | null;
  /**
   * Form values the dashboard forwarded, keyed by the paths the strategy listed in
   * {@link UnifiedSlugStrategy.watchFormFields} — e.g. `{ 'customFields.brandId': '7' }`. An empty
   * object for a caller with no form.
   */
  context: Record<string, unknown>;
}

/**
 * @description
 * Decides what a slug *says*. The returned base is passed through the host's core `SlugStrategy` and
 * made unique by core's `EntitySlugService` (`-1`, `-2`…), as `slugForEntity` does. Return `''` when
 * the input cannot yield a slug: a slug is never invented.
 *
 * The plugin calls `init(injector)` on bootstrap and `destroy()` on shutdown.
 *
 * @example
 * ```ts
 * // A product slug that carries the brand: "summer-dress-acme".
 * class BrandSlugStrategy implements UnifiedSlugStrategy {
 *   readonly watchFormFields = ['customFields.brand'];
 *
 *   generateBase(ctx: RequestContext, { entityName, name, context }: UnifiedSlugBaseInput) {
 *     const brand = entityName === 'Product' ? context['customFields.brand'] : undefined;
 *     return typeof brand === 'string' && brand ? `${name} ${brand}` : name;
 *   }
 * }
 * ```
 */
export interface UnifiedSlugStrategy extends InjectableStrategy {
  /**
   * Paths in the product / collection detail form whose values `generateBase` needs. The dashboard
   * field watches them, regenerates while the slug is still empty when one changes, and sends their
   * values as {@link UnifiedSlugBaseInput.context}. Default: none.
   */
  readonly watchFormFields?: readonly string[];

  generateBase(ctx: RequestContext, input: UnifiedSlugBaseInput): string | Promise<string>;
}

/**
 * @description
 * Options for `UnifiedSlugPlugin.init()`.
 */
export interface UnifiedSlugPluginOptions {
  /**
   * What a generated slug says.
   *
   * @default new DefaultUnifiedSlugStrategy() — the name, as core's `slugForEntity` would slugify it.
   */
  slugStrategy?: UnifiedSlugStrategy;
}

/**
 * @description
 * {@link UnifiedSlugPluginOptions} with every default applied.
 */
export type ResolvedUnifiedSlugPluginOptions = Required<UnifiedSlugPluginOptions>;
