import { type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Injector, PluginCommonModule, type Type, VendurePlugin } from '@vendure/core';
import { adminApiExtensions, shopApiExtensions } from './api-extensions';
import {
  DEFAULT_COUNTRY_SYNC_SCHEDULE,
  DEFAULT_NOVA_POSHTA_API_URL,
  DEFAULT_NOVA_POSHTA_TIMEOUT,
  NOVA_POSHTA_PLUGIN_OPTIONS,
} from './constants';
import { createCountrySyncTask } from './country-sync-task';
import { regionCustomFields } from './custom-fields';
import { NovaPoshtaClient } from './nova-poshta.client';
import { NovaPoshtaAdminResolver, NovaPoshtaShopResolver } from './nova-poshta.resolvers';
import { NovaPoshtaService } from './nova-poshta.service';
import { StaticNovaPoshtaApiKeyStrategy } from './static-api-key-strategy';
import type { NovaPoshtaPluginOptions, ResolvedNovaPoshtaPluginOptions } from './types';

/**
 * @description
 * [Nova Poshta](https://novaposhta.ua/) city and warehouse lookups for checkout, in Ukraine and abroad,
 * as Shop API queries. Per country, admins choose which warehouse types customers may pick abroad.
 *
 * @example
 * ```ts
 * import { NovaPoshtaPlugin } from '@uplab/vendure-plugin-nova-poshta';
 *
 * export const config: VendureConfig = {
 *   plugins: [NovaPoshtaPlugin.init({ apiKey: process.env.NOVA_POSHTA_API_KEY! })],
 * };
 * ```
 */
@VendurePlugin({
  compatibility: '^3.7.0',
  imports: [PluginCommonModule],
  providers: [
    { provide: NOVA_POSHTA_PLUGIN_OPTIONS, useFactory: () => NovaPoshtaPlugin.options },
    NovaPoshtaClient,
    NovaPoshtaService,
  ],
  exports: [NovaPoshtaClient, NovaPoshtaService],
  shopApiExtensions: { schema: shopApiExtensions, resolvers: [NovaPoshtaShopResolver] },
  adminApiExtensions: { schema: adminApiExtensions, resolvers: [NovaPoshtaAdminResolver] },
  configuration: (config) => {
    config.customFields.Region = [...(config.customFields.Region ?? []), ...regionCustomFields];
    const { countrySync } = NovaPoshtaPlugin.options;
    if (countrySync) {
      config.schedulerOptions.tasks = [
        ...(config.schedulerOptions.tasks ?? []),
        createCountrySyncTask(countrySync.schedule),
      ];
    }
    return config;
  },
})
export class NovaPoshtaPlugin implements OnApplicationBootstrap, OnApplicationShutdown {
  /** @internal */
  static options: ResolvedNovaPoshtaPluginOptions;

  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * @description
   * Configures the plugin. See {@link NovaPoshtaPluginOptions}.
   */
  static init(options: NovaPoshtaPluginOptions): Type<NovaPoshtaPlugin> {
    this.options = {
      apiKeyStrategy:
        typeof options.apiKey === 'string' ? new StaticNovaPoshtaApiKeyStrategy(options.apiKey) : options.apiKey,
      apiUrl: options.apiUrl ?? DEFAULT_NOVA_POSHTA_API_URL,
      timeout: options.timeout ?? DEFAULT_NOVA_POSHTA_TIMEOUT,
      countrySync:
        options.countrySync === false
          ? false
          : { schedule: options.countrySync?.schedule ?? DEFAULT_COUNTRY_SYNC_SCHEDULE },
    };
    return NovaPoshtaPlugin;
  }

  // Core runs the InjectableStrategy lifecycle only for strategies in the VendureConfig.
  async onApplicationBootstrap(): Promise<void> {
    await NovaPoshtaPlugin.options.apiKeyStrategy.init?.(new Injector(this.moduleRef));
  }

  async onApplicationShutdown(): Promise<void> {
    await NovaPoshtaPlugin.options.apiKeyStrategy.destroy?.();
  }
}
