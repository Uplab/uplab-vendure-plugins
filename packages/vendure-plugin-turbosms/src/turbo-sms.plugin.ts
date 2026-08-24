import { PluginCommonModule, type Type, VendurePlugin } from '@vendure/core';
import { DEFAULT_TURBOSMS_API_URL, DEFAULT_TURBOSMS_TIMEOUT, TURBOSMS_PLUGIN_OPTIONS } from './constants';
import { createLowBalanceTask } from './low-balance-task';
import { TurboSmsService } from './turbo-sms.service';
import { type ResolvedTurboSmsPluginOptions, type TurboSmsPluginOptions } from './types';

/**
 * @description
 * Sends transactional SMS through [TurboSMS](https://turbosms.ua/).
 *
 * The plugin adds no API extensions and no entities — it exports {@link TurboSmsService}
 * for other plugins and for the host application to inject, and publishes
 * {@link TurboSmsSentEvent} / {@link TurboSmsFailedEvent} on the event bus.
 *
 * @example
 * ```ts
 * import { TurboSmsPlugin } from '@uplab/vendure-plugin-turbosms';
 *
 * export const config: VendureConfig = {
 *   plugins: [
 *     TurboSmsPlugin.init({
 *       apiKey: process.env.TURBOSMS_API_KEY!,
 *       sender: 'MyShop',
 *       dryRun: process.env.NODE_ENV !== 'production',
 *     }),
 *   ],
 * };
 * ```
 */
@VendurePlugin({
  compatibility: '^3.7.0',
  imports: [PluginCommonModule],
  providers: [{ provide: TURBOSMS_PLUGIN_OPTIONS, useFactory: () => TurboSmsPlugin.options }, TurboSmsService],
  exports: [TurboSmsService],
  configuration: (config) => {
    const { lowBalanceAlert } = TurboSmsPlugin.options;
    if (lowBalanceAlert) {
      config.schedulerOptions.tasks = [...(config.schedulerOptions.tasks ?? []), createLowBalanceTask(lowBalanceAlert)];
    }
    return config;
  },
})
export class TurboSmsPlugin {
  /** @internal */
  static options: ResolvedTurboSmsPluginOptions;

  /**
   * @description
   * Configures the plugin. See {@link TurboSmsPluginOptions}.
   */
  static init(options: TurboSmsPluginOptions): Type<TurboSmsPlugin> {
    this.options = {
      ...options,
      dryRun: options.dryRun ?? false,
      timeout: options.timeout ?? DEFAULT_TURBOSMS_TIMEOUT,
      apiUrl: withTrailingSlash(options.apiUrl ?? DEFAULT_TURBOSMS_API_URL),
    };
    return TurboSmsPlugin;
  }
}

/**
 * Endpoints are resolved against `apiUrl` as relative URLs, which drops the last path
 * segment of a base that does not end in a slash.
 */
function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
