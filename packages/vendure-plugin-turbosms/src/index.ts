/**
 * The public API of this package. Every export here is a deliberate commitment: adding
 * one later is a minor release, removing one is a breaking change. Anything not listed
 * is internal and may change at any time.
 */
export { TURBOSMS_PLUGIN_OPTIONS } from './constants';
export { TurboSmsFailedEvent, TurboSmsLowBalanceEvent, TurboSmsSentEvent } from './events';
export {
  TurboSmsError,
  TurboSmsRejectedError,
  TurboSmsTransportError,
  type TurboSmsRejectedErrorDetails,
  type TurboSmsTransportErrorDetails,
} from './turbo-sms-error';
export { TurboSmsPlugin } from './turbo-sms.plugin';
export { TurboSmsService } from './turbo-sms.service';
export {
  type ResolvedTurboSmsPluginOptions,
  type TurboSmsLowBalanceAlertOptions,
  type TurboSmsPluginOptions,
  type TurboSmsRefusedRecipient,
  type TurboSmsSendOptions,
  type TurboSmsSendResult,
} from './types';
