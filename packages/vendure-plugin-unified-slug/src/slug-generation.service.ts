import { Inject, Injectable } from '@nestjs/common';
import { EntitySlugService, RequestContext } from '@vendure/core';
import { UNIFIED_SLUG_PLUGIN_OPTIONS } from './constants';
import type { ResolvedUnifiedSlugPluginOptions, UnifiedSlugBaseInput } from './types';

/**
 * @description
 * Generates a slug for a product or collection: the configured {@link UnifiedSlugStrategy} decides
 * what it says, core's `EntitySlugService` makes it unique — the same service core's `slugForEntity`
 * query uses. Exported from the plugin, so an importer or another plugin produces the same URL the
 * dashboard field does.
 *
 * An empty base short-circuits: the name yielded nothing, and a slug is never invented. Core would
 * answer `''` too, but only after a database round trip.
 */
@Injectable()
export class SlugGenerationService {
  constructor(
    @Inject(UNIFIED_SLUG_PLUGIN_OPTIONS) private readonly options: ResolvedUnifiedSlugPluginOptions,
    private readonly entitySlugService: EntitySlugService,
  ) {}

  async generate(ctx: RequestContext, input: UnifiedSlugBaseInput): Promise<string> {
    const base = (await this.options.slugStrategy.generateBase(ctx, input)).trim();
    if (!base) {
      return '';
    }
    return this.entitySlugService.generateSlugFromInput(ctx, {
      entityName: input.entityName,
      fieldName: 'slug',
      inputValue: base,
      entityId: input.entityId == null ? undefined : String(input.entityId),
    });
  }
}
