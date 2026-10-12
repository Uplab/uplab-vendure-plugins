// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChangeHistoryRegistry } from '../registry';
import { answerQueries, refetches } from '../testing/dashboard-mock';
import { dialogData, entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { EntryDialog } from './entry-dialog';

vi.mock('@vendure/dashboard', () => import('../testing/dashboard-mock'));
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
});
