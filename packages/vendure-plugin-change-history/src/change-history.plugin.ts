// Keep this import first: the dashboard's plugin discovery only scans compiled files that mention
// `@vendure/core` within their first 5 KB.
import { ConfigService, Injector, Logger, PluginCommonModule, Type, VendurePlugin } from '@vendure/core';
import { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { adminApiExtensions } from './api/api-extensions';
import { ChangeHistoryAdminResolver, ChangeHistoryEntryResolver } from './api/change-history-admin.resolver';
import { CapturePipeline } from './capture/capture-pipeline';
import { ChannelCapture } from './capture/channel-capture';
import { CollectionCapture } from './capture/collection-capture';
import { ChangeHistoryWriter } from './capture/entry-writer.service';
import { ChangeHistoryEventHandlers } from './capture/event-handlers';
import { FacetCapture } from './capture/facet-capture';
import { StockAdjustmentCapture } from './capture/stock-adjustments';
import { CHANGE_HISTORY_PLUGIN_OPTIONS, loggerCtx, readChangeHistory } from './constants';
import { ChangeHistoryCollectionMembers } from './entities/change-history-collection-members.entity';
import { ChangeHistoryDetail } from './entities/change-history-detail.entity';
import { ChangeHistoryEntry } from './entities/change-history-entry.entity';
import { ChangeHistoryDefinitions } from './entity-definitions/definitions.service';
import { resolveOptions } from './options';
import { ChangeHistoryReader } from './read/change-history-reader.service';
import { createRetentionTasks } from './retention/tasks';
import { ChangeHistoryContextService } from './services/change-history-context.service';
import { ChangeHistoryRetentionService } from './services/change-history-retention.service';
import { ChangeHistoryStrategies } from './services/change-history-strategies.service';
import { ChangeHistoryService } from './services/change-history.service';
import { ChangeHistoryPluginOptions, ResolvedChangeHistoryPluginOptions } from './types';

/**
 * @description
 * Records who changed what in the catalogue and when — products, variants, collections, facets, assets
 * and promotions — with before → after values, batches of bulk operations and runs of external syncs,
 * and shows it in the dashboard. Entities only: the host generates the migration.
 *
 * @example
 * ```ts
 * plugins: [
 *   ChangeHistoryPlugin.init({
 *     retention: { archive: new FileSystemArchiveStorage({ dir: './change-history-archive' }) },
 *   }),
 * ]
 * ```
 */
@VendurePlugin({
  imports: [PluginCommonModule],
  entities: [ChangeHistoryEntry, ChangeHistoryDetail, ChangeHistoryCollectionMembers],
  adminApiExtensions: {
    schema: adminApiExtensions,
    resolvers: [ChangeHistoryAdminResolver, ChangeHistoryEntryResolver],
  },
  providers: [
    { provide: CHANGE_HISTORY_PLUGIN_OPTIONS, useFactory: () => ChangeHistoryPlugin.options },
    ChangeHistoryContextService,
    ChangeHistoryStrategies,
    ChangeHistoryDefinitions,
    ChangeHistoryWriter,
    CapturePipeline,
    StockAdjustmentCapture,
    CollectionCapture,
    FacetCapture,
    ChannelCapture,
    ChangeHistoryEventHandlers,
    ChangeHistoryReader,
    ChangeHistoryService,
    ChangeHistoryRetentionService,
  ],
  exports: [ChangeHistoryService, ChangeHistoryRetentionService],
  // Resolved relative to the compiled plugin file; the sources are copied to `dist/dashboard/`. Must stay
  // a string literal: the dashboard finds it by a static scan.
  dashboard: './dashboard/index.tsx',
  compatibility: '^3.7.0',
  configuration: (config) => {
    if (!ChangeHistoryPlugin.options) {
      throw new Error('ChangeHistoryPlugin: register it as ChangeHistoryPlugin.init({ retention: { archive } })');
    }
    config.authOptions.customPermissions = [...(config.authOptions.customPermissions ?? []), readChangeHistory];
    const { retention } = ChangeHistoryPlugin.options;
    if (retention.schedule !== false) {
      config.schedulerOptions.tasks = [
        ...(config.schedulerOptions.tasks ?? []),
        ...createRetentionTasks({ ...retention, schedule: retention.schedule }),
      ];
    }
    return config;
  },
})
export class ChangeHistoryPlugin implements OnApplicationBootstrap, OnApplicationShutdown {
  /** @internal */
  static options: ResolvedChangeHistoryPluginOptions;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly strategies: ChangeHistoryStrategies,
    private readonly eventHandlers: ChangeHistoryEventHandlers,
    private readonly collections: CollectionCapture,
    private readonly configService: ConfigService,
  ) {}

  /** Validates the options (throws on anything unusable) and applies the defaults. */
  static init(options: ChangeHistoryPluginOptions): Type<ChangeHistoryPlugin> {
    this.options = resolveOptions(options);
    return ChangeHistoryPlugin;
  }

  /** Runs on the server and on the worker: both publish catalogue events. */
  async onApplicationBootstrap(): Promise<void> {
    await this.strategies.init(new Injector(this.moduleRef));
    this.warnWithoutScheduler();
    this.eventHandlers.register();
    // Never fails the bootstrap; a collection without a snapshot would lose its first change of contents.
    await this.collections.seedMissing();
  }

  /** The built-in retention tasks need a scheduler; core's default strategy runs nothing. */
  private warnWithoutScheduler(): void {
    const strategy = this.configService.schedulerOptions?.schedulerStrategy;
    if (
      ChangeHistoryPlugin.options.retention.schedule !== false &&
      strategy?.constructor?.name === 'NoopSchedulerStrategy'
    ) {
      Logger.warn(
        '[ChangeHistory] retention tasks are registered but no scheduler runs them: add DefaultSchedulerPlugin ' +
          '(or another SchedulerStrategy), or set retention.schedule to false and call ChangeHistoryRetentionService yourself',
        loggerCtx,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.strategies.destroy();
  }
}
