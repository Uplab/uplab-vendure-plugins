// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEED_QUERY_MARKER, feedFilter, periodBounds, searchFilter } from '../format';
import { getChangeHistoryRegistry, type ChangeHistoryEntryData } from '../registry';
import { answerQueries } from '../testing/dashboard-mock';
import { dialogData, entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { changeHistoryListRoute } from './change-history-list';

/** A column as the page customizes it. */
interface Column {
  header?: () => ReactNode;
  cell?: (context: { row: { original: ChangeHistoryEntryData } }) => ReactNode;
  meta?: { disabled?: boolean; dependencies?: string[] };
  enableColumnFilter?: boolean;
  enableSorting?: boolean;
  enableHiding?: boolean;
}

interface FacetedFilter {
  title: string;
  optionsFn: () => Promise<Array<{ value: string; label: string }>>;
}

/** What the page gives the table. */
interface TableProps {
  page: number;
  itemsPerPage: number;
  sorting: Array<{ id: string; desc: boolean }>;
  columnFilters: Array<{ id: string; value: unknown }>;
  includeSelectionColumn: boolean;
  onPageChange: (table: unknown, page: number, perPage: number) => void;
  onSortChange: (table: unknown, sorting: Array<{ id: string; desc: boolean }>) => void;
  onFilterChange: (table: unknown, filters: Array<{ id: string; value: unknown }>) => void;
  transformQueryKey: (key: unknown[]) => unknown[];
  transformVariables: (variables: { options?: Record<string, unknown> }) => { options: Record<string, unknown> };
  onSearchTermChange: (term: string) => unknown;
  facetedFilters: Record<string, FacetedFilter>;
  defaultVisibility: Record<string, boolean>;
  defaultColumnOrder: string[];
  customizeColumns: Record<string, Column>;
  listQuery: { source: string };
}

/** A query of the fake query cache, shaped like TanStack Query's. */
interface FakeQuery {
  queryKey: unknown[];
  observers: number;
  state: {
    status: 'pending' | 'success' | 'error';
    fetchStatus: 'idle' | 'fetching';
    data?: unknown;
    error?: unknown;
    dataUpdatedAt: number;
    errorUpdatedAt: number;
  };
  getObserversCount: () => number;
}

/**
 * The fields core's PaginatedListDataTable (3.7.2 and 3.7.3) puts in the list query: a column per field of the
 * document unless it is disabled (`meta.disabled` drops the column, and its field with it), of those the visible
 * ones and always `id`, plus the `meta.dependencies` of every selected column.
 */
function selectedFields(props: Pick<TableProps, 'customizeColumns' | 'defaultVisibility'>, fields: string[]) {
  const columns = fields.filter((field) => !props.customizeColumns[field]?.meta?.disabled);
  const shown = columns.filter((field) => props.defaultVisibility[field] !== false || field === 'id');
  return new Set([...shown, ...shown.flatMap((field) => props.customizeColumns[field]?.meta?.dependencies ?? [])]);
}

const COLUMNS = ['createdAt', 'actorLabel', 'entityType', 'entityLabel', 'action', 'summary', 'source', 'actorId'];

const h = vi.hoisted(() => ({
  table: undefined as unknown as TableProps,
  mounts: 0,
  rows: [] as ChangeHistoryEntryData[],
  search: {} as Record<string, unknown>,
  setSearch: (_next: Record<string, unknown>) => undefined as void,
  navigations: [] as Array<{ to: unknown; search: Record<string, unknown> }>,
  client: undefined as unknown,
  options: undefined as unknown,
  optionsRequests: [] as unknown[][],
}));

vi.mock('@vendure/dashboard', async () => {
  const base = await import('../testing/dashboard-mock');
  const children = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    ...base,
    api: {
      query: (...args: unknown[]) => {
        h.optionsRequests.push(args);
        return h.options instanceof Error ? Promise.reject(h.options) : Promise.resolve(h.options);
      },
    },
    Page: ({ children, pageId }: { children?: ReactNode; pageId: string }) => (
      <main data-page={pageId}>{children}</main>
    ),
    PageTitle: ({ children }: { children?: ReactNode }) => <h1>{children}</h1>,
    PageActionBar: children,
    PageActionBarLeft: children,
    PageActionBarRight: children,
    PageLayout: children,
    FullWidthPageBlock: children,
    Label: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
    Switch: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (checked: boolean) => void }) => (
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
    DateRangePicker: ({
      dateRange,
      onDateRangeChange,
    }: {
      dateRange: { from?: Date; to?: Date };
      onDateRangeChange: (range: { from: Date; to: Date }) => void;
    }) => (
      <button
        type="button"
        data-from={dateRange.from?.toISOString() ?? ''}
        data-to={dateRange.to?.toISOString() ?? ''}
        onClick={() => onDateRangeChange({ from: new Date(2026, 9, 1), to: new Date(2026, 9, 3) })}
      >
        pick a period
      </button>
    ),
    Dialog: ({
      open,
      onOpenChange,
      children: content,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children?: ReactNode;
    }) =>
      open ? (
        <>
          {content}
          <button type="button" onClick={() => onOpenChange(false)}>
            close the window
          </button>
        </>
      ) : null,
    useNavigate:
      () =>
      ({ to, search }: { to: unknown; search: (previous: Record<string, unknown>) => Record<string, unknown> }) => {
        const next = search(h.search);
        h.navigations.push({ to, search: next });
        h.search = next;
        h.setSearch(next);
      },
    useQueryClient: () => h.client,
    /**
     * The table: it keeps the props it was given and the number of times it was mounted (a new `key` mounts it
     * again), and renders the rows given by the test through the page's own column definitions — each row with
     * only the fields core's list query would select (see `selectedFields`).
     */
    PaginatedListDataTable: (props: TableProps) => {
      useState(() => ++h.mounts);
      h.table = props;
      const pick = (row: ChangeHistoryEntryData) => {
        const fields = selectedFields(props, Object.keys(row));
        return Object.fromEntries(Object.entries(row).filter(([key]) => fields.has(key))) as ChangeHistoryEntryData;
      };
      return (
        <table>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th key={column} data-column={column}>
                  {props.customizeColumns[column].header?.() ?? column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {h.rows.map((row) => (
              <tr key={row.id}>
                {COLUMNS.map((column) => (
                  <td key={column} data-column={column}>
                    {props.customizeColumns[column].cell?.({ row: { original: pick(row) } })}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    },
  };
});
// Lingui's `t` is one function per locale, so that the page's memoized filters keep their loaders.
vi.mock('@lingui/react/macro', async () => {
  const base = await import('../testing/lingui-mock');
  const lingui = base.useLingui();
  return { ...base, useLingui: () => lingui };
});
vi.mock('@lingui/react', () => import('../testing/lingui-mock'));

const REGISTRY_KEY = Symbol.for('@uplab/vendure-plugin-change-history/registry');

/** TanStack Query's client as far as the page uses it: the query cache, `fetchQuery` and `refetchQueries`. */
function fakeQueryClient() {
  const queries: FakeQuery[] = [];
  const listeners = new Set<(event: { query: FakeQuery }) => void>();
  const refetched: unknown[][] = [];
  const cache = {
    findAll: vi.fn(({ predicate }: { predicate: (query: FakeQuery) => boolean }) => queries.filter(predicate)),
    subscribe: (listener: (event: { query: FakeQuery }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    queries,
    listeners,
    refetched,
    cache,
    getQueryCache: () => cache,
    fetchQuery: ({ queryFn }: { queryFn: () => Promise<unknown> }) => queryFn(),
    refetchQueries: vi.fn(({ predicate, type }: { predicate: (query: FakeQuery) => boolean; type: string }) => {
      refetched.push(...queries.filter((query) => type === 'active' && predicate(query)).map((q) => q.queryKey));
      return Promise.resolve();
    }),
    /** Adds or updates a query and notifies the cache's listeners, as the table's own query would. */
    put(key: unknown[], state: Partial<FakeQuery['state']>, observers = 1): FakeQuery {
      let query = queries.find((candidate) => JSON.stringify(candidate.queryKey) === JSON.stringify(key));
      if (!query) {
        const created: FakeQuery = {
          queryKey: key,
          observers,
          state: { status: 'pending', fetchStatus: 'idle', dataUpdatedAt: 0, errorUpdatedAt: 0 },
          getObserversCount: () => created.observers,
        };
        query = created;
        queries.push(query);
      }
      query.observers = observers;
      query.state = { ...query.state, ...state };
      for (const listener of listeners) {
        listener({ query });
      }
      return query;
    },
  };
}

type Client = ReturnType<typeof fakeQueryClient>;
const client = () => h.client as Client;

/** The feed's list query as the table keys it (the page adds the marker and the switches). */
const FEED_KEY = ['changeHistoryEntries', FEED_QUERY_MARKER];

/** Puts the feed's query into the cache and lets the page read it (it reads after the current task). */
async function feedQuery(state: Partial<FakeQuery['state']>, key = FEED_KEY, observers = 1) {
  await act(async () => {
    client().put(key, state, observers);
  });
}

const success = (totalItems: number, at = 1): Partial<FakeQuery['state']> => ({
  status: 'success',
  fetchStatus: 'idle',
  data: { changeHistoryEntries: { items: [], totalItems } },
  dataUpdatedAt: at,
});

const OPTIONS = {
  changeHistoryFilterOptions: {
    entityTypes: ['Product', 'Collection'],
    actions: ['updated', 'created'],
    sources: ['admin', 'api_key'],
    actors: [
      { type: 'admin', id: '1', label: 'Іван Петренко' },
      { type: 'api_key', id: '2', label: 'Odoo (API key)' },
    ],
  },
};

beforeEach(() => {
  setLocale('uk');
  h.client = fakeQueryClient();
  h.mounts = 0;
  h.rows = [];
  h.navigations = [];
  h.options = OPTIONS;
  h.optionsRequests = [];
  answerQueries((key) =>
    key[0] === 'change-history-entry' ? { data: dialogData(entry({ id: String(key[1]) })) } : undefined,
  );
});
afterEach(() => {
  cleanup();
  setLocale('en');
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
});

/** The feed at a URL; navigating changes the URL it reads, as the router would. */
function feed(search: Record<string, unknown> = {}, rows: ChangeHistoryEntryData[] = []) {
  h.rows = rows;
  h.search = search;
  function Router() {
    const [current, setCurrent] = useState(search);
    h.setSearch = setCurrent;
    return changeHistoryListRoute.component({ useSearch: () => current } as never) as ReactElement;
  }
  return render(<Router />);
}

/** The URL's search params as the router writes them (undefined ones left out). */
const url = () => Object.fromEntries(Object.entries(h.search).filter(([, value]) => value !== undefined));

const row = (index = 0) => screen.getAllByRole('row')[index + 1];
const cell = (column: string, index = 0) => row(index).querySelector(`[data-column="${column}"]`) as HTMLElement;
const wrapper = () => document.querySelector('table')?.parentElement as HTMLElement;

describe('the change history route', () => {
  it('sits under System, for those allowed to read the history', () => {
    expect(changeHistoryListRoute.path).toBe('/change-history');
    expect(changeHistoryListRoute.navMenuItem).toMatchObject({
      sectionId: 'system',
      id: 'change-history',
      title: 'change-history.nav.title',
      requiresPermission: 'ReadChangeHistory',
    });
  });

  it('titles the page and its breadcrumb «Журнал змін»', () => {
    const loaded = (changeHistoryListRoute.loader as () => { breadcrumb: () => ReactNode; title: () => ReactNode })();
    render(
      <>
        <span data-testid="breadcrumb">{loaded.breadcrumb()}</span>
        <span data-testid="title">{loaded.title()}</span>
      </>,
    );
    expect(screen.getByTestId('breadcrumb').textContent).toBe('Журнал змін');
    expect(screen.getByTestId('title').textContent).toBe('Журнал змін');
  });
});

describe('ChangeHistoryListPage', () => {
  it('shows the feed with its title, newest first, 20 a page, without a selection column', () => {
    feed();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Журнал змін');
    expect(document.querySelector('[data-page]')?.getAttribute('data-page')).toBe('change-history-list');
    expect(h.table).toMatchObject({
      page: 1,
      itemsPerPage: 20,
      sorting: [{ id: 'createdAt', desc: true }],
      columnFilters: [],
      includeSelectionColumn: false,
      defaultColumnOrder: ['createdAt', 'actorLabel', 'entityType', 'entityLabel', 'action', 'summary'],
    });
    expect(h.table.defaultVisibility).toMatchObject({ source: false, actorId: false, summary: true });
  });

  describe('rows', () => {
    const rows = () => [
      entry({ id: '7', entityLabel: 'Oversize tee' }),
      entry({ id: '8', entityType: 'Batch', entityLabel: null, action: 'batch', batchId: 'import:1' }),
    ];

    it('opens a row’s entry from a click anywhere on the row, and closes it', () => {
      feed({ page: 2 }, rows());
      fireEvent.click(cell('summary').firstChild as HTMLElement);
      expect(url()).toEqual({ page: 2, entry: 7 });
      expect(h.navigations[0].to).toBe('.');
      expect(screen.getByRole('dialog')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'close the window' }));
      expect(url()).toEqual({ page: 2 });
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('opens the entry of the row clicked, whichever cell', () => {
      feed({}, rows());
      fireEvent.click(cell('action', 1));
      expect(url()).toEqual({ entry: 8 });
    });

    it('opens the entry from its time, once', () => {
      feed({}, rows());
      fireEvent.click(within(cell('createdAt')).getByRole('button'));
      expect(h.navigations).toHaveLength(1);
      expect(url()).toEqual({ entry: 7 });
    });

    it('lets links and buttons inside a row do their own thing', () => {
      feed({}, rows());
      const link = within(cell('entityLabel')).getByRole('link');
      // The router would follow it; jsdom does not navigate.
      link.addEventListener('click', (event) => event.preventDefault());
      fireEvent.click(link);
      expect(h.navigations).toEqual([]);
    });

    it('opens nothing from the header or from outside the rows', () => {
      feed({}, rows());
      fireEvent.click(screen.getAllByRole('columnheader')[0]);
      fireEvent.click(document.querySelector('table') as HTMLElement);
      expect(h.navigations).toEqual([]);
    });

    it('opens nothing from a row without an entry', () => {
      feed({}, rows());
      const blank = document.createElement('tr');
      blank.appendChild(document.createElement('td'));
      document.querySelector('tbody')?.appendChild(blank);
      fireEvent.click(blank.firstChild as HTMLElement);
      expect(h.navigations).toEqual([]);
    });

    it('marks every cell with its entry, and gives a cut cell its whole text on hover', () => {
      feed({}, rows());
      for (const column of COLUMNS) {
        expect(
          cell(column).querySelector('[data-change-history-entry]')?.getAttribute('data-change-history-entry'),
        ).toBe('7');
      }
      const summary = cell('source').firstChild as HTMLElement;
      Object.defineProperties(summary, { scrollWidth: { value: 300 }, clientWidth: { value: 100 } });
      fireEvent.mouseEnter(summary);
      expect(summary.title).toBe('Адмін-панель');
    });
  });

  describe('columns', () => {
    it('heads the columns in the dashboard’s language, the time column with core’s own header', () => {
      feed();
      expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
        'createdAt',
        'Хто',
        'Тип',
        'Об’єкт',
        'Дія',
        'Що змінилось',
        'Джерело',
        'Хто',
      ]);
      expect(h.table.customizeColumns.createdAt.header).toBeUndefined();
    });

    it('shows when, who, what type, which object, what happened and what changed', () => {
      feed({}, [
        entry({
          id: '7',
          entityType: 'Collection',
          entityLabel: 'Sale',
          changes: { enabled: { kind: 'bool', from: false, to: true } },
        }),
      ]);
      expect(within(cell('createdAt')).getByRole('button').textContent).toBe('2026-10-12 08:00');
      expect(cell('actorLabel').textContent).toBe('Іван Петренко');
      expect((cell('actorLabel').firstChild as HTMLElement).title).toBe('Іван Петренко');
      expect(cell('entityType').textContent).toBe('Колекція');
      expect(cell('entityLabel').textContent).toBe('Sale');
      expect((cell('entityLabel').firstChild as HTMLElement).title).toBe('Sale');
      expect(cell('action').textContent).toBe('оновлено');
      expect(cell('summary').textContent).not.toBe('');
      expect(cell('source').textContent).toBe('Адмін-панель');
    });

    it('leaves the object’s tooltip out when it has no name', () => {
      feed({}, [entry({ entityLabel: null })]);
      expect((cell('entityLabel').firstChild as HTMLElement).hasAttribute('title')).toBe(false);
    });

    it('fills the hidden «Who» filter column with the API key owner’s name, a dash for nobody', () => {
      feed({}, [
        entry({ id: '1', actorType: 'api_key', actorLabel: 'Odoo (API key)', source: 'api_key' }),
        entry({ id: '2', actorType: 'system', actorLabel: null, source: 'collection_rules' }),
      ]);
      expect(cell('actorId', 0).textContent).toBe('Odoo');
      expect(cell('actorId', 1).textContent).toBe('—');
      expect(h.table.customizeColumns.actorId).toMatchObject({
        enableSorting: false,
        enableHiding: false,
        meta: { dependencies: ['id', 'actorType', 'actorLabel'] },
      });
    });

    it('leaves the cause of a derived entry out of its query: the feed lists none, and the table would add a column', () => {
      feed();
      expect(h.table.listQuery.source).toContain('derivedFromId');
      expect(h.table.listQuery.source).not.toContain('derivedFrom {');
    });

    it('keeps the cells’ inputs out of the columns, and selects each through the cells that read it', () => {
      feed();
      for (const field of [
        'entityId',
        'parentType',
        'parentId',
        'actorType',
        'batchId',
        'derivedFromId',
        'changes',
        'meta',
        'compactedAt',
        'isCompacted',
        'derivedCount',
        'batchCounts',
        'entityDeleted',
        'parentDeleted',
      ]) {
        expect(h.table.customizeColumns[field]).toEqual({ meta: { disabled: true } });
      }
      // The columns built from several fields select them all.
      expect(h.table.customizeColumns.summary.meta?.dependencies).toContain('changes');
      expect(h.table.customizeColumns.createdAt.enableColumnFilter).toBe(false);
      // Whichever single column is left visible, the query still has what its cells read.
      const all = Object.keys(entry());
      for (const column of COLUMNS) {
        const visibility = Object.fromEntries(COLUMNS.map((other) => [other, other === column]));
        const fields = selectedFields(
          { ...h.table, defaultVisibility: { ...h.table.defaultVisibility, ...visibility } },
          all,
        );
        expect(fields.has('id')).toBe(true);
      }
    });

    it('selects the entry id though no column shows it or offers it in the settings: a row opens its entry', () => {
      feed({}, [entry({ id: '7' })]);
      // A disabled column leaves the list query: the id must stay a column, hidden and not hideable.
      expect(h.table.customizeColumns.id?.meta?.disabled).toBeUndefined();
      expect(h.table.customizeColumns.id).toMatchObject({ enableHiding: false });
      expect(h.table.defaultVisibility.id).toBe(false);
      expect(selectedFields(h.table, Object.keys(entry())).has('id')).toBe(true);
      fireEvent.click(cell('entityType'));
      expect(url()).toEqual({ entry: 7 });
    });
  });

  describe('the URL', () => {
    it('reads the switches, the period and the open entry from the URL', () => {
      feed({ collapse: 'false', hideSystem: 'true', from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T23:59:59.999Z' });
      const [collapse, hideSystem] = screen.getAllByRole('switch') as HTMLInputElement[];
      expect(collapse.checked).toBe(false);
      expect(hideSystem.checked).toBe(true);
      const picker = screen.getByRole('button', { name: 'pick a period' });
      expect(picker.getAttribute('data-from')).toBe('2026-10-01T00:00:00.000Z');
      expect(picker.getAttribute('data-to')).toBe('2026-10-03T23:59:59.999Z');
    });

    it('collapses bulk operations and shows system changes by default, with no period', () => {
      feed();
      const [collapse, hideSystem] = screen.getAllByRole('switch') as HTMLInputElement[];
      expect(collapse.checked).toBe(true);
      expect(hideSystem.checked).toBe(false);
      expect(screen.getByRole('button', { name: 'pick a period' }).getAttribute('data-from')).toBe('');
      expect(screen.queryByRole('button', { name: 'Скинути період' })).toBeNull();
    });

    it('keeps a switch in the URL and goes back to the first page', () => {
      feed({ page: 3, perPage: 50 });
      fireEvent.click(screen.getByRole('switch', { checked: true }));
      expect(url()).toEqual({ collapse: false, perPage: 50 });
      fireEvent.click(screen.getAllByRole('switch')[1]);
      expect(url()).toEqual({ collapse: false, hideSystem: true, perPage: 50 });
      fireEvent.click(screen.getAllByRole('switch')[0]);
      expect(url()).toEqual({ hideSystem: true, perPage: 50 });
    });

    it('keeps a picked period as whole days, back to the first page, and clears it', () => {
      feed({ page: 3 });
      fireEvent.click(screen.getByRole('button', { name: 'pick a period' }));
      const period = periodBounds(new Date(2026, 9, 1), new Date(2026, 9, 3));
      expect(url()).toEqual(period);

      fireEvent.click(screen.getByRole('button', { name: 'Скинути період' }));
      expect(url()).toEqual({});
      expect(screen.queryByRole('button', { name: 'Скинути період' })).toBeNull();
    });

    it('opens on the page, the page size, the sort and the filters of the URL', () => {
      const filters = [{ id: 'action', value: { in: ['created'] } }];
      feed({ page: 2, perPage: 50, sort: '-entityLabel,,createdAt', filters });
      expect(h.table).toMatchObject({
        page: 2,
        itemsPerPage: 50,
        sorting: [
          { id: 'entityLabel', desc: true },
          { id: 'createdAt', desc: false },
        ],
        columnFilters: filters,
      });
    });

    it('sorts newest first when the URL’s sort is empty or unreadable', () => {
      feed({ sort: '' });
      expect(h.table.sorting).toEqual([{ id: 'createdAt', desc: true }]);
      cleanup();
      feed({ sort: 5 });
      expect(h.table.sorting).toEqual([{ id: 'createdAt', desc: true }]);
    });

    it('keeps the page and the page size in the URL, only when they change', () => {
      feed({ page: 2, perPage: 20 });
      act(() => h.table.onPageChange(undefined, 2, 20));
      expect(h.navigations).toEqual([]);
      act(() => h.table.onPageChange(undefined, 3, 20));
      expect(url()).toEqual({ page: 3, perPage: 20 });
      act(() => h.table.onPageChange(undefined, 3, 50));
      expect(url()).toEqual({ page: 3, perPage: 50 });
    });

    it('keeps the sort in the URL, and leaves it out when there is none', () => {
      feed();
      act(() =>
        h.table.onSortChange(undefined, [
          { id: 'createdAt', desc: true },
          { id: 'entityLabel', desc: false },
        ]),
      );
      expect(url()).toEqual({ sort: '-createdAt,entityLabel' });
      act(() => h.table.onSortChange(undefined, []));
      expect(url()).toEqual({});
    });

    it('keeps the column filters in the URL from the first page, only when they change', () => {
      const filters = [{ id: 'action', value: { in: ['created'] } }];
      feed({ page: 3, filters });
      act(() => h.table.onFilterChange(undefined, [{ id: 'action', value: { in: ['created'] } }]));
      expect(h.navigations).toEqual([]);
      const next = [{ id: 'action', value: { in: ['created', 'updated'] } }];
      act(() => h.table.onFilterChange(undefined, next));
      expect(url()).toEqual({ page: 1, filters: next });
      act(() => h.table.onFilterChange(undefined, []));
      expect(url()).toEqual({ page: 1 });
    });
  });

  describe('the query', () => {
    it('keys the feed’s query by its marker, the switches and the period', () => {
      feed({ hideSystem: true, from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T23:59:59.999Z' });
      expect(h.table.transformQueryKey(['changeHistoryEntries', { skip: 0 }])).toEqual([
        'changeHistoryEntries',
        { skip: 0 },
        FEED_QUERY_MARKER,
        true,
        true,
        '2026-10-01T00:00:00.000Z',
        '2026-10-03T23:59:59.999Z',
      ]);
    });

    it('adds the switches and the period to the table’s filter', () => {
      const switches = {
        collapseBatches: false,
        hideSystem: true,
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-03T23:59:59.999Z',
      };
      feed({ collapse: false, hideSystem: true, from: switches.from, to: switches.to });
      const tableFilter = { _and: [{ action: { in: ['created'] } }] };
      expect(h.table.transformVariables({ options: { take: 20, filter: tableFilter } })).toEqual({
        options: { take: 20, filter: feedFilter(tableFilter, switches) },
      });
      expect(h.table.transformVariables({})).toEqual({ options: { filter: feedFilter(undefined, switches) } });
    });

    it('searches by the object’s name and what a run was about', () => {
      feed();
      expect(h.table.onSearchTermChange).toBe(searchFilter);
      expect(h.table.onSearchTermChange('SO-1042')).toEqual(searchFilter('SO-1042'));
    });
  });

  describe('the filters', () => {
    it('offers the types the server knows and the registered ones, once each, by label', async () => {
      getChangeHistoryRegistry().entityTypes.set('Supplier', { label: 'Постачальник' });
      getChangeHistoryRegistry().entityTypes.set('Product', { label: 'Товар' });
      feed();
      const { entityType } = h.table.facetedFilters;
      expect(entityType.title).toBe('Тип');
      expect(await act(() => entityType.optionsFn())).toEqual([
        { value: 'Collection', label: 'Колекція' },
        { value: 'Supplier', label: 'Постачальник' },
        { value: 'Product', label: 'Товар' },
      ]);
      expect(h.optionsRequests).toHaveLength(1);
    });

    it('offers the actions and the sources by label', async () => {
      feed();
      const { action, source } = h.table.facetedFilters;
      expect(action.title).toBe('Дія');
      expect(await act(() => action.optionsFn())).toEqual([
        { value: 'updated', label: 'оновлено' },
        { value: 'created', label: 'створено' },
      ]);
      expect(source.title).toBe('Джерело');
      expect((await act(() => source.optionsFn())).map((option) => option.value).sort()).toEqual(['admin', 'api_key']);
      const labels = (await act(() => source.optionsFn())).map((option) => option.label);
      expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
      expect(labels).toContain('Адмін-панель');
    });

    it('offers each person once, an API key marked as one', async () => {
      feed();
      const { actorId } = h.table.facetedFilters;
      expect(actorId.title).toBe('Хто');
      expect(await act(() => actorId.optionsFn())).toEqual([
        { value: 'api_key:2', label: 'Odoo (API-ключ)' },
        { value: 'admin:1', label: 'Іван Петренко' },
      ]);
    });

    it('says the filter options failed to load, and gives the filters new loaders on retry', async () => {
      getChangeHistoryRegistry().entityTypes.set('Supplier', { label: 'Постачальник' });
      h.options = new Error('Failed to fetch');
      feed();
      expect(screen.queryByRole('alert')).toBeNull();
      // The filters still offer what the dashboard knows.
      expect(await act(() => h.table.facetedFilters.entityType.optionsFn())).toEqual([
        { value: 'Supplier', label: 'Постачальник' },
      ]);
      expect(await act(() => h.table.facetedFilters.actorId.optionsFn())).toEqual([]);
      expect(screen.getByRole('alert').textContent).toContain('Не вдалося завантажити варіанти фільтрів.');
      expect(screen.getByRole('alert').getAttribute('title')).toBe('Failed to fetch');

      const before = h.table.facetedFilters;
      h.options = OPTIONS;
      fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(h.table.facetedFilters).not.toBe(before);
      expect((await act(() => h.table.facetedFilters.action.optionsFn())).length).toBe(2);
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps the same loaders while nothing failed, so the filters do not ask again', async () => {
      feed();
      const before = h.table.facetedFilters;
      await act(() => before.action.optionsFn());
      fireEvent.click(screen.getAllByRole('switch')[1]);
      expect(h.table.facetedFilters).toBe(before);
    });
  });

  describe('a failed feed request', () => {
    it('says the history failed to load, with a retry, and hides the table’s «No results»', async () => {
      feed();
      expect(wrapper().className).not.toContain('[&_tbody]:hidden');
      await feedQuery({ status: 'error', fetchStatus: 'idle', error: new Error('Failed to fetch'), errorUpdatedAt: 1 });
      expect(screen.getByRole('alert').textContent).toContain('Не вдалося завантажити історію змін.');
      expect(wrapper().className).toContain('[&_tbody]:hidden');

      fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
      expect(client().refetchQueries).toHaveBeenCalledWith(expect.objectContaining({ type: 'active' }));
      expect(client().refetched).toEqual([FEED_KEY]);

      await feedQuery({ fetchStatus: 'fetching' });
      expect((screen.getByRole('button', { name: 'Повторити' }) as HTMLButtonElement).disabled).toBe(true);

      await feedQuery(success(3, 2));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(wrapper().className).not.toContain('[&_tbody]:hidden');
    });

    it('shows the feed’s failure alone when the filter options failed too', async () => {
      h.options = new Error('Failed to fetch');
      feed();
      await act(() => h.table.facetedFilters.action.optionsFn());
      await feedQuery({ status: 'error', fetchStatus: 'idle', error: new Error('Failed to fetch'), errorUpdatedAt: 1 });
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(screen.getByRole('alert').textContent).toContain('Не вдалося завантажити історію змін.');
    });

    it('reads the newest feed query on screen, not another query or one nobody shows', async () => {
      feed();
      // A query of the feed nobody observes any more (a previous page) and another page's query.
      await feedQuery({ status: 'error', error: new Error('old'), errorUpdatedAt: 9 }, [...FEED_KEY, 'old'], 0);
      await feedQuery({ status: 'error', error: new Error('other'), errorUpdatedAt: 9 }, ['changeHistoryEntry'], 1);
      expect(screen.queryByRole('alert')).toBeNull();

      await feedQuery({ status: 'error', fetchStatus: 'idle', error: new Error('failed'), errorUpdatedAt: 1 });
      await feedQuery(success(3, 5), [...FEED_KEY, 'newer']);
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('reads the cache once for a burst of updates, and stops reading when the page is gone', async () => {
      const { unmount } = feed();
      const reads = () => client().cache.findAll.mock.calls.length;
      const initial = reads();
      await act(async () => {
        client().put(FEED_KEY, { status: 'pending', fetchStatus: 'fetching' });
        client().put(FEED_KEY, success(3, 1));
      });
      expect(reads()).toBe(initial + 1);

      client().put(FEED_KEY, success(4, 2));
      unmount();
      await Promise.resolve();
      expect(reads()).toBe(initial + 1);
      expect(client().listeners.size).toBe(0);
    });
  });

  describe('a page past the end', () => {
    it('opens the table again on the last page and corrects the URL', async () => {
      feed({ page: 9, perPage: 10 });
      expect(h.table.page).toBe(9);
      expect(h.mounts).toBe(1);

      await feedQuery(success(25));
      expect(h.table.page).toBe(3);
      expect(h.mounts).toBe(2);
      expect(url()).toEqual({ page: 3, perPage: 10 });
    });

    it('waits for the request to finish before it corrects the page', async () => {
      feed({ page: 9, perPage: 10 });
      await feedQuery({ ...success(25), fetchStatus: 'fetching' });
      expect(h.table.page).toBe(9);
      expect(h.mounts).toBe(1);
      expect(h.navigations).toEqual([]);
    });

    it('leaves a page within the list alone', async () => {
      feed({ page: 2, perPage: 10 });
      await feedQuery(success(25));
      expect(h.table.page).toBe(2);
      expect(h.mounts).toBe(1);
      expect(h.navigations).toEqual([]);
    });
  });
});
