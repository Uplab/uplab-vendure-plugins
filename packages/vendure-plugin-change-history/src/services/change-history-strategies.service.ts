import { Inject, Injectable } from '@nestjs/common';
import { Injector, Logger, TransactionalConnection } from '@vendure/core';
import { BeforeStateStrategy } from '../before-state/before-state-strategy';
import { selectBeforeStateStrategy } from '../before-state/select-strategy';
import { CHANGE_HISTORY_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { ResolvedChangeHistoryPluginOptions } from '../types';

/**
 * Owns the lifecycle of the strategies passed as plugin options: Vendure core runs `init` / `destroy`
 * only for strategies in `VendureConfig`, so the plugin does it for its own. The before-state strategy
 * comes first — capture needs it.
 */
@Injectable()
export class ChangeHistoryStrategies {
  private selected?: BeforeStateStrategy;

  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly connection: TransactionalConnection,
  ) {}

  /** The before-state strategy in use, chosen on bootstrap. */
  get beforeState(): BeforeStateStrategy {
    if (!this.selected) {
      throw new Error('ChangeHistoryPlugin: the before-state strategy is selected on application bootstrap');
    }
    return this.selected;
  }

  async init(injector: Injector): Promise<void> {
    const driver = this.connection.rawConnection.options.type;
    const { strategy, warning } = selectBeforeStateStrategy(this.options.beforeState, driver);
    if (warning) {
      Logger.warn(`${warning}`, loggerCtx);
    } else if (!strategy.supports(this.connection)) {
      Logger.warn(`the before-state strategy "${strategy.name}" does not support "${driver}"`, loggerCtx);
    }
    await strategy.init?.(injector);
    this.selected = strategy;

    const { archive } = this.options.retention;
    if (archive === 'none') {
      Logger.info('retention.archive is "none": compaction keeps no copy of what it strips', loggerCtx);
    } else {
      await archive.init?.(injector);
    }
  }

  async destroy(): Promise<void> {
    await this.selected?.destroy?.();
    const { archive } = this.options.retention;
    if (archive !== 'none') {
      await archive.destroy?.();
    }
  }
}
