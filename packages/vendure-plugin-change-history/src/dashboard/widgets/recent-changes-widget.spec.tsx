// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedFilter, periodBounds } from '../format';
import { answerQueries, refetches } from '../testing/dashboard-mock';
import { dialogData, entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { RecentChangesWidget } from './recent-changes-widget';

const query = vi.hoisted(() => ({
  /** The dashboard's language for dates: the times are formatted for it, as the dashboard does. */
  dateLocale: 'uk-UA',
  fetching: false,
  queryFn: undefined as undefined | (() => unknown),
  api: [] as unknown[][],
}));

vi.mock('@vendure/dashboard', async () => {
  const base = await import('../testing/dashboard-mock');
  return {
    ...base,
    api: {
      query: (...args: unknown[]) => {
        query.api.push(args);
        return Promise.resolve({});
      },
    },
    useLocalFormat: () => ({
      ...base.useLocalFormat(),
      formatDate: (value: string, options: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat(query.dateLocale, options).format(new Date(value)),
    }),
    // The widget's own query: its request is kept so that a test can read the variables it sends.
    useQuery: (options: { queryKey: readonly unknown[]; enabled?: boolean; queryFn: () => unknown }) => {
      if (options.queryKey[0] === 'change-history-recent') {
        query.queryFn = options.queryFn;
        return { ...base.useQuery(options), isFetching: query.fetching };
      }
      return base.useQuery(options);
    },
    Link: ({ to, search, children }: { to: string; search?: Record<string, unknown>; children?: ReactNode }) => {
      const params = Object.entries(search ?? {}).filter(([, value]) => value !== undefined);
      return (
        <a href={`${to}?${new URLSearchParams(params.map(([key, value]) => [key, String(value)]))}`}>{children}</a>
      );
    },
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children?: ReactNode;
    }) =>
      open ? (
        <>
          {children}
          <button type="button" onClick={() => onOpenChange(false)}>
            close the window
          </button>
        </>
      ) : null,
  };
});
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));
vi.mock('@lingui/react', () => import('../testing/lingui-mock'));

beforeEach(() => setLocale('uk'));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  query.dateLocale = 'uk-UA';
  query.fetching = false;
  query.queryFn = undefined;
  query.api.length = 0;
});

const recent = (answer: Parameters<typeof answerQueries>[0]) => {
  answerQueries(answer);
  render(<RecentChangesWidget />);
};

const lines = (items: Array<ReturnType<typeof entry>>) =>
  recent((key) => {
    if (key[0] === 'change-history-recent') {
      return { data: { changeHistoryEntries: { items, totalItems: items.length } } };
    }
    return key[0] === 'change-history-entry' ? { data: dialogData(entry({ id: String(key[1]) })) } : undefined;
  });

/** The time of each line: a button that opens the line's entry. */
const times = () => screen.getAllByRole('listitem').map((item) => item.querySelector('button') as HTMLButtonElement);

/** The Insights page's period (see the dashboard mock), as whole local days. */
const PERIOD = periodBounds(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-12T00:00:00Z'));

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

  it('asks for the last 10 rows of the default feed within the page’s whole days', async () => {
    lines([]);
    await query.queryFn?.();
    expect(query.api).toHaveLength(1);
    expect(query.api[0][1]).toEqual({
      options: {
        take: 10,
        sort: { createdAt: 'DESC' },
        filter: feedFilter(undefined, { collapseBatches: true, hideSystem: false, ...PERIOD }),
      },
    });
  });

  it('sizes the time column by the longest time in the dashboard’s language, «10:10 AM» included', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 12, 18, 0) });
    query.dateLocale = 'en-US';
    lines([
      entry({ id: '1', createdAt: new Date(2026, 9, 12, 10, 10).toISOString() }),
      entry({ id: '2', createdAt: new Date(2026, 9, 12, 8, 0).toISOString() }),
    ]);
    expect(times().map((time) => time.textContent)).toEqual(['10:10 AM', '8:00 AM']);
    // One column for every line (a subgrid of the list), as wide as its longest time: no fixed width to outgrow.
    expect(screen.getByRole('list').className).toContain('grid-cols-[auto_minmax(0,1fr)]');
    for (const line of screen.getAllByRole('listitem')) {
      expect(line.className).toContain('col-span-2');
      expect(line.className).toContain('grid-cols-subgrid');
    }
    for (const time of times()) {
      expect(time.className).not.toMatch(/(^|\s)w-/);
      expect(time.className).toContain('whitespace-nowrap');
    }
  });

  it('shows today’s changes by time and older ones by day and time', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 12, 18, 0) });
    lines([
      entry({ id: '1', createdAt: new Date(2026, 9, 12, 9, 0).toISOString() }),
      entry({ id: '2', createdAt: new Date(2026, 9, 11, 8, 0).toISOString() }),
    ]);
    expect(times().map((time) => time.textContent)).toEqual(['09:00', '11.10, 08:00']);
  });

  it('opens a line’s entry from the keyboard: its time is a focusable button', () => {
    lines([entry({ id: '7', entityLabel: 'Oversize tee' })]);
    const [time] = times();
    expect(time.type).toBe('button');
    expect(time.className).toContain('focus-visible:ring-2');
    time.focus();
    expect(document.activeElement).toBe(time);
    // Enter and Space press a focused button: the browser turns them into a click.
    fireEvent.click(time);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('greys out system lines, not people’s', () => {
    lines([entry({ id: '1' }), entry({ id: '2', source: 'collection_rules', actorType: 'system', actorLabel: null })]);
    const [person, system] = screen.getAllByRole('listitem');
    expect(person.className).not.toContain('bg-muted/20');
    expect(system.className).toContain('bg-muted/20');
  });

  it('opens a line’s entry in the entry window, and closes it', () => {
    lines([entry({ id: '7', entityLabel: 'Oversize tee' })]);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('listitem'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'close the window' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gives a cut line of what changed its whole text on hover', () => {
    lines([entry({ id: '7' })]);
    const changed = screen.getByRole('listitem').querySelector('.line-clamp-2') as HTMLElement;
    fireEvent.mouseEnter(changed);
    expect(changed.title).toBe('');
    Object.defineProperties(changed, { scrollHeight: { value: 60 }, clientHeight: { value: 40 } });
    fireEvent.mouseEnter(changed);
    expect(changed.title).toBe(changed.textContent?.replace(/\s+/g, ' ').trim());
    expect(changed.title).toContain('оновлено');
  });

  it('links «All changes» to the feed with the default switches and the page’s period', () => {
    lines([]);
    const link = screen.getByRole('link', { name: 'Усі зміни →' });
    const url = new URL(link.getAttribute('href') ?? '', 'http://dashboard');
    expect(url.pathname).toBe('/change-history');
    // The feed's defaults (collapsed batches, system rows shown) stay out of the URL.
    expect(Object.fromEntries(url.searchParams)).toEqual({ from: PERIOD.from, to: PERIOD.to });
  });

  it('refreshes on demand, and spins while it does', () => {
    lines([]);
    const refresh = screen.getByRole('button', { name: 'Оновити' }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(false);
    expect(refresh.querySelector('svg')?.getAttribute('class')).not.toContain('animate-spin');
    fireEvent.click(refresh);
    expect(refetches).toEqual(['change-history-recent']);
    cleanup();

    query.fetching = true;
    lines([]);
    const spinning = screen.getByRole('button', { name: 'Оновити' }) as HTMLButtonElement;
    expect(spinning.disabled).toBe(true);
    expect(spinning.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');
  });
});
