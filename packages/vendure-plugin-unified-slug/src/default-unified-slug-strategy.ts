import type { RequestContext } from '@vendure/core';
import type { UnifiedSlugBaseInput, UnifiedSlugStrategy } from './types';

/**
 * @description
 * The slug is the name. It does not slugify anything itself: the base is passed through the host's
 * configured core `SlugStrategy` afterwards, so the result is exactly what core's own `slugForEntity`
 * query would answer for the same name.
 */
export class DefaultUnifiedSlugStrategy implements UnifiedSlugStrategy {
  generateBase(_ctx: RequestContext, { name }: UnifiedSlugBaseInput): string {
    return name.trim();
  }
}
