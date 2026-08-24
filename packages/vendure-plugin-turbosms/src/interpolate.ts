/**
 * @description
 * Replaces `{placeholder}` tokens in a template with the given values. Unknown tokens are
 * left untouched.
 *
 * The plugin does not render messages itself — this is here because filling a short
 * template is the one thing every caller ends up writing, and it saves reaching for an
 * i18n library to build a two-placeholder string.
 *
 * @example
 * ```ts
 * interpolate('Your {brand} code is {code}', { brand: 'MyShop', code: '1234' });
 * // 'Your MyShop code is 1234'
 * ```
 */
export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}
