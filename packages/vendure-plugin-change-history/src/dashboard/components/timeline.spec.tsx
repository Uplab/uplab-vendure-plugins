// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeHistoryEntryData } from '../registry';
import { answerQueries, refetches } from '../testing/dashboard-mock';
import { entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { EntityTimeline } from './timeline';

vi.mock('@vendure/dashboard', () => import('../testing/dashboard-mock'));
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));
vi.mock('@lingui/react', () => import('../testing/lingui-mock'));

beforeEach(() => setLocale('uk'));
afterEach(() => {
  cleanup();
  setLocale('en');
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
          ? { data: { changeHistoryEntries: { items: members, totalItems: 121 } } }
          : undefined,
    );
    fireEvent.click(screen.getByRole('button', { name: 'розгорнути' }));
    expect(screen.getByRole('button', { name: 'показати всі (120)' })).toBeTruthy();
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
