import { LanguageCode } from '@vendure/core';

/**
 * @description
 * Dialling prefixes that pin a recipient to a language regardless of the language of the
 * request that triggered the message: a Ukrainian mobile number is a stronger signal
 * about what its owner reads than the storefront's current locale.
 *
 * This is the only place the plugin infers anything from a phone number. Pass the
 * `resolveLanguage` plugin option to replace the rule entirely.
 */
export const languageByDiallingPrefix: Readonly<Record<string, LanguageCode>> = {
  '380': LanguageCode.uk,
};

/**
 * @description
 * The plugin's built-in language rule. Returns `undefined` when the recipient's number
 * says nothing about their language, in which case the caller falls back to the language
 * of the request context.
 */
export function defaultResolveLanguage(recipient: string): LanguageCode | undefined {
  const prefix = Object.keys(languageByDiallingPrefix).find((p) => recipient.startsWith(p));
  return prefix ? languageByDiallingPrefix[prefix] : undefined;
}
