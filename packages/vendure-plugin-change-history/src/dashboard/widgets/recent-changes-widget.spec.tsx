// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerQueries, refetches } from '../testing/dashboard-mock';
import { entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { RecentChangesWidget } from './recent-changes-widget';

vi.mock('@vendure/dashboard', () => import('../testing/dashboard-mock'));
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));
vi.mock('@lingui/react', () => import('../testing/lingui-mock'));

beforeEach(() => setLocale('uk'));
afterEach(cleanup);

const recent = (answer: Parameters<typeof answerQueries>[0]) => {
  answerQueries(answer);
  render(<RecentChangesWidget />);
};

describe('RecentChangesWidget', () => {
  it('says that the request failed, with a retry, instead of «no changes»', () => {
    recent((key) =>
      key[0] === 'change-history-recent' ? { isError: true, error: new Error('Failed to fetch') } : undefined,
    );
    expect(screen.getByRole('alert').textContent).toContain('Не вдалося завантажити історію змін.');
    expect(document.body.textContent).not.toContain('За цей період змін немає.');
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    expect(refetches).toEqual(['change-history-recent']);
  });

  it('says there were no changes only when the request succeeded', () => {
    recent(() => ({ data: { changeHistoryEntries: { items: [], totalItems: 0 } } }));
    expect(screen.getByText('За цей період змін немає.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the type of each object and names the refresh button', () => {
    recent(() => ({
      data: {
        changeHistoryEntries: {
          items: [
            entry({
              entityType: 'Collection',
              entityLabel: 'Sale',
              changes: { enabled: { kind: 'bool', from: false, to: true } },
            }),
          ],
          totalItems: 1,
        },
      },
    }));
    const line = screen.getByRole('listitem').textContent ?? '';
    expect(line).toContain('Колекція');
    expect(line).toContain('Sale');
    expect(screen.getByRole('button', { name: 'Оновити' })).toBeTruthy();
  });

  it('waits while loading', () => {
    recent(() => ({ isLoading: true }));
    expect(document.querySelector('[data-skeleton]')).toBeTruthy();
    expect(document.body.textContent).not.toContain('За цей період змін немає.');
  });
});
