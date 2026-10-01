/**
 * The injection token under which the plugin options are provided.
 */
export const UNIFIED_SLUG_PLUGIN_OPTIONS = Symbol('UNIFIED_SLUG_PLUGIN_OPTIONS');

/**
 * The entities whose translations carry a `slug` this plugin unifies. The interceptor, the
 * generate query and the dashboard field all cover exactly these two.
 */
export const UNIFIED_SLUG_ENTITY_NAMES = ['Product', 'Collection'] as const;
