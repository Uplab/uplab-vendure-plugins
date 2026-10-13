/**
 * `@lingui/react/macro` and `@lingui/react` for render tests: see `./i18n.ts`. Used with
 * `vi.mock('@lingui/react/macro', () => import('./testing/lingui-mock'))` (and the same for `@lingui/react`).
 */
import { Children, type ReactNode } from 'react';
import { currentLocale, translateDescriptor, translateMessage } from './i18n';

/** The macro's text, as the source writes it: plain text children (whitespace runs read as one space). */
function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export function Trans({ children, context }: { children?: ReactNode; context?: string }) {
  return <>{translateMessage(textOf(children), context)}</>;
}

const i18n = {
  _: (descriptor: { id: string; message?: string } | string) =>
    typeof descriptor === 'string' ? translateDescriptor({ id: descriptor }) : translateDescriptor(descriptor),
  get locale() {
    return currentLocale();
  },
};

/** One `t` across renders, as Lingui keeps one per locale: a memo that depends on it is not rebuilt each render. */
const t = (descriptor: { message: string; context?: string } | string) =>
  typeof descriptor === 'string' ? descriptor : translateMessage(descriptor.message, descriptor.context);

export function useLingui() {
  return { i18n, t };
}
