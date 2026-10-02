import { EntitySlugService, RequestContext } from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
import { SlugGenerationService } from './slug-generation.service';
import type { UnifiedSlugBaseInput, UnifiedSlugStrategy } from './types';

describe('SlugGenerationService', () => {
  const ctx = {} as RequestContext;
  const build = (generateBase: UnifiedSlugStrategy['generateBase']) => {
    const strategy = { generateBase: vi.fn(generateBase) };
    const generateSlugFromInput = vi.fn(
      async (_ctx: RequestContext, { inputValue }: { inputValue: string }) =>
        `${inputValue.toLowerCase().replace(/\s+/g, '-')}-1`,
    );
    const entitySlugService = { generateSlugFromInput } as unknown as EntitySlugService;
    return {
      strategy,
      generateSlugFromInput,
      service: new SlugGenerationService({ slugStrategy: strategy }, entitySlugService),
    };
  };
  const input: UnifiedSlugBaseInput = { entityName: 'Product', name: 'Summer Dress', entityId: 42, context: {} };

  it('hands the strategy’s base to core for normalising and uniqueness, excluding the entity itself', async () => {
    const { service, generateSlugFromInput } = build((_ctx, { name }) => name);

    await expect(service.generate(ctx, input)).resolves.toBe('summer-dress-1');
    expect(generateSlugFromInput).toHaveBeenCalledWith(ctx, {
      entityName: 'Product',
      fieldName: 'slug',
      inputValue: 'Summer Dress',
      entityId: '42',
    });
  });

  it('passes no entityId to core on create', async () => {
    const { service, generateSlugFromInput } = build((_ctx, { name }) => name);

    await service.generate(ctx, { ...input, entityName: 'Collection', entityId: null });
    expect(generateSlugFromInput).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ entityName: 'Collection', entityId: undefined }),
    );
  });

  it('gives the strategy the input untouched, context included', async () => {
    const { service, strategy } = build(() => 'x');
    const withContext = { ...input, context: { 'customFields.brand': 'acme' } };

    await service.generate(ctx, withContext);
    expect(strategy.generateBase).toHaveBeenCalledWith(ctx, withContext);
  });

  it('awaits an async strategy', async () => {
    const { service } = build(async () => 'Async Base');

    await expect(service.generate(ctx, input)).resolves.toBe('async-base-1');
  });

  it.each(['', '   '])(
    'answers an empty slug for the base %j without asking core — a slug is never invented',
    async (base) => {
      const { service, generateSlugFromInput } = build(() => base);

      await expect(service.generate(ctx, input)).resolves.toBe('');
      expect(generateSlugFromInput).not.toHaveBeenCalled();
    },
  );
});
