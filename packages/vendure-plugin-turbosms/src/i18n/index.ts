import { LanguageCode } from '@vendure/core';
import { type TurboSmsTranslations } from '../types';

/**
 * Message templates shipped with the plugin. These are deliberately self-contained: the
 * plugin does not register them with Vendure's `I18nService`, because that instance
 * translates GraphQL errors for API responses and is not available to background code
 * that sends SMS. Override or extend them via the `translations` plugin option.
 */
export const defaultTranslations: Partial<Record<LanguageCode, TurboSmsTranslations>> = {
  [LanguageCode.en]: {
    otpCode: 'Your {sender} login code – {code}',
  },
  [LanguageCode.uk]: {
    otpCode: 'Ваш код входу {sender} – {code}',
  },
  [LanguageCode.pl]: {
    otpCode: 'Twój kod logowania {sender} – {code}',
  },
};

/**
 * Replaces `{placeholder}` tokens in a template. Unknown tokens are left untouched.
 */
export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}
