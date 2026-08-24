import { LanguageCode, PluginCommonModule, type Type, VendurePlugin } from '@vendure/core';
import { DEFAULT_TURBOSMS_API_URL, TURBOSMS_PLUGIN_OPTIONS } from './constants';
import { SmsService } from './sms.service';
import { TurboSmsApiService } from './turbo-sms-api.service';
import { type ResolvedTurboSmsPluginOptions, type TurboSmsPluginOptions } from './types';

/**
 * @description
 * Sends transactional SMS through [TurboSMS](https://turbosms.ua/).
 *
 * The plugin adds no API extensions and no entities — it exports {@link SmsService} and
 * {@link TurboSmsApiService} for other plugins and for the host application to inject.
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
  providers: [
    { provide: TURBOSMS_PLUGIN_OPTIONS, useFactory: () => TurboSmsPlugin.options },
    TurboSmsApiService,
    SmsService,
  ],
  exports: [SmsService, TurboSmsApiService],
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
      dryRun: false,
      apiUrl: DEFAULT_TURBOSMS_API_URL,
      defaultLanguageCode: LanguageCode.en,
      ...options,
    };
    return TurboSmsPlugin;
  }
}
