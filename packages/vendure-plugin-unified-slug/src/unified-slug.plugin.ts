import { type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { APP_INTERCEPTOR, ModuleRef } from '@nestjs/core';
import { Injector, PluginCommonModule, type Type, VendurePlugin } from '@vendure/core';
import { adminApiExtensions } from './api-extensions';
import { UNIFIED_SLUG_PLUGIN_OPTIONS } from './constants';
import { DefaultUnifiedSlugStrategy } from './default-unified-slug-strategy';
import { SlugBackfillService } from './slug-backfill.service';
import { SlugGenerationService } from './slug-generation.service';
import type { ResolvedUnifiedSlugPluginOptions, UnifiedSlugPluginOptions } from './types';
import { UnifiedSlugAdminResolver } from './unified-slug-admin.resolver';
import { UnifiedSlugInterceptor } from './unified-slug.interceptor';

/**
 * @description
 * Keeps **one slug per product and collection, identical in every language**:
 *
 * - the server rewrites the `translations` of `createProduct`, `updateProduct`, `updateProducts`,
 *   `createCollection` and `updateCollection` before the core resolver runs, so the invariant holds
 *   for every API client;
 * - the dashboard shows a single slug field instead of one per language tab, and generates it on
 *   update as well as on create;
 * - {@link SlugGenerationService} and the `unifiedSlugGenerate` Admin API query own what a generated
 *   slug says, through a pluggable {@link UnifiedSlugStrategy}.
 *
 * @example
 * ```ts
 * import { UnifiedSlugPlugin } from '@uplab/vendure-plugin-unified-slug';
 *
 * export const config: VendureConfig = {
 *   plugins: [UnifiedSlugPlugin.init()],
 * };
 * ```
 */
@VendurePlugin({
  compatibility: '^3.7.0',
  imports: [PluginCommonModule],
  providers: [
    { provide: UNIFIED_SLUG_PLUGIN_OPTIONS, useFactory: () => UnifiedSlugPlugin.options },
    { provide: APP_INTERCEPTOR, useClass: UnifiedSlugInterceptor },
    SlugGenerationService,
    SlugBackfillService,
  ],
  exports: [SlugGenerationService],
  adminApiExtensions: { schema: adminApiExtensions, resolvers: [UnifiedSlugAdminResolver] },
  // Resolved relative to the compiled plugin file; the sources are copied to `dist/dashboard/`.
  dashboard: './dashboard/index.tsx',
})
export class UnifiedSlugPlugin implements OnApplicationBootstrap, OnApplicationShutdown {
  /** @internal */
  static options: ResolvedUnifiedSlugPluginOptions = { slugStrategy: new DefaultUnifiedSlugStrategy() };

  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * @description
   * Configures the plugin. See {@link UnifiedSlugPluginOptions}.
   */
  static init(options: UnifiedSlugPluginOptions = {}): Type<UnifiedSlugPlugin> {
    this.options = {
      slugStrategy: options.slugStrategy ?? new DefaultUnifiedSlugStrategy(),
    };
    return UnifiedSlugPlugin;
  }

  // Core runs the InjectableStrategy lifecycle only for strategies in the VendureConfig.
  async onApplicationBootstrap(): Promise<void> {
    await UnifiedSlugPlugin.options.slugStrategy.init?.(new Injector(this.moduleRef));
  }

  async onApplicationShutdown(): Promise<void> {
    await UnifiedSlugPlugin.options.slugStrategy.destroy?.();
  }
}
