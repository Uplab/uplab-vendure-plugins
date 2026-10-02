import { Inject } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, type ID, Permission, RequestContext, UserInputError } from '@vendure/core';
import { UNIFIED_SLUG_ENTITY_NAMES, UNIFIED_SLUG_PLUGIN_OPTIONS } from './constants';
import { SlugGenerationService } from './slug-generation.service';
import type { ResolvedUnifiedSlugPluginOptions, UnifiedSlugEntityName } from './types';

interface UnifiedSlugGenerateInput {
  entityName: string;
  name: string;
  entityId?: ID | null;
  context?: unknown;
}

function isUnifiedSlugEntityName(entityName: string): entityName is UnifiedSlugEntityName {
  return (UNIFIED_SLUG_ENTITY_NAMES as readonly string[]).includes(entityName);
}

/** Gated like core's `slugForEntity`, which this query replaces on the dashboard's slug field. */
@Resolver()
export class UnifiedSlugAdminResolver {
  constructor(
    @Inject(UNIFIED_SLUG_PLUGIN_OPTIONS) private readonly options: ResolvedUnifiedSlugPluginOptions,
    private readonly slugGenerationService: SlugGenerationService,
  ) {}

  @Query()
  @Allow(Permission.Authenticated)
  unifiedSlugGenerate(@Ctx() ctx: RequestContext, @Args() args: { input: UnifiedSlugGenerateInput }): Promise<string> {
    const { entityName, name, entityId, context } = args.input;
    if (!isUnifiedSlugEntityName(entityName)) {
      // A typo'd entityName would otherwise be probed for uniqueness against the wrong table.
      const expected = UNIFIED_SLUG_ENTITY_NAMES.map((n) => `'${n}'`).join(' or ');
      throw new UserInputError(`unifiedSlugGenerate does not know the entity «${entityName}»; expected ${expected}`);
    }
    if (context != null && (typeof context !== 'object' || Array.isArray(context))) {
      throw new UserInputError('unifiedSlugGenerate expects `context` to be an object keyed by form path');
    }
    return this.slugGenerationService.generate(ctx, {
      entityName,
      name,
      entityId,
      context: (context ?? {}) as Record<string, unknown>,
    });
  }

  @Query()
  @Allow(Permission.Authenticated)
  unifiedSlugSettings(): { watchFormFields: string[] } {
    return { watchFormFields: [...(this.options.slugStrategy.watchFormFields ?? [])] };
  }
}
