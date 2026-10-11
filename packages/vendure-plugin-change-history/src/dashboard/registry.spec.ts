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
    registerChangeHistoryFieldLabels('Product', undefined as never);

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

  it('reports and skips registrations it could not render, without throwing', async () => {
    const pub = await import('./public');
    const { getChangeHistoryRegistry } = await import('./registry');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bad = <T>(value: unknown) => value as T;
    const rejects = (register: () => void, message: RegExp) => {
      error.mockClear();
      expect(register).not.toThrow();
      expect(error).toHaveBeenCalledWith(expect.stringMatching(message));
    };

    rejects(() => pub.registerChangeHistoryFieldLabels('', {}), /entityType must be a non-empty string/);
    rejects(() => pub.registerChangeHistoryFieldLabels('Product', { sku: 'SKU', name: bad({}) }), /needs a label/);
    rejects(() => pub.registerChangeHistoryValueRenderer('color', bad(undefined)), /React component/);
    rejects(() => pub.registerChangeHistoryDetailRenderer('stock', bad('table')), /React component/);
    rejects(() => pub.registerChangeHistorySource('erp', bad({ label: 'ERP', tone: 'loud' })), /tone must be/);
    rejects(
      () => pub.registerChangeHistorySource('erp', bad({ label: 'ERP', tone: 'system', icon: 'plug' })),
      /icon of source "erp" must be a React component/,
    );
    rejects(
      () => pub.registerChangeHistorySource('erp', bad({ label: 'ERP', tone: 'system', countLabels: { zeroed: 3 } })),
      /count "zeroed" of source "erp" needs a label/,
    );
    rejects(() => pub.registerChangeHistoryAction('archived', bad({})), /needs a label/);
    rejects(() => pub.registerChangeHistoryBatchKind(bad(1), { label: 'x' }), /kind must be/);
    rejects(() => pub.registerChangeHistoryEntityType('Order', bad(undefined)), /needs a label/);

    // A non-Error thrown inside a registration is reported as it is.
    const throwing = new Proxy(
      {},
      {
        ownKeys() {
          throw 'unreadable labels';
        },
      },
    );
    error.mockClear();
    expect(() => pub.registerChangeHistoryFieldLabels('Product', throwing)).not.toThrow();
    expect(error).toHaveBeenCalledWith('unreadable labels');

    // Nothing of a rejected registration is kept, not even its valid part.
    const store = getChangeHistoryRegistry();
    expect(store.fieldLabels.get('Product')?.has('sku')).toBeFalsy();
    expect(store.sources.has('erp')).toBe(false);
    expect(store.valueRenderers.has('color')).toBe(false);
  });
});
