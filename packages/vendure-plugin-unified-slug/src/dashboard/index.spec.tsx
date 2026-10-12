// @vitest-environment jsdom
import type { DashboardExtension } from '@vendure/dashboard';
import { defineDashboardExtension } from '@vendure/dashboard';
import { describe, expect, it, vi } from 'vitest';
import { UnifiedSlugInput } from './components/unified-slug-input';
import './index';

vi.mock('@vendure/dashboard', async () => ({
  ...(await import('./testing/dashboard-mock')),
  defineDashboardExtension: vi.fn(),
}));
vi.mock('@lingui/react/macro', () => import('./testing/lingui-mock'));

const extension = () => vi.mocked(defineDashboardExtension).mock.calls[0][0] as DashboardExtension;

describe('the dashboard extension', () => {
  it('is defined once, on import', () => {
    expect(defineDashboardExtension).toHaveBeenCalledTimes(1);
  });

  it('replaces the slug field of the product and collection detail forms with the unified one', () => {
    expect(extension()).toEqual({
      detailForms: [
        {
          pageId: 'product-detail',
          inputs: [{ blockId: 'main-form', field: 'slug', component: UnifiedSlugInput }],
        },
        {
          pageId: 'collection-detail',
          inputs: [{ blockId: 'main-form', field: 'slug', component: UnifiedSlugInput }],
        },
      ],
    });
  });
});
