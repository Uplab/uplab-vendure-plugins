import { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  Injector,
  PluginCommonModule,
  ProcessContext,
  RequestContextService,
  Type,
  VendurePlugin,
} from '@vendure/core';
import { CurrencyExchangeRateAdminResolver } from './api/admin.resolver';
import { adminApiExtensions, shopApiExtensions } from './api/api-extensions';
import { CurrencyExchangeRateShopFieldResolver, CurrencyExchangeRateShopResolver } from './api/shop.resolver';
import { CURRENCY_EXCHANGE_RATE_PLUGIN_OPTIONS, DEFAULT_SYNC_SCHEDULE } from './constants';
import { createCurrencyExchangeRateSyncTask } from './currency-exchange-rate-sync.task';
import { CurrencyExchangeRate } from './entities/currency-exchange-rate.entity';
import { CurrencyExchangeRateSyncService } from './services/currency-exchange-rate-sync.service';
import { CurrencyExchangeRateService } from './services/currency-exchange-rate.service';
import { CurrencyExchangeRatePluginOptions, ResolvedCurrencyExchangeRatePluginOptions } from './types';

function resolveOptions(options: CurrencyExchangeRatePluginOptions): ResolvedCurrencyExchangeRatePluginOptions {
  return {
    source: options.source,
    sync: options.sync === false ? false : { schedule: options.sync?.schedule ?? DEFAULT_SYNC_SCHEDULE },
  };
}

/**
 * @description
 * Exchange rates against the hryvnia for showing and charging prices in other currencies. Rates come
 * from a pluggable {@link ExchangeRateSource} (Monobank, the NBU, fixed rates or your own),
 * are refreshed on a schedule, and can be overridden per currency in the dashboard.
 */
@VendurePlugin({
  imports: [PluginCommonModule],
  entities: [CurrencyExchangeRate],
  shopApiExtensions: {
    resolvers: [CurrencyExchangeRateShopResolver, CurrencyExchangeRateShopFieldResolver],
    schema: shopApiExtensions,
  },
  adminApiExtensions: { resolvers: [CurrencyExchangeRateAdminResolver], schema: adminApiExtensions },
  // Resolved relative to the compiled plugin file; the sources are copied to `dist/dashboard/`.
  dashboard: './dashboard/index.tsx',
  providers: [
    { provide: CURRENCY_EXCHANGE_RATE_PLUGIN_OPTIONS, useFactory: () => CurrencyExchangeRatePlugin.options },
    CurrencyExchangeRateService,
    CurrencyExchangeRateSyncService,
  ],
  exports: [CurrencyExchangeRateService, CurrencyExchangeRateSyncService],
  compatibility: '^3.7.0',
  configuration: (config) => {
    const { sync } = CurrencyExchangeRatePlugin.options;
    if (sync) {
      config.schedulerOptions.tasks = [
        ...(config.schedulerOptions.tasks ?? []),
        createCurrencyExchangeRateSyncTask(sync.schedule),
      ];
    }
    return config;
  },
})
export class CurrencyExchangeRatePlugin implements OnApplicationBootstrap, OnApplicationShutdown {
  /** @internal */
  static options: ResolvedCurrencyExchangeRatePluginOptions;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly processContext: ProcessContext,
    private readonly requestContextService: RequestContextService,
    private readonly syncService: CurrencyExchangeRateSyncService,
  ) {}

  static init(options: CurrencyExchangeRatePluginOptions): Type<CurrencyExchangeRatePlugin> {
    this.options = resolveOptions(options);
    return CurrencyExchangeRatePlugin;
  }

  // Source first: the backfill needs it.
  async onApplicationBootstrap(): Promise<void> {
    await CurrencyExchangeRatePlugin.options.source.init?.(new Injector(this.moduleRef));
    if (this.processContext.isServer) {
      await this.syncService.backfillIfEmpty(await this.requestContextService.create({ apiType: 'admin' }));
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await CurrencyExchangeRatePlugin.options.source.destroy?.();
  }
}
