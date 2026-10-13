// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import type { DashboardExtension, DashboardPageBlockDefinition } from '@vendure/dashboard';
import { defineDashboardExtension } from '@vendure/dashboard';
import { isValidElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryBlock } from './components/history-block';
import './index';
import { changeHistoryListRoute } from './routes/change-history-list';
import { setLocale } from './testing/i18n';
import { RECENT_CHANGES_WIDGET_ID, RecentChangesWidget } from './widgets/recent-changes-widget';

vi.mock('@vendure/dashboard', async () => ({
  ...(await import('./testing/dashboard-mock')),
  defineDashboardExtension: vi.fn(),
}));
vi.mock('@lingui/react/macro', () => import('./testing/lingui-mock'));
vi.mock('@lingui/react', () => import('./testing/lingui-mock'));

beforeEach(() => setLocale('uk'));
afterEach(() => {
  cleanup();
  setLocale('en');
});

const extension = () => vi.mocked(defineDashboardExtension).mock.calls[0][0] as DashboardExtension;
const blocks = () => extension().pageBlocks as DashboardPageBlockDefinition[];

describe('the dashboard extension', () => {
  it('is defined once, on import', () => {
    expect(defineDashboardExtension).toHaveBeenCalledTimes(1);
  });

  it('adds the change history feed', () => {
    expect(extension().routes).toEqual([changeHistoryListRoute]);
  });

  it('adds the history block after the last core block of each detail page', () => {
    expect(blocks().map((block) => [block.id, block.location.pageId, block.location.position])).toEqual([
      ['change-history-product', 'product-detail', { blockId: 'product-variants-table', order: 'after' }],
      ['change-history-product-new-variants', 'product-detail', { blockId: 'generate-variants', order: 'after' }],
      ['change-history-product-variant', 'product-variant-detail', { blockId: 'stock', order: 'after' }],
      ['change-history-collection', 'collection-detail', { blockId: 'contents', order: 'after' }],
      ['change-history-facet', 'facet-detail', { blockId: 'facet-values', order: 'after' }],
      ['change-history-promotion', 'promotion-detail', { blockId: 'actions', order: 'after' }],
      ['change-history-asset', 'asset-detail', { blockId: 'custom-fields', order: 'after' }],
      ['change-history-facet-value', 'facet-value-detail', { blockId: 'custom-fields', order: 'after' }],
    ]);
    for (const block of blocks()) {
      expect(block.location.column).toBe('main');
      expect(block.component).toBe(HistoryBlock);
      expect(block.requiresPermission).toBe('ReadChangeHistory');
    }
  });

  it('titles every block «Історія змін»', () => {
    for (const block of blocks()) {
      expect(isValidElement(block.title)).toBe(true);
      const { container, unmount } = render(block.title as ReactElement);
      expect(container.textContent).toBe('Історія змін');
      unmount();
    }
  });

  it('renders the block only on a page with an entity, never on a «new» page', () => {
    const [block] = blocks();
    const shouldRender = block.shouldRender as (context: Record<string, unknown>) => boolean;
    expect(shouldRender({ entity: { id: '1' } })).toBe(true);
    expect(shouldRender({ entity: undefined })).toBe(false);
    expect(shouldRender({})).toBe(false);
  });

  it('adds the «Recent changes» widget for those allowed to read the history', () => {
    expect(extension().widgets).toEqual([
      {
        id: RECENT_CHANGES_WIDGET_ID,
        name: 'Recent changes',
        component: RecentChangesWidget,
        defaultSize: { w: 6, h: 6 },
        minSize: { w: 4, h: 4 },
        requiresPermissions: ['ReadChangeHistory'],
      },
    ]);
  });
});
