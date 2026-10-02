import { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  CurrencyCode,
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
import { EXCHANGE_RATES_PLUGIN_OPTIONS, DEFAULT_SYNC_SCHEDULE } from './constants';
import { createExchangeRateSyncTask } from './exchange-rate-sync.task';
import { CurrencyExchangeRate } from './entities/currency-exchange-rate.entity';
import { CurrencyExchangeRateSyncService } from './services/currency-exchange-rate-sync.service';
import { CurrencyExchangeRateService } from './services/currency-exchange-rate.service';
import { ExchangeRatesPluginOptions, ResolvedExchangeRatesPluginOptions } from './types';

function resolveOptions(options: ExchangeRatesPluginOptions): ResolvedExchangeRatesPluginOptions {
  if (options.baseCurrency && !(Object.values(CurrencyCode) as string[]).includes(options.baseCurrency)) {
    throw new Error(`ExchangeRatesPlugin: "${options.baseCurrency}" is not a CurrencyCode`);
  }
  return {
    source: options.source,
    baseCurrency: options.baseCurrency,
    sync: options.sync === false ? false : { schedule: options.sync?.schedule ?? DEFAULT_SYNC_SCHEDULE },
  };
}

/**
 * @description
 * Exchange rates for showing and charging prices in other currencies, in any base currency. Rates come
 * from a pluggable {@link ExchangeRateSource} (the ECB, Frankfurter, Monobank, the NBU, fixed rates or
 * your own), are refreshed on a schedule, and can be overridden per currency in the dashboard.
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
    { provide: EXCHANGE_RATES_PLUGIN_OPTIONS, useFactory: () => ExchangeRatesPlugin.options },
    CurrencyExchangeRateService,
    CurrencyExchangeRateSyncService,
  ],
  exports: [CurrencyExchangeRateService, CurrencyExchangeRateSyncService],
  compatibility: '^3.7.0',
  configuration: (config) => {
    const { sync } = ExchangeRatesPlugin.options;
    if (sync) {
      config.schedulerOptions.tasks = [
        ...(config.schedulerOptions.tasks ?? []),
        createExchangeRateSyncTask(sync.schedule),
      ];
    }
    return config;
  },
})
export class ExchangeRatesPlugin implements OnApplicationBootstrap, OnApplicationShutdown {
  /** @internal */
  static options: ResolvedExchangeRatesPluginOptions;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly processContext: ProcessContext,
    private readonly requestContextService: RequestContextService,
    private readonly syncService: CurrencyExchangeRateSyncService,
  ) {}

  static init(options: ExchangeRatesPluginOptions): Type<ExchangeRatesPlugin> {
    this.options = resolveOptions(options);
    return ExchangeRatesPlugin;
  }

  // Source first: the backfill needs it.
  async onApplicationBootstrap(): Promise<void> {
    await ExchangeRatesPlugin.options.source.init?.(new Injector(this.moduleRef));
    if (this.processContext.isServer) {
      await this.syncService.backfillIfEmpty(await this.requestContextService.create({ apiType: 'admin' }));
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await ExchangeRatesPlugin.options.source.destroy?.();
  }
}
