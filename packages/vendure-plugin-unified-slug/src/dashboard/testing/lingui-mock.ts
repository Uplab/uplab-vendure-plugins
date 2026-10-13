/**
 * `@lingui/react/macro` for render tests: see `./i18n.ts`. Used with
 * `vi.mock('@lingui/react/macro', () => import('./testing/lingui-mock'))`.
 */
import { translateMessage } from './i18n';

/** The uncompiled `t` macro is a tag: the message is its literal text. */
const t = (strings: TemplateStringsArray) => translateMessage(strings.join(''));

export function useLingui() {
  return { t };
}
