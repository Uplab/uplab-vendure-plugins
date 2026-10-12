// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DashboardRouteDefinition } from '@vendure/dashboard';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCurrencyExchangeRateDetailDocument,
  updateCurrencyExchangeRateDocument,
  type CurrencyExchangeRateFields,
} from '../graphql';
import { detailPage, grantPermissions, showDetailPage, toast } from '../testing/dashboard-mock';
import { setLocale } from '../testing/i18n';
import { currencyExchangeRateDetailRoute } from './currency-exchange-rate-detail';

vi.mock('@vendure/dashboard', () => import('../testing/dashboard-mock'));
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));

type Route = Parameters<DashboardRouteDefinition['component']>[0];

interface LoaderOptions {
  pageId: string;
  queryDocument: unknown;
  breadcrumb: (isNew: boolean, entity?: { code: string }) => [{ path: string; label: ReactNode }, string];
}

const usd: CurrencyExchangeRateFields = {
  id: '1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-12T08:00:00.000Z',
  code: 'USD',
  baseCurrency: 'UAH',
  rate: 41.52345678,
  enabled: true,
  useCustomRate: false,
  customRate: null,
};

/** The page with `entity` loaded, or still loading for `null`. */
function renderPage(entity: CurrencyExchangeRateFields | null = usd, { isPending = false } = {}) {
  showDetailPage({ entity: entity ?? undefined, isPending });
  const route = { useParams: () => ({ id: '1' }) } as unknown as Route;
  render(<>{currencyExchangeRateDetailRoute.component(route)}</>);
}

const definition = (term: string) => screen.getByText(term).nextElementSibling!;
const updateButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Оновити' });
const customRateInput = () => screen.getByLabelText<HTMLInputElement>('Власний курс');
const customRateError = () => screen.queryByRole('alert')?.textContent;

beforeEach(() => {
  setLocale('uk');
  grantPermissions(['UpdateSettings']);
  detailPage.submitted.length = 0;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setLocale('en');
});

describe('the currency exchange rate detail page', () => {
  it('is at /currency-exchange-rates/$id, under a breadcrumb back to the list', () => {
    const loader = currencyExchangeRateDetailRoute.loader as unknown as LoaderOptions;
    expect(currencyExchangeRateDetailRoute.path).toBe('/currency-exchange-rates/$id');
    expect(loader.pageId).toBe('currency-exchange-rate-detail');
    expect(loader.queryDocument).toBe(getCurrencyExchangeRateDetailDocument);

    const [list, current] = loader.breadcrumb(false, { code: 'USD' });
    expect(list.path).toBe('/currency-exchange-rates');
    expect(isValidElement(list.label)).toBe(true);
    expect(render(list.label as ReactElement).container.textContent).toBe('Курси обміну валют');
    expect(current).toBe('USD');
    expect(loader.breadcrumb(true, undefined)[1]).toBe('');
  });

  it('loads the rate by the id in the URL and updates only its editable fields', () => {
    renderPage();
    const options = detailPage.options!;

    expect(options.pageId).toBe('currency-exchange-rate-detail');
    expect(options.entityName).toBe('CurrencyExchangeRate');
    expect(options.queryDocument).toBe(getCurrencyExchangeRateDetailDocument);
    expect(options.updateDocument).toBe(updateCurrencyExchangeRateDocument);
    expect(options.params).toEqual({ id: '1' });
    expect(options.setValuesForUpdate(usd)).toEqual({
      id: '1',
      enabled: true,
      useCustomRate: false,
      customRate: null,
    });
    expect(options.setValuesForUpdate({ ...usd, useCustomRate: true, customRate: 42 })).toEqual({
      id: '1',
      enabled: true,
      useCustomRate: true,
      customRate: 42,
    });
  });

  it('shows the currency’s details and its fetched rate in full', () => {
    renderPage();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('USD');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Деталі');
    expect(screen.getByText('Довідкова інформація для цієї валюти')).toBeTruthy();
    expect(definition('Код').textContent).toBe('USD');
    expect(definition('Базова валюта').textContent).toBe('UAH');
    expect(definition('Статус').textContent).toBe('Увімкнено');
    expect(definition('Статус').firstElementChild?.getAttribute('data-variant')).toBe('success');
    expect(definition('Останнє оновлення').textContent).toBe('2026-10-12 08:00');
    expect(definition('Курс із джерела').textContent).toBe('41,52345678');
  });

  it('states the units of the fetched rate', () => {
    setLocale('en');
    renderPage();

    expect(screen.getByText('UAH per 1 USD')).toBeTruthy();
  });

  it('shows placeholders while the rate loads', () => {
    renderPage(null);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Курс обміну валюти');
    expect(definition('Код').textContent).toBe('—');
    expect(definition('Базова валюта').textContent).toBe('—');
    expect(definition('Статус').textContent).toBe('Вимкнено');
    expect(definition('Статус').firstElementChild?.getAttribute('data-variant')).toBe('secondary');
    expect(definition('Останнє оновлення').textContent).toBe('—');
    expect(definition('Курс із джерела').textContent).toBe('—');
    expect(screen.queryByText(/per 1/)).toBeNull();
  });

  it('shows a disabled rate as such', () => {
    renderPage({ ...usd, enabled: false });

    expect(definition('Статус').textContent).toBe('Вимкнено');
    expect(screen.getByLabelText('Увімкнено').getAttribute('aria-checked')).toBe('false');
  });

  it('keeps Update disabled until the form changes, then submits the change', async () => {
    renderPage();
    expect(updateButton().disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Увімкнено'));

    await waitFor(() => expect(updateButton().disabled).toBe(false));
    fireEvent.click(updateButton());
    await waitFor(() =>
      expect(detailPage.submitted).toEqual([{ id: '1', enabled: false, useCustomRate: false, customRate: null }]),
    );
  });

  it('keeps Update disabled while the update is being saved', async () => {
    renderPage(usd, { isPending: true });

    fireEvent.click(screen.getByLabelText('Увімкнено'));

    await waitFor(() => expect(screen.getByLabelText('Увімкнено').getAttribute('aria-checked')).toBe('false'));
    expect(updateButton().disabled).toBe(true);
  });

  it('hides Update from administrators without the UpdateSettings permission', () => {
    grantPermissions([]);
    renderPage();

    expect(screen.queryByRole('button', { name: 'Оновити' })).toBeNull();
  });

  it('lets the custom rate be entered only while “Use custom rate” is on', async () => {
    renderPage();
    expect(
      screen.getByText(
        'У тих самих одиницях; застосовується замість курсу із джерела, поки ввімкнено «Використовувати власний курс»',
      ),
    ).toBeTruthy();
    expect(customRateInput().disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Використовувати власний курс'));

    await waitFor(() => expect(customRateInput().disabled).toBe(false));
  });

  it('requires a custom rate greater than 0 while “Use custom rate” is on', async () => {
    renderPage();

    fireEvent.click(screen.getByLabelText('Використовувати власний курс'));
    await waitFor(() => expect(customRateError()).toBe('Введіть власний курс, більший за 0'));
    expect(updateButton().disabled).toBe(true);

    fireEvent.change(customRateInput(), { target: { value: '-2' } });
    await waitFor(() => expect(customRateInput().value).toBe('-2'));
    expect(customRateError()).toBe('Введіть власний курс, більший за 0');
    expect(updateButton().disabled).toBe(true);

    fireEvent.change(customRateInput(), { target: { value: '42.5' } });
    await waitFor(() => expect(customRateError()).toBeUndefined());
    expect(updateButton().disabled).toBe(false);

    fireEvent.click(updateButton());
    await waitFor(() =>
      expect(detailPage.submitted).toEqual([{ id: '1', enabled: true, useCustomRate: true, customRate: 42.5 }]),
    );
  });

  it('clears the custom rate when its input is emptied', async () => {
    renderPage({ ...usd, useCustomRate: true, customRate: 42 });
    expect(customRateInput().value).toBe('42');

    fireEvent.change(customRateInput(), { target: { value: '' } });

    await waitFor(() => expect(customRateError()).toBe('Введіть власний курс, більший за 0'));
    expect(customRateInput().value).toBe('');
  });

  it('confirms a saved update and resets the form to it', () => {
    renderPage();

    detailPage.options!.onSuccess({});

    expect(toast.success).toHaveBeenCalledWith('Курс обміну валюти оновлено');
    expect(detailPage.resetForm).toHaveBeenCalled();
  });

  it('reports a failed update with the error’s message, or as unknown', () => {
    renderPage();

    detailPage.options!.onError(new Error('Custom rate must be positive'));
    detailPage.options!.onError('timeout');

    expect(toast.error.mock.calls).toEqual([
      ['Не вдалося оновити курс обміну валюти', { description: 'Custom rate must be positive' }],
      ['Не вдалося оновити курс обміну валюти', { description: 'Невідома помилка' }],
    ]);
  });
});
