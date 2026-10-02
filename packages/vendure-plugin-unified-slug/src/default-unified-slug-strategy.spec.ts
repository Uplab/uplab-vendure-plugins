import { RequestContext } from '@vendure/core';
import { describe, expect, it } from 'vitest';
import { DefaultUnifiedSlugStrategy } from './default-unified-slug-strategy';
import type { UnifiedSlugStrategy } from './types';

describe('DefaultUnifiedSlugStrategy', () => {
  const strategy: UnifiedSlugStrategy = new DefaultUnifiedSlugStrategy();
  const ctx = {} as RequestContext;
  const base = (name: string) => strategy.generateBase(ctx, { entityName: 'Product', name, context: {} });

  it('leaves slugifying to core’s SlugStrategy, so the result matches slugForEntity', () => {
    expect(base('Café Français')).toBe('Café Français');
  });

  it('trims, and yields nothing for a blank name', () => {
    expect(base('  Dress  ')).toBe('Dress');
    expect(base('   ')).toBe('');
  });

  it('watches no form fields', () => {
    expect(strategy.watchFormFields).toBeUndefined();
  });
});
