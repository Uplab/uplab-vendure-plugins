import { Asset, CustomFieldConfig } from '@vendure/core';
import { describe, expect, it } from 'vitest';
import { customFieldSpecs, normaliseCustomFieldValue, normaliseScalar } from './custom-field-specs';

const configs = [
  { name: 'subtitle', type: 'string' },
  { name: 'size', type: 'string', options: [{ value: 'S' }, { value: 'M' }] },
  { name: 'seoTitle', type: 'localeString' },
  { name: 'body', type: 'localeText', ui: { component: 'rich-text-form-input' } },
  { name: 'isHit', type: 'boolean' },
  { name: 'saleFrom', type: 'datetime' },
  { name: 'priority', type: 'int' },
  { name: 'price', type: 'int' },
  { name: 'fullPrice', type: 'int', ui: { component: 'currency-form-input' } },
  { name: 'dims', type: 'struct', fields: [] },
  { name: 'tags', type: 'string', list: true },
  { name: 'image', type: 'relation', entity: Asset },
  { name: 'gallery', type: 'relation', entity: Asset, list: true },
  { name: 'erpId', type: 'string', readonly: true },
  { name: 'viewCount', type: 'int', readonly: true },
  { name: 'secret', type: 'string', internal: true },
] as unknown as CustomFieldConfig[];

describe('customFieldSpecs', () => {
  it('derives a kind from the type and the form component', () => {
    const kinds = Object.fromEntries(customFieldSpecs(configs).map((spec) => [spec.name, spec.kind]));
    expect(kinds).toEqual({
      subtitle: 'text',
      size: 'enum',
      seoTitle: 'text',
      body: 'richtext',
      isHit: 'bool',
      saleFrom: 'date',
      priority: 'text',
      price: 'text',
      fullPrice: 'money',
      dims: 'json',
      tags: 'json',
      image: 'ref',
      gallery: 'refs',
    });
  });

  it('leaves out readonly and internal fields unless the host includes them', () => {
    const names = customFieldSpecs(configs, { includeReadonlyCustomFields: ['erpId'] }).map((spec) => spec.name);
    expect(names).toContain('erpId');
    expect(names).not.toContain('viewCount');
    expect(names).not.toContain('secret');
  });

  it('applies the host value kinds', () => {
    const price = customFieldSpecs(configs, { fieldKinds: { 'customFields.price': 'money' } }).find(
      (spec) => spec.name === 'price',
    );
    expect(price).toMatchObject({ key: 'customFields.price', kind: 'money', translatable: false, list: false });
  });

  it('marks translatable and relation fields', () => {
    const specs = customFieldSpecs(configs);
    expect(specs.find((s) => s.name === 'seoTitle')?.translatable).toBe(true);
    expect(specs.find((s) => s.name === 'gallery')).toMatchObject({ relation: Asset, list: true });
    expect(customFieldSpecs(undefined)).toEqual([]);
  });
});

describe('normaliseCustomFieldValue', () => {
  const [image, gallery, saleFrom] = ['image', 'gallery', 'saleFrom'].map((name) =>
    customFieldSpecs(configs).find((s) => s.name === name)!,
  );

  it('stores relations as ids', () => {
    expect(normaliseCustomFieldValue(image, { id: 5, name: 'x' })).toBe('5');
    expect(normaliseCustomFieldValue(image, null)).toBeNull();
    expect(normaliseCustomFieldValue(gallery, [{ id: 10 }, { id: 9 }])).toEqual(['9', '10']);
    expect(normaliseCustomFieldValue(gallery, undefined)).toEqual([]);
  });

  it('stores dates as ISO strings', () => {
    expect(normaliseCustomFieldValue(saleFrom, new Date('2026-10-01T10:00:00Z'))).toBe('2026-10-01T10:00:00.000Z');
    expect(normaliseScalar([new Date(0), 1])).toEqual(['1970-01-01T00:00:00.000Z', 1]);
    expect(normaliseScalar(undefined)).toBeNull();
  });
});
