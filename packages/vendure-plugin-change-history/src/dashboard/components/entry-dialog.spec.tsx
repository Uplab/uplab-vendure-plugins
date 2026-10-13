// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeHistoryDetailData, ChangeHistoryEntryData } from '../registry';
import { getChangeHistoryRegistry } from '../registry';
import { answerQueries, api, refetches } from '../testing/dashboard-mock';
import { dialogData, entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { EntryDialog } from './entry-dialog';

vi.mock('@vendure/dashboard', async () => {
  const mock = await import('../testing/dashboard-mock');
  const { useRef } = await import('react');
  return {
    ...mock,
    // Sends the request as React Query would, so that a test sees what the window asks for; with
    // `placeholderData` the last data stays while the next key loads.
    useQuery: (options: {
      queryKey: readonly unknown[];
      queryFn?: () => unknown;
      enabled?: boolean;
      placeholderData?: unknown;
    }) => {
      if (options.enabled !== false) {
        void options.queryFn?.();
      }
      const result = mock.useQuery(options);
      const previous = useRef<unknown>(undefined);
      if (result.data !== undefined) {
        previous.current = result.data;
      } else if (options.placeholderData && previous.current !== undefined) {
        return { ...result, data: previous.current, isLoading: false };
      }
      return result;
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
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
});

function open(value: ReturnType<typeof entry> | null, members: Array<ReturnType<typeof entry>> = []) {
  answerQueries((key) => (key[0] === 'change-history-entry' ? { data: dialogData(value, members) } : undefined));
  return render(<EntryDialog entryId="7" onClose={() => undefined} />);
}

const header = () => screen.getByRole('dialog').querySelector('header')?.textContent ?? '';

describe('EntryDialog', () => {
  it('names the collection a product was added to, with a link', () => {
    open(
      entry({
        action: 'collection_added',
        source: 'collection_rules',
        actorType: 'system',
        actorLabel: null,
        parentType: 'Collection',
        parentId: '20',
        meta: { collectionLabel: 'Sale' },
      }),
    );
    const link = screen.getByRole('link', { name: 'Sale' });
    expect(link.getAttribute('href')).toBe('/collections/20');
    expect(screen.getByText('Колекція')).toBeTruthy();
  });

  it('names the channel of a channel assignment', () => {
    open(entry({ entityType: 'Asset', action: 'channel_assigned', meta: { channelCode: 'uk-store' } }));
    expect(screen.getByText('Канал')).toBeTruthy();
    expect(screen.getByText('uk-store')).toBeTruthy();
  });

  it('names the cause of a derived entry under its header, and opens the cause’s entry from it', () => {
    const cause = entry({ id: '4', entityLabel: 'Oversize tee Basic', action: 'channel_assigned' });
    const derived = entry({
      id: '7',
      entityType: 'Asset',
      entityLabel: 'tee.jpg',
      action: 'channel_assigned',
      derivedFromId: '4',
      derivedFrom: cause,
      meta: { channelCode: 'uk-store' },
    });
    answerQueries((key) =>
      key[0] === 'change-history-entry' ? { data: dialogData(key[1] === '4' ? cause : derived) } : undefined,
    );
    render(<EntryDialog entryId="7" onClose={() => undefined} />);
    expect(header()).toContain('Причина: Товар «Oversize tee Basic» · додано до каналу');
    fireEvent.click(screen.getByRole('button', { name: 'Товар «Oversize tee Basic» · додано до каналу' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    expect(screen.getAllByRole('heading', { level: 2 }).map((title) => title.textContent)).toEqual([
      'Ресурс «tee.jpg»відкрити →',
      'Товар «Oversize tee Basic»відкрити →',
    ]);
    // Closing the cause's window goes back to the derived entry's.
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Ресурс «tee.jpg»відкрити →');
  });

  it('says nothing of a cause the reader cannot see, and names its close button in the dashboard’s language', () => {
    open(entry({ derivedFromId: '4', derivedFrom: null }));
    expect(header()).not.toContain('Причина');
    expect(screen.getByRole('button', { name: 'Закрити' })).toBeTruthy();
  });

  it('titles a batch without a label of its own by its registered kind, never by the raw kind', () => {
    const batch = entry({
      entityType: 'Batch',
      entityLabel: 'archive',
      action: 'batch',
      batchId: 'archive:1',
      meta: { kind: 'archive' },
      batchCounts: [{ entityType: 'Product', action: 'updated', count: 1 }],
    });
    const { unmount } = open(batch);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Масова операція');
    expect(document.body.textContent).not.toContain('archive');
    unmount();

    // The server leaves the label out when a host stored the kind there.
    const { unmount: unmountUnlabelled } = open({ ...batch, entityLabel: null });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Масова операція');
    unmountUnlabelled();

    getChangeHistoryRegistry().batchKinds.set('archive', { label: 'архівування' });
    open(batch);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Архівування');
    // The kind is the title: the line under it does not repeat it.
    expect(header().match(/архівування/gi)).toHaveLength(1);
  });

  it('shows a scheduled action once, though it is the title, the actor, the kind and the source', () => {
    const registry = getChangeHistoryRegistry();
    registry.sources.set('scheduled_action', { label: 'Відкладена дія', tone: 'scheduled' });
    registry.batchKinds.set('scheduled_action', { label: 'відкладена дія' });
    open(
      entry({
        entityType: 'Batch',
        entityLabel: 'Відкладена дія #3',
        action: 'batch',
        source: 'scheduled_action',
        actorType: 'system',
        actorLabel: null,
        batchId: 'scheduled_action:1',
        meta: { kind: 'scheduled_action' },
      }),
    );
    expect(header().match(/відкладена дія/gi)).toHaveLength(1);
  });

  it('links what a run was about', () => {
    answerQueries((key) => {
      if (key[0] === 'change-history-entry') {
        return {
          data: dialogData(
            entry({
              entityType: 'Run',
              entityLabel: 'ERP: залишки',
              action: 'run',
              source: 'erp',
              actorType: 'system',
              actorLabel: null,
              meta: { counts: { updated: 2 }, subject: { label: 'SO-1042', type: 'Order', id: '42' } },
            }),
          ),
        };
      }
      return key[0] === 'change-history-run-details'
        ? { data: { changeHistoryRunDetails: { items: [], totalItems: 0 } } }
        : undefined;
    });
    render(<EntryDialog entryId="7" onClose={() => undefined} />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('ERP: залишки');
    expect(screen.getByRole('link', { name: 'SO-1042' }).getAttribute('href')).toBe('/orders/42');
  });

  it('says why the entry could not be loaded and retries, in the dashboard language', () => {
    answerQueries((key) =>
      key[0] === 'change-history-entry' ? { isError: true, error: new Error('Failed to fetch') } : undefined,
    );
    render(<EntryDialog entryId="7" onClose={() => undefined} />);
    expect(screen.getByRole('alert').textContent).toContain('Не вдалося завантажити історію змін.');
    expect(document.body.textContent).not.toContain('Failed to fetch');
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    expect(refetches).toEqual(['change-history-entry']);
  });

  it('tells a missing permission apart', () => {
    answerQueries((key) =>
      key[0] === 'change-history-entry'
        ? { isError: true, error: new Error('You are not currently authorized to perform this action') }
        : undefined,
    );
    render(<EntryDialog entryId="7" onClose={() => undefined} />);
    expect(screen.getByRole('alert').textContent).toContain('Немає прав на перегляд цієї історії.');
  });

  it('lists a created entity as a grid, its name first', () => {
    open(
      entry({
        action: 'created',
        changes: {
          enabled: { kind: 'bool', to: true },
          'description.uk': { kind: 'richtext', to: '<p>Тепла</p>' },
          'name.uk': { kind: 'text', to: 'Худі' },
        },
      }),
    );
    const terms = [...document.querySelectorAll('dt')].map((term) => term.textContent);
    expect(terms).toEqual(['Назва (uk)', 'Увімкнено', 'Опис (uk)']);
  });

  it('says «deleted» once for a deleted derived entity', () => {
    const deleted = entry({
      id: '8',
      entityType: 'ProductVariant',
      entityLabel: 'Худі M',
      action: 'deleted',
      entityDeleted: true,
    });
    answerQueries((key) =>
      key[0] === 'change-history-entry'
        ? {
            data: {
              changeHistoryEntry: {
                ...entry({ action: 'deleted', entityDeleted: true, derivedCount: 1 }),
                derivedEntries: { items: [deleted], totalItems: 1 },
                batchMembers: { items: [], totalItems: 0 },
              },
            },
          }
        : undefined,
    );
    render(<EntryDialog entryId="7" onClose={() => undefined} />);
    const derivedLine = screen.getByText('Худі M').closest('div.text-sm')?.textContent ?? '';
    expect(derivedLine.match(/видалено/gi)).toHaveLength(1);
  });

  it('names the pager buttons', () => {
    const members = Array.from({ length: 20 }, (_, index) =>
      entry({ id: String(100 + index), batchId: 'bulk_edit:1' }),
    );
    answerQueries((key) =>
      key[0] === 'change-history-entry'
        ? {
            data: {
              changeHistoryEntry: {
                ...entry({ entityType: 'Batch', action: 'batch', batchId: 'bulk_edit:1', meta: { kind: 'bulk_edit' } }),
                derivedEntries: { items: [], totalItems: 0 },
                batchMembers: { items: members, totalItems: 45 },
              },
            },
          }
        : undefined,
    );
    render(<EntryDialog entryId="7" onClose={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Наступна сторінка' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Попередня сторінка' })).toBeTruthy();
  });

  it("titles a channel operation by its kind, names its channel once and its members' consequences", () => {
    const head = entry({
      entityType: 'Batch',
      entityLabel: null,
      action: 'batch',
      batchId: 'channel_assigned:1',
      meta: { kind: 'channel_assigned', channelCode: 'uk-store' },
      batchCounts: [{ entityType: 'Product', action: 'channel_assigned', count: 2 }],
    });
    const member = (id: string, label: string, derivedCount: number) =>
      entry({
        id,
        entityLabel: label,
        action: 'channel_assigned',
        batchId: 'channel_assigned:1',
        derivedCount,
        meta: { channelCode: 'uk-store' },
      });
    open(head, [member('11', 'Худі', 4), member('12', 'Кепка', 0)]);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Додано до каналу');
    expect(screen.getByText('Канал')).toBeTruthy();
    expect(screen.getByText('Товари: 2')).toBeTruthy();
    // The member rows do not repeat the channel; the one with variants says so.
    expect(screen.getAllByText('uk-store')).toHaveLength(1);
    const rows = [...document.querySelectorAll('tbody tr')].map((row) => row.textContent);
    expect(rows[0]).toContain('Наслідки зміни: 4');
    expect(rows[1]).not.toContain('Наслідки');
  });

  it("leaves a deleted entity's empty values out, and names a created filter list with its size", () => {
    open(
      entry({
        entityType: 'Collection',
        action: 'deleted',
        entityDeleted: true,
        meta: { lastState: { 'name.uk': 'Розпродаж', filters: [], customFields: {}, isPrivate: false } },
      }),
    );
    expect([...document.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['Назва (uk)', 'Приватне']);
  });
});

/** The entry window's answer for a page of derived entries and of batch members (`skip` → items). */
function paged(
  value: ChangeHistoryEntryData,
  {
    derived = () => [],
    derivedTotal = 0,
    members = () => [],
    memberTotal = 0,
  }: {
    derived?: (skip: number) => ChangeHistoryEntryData[];
    derivedTotal?: number;
    members?: (skip: number) => ChangeHistoryEntryData[];
    memberTotal?: number;
  },
) {
  return (key: readonly unknown[]) =>
    key[0] === 'change-history-entry'
      ? {
          data: {
            changeHistoryEntry: {
              ...value,
              derivedEntries: { items: derived(Number(key[2])), totalItems: derivedTotal },
              batchMembers: { items: members(Number(key[3])), totalItems: memberTotal },
            },
          },
        }
      : undefined;
}

const rangeText = () => screen.getByRole('button', { name: 'Наступна сторінка' }).parentElement?.textContent;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

function detailRow(id: string, over: Partial<ChangeHistoryDetailData> = {}): ChangeHistoryDetailData {
  return {
    id,
    entryId: '7',
    entityType: 'ProductVariant',
    entityId: id,
    entityLabel: `Худі ${id}`,
    sku: `H-${id}`,
    parentType: null,
    parentId: null,
    kind: 'stock',
    scope: 'main',
    scopeLabel: 'Основний',
    from: 1,
    to: 3,
    ...over,
  };
}

const run = (over: Partial<ChangeHistoryEntryData> = {}) =>
  entry({
    entityType: 'Run',
    entityLabel: 'ERP: залишки',
    action: 'run',
    source: 'erp',
    actorType: 'system',
    actorLabel: null,
    meta: { counts: { updated: 2, failed: 0 }, durationMs: 3000 },
    ...over,
  });

function openRun(value: ChangeHistoryEntryData, details: (skip: number) => unknown) {
  answerQueries((key) => {
    if (key[0] === 'change-history-entry') {
      return { data: dialogData(value) };
    }
    return key[0] === 'change-history-run-details' ? (details(Number(key[2])) as never) : undefined;
  });
  return render(<EntryDialog entryId="7" onClose={() => undefined} />);
}

describe('EntryDialog, every part of the window', () => {
  it("pages through a batch's members, each way, and asks for the page it shows", () => {
    const query = vi.spyOn(api, 'query');
    const members = (skip: number) =>
      Array.from({ length: Math.min(20, 45 - skip) }, (_, index) =>
        entry({ id: String(100 + skip + index), entityLabel: `Товар ${skip + index + 1}`, batchId: 'bulk_edit:1' }),
      );
    answerQueries(
      paged(entry({ entityType: 'Batch', action: 'batch', batchId: 'bulk_edit:1', meta: { kind: 'bulk_edit' } }), {
        members,
        memberTotal: 45,
      }),
    );
    render(<EntryDialog entryId="7" onClose={() => undefined} />);
    expect(rangeText()).toBe('1–20 / 45');
    expect(button('Попередня сторінка').disabled).toBe(true);

    fireEvent.click(button('Наступна сторінка'));
    expect(rangeText()).toBe('21–40 / 45');
    expect(screen.getByText('Товар 21')).toBeTruthy();
    expect(query).toHaveBeenCalledWith(expect.anything(), {
      id: '7',
      derivedOptions: { skip: 0, take: 20, sort: { createdAt: 'ASC' } },
      memberOptions: { skip: 20, take: 20, sort: { createdAt: 'ASC' } },
    });

    fireEvent.click(button('Наступна сторінка'));
    expect(rangeText()).toBe('41–45 / 45');
    expect(button('Наступна сторінка').disabled).toBe(true);

    fireEvent.click(button('Попередня сторінка'));
    expect(rangeText()).toBe('21–40 / 45');
    query.mockRestore();
  });

  it('titles a batch by its size when compacted, and names the fields a bulk edit set', () => {
    open(
      entry({
        entityType: 'Batch',
        entityLabel: null,
        action: 'batch',
        batchId: 'bulk_edit:1',
        isCompacted: true,
        meta: { kind: 'bulk_edit', fields: ['enabled'] },
        batchCounts: [
          { entityType: 'Product', action: 'updated', count: 30 },
          { entityType: 'ProductVariant', action: 'updated', count: 4 },
        ],
      }),
    );
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Об’єкти: 34 · Увімкнено');
    expect(document.body.textContent).toContain('Детальні значення зберігаються обмежений час');
  });

  it("shows a run's object, its counts with zeros and duration, and its rows with a pager", () => {
    const query = vi.spyOn(api, 'query');
    const rows = (skip: number) => Array.from({ length: 3 }, (_, index) => detailRow(String(skip + index + 1)));
    openRun(
      run({ meta: { counts: { updated: 2, failed: 0 }, durationMs: 3000, subject: { label: 'SO-7' } } }),
      (skip) => ({
        data: { changeHistoryRunDetails: { items: rows(skip), totalItems: 250 } },
      }),
    );
    expect(screen.getByText('Об’єкт')).toBeTruthy();
    expect(screen.getByText('SO-7')).toBeTruthy();
    expect(screen.getByText(/оновлено: 2 · помилки: 0/)).toBeTruthy();
    expect(screen.getByText('H-1')).toBeTruthy();
    expect(rangeText()).toBe('1–100 / 250');

    fireEvent.click(button('Наступна сторінка'));
    expect(screen.getByText('H-101')).toBeTruthy();
    expect(query).toHaveBeenCalledWith(expect.anything(), { entryId: '1', skip: 100, take: 100 });
    query.mockRestore();
  });

  it("waits for a run's rows, says when they could not be loaded and retries", () => {
    const { unmount } = openRun(run(), () => ({ isLoading: true }));
    expect(document.querySelector('[data-skeleton]')).not.toBeNull();
    unmount();

    openRun(run(), () => ({ isError: true, error: new Error('boom') }));
    expect(screen.getByRole('alert').textContent).toContain('Не вдалося завантажити історію змін.');
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    expect(refetches).toEqual(['change-history-run-details']);
  });

  it('says a run has no rows, unless they were compacted away, and names a run without a label by its source', () => {
    getChangeHistoryRegistry().sources.set('erp', { label: 'ERP-синхронізація', tone: 'system' });
    const empty = () => ({ data: { changeHistoryRunDetails: { items: [], totalItems: 0 } } });
    const { unmount } = openRun(run({ entityLabel: null }), empty);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('ERP-синхронізація');
    expect(screen.getByText('Рядків немає.')).toBeTruthy();
    unmount();

    openRun(run({ isCompacted: true }), () => ({}));
    expect(screen.queryByText('Рядків немає.')).toBeNull();
    expect(document.body.textContent).toContain('Детальні значення зберігаються обмежений час');
  });

  it('titles an entity without a label by its id, links its page and leaves «deleted» out', () => {
    open(entry({ entityLabel: null }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Товар «1»відкрити →');
    expect(screen.getByRole('link', { name: 'відкрити →' }).getAttribute('href')).toBe('/products/1');
    expect(screen.queryByRole('button', { name: 'Повна історія' })).toBeNull();
  });

  it('titles a collection-rules batch by its collection, with a link to it', () => {
    open(
      entry({
        entityType: 'Batch',
        entityLabel: 'Sale',
        action: 'batch',
        source: 'collection_rules',
        actorType: 'system',
        actorLabel: null,
        batchId: 'collection_rules:1',
        parentType: 'Collection',
        parentId: '20',
        meta: { counts: { added: 2, removed: 0 } },
        batchCounts: [{ entityType: 'Product', action: 'collection_added', count: 2 }],
      }),
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Колекція «Sale»відкрити →');
    expect(screen.getByRole('link', { name: 'відкрити →' }).getAttribute('href')).toBe('/collections/20');
    expect(header()).toContain('оновлено вміст колекції');
  });

  it('marks a deletion as deleted though the entity is not known to be gone', () => {
    open(entry({ entityType: 'Supplier', action: 'deleted', entityDeleted: false }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Supplier «Oversize tee»Видалено');
    expect(screen.queryByText('Останній стан')).toBeNull();
  });

  it("names a membership's collection by its id when no name was recorded, and a gone collection as deleted", () => {
    const membership = (over: Partial<ChangeHistoryEntryData>) =>
      entry({ action: 'collection_removed', parentType: 'Collection', parentId: '20', ...over });
    const { unmount } = open(membership({}));
    expect(screen.getByRole('link', { name: '20' }).getAttribute('href')).toBe('/collections/20');
    unmount();

    open(membership({ parentDeleted: true, meta: { collectionLabel: 'Sale' } }));
    expect(screen.queryByRole('link', { name: 'Sale' })).toBeNull();
    expect(screen.getByText('Колекція').nextElementSibling?.textContent).toBe('SaleВидалено');
  });

  it('shows a dash for a channel operation whose channel was not recorded, and none for a membership without a parent', () => {
    const { unmount } = open(
      entry({
        entityType: 'Batch',
        action: 'batch',
        batchId: 'channel_removed:1',
        batchCounts: [{ entityType: 'Product', action: 'channel_removed', count: 1 }],
      }),
    );
    expect(screen.getByText('Канал').nextElementSibling?.textContent).toBe('—');
    unmount();

    open(entry({ action: 'collection_added', parentId: null }));
    expect(screen.queryByText('Колекція')).toBeNull();
    expect(screen.queryByText('Канал')).toBeNull();
  });

  it('shows the last state of a deleted entity, a value too long to keep as «…»', () => {
    open(
      entry({
        action: 'deleted',
        entityDeleted: true,
        meta: { lastState: { 'name.uk': 'Худі', description: { stripped: true }, customFields: { erp: 7 } } },
      }),
    );
    expect(screen.getByText('Останній стан')).toBeTruthy();
    expect([...document.querySelectorAll('dt')].map((term) => term.textContent)).toEqual([
      'Назва (uk)',
      'Опис',
      'Custom fields',
    ]);
    expect(document.querySelectorAll('dd')[1]?.textContent).toBe('…');
  });

  it('leaves the last state out when none was recorded', () => {
    open(entry({ action: 'deleted', entityDeleted: true, meta: { lastState: 'gone' } }));
    expect(screen.queryByText('Останній стан')).toBeNull();
  });

  it("says that an update's details were not recorded, and counts a host action", () => {
    const { unmount } = open(entry({ meta: { noBefore: true } }));
    expect(screen.getByText('деталі недоступні')).toBeTruthy();
    unmount();

    open(entry({ action: 'products_reordered', meta: { counts: { moved: 3, total: 12 } } }));
    expect(screen.getByText('переміщено: 3 (усього: 12)')).toBeTruthy();
  });

  it('lists the derived changes, a created one as a grid and an updated one as a table, with a pager', () => {
    const derived = (skip: number) =>
      skip === 0
        ? [
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
              changes: { enabled: { kind: 'bool', from: true, to: false } },
            }),
            entry({ id: '23', entityType: 'ProductVariant', entityLabel: 'Худі L', changes: null }),
          ]
        : [entry({ id: '41', entityType: 'ProductVariant', entityLabel: 'Худі XL' })];
    answerQueries(paged(entry({ derivedCount: 25 }), { derived, derivedTotal: 25 }));
    render(<EntryDialog entryId="7" onClose={() => undefined} />);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Наслідки зміни: 25');
    expect(screen.getByText('H-S')).toBeTruthy();
    expect(screen.getByText('Ні')).toBeTruthy();
    expect(rangeText()).toBe('1–20 / 25');
    fireEvent.click(button('Наступна сторінка'));
    expect(screen.getByText('Худі XL')).toBeTruthy();
    expect(rangeText()).toBe('21–25 / 25');
  });

  it('leaves the derived list empty when the reader may see none of them', () => {
    open(entry({ derivedCount: 4 }));
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Наслідки зміни: 4');
    expect(screen.queryByRole('button', { name: 'Наступна сторінка' })).toBeNull();
  });

  it("opens a deleted entity's full history in the window, and goes back to the entry", () => {
    answerQueries((key) => {
      if (key[0] === 'change-history-entry') {
        return { data: dialogData(entry({ action: 'deleted', entityDeleted: true })) };
      }
      return key[0] === 'change-history-timeline'
        ? { data: { changeHistoryEntityTimeline: { items: [entry({ id: '3', action: 'created' })], hasMore: false } } }
        : undefined;
    });
    render(<EntryDialog entryId="7" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Повна історія' }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Повна історія · Товар «Oversize tee»');
    expect(document.body.textContent).toContain('Створено');

    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Товар «Oversize tee»Видалено');
  });

  it('closes, from the entry or from its full history, and forgets the history it showed', () => {
    const onClose = vi.fn();
    answerQueries((key) =>
      key[0] === 'change-history-entry'
        ? { data: dialogData(entry({ action: 'deleted', entityDeleted: true })) }
        : undefined,
    );
    const { rerender } = render(<EntryDialog entryId="7" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Повна історія' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<EntryDialog entryId={undefined} onClose={onClose} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<EntryDialog entryId="7" onClose={onClose} />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Товар «Oversize tee»Видалено');
  });

  it('does not open the full history of the entry it still shows while the next one loads', () => {
    answerQueries((key) =>
      key[0] === 'change-history-entry' && key[1] === '7'
        ? { data: dialogData(entry({ action: 'deleted', entityDeleted: true })) }
        : { isLoading: true },
    );
    const { rerender } = render(<EntryDialog entryId="7" onClose={() => undefined} />);
    rerender(<EntryDialog entryId="8" onClose={() => undefined} />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Товар «Oversize tee»Видалено');
    fireEvent.click(screen.getByRole('button', { name: 'Повна історія' }));
    expect(screen.queryByRole('button', { name: 'Назад' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Товар «Oversize tee»Видалено');
  });

  it('waits for the entry, and says when it no longer exists', () => {
    answerQueries((key) => (key[0] === 'change-history-entry' ? { isLoading: true } : undefined));
    const { unmount } = render(<EntryDialog entryId="7" onClose={() => undefined} />);
    expect(document.querySelector('[data-skeleton]')).not.toBeNull();
    unmount();

    open(null);
    expect(screen.getByText('Цього запису вже немає.')).toBeTruthy();
  });
});
