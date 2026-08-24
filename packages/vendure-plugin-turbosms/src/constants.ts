/**
 * The injection token under which the plugin options are provided.
 */
export const TURBOSMS_PLUGIN_OPTIONS = Symbol('TURBOSMS_PLUGIN_OPTIONS');

/**
 * The context string used by this plugin when logging.
 */
export const loggerCtx = 'TurboSmsPlugin';

/**
 * The default base URL of the TurboSMS REST API.
 */
export const DEFAULT_TURBOSMS_API_URL = 'https://api.turbosms.ua/';
