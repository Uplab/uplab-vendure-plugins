import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  actionLabelOf,
  ALL_BUILT_IN_LABELS,
  batchKindLabelOf,
  batchKindOf,
  countLabelOf,
  entityTypeLabelOf,
  entityTypePluralLabelOf,
  FIELD_LABELS,
  fieldLabelOf,
  enumValueLabelOf,
  humanizeKey,
  humanizePhrase,
  knownBatchKindLabelOf,
  OBJECTS_LABEL,
  sourceOf,
  splitLanguage,
} from './labels';
import { getChangeHistoryRegistry } from './registry';

const REGISTRY_KEY = Symbol.for('@uplab/vendure-plugin-change-history/registry');

afterEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
});

describe('splitLanguage', () => {
  it('splits a language-code suffix off a translatable key', () => {
    expect(splitLanguage('name.uk')).toEqual({ base: 'name', language: 'uk' });
    expect(splitLanguage('customFields.subtitle.en')).toEqual({ base: 'customFields.subtitle', language: 'en' });
    expect(splitLanguage('description.pt_BR')).toEqual({ base: 'description', language: 'pt_BR' });
  });

  it('keeps keys without one whole', () => {
    expect(splitLanguage('enabled')).toEqual({ base: 'enabled' });
    expect(splitLanguage('customFields.price')).toEqual({ base: 'customFields.price' });
    expect(splitLanguage('customFields.sku')).toEqual({ base: 'customFields.sku' });
  });
});

describe('humanizeKey', () => {
  it('turns a key nobody labelled into words', () => {
    expect(humanizeKey('customFields.discountStartAt')).toBe('Discount start at');
    expect(humanizeKey('stock_threshold')).toBe('Stock threshold');
    expect(humanizeKey('')).toBe('');
  });

  it('keeps acronyms as they are written', () => {
    expect(humanizeKey('syncERPStock')).toBe('Sync ERP stock');
    expect(humanizeKey('ProductOrder')).toBe('Product order');
    expect(humanizePhrase('products_reordered')).toBe('products reordered');
    expect(humanizePhrase('ERP_sync')).toBe('ERP sync');
    expect(humanizePhrase('')).toBe('');
  });
});

describe('fieldLabelOf', () => {
  it('uses the built-in label of a core field, with the language of a translatable one', () => {
    const registry = getChangeHistoryRegistry();
    expect(fieldLabelOf(registry, 'Product', 'name.uk')).toEqual({ label: FIELD_LABELS.name, language: 'uk' });
    expect(fieldLabelOf(registry, 'ProductVariant', 'sku')).toEqual({ label: FIELD_LABELS.sku, language: undefined });
  });

  it('prefers the host label, by full key and then by the key without the language', () => {
    const registry = getChangeHistoryRegistry();
    registry.fieldLabels.set(
      'Product',
      new Map<string, string | { id: string }>([
        ['name', 'Title'],
        ['customFields.subtitle.uk', 'Підзаголовок'],
      ]),
    );
    expect(fieldLabelOf(registry, 'Product', 'name.en')).toEqual({ label: 'Title', language: 'en' });
    expect(fieldLabelOf(registry, 'Product', 'customFields.subtitle.uk')).toEqual({ label: 'Підзаголовок' });
    // Another type keeps the built-in label.
    expect(fieldLabelOf(registry, 'Collection', 'name.en').label).toBe(FIELD_LABELS.name);
  });

  it('falls back to the readable key', () => {
    expect(fieldLabelOf(getChangeHistoryRegistry(), 'Product', 'customFields.fullPrice')).toEqual({
      label: 'Full price',
      language: undefined,
    });
  });
});

describe('type, action, batch and count labels', () => {
  it('reads host registrations first, then the built-ins, then the raw value', () => {
    const registry = getChangeHistoryRegistry();
    registry.entityTypes.set('ProductOrder', { label: 'Product order' });
    registry.actions.set('archived', { label: 'archived' });
    registry.batchKinds.set('bulk_edit', { label: 'bulk edit' });
    registry.sources.set('erp', { label: 'ERP', tone: 'system', countLabels: { zeroed: 'zeroed' } });

    expect(entityTypeLabelOf(registry, 'ProductOrder')).toBe('Product order');
    expect(entityTypeLabelOf(registry, 'Product')).toEqual({ id: 'change-history.type.Product', message: 'Product' });
    expect(entityTypeLabelOf(registry, 'Thing')).toBe('Thing');
    expect(entityTypeLabelOf(registry, 'StockThreshold')).toBe('Stock threshold');

    expect(actionLabelOf(registry, 'archived')).toBe('archived');
    expect(actionLabelOf(registry, 'stock_adjusted')).toEqual({
      id: 'change-history.action.stock_adjusted',
      message: 'stock adjusted',
    });
    expect(actionLabelOf(registry, 'set_badge')).toBe('set badge');

    expect(batchKindLabelOf(registry, 'bulk_edit')).toBe('bulk edit');
    expect(batchKindLabelOf(registry, 'collection_rules')).toMatchObject({
      id: 'change-history.batch.collection_rules',
    });
    // A kind nobody labelled reads as a bulk operation, never as its raw key.
    expect(batchKindLabelOf(registry, 'odoo_import')).toMatchObject({ id: 'change-history.action.batch' });
    expect(knownBatchKindLabelOf(registry, 'odoo_import')).toBeUndefined();
    expect(knownBatchKindLabelOf(registry, 'bulk_edit')).toBe('bulk edit');

    expect(countLabelOf(registry, 'erp', 'zeroed')).toBe('zeroed');
    expect(countLabelOf(registry, 'erp', 'updated')).toMatchObject({ id: 'change-history.count.updated' });
    expect(countLabelOf(registry, 'other', 'skipped_items')).toBe('skipped items');
  });

  it('labels the values of core enums', () => {
    expect(enumValueLabelOf('ProductVariant', 'trackInventory', 'INHERIT')).toMatchObject({
      id: 'change-history.enum.GlobalFlag.INHERIT',
    });
    expect(enumValueLabelOf('Asset', 'type', 'IMAGE')).toMatchObject({ id: 'change-history.enum.AssetType.IMAGE' });
    // `type` is an asset's file type only.
    expect(enumValueLabelOf('Product', 'type', 'IMAGE')).toBeUndefined();
    expect(enumValueLabelOf('ProductVariant', 'trackInventory', 'SOMETIMES')).toBeUndefined();
  });

  it('gives plural nouns for the run count line', () => {
    expect(entityTypePluralLabelOf('ProductVariant').message).toBe('Variants');
    expect(entityTypePluralLabelOf('Warehouse')).toBe(OBJECTS_LABEL);
    expect(entityTypePluralLabelOf(undefined)).toBe(OBJECTS_LABEL);
  });
});

describe('sourceOf', () => {
  it('knows the built-in sources and their tones', () => {
    const registry = getChangeHistoryRegistry();
    expect(sourceOf(registry, 'collection_rules')).toMatchObject({ tone: 'system' });
    expect(sourceOf(registry, 'api_key')).toMatchObject({ tone: 'human' });
  });

  it('returns a host source as registered', () => {
    const registry = getChangeHistoryRegistry();
    const definition = { label: 'Scheduled action', tone: 'scheduled' as const };
    registry.sources.set('scheduled_action', definition);
    expect(sourceOf(registry, 'scheduled_action')).toBe(definition);
  });

  it('treats an unknown source as a person unless the actor was the system', () => {
    const registry = getChangeHistoryRegistry();
    expect(sourceOf(registry, 'pim_sync', 'system')).toEqual({ label: 'Pim sync', tone: 'system' });
    expect(sourceOf(registry, 'import_ui', 'admin')).toEqual({ label: 'Import ui', tone: 'human' });
  });
});

describe('batchKindOf', () => {
  it('reads the kind from `<kind>:<uuid>`', () => {
    expect(batchKindOf('bulk_edit:6f9c2a7e-1b2c-4d5e-8f90-123456789abc')).toBe('bulk_edit');
    expect(batchKindOf('no-kind')).toBeUndefined();
    expect(batchKindOf(null)).toBeUndefined();
  });
});

describe('the catalogs', () => {
  const catalog = (lang: string) => readFileSync(join(__dirname, 'i18n', `${lang}.po`), 'utf8');

  /** msgctxt + msgid → msgstr of every entry. */
  function entries(text: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const block of text.split(/\n\n+/)) {
      const id = /^msgid "(.*)"$/m.exec(block)?.[1];
      const context = /^msgctxt "(.*)"$/m.exec(block)?.[1] ?? '';
      const translation = /^msgstr "(.*)"$/m.exec(block)?.[1];
      if (id) {
        result.set(`${context}|${id}`, translation ?? '');
      }
    }
    return result;
  }

  it('translate every built-in label in English and Ukrainian', () => {
    for (const lang of ['en', 'uk']) {
      const messages = entries(catalog(lang));
      for (const builtIn of ALL_BUILT_IN_LABELS) {
        expect(messages.get(`|${builtIn.id}`), `${lang}: ${builtIn.id}`).toBeTruthy();
      }
    }
    expect(entries(catalog('en')).get('|change-history.field.facetValues')).toBe(FIELD_LABELS.facetValues.message);
  });

  it('translate every message the components use, and only those', () => {
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
        if (item.isDirectory()) {
          return sources(join(dir, item.name));
        }
        return item.name.endsWith('.tsx') && !item.name.endsWith('.spec.tsx')
          ? [readFileSync(join(dir, item.name), 'utf8')]
          : [];
      });
    const used = new Set<string>();
    for (const source of sources(__dirname)) {
      for (const match of source.matchAll(/<Trans context="change-history">([\s\S]*?)<\/Trans>/g)) {
        used.add(`change-history|${match[1].replace(/\s+/g, ' ').trim()}`);
      }
      for (const match of source.matchAll(/message: '([^']*)', context: 'change-history'/g)) {
        used.add(`change-history|${match[1]}`);
      }
    }
    expect(used.size).toBeGreaterThan(40);
    for (const lang of ['en', 'uk']) {
      const contexted = [...entries(catalog(lang)).keys()].filter((key) => key.startsWith('change-history|'));
      expect(contexted.sort(), lang).toEqual([...used].sort());
    }
  });

  it('spell Ukrainian words in Cyrillic only (no Latin look-alikes such as H, i, o, c)', () => {
    const uk = entries(catalog('uk'));
    // «Ні» is U+041D U+0456 and looks exactly like Latin "Hi": compare code points, not glyphs.
    expect(uk.get('change-history|No')).toBe('Ні');
    expect(uk.get('change-history|Yes')).toBe('Так');
    const mixed: string[] = [];
    for (const [key, translation] of uk) {
      for (const word of translation.split(/[^\p{L}]+/u)) {
        if (/\p{Script=Latin}/u.test(word) && /\p{Script=Cyrillic}/u.test(word)) {
          mixed.push(`${key}: ${word}`);
        }
      }
    }
    expect(mixed).toEqual([]);
  });

  it('have the same messages in both languages, all translated, with a context or an explicit id, and no ICU', () => {
    const en = entries(catalog('en'));
    const uk = entries(catalog('uk'));
    expect([...uk.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [key, translation] of uk) {
      expect(translation, key).not.toBe('');
      // The column settings menu translates `fieldName.<column>`: the feed's own columns are in the catalogs.
      expect(
        key.startsWith('change-history|') || key.startsWith('|change-history.') || key.startsWith('|fieldName.'),
        key,
      ).toBe(true);
      expect(translation, key).not.toMatch(/[{}]/);
    }
  });
});
