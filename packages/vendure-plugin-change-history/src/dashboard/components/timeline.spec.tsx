// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeHistoryDetailData, ChangeHistoryEntryData } from '../registry';
import { getChangeHistoryRegistry } from '../registry';
import { answerQueries, api, refetches } from '../testing/dashboard-mock';
import { dialogData, entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { EntityTimeline } from './timeline';

vi.mock('@vendure/dashboard', async () => {
  const mock = await import('../testing/dashboard-mock');
  type Options = {
    queryKey: readonly unknown[];
    queryFn?: (context: { pageParam: null }) => unknown;
    enabled?: boolean;
  };
  return {
    ...mock,
    // Sends the request as React Query would, so that a test sees what the timeline asks for.
    useQuery: (options: Options) => {
      if (options.enabled !== false) {
        void options.queryFn?.({ pageParam: null });
      }
      return mock.useQuery(options);
    },
    // A next page exists when the last one says so, as React Query reads it with `getNextPageParam`.
    useInfiniteQuery: (options: Options & { getNextPageParam: (page: unknown) => unknown }) => {
      void options.queryFn?.({ pageParam: null });
      const result = mock.useInfiniteQuery(options);
      const last = result.data?.pages.at(-1);
      return { ...result, hasNextPage: last !== undefined && options.getNextPageParam(last) !== undefined };
    },
    // A dialog that can be dismissed, as the Escape key or the close button does.
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
            Dismiss
          </button>
        </>
      ) : null,
  };
});
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));
vi.mock('@lingui/react', () => import('../testing/lingui-mock'));

const REGISTRY_KEY = Symbol.for('@uplab/vendure-plugin-change-history/registry');

beforeEach(() => setLocale('uk'));
afterEach(() => {
  cleanup();
  setLocale('en');
  vi.restoreAllMocks();
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
});

const page = (items: ChangeHistoryEntryData[]) => ({
  data: { changeHistoryEntityTimeline: { items, endCursor: null, hasMore: false } },
});

function timeline(items: ChangeHistoryEntryData[], others?: Parameters<typeof answerQueries>[0]) {
  answerQueries((key) => (key[0] === 'change-history-timeline' ? page(items) : others?.(key)));
  return render(<EntityTimeline subject={{ entityType: 'Product', entityId: '1' }} />);
}

/** The title line of the n-th item: what happened, who, when. */
const titleLine = (index = 0) =>
  (document.querySelectorAll('.flex-wrap.items-center.text-sm')[index]?.textContent ?? '').replace(/\s+/g, ' ');

describe('EntityTimeline', () => {
  it('reads what happened first, then who: grammatical in Ukrainian', () => {
    timeline([entry({ changes: { enabled: { kind: 'bool', from: true, to: false } } })]);
    expect(titleLine()).toMatch(/^Оновлено·Іван Петренко·/);
  });

  it('reads the same way in English', () => {
    setLocale('en');
    timeline([
      entry({
        action: 'option_group_added',
        changes: { optionGroups: { kind: 'refs', added: ['1'], labels: { 1: 'Size' } } },
      }),
    ]);
    expect(titleLine()).toMatch(/^Option group added·Іван Петренко·/);
  });

  it('leaves the field / was / became header out of every item', () => {
    timeline([entry({ changes: { enabled: { kind: 'bool', from: true, to: false } } })]);
    expect(document.querySelector('thead')).toBeNull();
  });

  it('says «deleted» once for a deleted child', () => {
    timeline([
      entry({
        entityType: 'ProductVariant',
        entityId: '9',
        entityLabel: 'Худі M',
        action: 'deleted',
        entityDeleted: true,
      }),
    ]);
    expect(titleLine().match(/видалено/gi)).toHaveLength(1);
  });

  it('says that the history could not be loaded, with a retry, instead of «no changes»', () => {
    answerQueries((key) =>
      key[0] === 'change-history-timeline' ? { isError: true, error: new Error('Failed to fetch') } : undefined,
    );
    render(<EntityTimeline subject={{ entityType: 'Product', entityId: '1' }} />);
    expect(screen.getByRole('alert').textContent).toContain('Не вдалося завантажити історію змін.');
    expect(document.body.textContent).not.toContain('Змін ще не записано.');
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    expect(refetches).toEqual(['change-history-timeline']);
  });

  it("reports a batch's members that could not be loaded", () => {
    timeline(
      [
        entry({
          entityType: 'Batch',
          action: 'batch',
          batchId: 'bulk_edit:1',
          meta: { kind: 'bulk_edit', fields: ['enabled'] },
          batchCounts: [{ entityType: 'Product', action: 'updated', count: 3 }],
        }),
      ],
      (key) => (key[0] === 'change-history-batch-members' ? { isError: true, error: new Error('boom') } : undefined),
    );
    // A fold opens with the same word everywhere.
    fireEvent.click(screen.getByRole('button', { name: 'розгорнути' }));
    expect(screen.getByRole('alert').textContent).toContain('Не вдалося завантажити історію змін.');
  });

  it('offers the rest of a batch when it has more members than are shown', () => {
    const members = [entry({ id: '2', batchId: 'bulk_edit:1' })];
    timeline(
      [
        entry({
          entityType: 'Batch',
          action: 'batch',
          batchId: 'bulk_edit:1',
          meta: { kind: 'bulk_edit' },
          batchCounts: [{ entityType: 'Product', action: 'updated', count: 120 }],
        }),
      ],
      (key) =>
        key[0] === 'change-history-batch-members'
          ? {
              data: {
                changeHistoryEntry: {
                  batchMembers: { items: members, totalItems: 120 },
                  derivedEntries: { items: [], totalItems: 0 },
                },
              },
            }
          : undefined,
    );
    fireEvent.click(screen.getByRole('button', { name: 'розгорнути' }));
    expect(screen.getByRole('button', { name: 'показати всі (120)' })).toBeTruthy();
  });

  it('lists the derived entries the reader may see, and offers the rest', () => {
    timeline([entry({ changes: { name: { kind: 'text', from: 'A', to: 'B' } }, derivedCount: 80 })], (key) =>
      key[0] === 'change-history-derived'
        ? {
            data: {
              changeHistoryEntry: {
                derivedEntries: {
                  items: [entry({ id: '3', entityType: 'ProductVariant', entityLabel: 'Tee S (TS-S)' })],
                  totalItems: 60,
                },
                batchMembers: { items: [], totalItems: 0 },
              },
            },
          }
        : undefined,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Наслідки зміни: 80' }));
    expect(screen.getByText('Tee S (TS-S)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'показати всі (60)' })).toBeTruthy();
  });

  it('links what a run was about', () => {
    timeline([
      entry({
        entityType: 'Run',
        entityLabel: 'Odoo: залишки після замовлення',
        action: 'run',
        source: 'odoo',
        actorType: 'system',
        actorLabel: null,
        meta: { subject: { label: 'SO-1042', type: 'Order', id: 42 } },
      }),
    ]);
    expect(titleLine()).toMatch(/^Odoo: залишки після замовлення·SO-1042·/);
    expect(screen.getByRole('link', { name: 'SO-1042' }).getAttribute('href')).toBe('/orders/42');
  });

  it('shows the run label first, and its source not again', () => {
    timeline([
      entry({
        entityType: 'Run',
        entityLabel: 'Odoo: залишки після замовлення #1042',
        action: 'run',
        source: 'odoo',
        actorType: 'system',
        actorLabel: null,
      }),
    ]);
    expect(titleLine()).toMatch(/^Odoo: залишки після замовлення #1042·/);
  });
});

function detailRow(id: string, over: Partial<ChangeHistoryDetailData> = {}): ChangeHistoryDetailData {
  return {
    id,
    entryId: '5',
    entityType: 'ProductVariant',
    entityId: '9',
    entityLabel: 'Худі M',
    sku: 'H-M',
    parentType: 'Product',
    parentId: '1',
    kind: 'stock',
    scope: 'main',
    scopeLabel: `Склад ${id}`,
    from: 1,
    to: 4,
    ...over,
  };
}

/** A run with its first rows, as the timeline query returns it. */
const runWith = (details: ChangeHistoryDetailData[], detailsTotal: number) => ({
  ...entry({
    id: '5',
    entityType: 'Run',
    entityLabel: 'ERP: залишки',
    action: 'run',
    source: 'erp',
    actorType: 'system',
    actorLabel: null,
  }),
  details,
  detailsTotal,
});

const membersOf = (items: ChangeHistoryEntryData[], totalItems = items.length) => ({
  data: {
    changeHistoryEntry: {
      batchMembers: { items, totalItems },
      derivedEntries: { items: [], totalItems: 0 },
    },
  },
});

const derivedOf = (items: ChangeHistoryEntryData[], totalItems = items.length) => ({
  data: {
    changeHistoryEntry: {
      derivedEntries: { items, totalItems },
      batchMembers: { items: [], totalItems: 0 },
    },
  },
});

const bulkEdit = (over: Partial<ChangeHistoryEntryData> = {}) =>
  entry({
    id: '6',
    entityType: 'Batch',
    action: 'batch',
    batchId: 'bulk_edit:1',
    meta: { kind: 'bulk_edit' },
    batchCounts: [{ entityType: 'Product', action: 'updated', count: 2 }],
    ...over,
  });

describe('EntityTimeline, its states', () => {
  it('waits for the first page', () => {
    answerQueries((key) => (key[0] === 'change-history-timeline' ? { isLoading: true } : undefined));
    render(<EntityTimeline subject={{ entityType: 'Product', entityId: '1' }} />);
    expect(document.querySelectorAll('[data-skeleton]')).toHaveLength(2);
  });

  it('says when nothing was recorded yet', () => {
    timeline([]);
    expect(document.body.textContent).toBe('Змін ще не записано.');
  });

  it('asks for the first 20 items, and offers the next page when there is one', () => {
    const query = vi.spyOn(api, 'query');
    answerQueries((key) =>
      key[0] === 'change-history-timeline'
        ? { data: { changeHistoryEntityTimeline: { items: [entry()], endCursor: 'c1', hasMore: true } } }
        : undefined,
    );
    render(<EntityTimeline subject={{ entityType: 'Product', entityId: '1' }} />);
    expect(query).toHaveBeenCalledWith(expect.anything(), {
      entityType: 'Product',
      entityId: '1',
      first: 20,
      after: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Показати ще' }));
    expect(refetches).toEqual(['change-history-timeline:next']);
  });

  it('keeps the items it has when the next page fails, and retries that page', () => {
    answerQueries((key) =>
      key[0] === 'change-history-timeline'
        ? {
            data: { changeHistoryEntityTimeline: { items: [entry()], endCursor: 'c1', hasMore: true } },
            isError: true,
            error: new Error('Failed to fetch'),
          }
        : undefined,
    );
    render(<EntityTimeline subject={{ entityType: 'Product', entityId: '1' }} />);
    expect(titleLine()).toMatch(/^Оновлено·/);
    expect(screen.queryByRole('button', { name: 'Показати ще' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    expect(refetches).toEqual(['change-history-timeline:next']);
  });
});

describe('EntityTimeline, a run', () => {
  it("shows a run's own rows when they are all the subject's, and the rest in the entry window", () => {
    answerQueries((key) => {
      if (key[0] === 'change-history-timeline') {
        return page([runWith([detailRow('1'), detailRow('2')], 120)]);
      }
      return key[0] === 'change-history-entry'
        ? { data: dialogData(entry({ id: '5', entityType: 'Run' })) }
        : undefined;
    });
    render(<EntityTimeline subject={{ entityType: 'ProductVariant', entityId: '9' }} />);
    expect(screen.getByText('Склад 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'розгорнути' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'показати всі (120)' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('folds a run that touched several entities into its count line, and unfolds its rows', () => {
    timeline([runWith([detailRow('1'), detailRow('2', { entityId: '10', entityLabel: 'Худі L', sku: 'H-L' })], 2)]);
    expect(titleLine()).toMatch(/^ERP: залишки·Варіанти: 2 · Рядки: 2·/);
    expect(screen.queryByText('Склад 1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'розгорнути' }));
    expect(screen.getByText('Склад 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /показати всі/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'згорнути' }));
    expect(screen.queryByText('Склад 1')).toBeNull();
  });

  it('offers the rest of the rows of a folded run once unfolded', () => {
    timeline([runWith([detailRow('1', { entityType: 'Product', entityId: '2' })], 30)]);
    fireEvent.click(screen.getByRole('button', { name: 'розгорнути' }));
    expect(screen.getByRole('button', { name: 'показати всі (30)' })).toBeTruthy();
  });
});

describe('EntityTimeline, a batch', () => {
  it('asks for 50 of its members only when unfolded, and lists what each one had done to it', () => {
    const query = vi.spyOn(api, 'query');
    timeline([bulkEdit()], (key) =>
      key[0] === 'change-history-batch-members'
        ? membersOf([
            entry({ id: '11', entityLabel: 'Худі', changes: { enabled: { kind: 'bool', from: true, to: false } } }),
            entry({ id: '12', entityLabel: 'Кепка', action: 'channel_assigned', derivedCount: 3 }),
            entry({ id: '13', entityLabel: 'Шапка', action: 'channel_assigned' }),
          ])
        : undefined,
    );
    expect(query).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: '6' }));
    fireEvent.click(screen.getByRole('button', { name: 'розгорнути' }));
    expect(query).toHaveBeenCalledWith(expect.anything(), {
      id: '6',
      memberOptions: { take: 50, sort: { createdAt: 'ASC' } },
      derivedOptions: { take: 1 },
    });
    const members = [...document.querySelectorAll('ul li')].map((item) => item.textContent);
    expect(members).toEqual([
      'Худі · оновлено · Увімкнено: Так → Ні',
      'Кепка · додано до каналуНаслідки зміни: 3',
      'Шапка · додано до каналу',
    ]);
    expect(screen.queryByRole('button', { name: /показати всі/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'згорнути' }));
    expect(document.querySelector('ul')).toBeNull();
  });

  it('waits for its members, and retries them when they could not be loaded', () => {
    timeline([bulkEdit()], (key) => (key[0] === 'change-history-batch-members' ? { isLoading: true } : undefined));
    fireEvent.click(screen.getByRole('button', { name: 'розгорнути' }));
    expect(document.querySelector('ul [data-skeleton]')).not.toBeNull();
    cleanup();

    timeline([bulkEdit()], (key) =>
      key[0] === 'change-history-batch-members' ? { isError: true, error: new Error('boom') } : undefined,
    );
    fireEvent.click(screen.getByRole('button', { name: 'розгорнути' }));
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    expect(refetches).toEqual(['change-history-batch-members']);
  });

  it('links the collection of a collection-rules batch, and cannot unfold a compacted one', () => {
    timeline([
      bulkEdit({
        batchId: 'collection_rules:1',
        source: 'collection_rules',
        actorType: 'system',
        actorLabel: null,
        parentType: 'Collection',
        parentId: '20',
        entityLabel: 'Sale',
        isCompacted: true,
        meta: { counts: { added: 2, removed: 1 } },
      }),
    ]);
    expect(titleLine()).toMatch(/^Оновлено вміст колекції·Sale·Правила колекції·/);
    expect(screen.getByRole('link', { name: 'Sale' }).getAttribute('href')).toBe('/collections/20');
    expect(screen.getByText('+2 / −1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'розгорнути' })).toBeNull();
  });
});

describe('EntityTimeline, derived changes', () => {
  it('lists a created derived entity by its values and an updated one by its changes, and folds them again', () => {
    const query = vi.spyOn(api, 'query');
    timeline([entry({ derivedCount: 2 })], (key) =>
      key[0] === 'change-history-derived'
        ? derivedOf([
            entry({
              id: '21',
              entityType: 'ProductVariant',
              entityLabel: 'Худі S',
              action: 'created',
              changes: { sku: { kind: 'text', to: 'H-S' } },
            }),
            entry({
              id: '22',
              entityType: 'ProductVariant',
              entityLabel: 'Худі M',
              action: 'deleted',
              entityDeleted: true,
              changes: { enabled: { kind: 'bool', from: true, to: false } },
            }),
            entry({ id: '23', entityType: 'ProductVariant', entityLabel: 'Худі L', changes: null }),
          ])
        : undefined,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Наслідки зміни: 2' }));
    expect(query).toHaveBeenCalledWith(expect.anything(), {
      id: '1',
      derivedOptions: { take: 50, sort: { createdAt: 'ASC' } },
      memberOptions: { take: 1 },
    });
    expect(screen.getByText('H-S')).toBeTruthy();
    expect(screen.getByText('Ні')).toBeTruthy();
    expect(screen.getByText('Худі L')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /показати всі/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Наслідки зміни: 2' }));
    expect(screen.queryByText('H-S')).toBeNull();
  });

  it('counts the derived changes of a compacted entry without offering to unfold them', () => {
    timeline([entry({ derivedCount: 3, isCompacted: true })]);
    expect(screen.queryByRole('button', { name: 'Наслідки зміни: 3' })).toBeNull();
    expect(screen.getByText('Наслідки зміни: 3', { exact: false })).toBeTruthy();
  });

  it('waits for the derived changes, and retries them when they could not be loaded', () => {
    timeline([entry({ derivedCount: 2 })], (key) =>
      key[0] === 'change-history-derived' ? { isLoading: true } : undefined,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Наслідки зміни: 2' }));
    expect(document.querySelector('[data-skeleton]')).not.toBeNull();
    cleanup();

    timeline([entry({ derivedCount: 2 })], (key) =>
      key[0] === 'change-history-derived' ? { isError: true, error: new Error('boom') } : undefined,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Наслідки зміни: 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    expect(refetches).toEqual(['change-history-derived']);
  });
});

describe('EntityTimeline, an entry', () => {
  const badges = () => [...document.querySelectorAll('[data-badge]')].map((badge) => badge.textContent);

  it('marks a change caused by another, and the bulk operation it was part of', () => {
    getChangeHistoryRegistry().batchKinds.set('archive', { label: 'архівування' });
    timeline([entry({ derivedFromId: '4', batchId: 'archive:1' })]);
    expect(badges()).toEqual(['Наслідок іншої зміни', 'Архівування']);
  });

  it("leaves out a batch badge that would repeat the line, or that collection rules' own items carry", () => {
    timeline([
      entry({ id: '2', action: 'channel_assigned', batchId: 'channel_assigned:1', meta: { channelCode: 'uk-store' } }),
      entry({
        id: '3',
        action: 'collection_added',
        source: 'admin',
        batchId: 'collection_rules:1',
        parentType: 'Collection',
        parentId: '20',
        meta: { collectionLabel: 'Sale' },
      }),
    ]);
    expect(badges()).toEqual([]);
    expect(screen.getByText('Канал: uk-store', { exact: false })).toBeTruthy();
    expect(screen.getByRole('link', { name: '«Sale»' }).getAttribute('href')).toBe('/collections/20');
  });

  it("names a membership's collection by its id when no name was recorded, and a gone one as deleted", () => {
    timeline([
      entry({ id: '2', action: 'collection_removed', parentType: 'Collection', parentId: '20', parentDeleted: true }),
      entry({ id: '3', action: 'collection_added', parentType: 'Collection', parentId: null }),
    ]);
    expect(titleLine(0)).toMatch(/^Вилучено з колекції«20»Видалено·/);
    expect(titleLine(1)).toMatch(/^Додано до колекції·Іван Петренко·/);
  });

  it("names another entity's change by its type, its values when created, and an unrecorded update's details", () => {
    timeline([
      entry({
        id: '2',
        entityType: 'ProductVariant',
        entityId: '9',
        entityLabel: 'Худі M',
        action: 'created',
        changes: { sku: { kind: 'text', to: 'H-M' } },
      }),
      entry({ id: '3', meta: { noBefore: true } }),
      entry({ id: '4', action: 'products_reordered', meta: { counts: { moved: 3 } } }),
      entry({ id: '5', action: 'channel_removed' }),
    ]);
    expect(titleLine(0)).toMatch(/^Створено·Варіант Худі M·/);
    expect(screen.getByText('H-M')).toBeTruthy();
    expect(screen.getByText('деталі недоступні')).toBeTruthy();
    expect(screen.getByText('переміщено: 3')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Канал');
  });
});
