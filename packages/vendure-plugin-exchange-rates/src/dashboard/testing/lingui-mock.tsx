/**
 * `@lingui/react/macro` for render tests: see `./i18n.ts`. Used with
 * `vi.mock('@lingui/react/macro', () => import('./testing/lingui-mock'))`.
 *
 * Uncompiled, a `Trans` with expressions (`{entity.code}`) cannot tell them from its literal text, so its
 * message is not found in the catalog and renders as written — what Lingui shows for English.
 */
import { Children, type ReactNode } from 'react';
import { currentLocale, translateMessage } from './i18n';

/** The macro's text, as the source writes it: its children (whitespace runs read as one space). */
function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export function Trans({ children }: { children?: ReactNode }) {
  return <>{translateMessage(textOf(children))}</>;
}

/** The uncompiled `t` macro is a tag: the message is its literal text. */
const t = (strings: TemplateStringsArray) => translateMessage(strings.join(''));

const i18n = {
  get locale() {
    return currentLocale();
  },
};

export function useLingui() {
  return { t, i18n };
}
