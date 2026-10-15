// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import type { DashboardRouteDefinition } from '@vendure/dashboard';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrencyExchangeRateListDocument, type CurrencyExchangeRateFields } from '../graphql';
import { listPage, showListRows } from '../testing/dashboard-mock';
import { setLocale } from '../testing/i18n';
import { currencyExchangeRateListRoute } from './currency-exchange-rate-list';

vi.mock('@vendure/dashboard', () => import('../testing/dashboard-mock'));
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));

type Route = Parameters<DashboardRouteDefinition['component']>[0];

function rate(over: Partial<CurrencyExchangeRateFields>): CurrencyExchangeRateFields {
  return {
    id: '1',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-12T08:00:00.000Z',
    code: 'USD',
    baseCurrency: 'UAH',
    rate: 41.5,
    enabled: true,
    useCustomRate: false,
    customRate: null,
    ...over,
  };
}

const route = { id: 'currency-exchange-rates' } as unknown as Route;

function renderList(rows: CurrencyExchangeRateFields[]) {
  showListRows(rows as unknown as Record<string, unknown>[]);
  render(<>{currencyExchangeRateListRoute.component(route)}</>);
  return listPage.props!;
}

/** The cells of the row whose code link reads `code`. */
function rowOf(code: string) {
  const row = screen.getByRole('link', { name: code }).closest('tr')!;
  return within(row).getAllByRole('cell');
}

beforeEach(() => setLocale('uk'));
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('the currency exchange rate list', () => {
  it('is in the settings menu at /currency-exchange-rates, for those who can read settings', () => {
    expect(currencyExchangeRateListRoute.path).toBe('/currency-exchange-rates');
    expect(currencyExchangeRateListRoute.navMenuItem).toEqual({
      sectionId: 'settings',
      id: 'currency-exchange-rates',
      title: 'Currency exchange rates',
      requiresPermission: 'ReadSettings',
    });
  });

  it('titles the page and its breadcrumb «Курси обміну валют»', () => {
    const loader = currencyExchangeRateListRoute.loader as unknown as () => {
      breadcrumb: () => ReactNode;
      title: () => ReactNode;
    };
    const { breadcrumb, title } = loader();

    expect(render(<>{breadcrumb()}</>).container.textContent).toBe('Курси обміну валют');
    cleanup();
    expect(render(<>{title()}</>).container.textContent).toBe('Курси обміну валют');
    cleanup();

    renderList([]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Курси обміну валют');
  });

  it('lists the rates by code, showing the rate, its status and whether a custom rate is used', () => {
    const props = renderList([]);

    expect(props.pageId).toBe('currency-exchange-rate-list');
    expect(props.listQuery).toBe(getCurrencyExchangeRateListDocument);
    expect(props.route).toBe(route);
    expect(props.defaultSort).toEqual([{ id: 'code', desc: false }]);
    expect(props.defaultColumnOrder).toEqual(['code', 'rate', 'enabled', 'useCustomRate']);
    expect(props.defaultVisibility).toEqual({
      code: true,
      rate: true,
      enabled: true,
      useCustomRate: true,
      baseCurrency: false,
      customRate: false,
      updatedAt: false,
    });
    expect(screen.getAllByRole('columnheader').at(-1)?.textContent).toBe('Власний курс');
  });

  it('links each code to the rate’s detail page', () => {
    renderList([rate({ id: '7', code: 'USD' })]);

    expect(screen.getByRole('link', { name: 'USD' }).getAttribute('href')).toBe('./7');
  });

  it('shows the fetched rate with its base currency, and an enabled rate as such', () => {
    renderList([rate({ code: 'USD', rate: 41.5, enabled: true, useCustomRate: false })]);

    const [, value, status, custom] = rowOf('USD');
    expect(value.textContent).toBe('41,5 UAH');
    expect(status.textContent).toBe('Увімкнено');
    expect(status.firstElementChild?.getAttribute('data-variant')).toBe('success');
    expect(custom.textContent).toBe('Курс із джерела');
    expect(custom.firstElementChild?.getAttribute('data-variant')).toBe('outline');
    expect(custom.firstElementChild?.className).toContain('bg-secondary');
  });

  it('shows the custom rate instead of the fetched one while it is used', () => {
    renderList([rate({ code: 'EUR', rate: 47.9, enabled: false, useCustomRate: true, customRate: 48.25 })]);

    const [, value, status, custom] = rowOf('EUR');
    expect(value.textContent).toBe('48,25 UAH');
    expect(status.textContent).toBe('Вимкнено');
    expect(status.firstElementChild?.getAttribute('data-variant')).toBe('outline');
    expect(status.firstElementChild?.className).toContain('bg-secondary');
    expect(custom.textContent).toBe('Використовується власний курс');
    expect(custom.firstElementChild?.getAttribute('data-variant')).toBe('success');
  });

  it('falls back to the fetched rate when a custom rate is switched on but not set', () => {
    renderList([rate({ code: 'PLN', rate: 11.25, useCustomRate: true, customRate: null })]);

    expect(rowOf('PLN')[1].textContent).toBe('11,25 UAH');
  });

  it('shows 0 rather than a broken number for a row without a rate', () => {
    // The schema declares `rate: Float!`; the cell still guards against a row that lacks it.
    renderList([rate({ code: 'CZK', rate: null as unknown as number })]);

    expect(rowOf('CZK')[1].textContent).toBe('0 UAH');
  });

  it('searches the rates by currency code, and drops the filter for an empty search', () => {
    const { onSearchTermChange } = renderList([]);

    expect(onSearchTermChange('us')).toEqual({ code: { contains: 'us' } });
    expect(onSearchTermChange('')).toEqual({});
  });

  it('filters the rates by status and by whether a custom rate is used', () => {
    const { facetedFilters } = renderList([]);

    const options = [
      { value: true, label: 'Увімкнено' },
      { value: false, label: 'Вимкнено' },
    ];
    expect(facetedFilters).toEqual({
      enabled: { title: 'Увімкнено', options },
      useCustomRate: { title: 'Власний курс', options },
    });
  });

  it('formats the last-updated date when the admin shows that column', () => {
    const { customizeColumns } = renderList([]);
    const row = rate({ updatedAt: '2026-10-12T08:30:00.000Z' }) as unknown as Record<string, unknown>;

    expect(render(<>{customizeColumns.updatedAt.cell!({ row: { original: row } })}</>).container.textContent).toBe(
      '2026-10-12 08:30',
    );
  });
});
