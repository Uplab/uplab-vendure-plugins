/**
 * Render tests' stand-in for Lingui's catalogs: the components' macros are not compiled in unit tests, so
 * `t` looks its messages up in the package's own catalogs (`i18n/{en,uk}.po`) — a test reads the same
 * Ukrainian as the dashboard.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Catalog = Map<string, string>;

function parse(lang: string): Catalog {
  const text = readFileSync(join(__dirname, '..', 'i18n', `${lang}.po`), 'utf8');
  const catalog: Catalog = new Map();
  for (const block of text.split(/\n\n+/)) {
    const id = /^msgid "(.*)"$/m.exec(block)?.[1];
    const translation = /^msgstr "(.*)"$/m.exec(block)?.[1];
    if (id && translation) {
      catalog.set(id, translation);
    }
  }
  return catalog;
}

const catalogs: Record<string, Catalog> = { en: parse('en'), uk: parse('uk') };
let locale = 'en';

/** The language the next render reads. */
export function setLocale(next: 'en' | 'uk'): void {
  locale = next;
}

export function translateMessage(message: string): string {
  return catalogs[locale].get(message) ?? message;
}
