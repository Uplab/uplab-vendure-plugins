// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerChangeHistoryDetailRenderer,
  registerChangeHistoryFieldLabels,
  registerChangeHistorySource,
  registerChangeHistoryValueRenderer,
  registerChangeHistoryValueText,
} from '../public';
import { setLocale } from '../testing/i18n';
import { useLabels } from './use-labels';

vi.mock('@lingui/react', () => import('../testing/lingui-mock'));

const REGISTRY_KEY = Symbol.for('@uplab/vendure-plugin-change-history/registry');

afterEach(() => {
  cleanup();
  setLocale('en');
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
});

const labels = () => renderHook(() => useLabels()).result.current;

describe('useLabels', () => {
  it('qualifies a field by its language, and a stock level by its location instead', () => {
    const { field } = labels();
    expect(field('Product', 'name.uk')).toBe('Name (uk)');
    expect(field('ProductVariant', 'stock', { kind: 'stock', from: 1, to: 2, location: 'Main' })).toBe('Stock (Main)');
    // A stock change without a named location reads as the field alone.
    expect(field('ProductVariant', 'stock', { kind: 'stock', from: 1, to: 2, location: '' })).toBe('Stock');
    expect(field('Product', 'name.en', { kind: 'text', from: 'a', to: 'b', location: 'Main' })).toBe('Name (en)');
  });

  it("reads a host's label as given and a built-in one in the dashboard's language", () => {
    setLocale('uk');
    registerChangeHistoryFieldLabels('Product', { 'customFields.subtitle': 'Підзаголовок' });
    const current = labels();
    expect(current.field('Product', 'customFields.subtitle')).toBe('Підзаголовок');
    expect(current.type('ProductVariant')).toBe('Варіант');
    expect(current.typePlural('ProductVariant')).toBe('Варіанти');
    expect(current.typePlural(undefined)).toBe('Об’єкти');
    expect(current.action('deleted')).toBe('видалено');
    expect(current.count('erp', 'failed')).toBe('помилки');
    expect(current.tr('as is')).toBe('as is');
  });

  it('names a batch kind nobody labelled a bulk operation, and knows it is unlabelled', () => {
    const current = labels();
    expect(current.batchKind('archive')).toBe('bulk operation');
    expect(current.knownBatchKind('archive')).toBeUndefined();
    expect(current.knownBatchKind('collection_rules')).toBe('collection contents updated');
  });

  it('labels a core enum value it knows, and leaves any other value to be shown as stored', () => {
    const current = labels();
    expect(current.enumValue('ProductVariant', 'trackInventory', 'INHERIT')).toBe('Inherit from global settings');
    expect(current.enumValue('Asset', 'type', 'IMAGE')).toBe('Image');
    expect(current.enumValue('ProductVariant', 'trackInventory', 'SOMETIMES')).toBeUndefined();
  });

  it("resolves a source's label and tone: a host's, a built-in, or an unknown system's", () => {
    registerChangeHistorySource('erp', { label: 'ERP', tone: 'system' });
    const current = labels();
    expect(current.source('erp')).toEqual({ label: 'ERP', tone: 'system' });
    expect(current.source('collection_rules')).toEqual({ label: 'Collection rules', tone: 'system' });
    expect(current.source('nightly_job', 'system')).toEqual({ label: 'Nightly job', tone: 'system' });
  });

  it("finds a host's renderers and value texts by kind", () => {
    const Renderer = () => null;
    const text = () => 'text';
    registerChangeHistoryValueRenderer('color', Renderer);
    registerChangeHistoryDetailRenderer('stock', Renderer);
    registerChangeHistoryValueText('stockThreshold', text);
    const current = labels();
    expect(current.valueRenderer('color')).toBe(Renderer);
    expect(current.detailRenderer('stock')).toBe(Renderer);
    expect(current.detailRenderer('price')).toBeUndefined();
    expect(current.valueText('stockThreshold')).toBe(text);
  });

  it('switches language with the dashboard', () => {
    const { result, rerender } = renderHook(() => useLabels());
    expect(result.current.type('Product')).toBe('Product');
    setLocale('uk');
    rerender();
    expect(result.current.type('Product')).toBe('Товар');
  });
});
