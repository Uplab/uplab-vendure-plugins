import { Injector } from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
import { DefaultUnifiedSlugStrategy } from './default-unified-slug-strategy';
import type { UnifiedSlugStrategy } from './types';
import { UnifiedSlugPlugin } from './unified-slug.plugin';

describe('UnifiedSlugPlugin', () => {
  it('installs the default strategy when called without options', () => {
    UnifiedSlugPlugin.init();

    expect(UnifiedSlugPlugin.options.slugStrategy).toBeInstanceOf(DefaultUnifiedSlugStrategy);
  });

  it('keeps the default when slugStrategy is passed as undefined', () => {
    UnifiedSlugPlugin.init({ slugStrategy: undefined });

    expect(UnifiedSlugPlugin.options.slugStrategy).toBeInstanceOf(DefaultUnifiedSlugStrategy);
  });

  it('keeps the strategy instance it is given', () => {
    const slugStrategy: UnifiedSlugStrategy = { generateBase: () => '' };
    UnifiedSlugPlugin.init({ slugStrategy });

    expect(UnifiedSlugPlugin.options.slugStrategy).toBe(slugStrategy);
  });

  it('runs the strategy lifecycle, which core only does for strategies in the VendureConfig', async () => {
    const slugStrategy = { generateBase: () => '', init: vi.fn(), destroy: vi.fn() };
    UnifiedSlugPlugin.init({ slugStrategy });
    const plugin = new UnifiedSlugPlugin({} as never);

    await plugin.onApplicationBootstrap();
    expect(slugStrategy.init).toHaveBeenCalledWith(expect.any(Injector));

    await plugin.onApplicationShutdown();
    expect(slugStrategy.destroy).toHaveBeenCalledOnce();
  });

  it('tolerates a strategy without lifecycle hooks', async () => {
    UnifiedSlugPlugin.init();
    const plugin = new UnifiedSlugPlugin({} as never);

    await expect(plugin.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(plugin.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
