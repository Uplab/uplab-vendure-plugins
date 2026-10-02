import { Permission, RequestContext, UserInputError } from '@vendure/core';
import { PERMISSIONS_METADATA_KEY } from '@vendure/core/dist/api/decorators/allow.decorator';
import { describe, expect, it, vi } from 'vitest';
import { DefaultUnifiedSlugStrategy } from './default-unified-slug-strategy';
import { SlugGenerationService } from './slug-generation.service';
import type { ResolvedUnifiedSlugPluginOptions, UnifiedSlugStrategy } from './types';
import { UnifiedSlugAdminResolver } from './unified-slug-admin.resolver';

/**
 * What a mocked service cannot get wrong for us: the permission gate, the `entityName` check, and
 * what reaches the service. The generation itself is `slug-generation.service.spec.ts`.
 */
describe('UnifiedSlugAdminResolver', () => {
  const ctx = {} as RequestContext;
  const build = (slugStrategy: UnifiedSlugStrategy = new DefaultUnifiedSlugStrategy()) => {
    const service = { generate: vi.fn(async () => 'summer-dress') };
    const options: ResolvedUnifiedSlugPluginOptions = { slugStrategy };
    return { service, resolver: new UnifiedSlugAdminResolver(options, service as unknown as SlugGenerationService) };
  };

  it.each(['unifiedSlugGenerate', 'unifiedSlugSettings'])(
    '`%s` is gated exactly like core’s slugForEntity, the query it replaces on the dashboard field',
    (method) => {
      const permissions = Reflect.getMetadata(
        PERMISSIONS_METADATA_KEY,
        (UnifiedSlugAdminResolver.prototype as unknown as Record<string, object>)[method],
      );
      expect(permissions).toEqual([Permission.Authenticated]);
    },
  );

  it('forwards name, entityId and context to the service', async () => {
    const { service, resolver } = build();
    const input = {
      entityName: 'Product',
      name: 'Summer Dress',
      entityId: 42,
      context: { 'customFields.brand': 'acme' },
    };

    await expect(resolver.unifiedSlugGenerate(ctx, { input })).resolves.toBe('summer-dress');
    expect(service.generate).toHaveBeenCalledWith(ctx, {
      entityName: 'Product',
      name: 'Summer Dress',
      entityId: 42,
      context: { 'customFields.brand': 'acme' },
    });
  });

  it.each([
    ['null', { entityName: 'Collection', name: 'Dresses', context: null }],
    ['absent', { entityName: 'Collection', name: 'Dresses' }],
  ])('hands the strategy an empty context when the caller sent none (%s)', async (_label, input) => {
    const { service, resolver } = build();

    await resolver.unifiedSlugGenerate(ctx, { input });
    expect(service.generate).toHaveBeenCalledWith(ctx, expect.objectContaining({ context: {} }));
  });

  it('refuses an entity it does not unify rather than probing the wrong table', () => {
    const { resolver, service } = build();

    expect(() => resolver.unifiedSlugGenerate(ctx, { input: { entityName: 'Facet', name: 'Colour' } })).toThrow(
      UserInputError,
    );
    expect(service.generate).not.toHaveBeenCalled();
  });

  it.each([
    ['a string', 'colour'],
    ['a number', 42],
    ['an array', ['colour']],
  ])('refuses a context that is %s — strategies are promised an object', (_label, context) => {
    const { resolver, service } = build();

    expect(() =>
      resolver.unifiedSlugGenerate(ctx, { input: { entityName: 'Product', name: 'Dress', context } }),
    ).toThrow(UserInputError);
    expect(service.generate).not.toHaveBeenCalled();
  });

  it('reports the strategy’s watch fields, and none for the default strategy', () => {
    expect(build().resolver.unifiedSlugSettings()).toEqual({ watchFormFields: [] });

    const strategy: UnifiedSlugStrategy = { watchFormFields: ['customFields.brand'], generateBase: () => '' };
    expect(build(strategy).resolver.unifiedSlugSettings()).toEqual({ watchFormFields: ['customFields.brand'] });
  });
});
