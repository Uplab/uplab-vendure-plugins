// @vitest-environment jsdom
import type { DashboardExtension } from '@vendure/dashboard';
import { defineDashboardExtension } from '@vendure/dashboard';
import { describe, expect, it, vi } from 'vitest';
import './index';
import { currencyExchangeRateDetailRoute } from './routes/currency-exchange-rate-detail';
import { currencyExchangeRateListRoute } from './routes/currency-exchange-rate-list';

vi.mock('@vendure/dashboard', async () => ({
  ...(await import('./testing/dashboard-mock')),
  defineDashboardExtension: vi.fn(),
}));
vi.mock('@lingui/react/macro', () => import('./testing/lingui-mock'));

describe('the dashboard extension', () => {
  it('is defined once, on import', () => {
    expect(defineDashboardExtension).toHaveBeenCalledTimes(1);
  });

  it('adds the exchange rate list and detail pages', () => {
    expect(vi.mocked(defineDashboardExtension).mock.calls[0][0] as DashboardExtension).toEqual({
      routes: [currencyExchangeRateListRoute, currencyExchangeRateDetailRoute],
    });
  });
});
