/**
 * Render tests' stand-in for Lingui: the components' macros are not compiled in unit tests, so `Trans`,
 * `t` and `i18n._` look their messages up in the package's own catalogs (`i18n/{en,uk}.po`) — a test reads
 * the same Ukrainian as the dashboard.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Catalog = Map<string, string>;

function parse(lang: string): Catalog {
  const text = readFileSync(join(__dirname, '..', 'i18n', `${lang}.po`), 'utf8');
  const catalog: Catalog = new Map();
  for (const block of text.split(/\n\n+/)) {
    const id = /^msgid "(.*)"$/m.exec(block)?.[1];
    const context = /^msgctxt "(.*)"$/m.exec(block)?.[1] ?? '';
    const translation = /^msgstr "(.*)"$/m.exec(block)?.[1];
    if (id && translation) {
      catalog.set(`${context}|${id}`, translation);
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

export function currentLocale(): string {
  return locale;
}

/** A message with a context (`<Trans context="change-history">`, `t({ message, context })`). */
export function translateMessage(message: string, context = ''): string {
  return catalogs[locale].get(`${context}|${message}`) ?? message;
}

/** A descriptor with an explicit id (`{ id: 'change-history.action.updated', message: 'updated' }`). */
export function translateDescriptor(descriptor: { id: string; message?: string }): string {
  return catalogs[locale].get(`|${descriptor.id}`) ?? descriptor.message ?? descriptor.id;
}
