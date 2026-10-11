import { afterEach, describe, expect, it, vi } from 'vitest';

const REGISTRY_KEY = Symbol.for('@uplab/vendure-plugin-change-history/registry');
const Renderer = () => null;

afterEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
  vi.resetModules();
});

describe('change history dashboard registry', () => {
  it('is one store for every copy of the module (the Vite dev server may load two)', async () => {
    const first = await import('./public');
    vi.resetModules();
    const second = await import('./public');
    const registry = await import('./registry');
    expect(second).not.toBe(first);

    first.registerChangeHistorySource('erp_sync', { label: 'ERP sync', tone: 'system' });
    first.registerChangeHistorySource('erp_stock', {
      label: 'ERP stock',
      tone: 'system',
      icon: Renderer,
      countLabels: { zeroed: { id: 'host.zeroed' } },
    });
    second.registerChangeHistoryAction('archived', { label: { id: 'host.archived', message: 'archived' } });

    const store = registry.getChangeHistoryRegistry();
    expect(store.sources.get('erp_sync')).toEqual({ label: 'ERP sync', tone: 'system' });
    expect(store.actions.get('archived')).toEqual({ label: { id: 'host.archived', message: 'archived' } });
  });

  it('merges field labels per entity type, the later registration winning', async () => {
    const { registerChangeHistoryFieldLabels } = await import('./public');
    const { getChangeHistoryRegistry } = await import('./registry');

    registerChangeHistoryFieldLabels('Product', { 'customFields.price': 'Price', name: 'Name' });
    registerChangeHistoryFieldLabels('Product', { name: { id: 'host.name' } });

    expect(Object.fromEntries(getChangeHistoryRegistry().fieldLabels.get('Product')!)).toEqual({
      'customFields.price': 'Price',
      name: { id: 'host.name' },
    });
  });

  it('keeps renderers, batch kinds and entity types', async () => {
    const pub = await import('./public');
    const { getChangeHistoryRegistry } = await import('./registry');
    const route = () => '/product-order/global';

    pub.registerChangeHistoryValueRenderer('color', Renderer);
    pub.registerChangeHistoryDetailRenderer('stock', Renderer);
    pub.registerChangeHistoryBatchKind('bulk_edit', { label: 'Bulk edit' });
    pub.registerChangeHistoryEntityType('ProductOrder', { label: 'Product order', route });

    const store = getChangeHistoryRegistry();
    expect(store.valueRenderers.get('color')).toBe(Renderer);
    expect(store.detailRenderers.get('stock')).toBe(Renderer);
    expect(store.batchKinds.get('bulk_edit')).toEqual({ label: 'Bulk edit' });
    expect(store.entityTypes.get('ProductOrder')).toEqual({ label: 'Product order', route });
    expect(pub.CHANGE_HISTORY_NAV_ORDER).toBe(600);
  });

  it('rejects registrations it could not render', async () => {
    const pub = await import('./public');
    const bad = <T>(value: unknown) => value as T;

    expect(() => pub.registerChangeHistoryFieldLabels('', {})).toThrow(/entityType must be a non-empty string/);
    expect(() => pub.registerChangeHistoryFieldLabels('Product', { name: bad({}) })).toThrow(/needs a label/);
    expect(() => pub.registerChangeHistoryValueRenderer('color', bad(undefined))).toThrow(/React component/);
    expect(() => pub.registerChangeHistoryDetailRenderer('stock', bad('table'))).toThrow(/React component/);
    expect(() => pub.registerChangeHistorySource('erp', bad({ label: 'ERP', tone: 'loud' }))).toThrow(/tone must be/);
    expect(() => pub.registerChangeHistorySource('erp', bad({ label: 'ERP', tone: 'system', icon: 'plug' }))).toThrow(
      /icon of source "erp" must be a React component/,
    );
    expect(() =>
      pub.registerChangeHistorySource('erp', bad({ label: 'ERP', tone: 'system', countLabels: { zeroed: 3 } })),
    ).toThrow(/count "zeroed" of source "erp" needs a label/);
    expect(() => pub.registerChangeHistoryAction('archived', bad({}))).toThrow(/needs a label/);
    expect(() => pub.registerChangeHistoryBatchKind(bad(1), { label: 'x' })).toThrow(/kind must be/);
    expect(() => pub.registerChangeHistoryEntityType('Order', bad(undefined))).toThrow(/needs a label/);
  });
});
