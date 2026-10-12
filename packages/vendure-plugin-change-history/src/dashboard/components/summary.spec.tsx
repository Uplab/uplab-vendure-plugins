// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { registerChangeHistoryBatchKind, registerChangeHistoryValueText } from '../public';
import { ActorName, actorOf } from './actor';
import { EntryAction, EntryCounts, EntryObject, EntrySummary, EntryType, RunCounts } from './summary';
import { useLabels } from './use-labels';

vi.mock('@vendure/dashboard', () => import('../testing/dashboard-mock'));
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));
vi.mock('@lingui/react', () => import('../testing/lingui-mock'));

const REGISTRY_KEY = Symbol.for('@uplab/vendure-plugin-change-history/registry');

afterEach(() => {
  cleanup();
  setLocale('en');
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
});

function Actor({ value }: { value: ReturnType<typeof entry> }) {
  return <ActorName actor={actorOf(value, useLabels())} />;
}

describe('EntrySummary', () => {
  it('names only the changed keys of an object of plain values (a per-location map)', () => {
    setLocale('uk');
    render(
      <EntrySummary
        entry={entry({
          changes: {
            'customFields.minStock': {
              kind: 'stockThreshold',
              from: { 'Шоурум Дніпро': 0, 'Шоурум Київ': 0, 'Шоурум Львів': 0, 'Шоурум Одеса': 0 },
              to: { 'Шоурум Дніпро': 0, 'Шоурум Київ': 13, 'Шоурум Львів': 0, 'Шоурум Одеса': 0, Основний: 3 },
            },
          },
        })}
      />,
    );
    expect(document.body.textContent).toBe('Min stock: Шоурум Київ: 0 → 13, Основний: — → 3');
  });

  it("lets a host's text of a kind say what changed, and falls back where it does not", () => {
    registerChangeHistoryValueText('stockThreshold', (value, { side }) =>
      side === 'to' && value && typeof value === 'object' ? `${Object.keys(value).length} locations` : undefined,
    );
    render(
      <EntrySummary
        entry={entry({
          changes: { 'customFields.minStock': { kind: 'stockThreshold', from: 4, to: { Kyiv: 1, Lviv: 2 } } },
        })}
      />,
    );
    expect(document.body.textContent).toBe('Min stock: 4 → 2 locations');
  });

  it('shows an identifier as stored, a quantity grouped', () => {
    render(
      <EntrySummary entry={entry({ changes: { 'customFields.odooId': { kind: 'text', from: 5950013, to: null } } })} />,
    );
    expect(document.body.textContent).toBe('Odoo id: 5950013 → —');
    cleanup();
    render(
      <EntrySummary entry={entry({ changes: { 'customFields.erp': { kind: 'id', from: 9342, to: 941185322 } } })} />,
    );
    expect(document.body.textContent).toBe('Erp: 9342 → 941185322');
    cleanup();
    render(
      <EntrySummary entry={entry({ changes: { 'customFields.paid': { kind: 'text', from: 1000, to: 25000 } } })} />,
    );
    expect(document.body.textContent).toBe('Paid: 1,000 → 25,000');
  });

  it("names a channel assignment's channel with the changes it caused", () => {
    setLocale('uk');
    render(
      <EntrySummary
        entry={entry({ action: 'channel_assigned', derivedCount: 6, meta: { channelCode: 'uk-store' } })}
      />,
    );
    expect(document.body.textContent).toBe('uk-storeНаслідки зміни: 6');
  });

  it('shows one short field as «field: was → became»', () => {
    render(<EntrySummary entry={entry({ changes: { enabled: { kind: 'bool', from: true, to: false } } })} />);
    expect(document.body.textContent).toBe('Enabled: Yes → No');
  });

  it('lists what a set change added and removed', () => {
    setLocale('uk');
    render(
      <EntrySummary
        entry={entry({
          changes: {
            facetValues: {
              kind: 'refs',
              added: ['2'],
              removed: ['1'],
              labels: { 1: 'Color: Black', 2: 'Color: White' },
            },
          },
        })}
      />,
    );
    expect(document.body.textContent).toBe('Значення фасетів: +Color: White, −Color: Black');
  });

  it('names a created entity instead of a dash', () => {
    render(
      <EntrySummary
        entry={entry({
          action: 'created',
          changes: {
            enabled: { kind: 'bool', to: true },
            'name.en': { kind: 'text', to: 'Oversize tee' },
          },
        })}
      />,
    );
    expect(document.body.textContent).toBe('Name (en): Oversize tee');
  });

  it('shows a localized core enum value', () => {
    setLocale('uk');
    render(
      <EntrySummary
        entry={entry({
          entityType: 'ProductVariant',
          changes: { trackInventory: { kind: 'enum', from: 'INHERIT', to: 'TRUE' } },
        })}
      />,
    );
    expect(document.body.textContent).toBe('Відстеження запасів: Успадкувати з глобальних налаштувань → Відстежувати');
  });

  it('shows the stock location after the field and the delta', () => {
    render(
      <EntrySummary
        entry={entry({
          action: 'stock_adjusted',
          changes: { stock: { kind: 'stock', from: 10, to: 42, location: 'Main' } },
        })}
      />,
    );
    expect(document.body.textContent).toBe('Stock (Main): 10 → 42 (+32)');
  });

  it("counts a run's rows as «label: number»", () => {
    setLocale('uk');
    render(
      <EntrySummary
        entry={entry({
          entityType: 'Run',
          action: 'run',
          source: 'erp',
          actorType: 'system',
          meta: { counts: { updated: 3, failed: 1 } },
        })}
      />,
    );
    expect(document.body.textContent).toBe('оновлено: 3, помилки: 1');
  });
});

describe('EntryObject', () => {
  it("links a run's subject, a label without a type as text", () => {
    const { rerender } = render(
      <EntryObject
        entry={entry({ entityType: 'Run', meta: { subject: { label: 'SO-1042', type: 'Order', id: 42 } } })}
      />,
    );
    expect(screen.getByRole('link', { name: 'SO-1042' }).getAttribute('href')).toBe('/orders/42');
    rerender(<EntryObject entry={entry({ entityType: 'Run', meta: { subject: { label: 'Nightly' } } })} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body.textContent).toBe('Nightly');
  });

  it('shows what a run was about', () => {
    render(<EntryObject entry={entry({ entityType: 'Run', entityLabel: 'Odoo: stock after order #1042' })} />);
    expect(document.body.textContent).toBe('Odoo: stock after order #1042');
  });

  it("keeps a variant's SKU apart from its name, so that a narrow cell cuts the name only", () => {
    render(<EntryObject entry={entry({ entityType: 'ProductVariant', entityLabel: 'Oversize tee S (TS-S)' })} cut />);
    expect(screen.getByText('(TS-S)')).toBeTruthy();
    expect(screen.getByText('Oversize tee S').getAttribute('class')).toContain('truncate');
  });
});

describe('a batch row', () => {
  const batch = (over: Partial<ReturnType<typeof entry>>) =>
    entry({ entityType: 'Batch', action: 'batch', entityLabel: null, batchId: 'archive:1', ...over });

  it("names a channel operation by its channel and its members' count", () => {
    setLocale('uk');
    const head = batch({
      batchId: 'channel_assigned:1',
      meta: { kind: 'channel_assigned', channelCode: 'uk-store' },
      batchCounts: [{ entityType: 'Product', action: 'channel_assigned', count: 3 }],
    });
    render(
      <>
        <EntryType entry={head} />|<EntryObject entry={head} />|<EntryAction entry={head} />|
        <EntrySummary entry={head} />
      </>,
    );
    expect(document.body.textContent).toBe('Масова операція|uk-store3|додано до каналу|Товар · додано до каналу: 3');
  });

  it('says what the members of an unlabelled batch had done to them, and what they are', () => {
    setLocale('uk');
    const head = batch({ batchCounts: [{ entityType: 'Product', action: 'updated', count: 1 }] });
    render(
      <>
        <EntryObject entry={head} />|<EntryAction entry={head} />
      </>,
    );
    expect(document.body.textContent).toBe('Товари1|оновлено');
  });

  it('calls a batch of mixed members a bulk operation, and a registered kind by its label', () => {
    const mixed = batch({
      batchCounts: [
        { entityType: 'Product', action: 'updated', count: 1 },
        { entityType: 'Collection', action: 'deleted', count: 2 },
      ],
    });
    const { rerender } = render(
      <>
        <EntryObject entry={mixed} />|<EntryAction entry={mixed} />
      </>,
    );
    expect(document.body.textContent).toBe('3|bulk operation');
    registerChangeHistoryBatchKind('archive', { label: 'archived' });
    rerender(<EntryAction entry={mixed} />);
    expect(document.body.textContent).toBe('archived');
  });
});

describe('EntrySummary, every kind of row', () => {
  it("names a membership's collection in quotes, and a dash when none was recorded", () => {
    const { container, rerender } = render(
      <EntrySummary entry={entry({ action: 'collection_added', meta: { collectionLabel: 'Sale' } })} />,
    );
    expect(container.textContent).toBe('«Sale»');
    rerender(<EntrySummary entry={entry({ action: 'collection_removed' })} />);
    expect(container.textContent).toBe('—');
    rerender(<EntrySummary entry={entry({ action: 'channel_removed' })} />);
    expect(container.textContent).toBe('—');
  });

  it("counts a host action's numbers, its total last", () => {
    const action = (counts: Record<string, number>) => entry({ action: 'products_reordered', meta: { counts } });
    const { container, rerender } = render(<EntrySummary entry={action({ moved: 3, added: 0, total: 12 })} />);
    expect(container.textContent).toBe('moved: 3 (total: 12)');
    rerender(<EntrySummary entry={action({ total: 12 })} />);
    expect(container.textContent).toBe('total: 12');
    rerender(<EntrySummary entry={action({ moved: 3 })} />);
    expect(container.textContent).toBe('moved: 3');
  });

  it('says that the details of an update recorded without its old values are unavailable, nothing more for a creation', () => {
    setLocale('uk');
    const { container, rerender } = render(<EntrySummary entry={entry({ meta: { noBefore: true } })} />);
    expect(container.textContent).toBe('деталі недоступні');
    rerender(<EntrySummary entry={entry({ action: 'created', meta: { noBefore: true } })} />);
    expect(container.textContent).toBe('—');
    rerender(<EntrySummary entry={entry({ action: 'deleted', meta: { noBefore: true } })} />);
    expect(container.textContent).toBe('—');
    rerender(<EntrySummary entry={entry()} />);
    expect(container.textContent).toBe('—');
  });

  it('names the fields of a larger change, four at most', () => {
    const text = { kind: 'text', from: 'a', to: 'b' };
    const { container, rerender } = render(
      <EntrySummary
        entry={entry({ changes: { enabled: { kind: 'bool', from: true, to: false }, 'name.en': text } })}
      />,
    );
    expect(container.textContent).toBe('Enabled, Name (en)');
    rerender(
      <EntrySummary
        entry={entry({
          changes: { 'name.en': text, 'slug.en': text, 'description.en': text, sku: text, 'customFields.erp': text },
        })}
      />,
    );
    expect(container.textContent).toBe('Name (en), Slug (en), Description (en), SKU, …');
  });

  it('names a single list-like or shortened field without its values', () => {
    const { container, rerender } = render(
      <EntrySummary
        entry={entry({ changes: { 'description.en': { kind: 'richtext', from: '<p>a</p>', to: '<p>b</p>' } } })}
      />,
    );
    expect(container.textContent).toBe('Description (en)');
    rerender(
      <EntrySummary
        entry={entry({ changes: { facetValues: { kind: 'refs', stripped: true, added: ['1'], labels: {} } } })}
      />,
    );
    expect(container.textContent).toBe('Facet values');
    rerender(
      <EntrySummary entry={entry({ changes: { 'customFields.note': { from: 'a', to: 'b', stripped: true } } })} />,
    );
    expect(container.textContent).toBe('Note');
  });

  it('reads a change of no recorded kind as text, a map of plain values by its changed keys', () => {
    const { container, rerender } = render(
      <EntrySummary entry={entry({ changes: { 'customFields.note': { from: 'draft', to: 'final' } } })} />,
    );
    expect(container.textContent).toBe('Note: draft → final');
    rerender(<EntrySummary entry={entry({ changes: { 'customFields.minStock': { from: null, to: { Kyiv: 2 } } } })} />);
    expect(container.textContent).toBe('Min stock: Kyiv: — → 2');
  });

  it('lists only what a set change added when nothing was removed', () => {
    render(
      <EntrySummary
        entry={entry({ changes: { facetValues: { kind: 'refs', added: ['2'], labels: { 2: 'Color: White' } } } })}
      />,
    );
    expect(document.body.textContent).toBe('Facet values: +Color: White');
  });

  it('names a created entity by a value of no recorded kind, and shows a dash when no value can name it', () => {
    const { container, rerender } = render(
      <EntrySummary entry={entry({ action: 'created', changes: { 'name.en': { to: 'Oversize tee' } } })} />,
    );
    expect(container.textContent).toBe('Name (en): Oversize tee');
    rerender(
      <EntrySummary
        entry={entry({
          action: 'created',
          changes: {
            facetValues: { kind: 'refs', added: ['1'], labels: { 1: 'Color: Black' } },
            'name.en': { kind: 'text', to: null },
            'customFields.erp': { kind: 'text', to: 'x', stripped: true },
          },
        })}
      />,
    );
    expect(container.textContent).toBe('—');
  });

  it("counts a run's rows with its duration, and the duration alone when nothing was counted", () => {
    const run = (meta: Record<string, unknown>) =>
      entry({ entityType: 'Run', action: 'run', source: 'erp', actorType: 'system', meta });
    const { container, rerender } = render(<EntrySummary entry={run({ counts: { updated: 3 }, durationMs: 4200 })} />);
    expect(container.textContent).toBe('updated: 3 · 4 s');
    rerender(<EntrySummary entry={run({ durationMs: 10 })} />);
    expect(container.textContent).toBe('1 s');
  });

  it('lists every count of a run, zeros included, where the window asks for them', () => {
    render(
      <RunCounts
        entry={entry({ entityType: 'Run', meta: { counts: { updated: 3, failed: 0 } } })}
        includeZero
        separator=" · "
      />,
    );
    expect(document.body.textContent).toBe('updated: 3 · failed: 0');
  });

  it('shows nothing for a host action whose counts are all zero', () => {
    render(<EntryCounts entry={entry({ meta: { counts: { moved: 0 } } })} />);
    expect(document.body.textContent).toBe('');
  });
});

describe('a run row', () => {
  it('shows a dash for a run with neither a subject nor a label', () => {
    render(<EntryObject entry={entry({ entityType: 'Run', entityLabel: null })} cut />);
    expect(document.body.textContent).toBe('—');
  });

  it('cuts a long run label in a narrow cell', () => {
    render(<EntryObject entry={entry({ entityType: 'Run', entityLabel: 'Odoo: stock' })} cut />);
    expect(screen.getByText('Odoo: stock').getAttribute('class')).toContain('truncate');
  });
});

describe('a batch row, by what it stands for', () => {
  const batch = (over: Partial<ReturnType<typeof entry>>) =>
    entry({ entityType: 'Batch', action: 'batch', entityLabel: null, batchId: null, ...over });

  it("shows a collection-rules batch as its collection's: type, link, kind and added / removed", () => {
    setLocale('uk');
    const head = batch({
      batchId: 'collection_rules:1',
      source: 'collection_rules',
      actorType: 'system',
      parentType: 'Collection',
      parentId: '20',
      entityLabel: 'Sale',
      meta: { counts: { added: 12, removed: 3 } },
      batchCounts: [
        { entityType: 'Product', action: 'collection_added', count: 12 },
        { entityType: 'Product', action: 'collection_removed', count: 3 },
      ],
    });
    render(
      <>
        <EntryType entry={head} />|<EntryObject entry={head} cut />|<EntryAction entry={head} />|
        <EntrySummary entry={head} />
      </>,
    );
    expect(document.body.textContent).toBe('Колекція|Sale15|оновлено вміст колекції|+12 / −3');
    expect(screen.getByRole('link', { name: 'Sale' }).getAttribute('href')).toBe('/collections/20');
  });

  it("shows a batch whose collection is gone as deleted, and one without a parent id as the batch's own", () => {
    const { container, rerender } = render(
      <EntryObject
        entry={batch({ parentType: 'Collection', parentId: '20', entityLabel: 'Sale', parentDeleted: true })}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toBe('SaleDeleted');
    rerender(<EntryObject entry={batch({ parentType: 'Collection', entityLabel: 'Sale' })} />);
    expect(container.textContent).toBe('Sale');
    rerender(<EntryType entry={batch({ parentType: 'Collection' })} />);
    expect(container.textContent).toBe('Bulk operation');
  });

  it('names a batch by its own label, and leaves out a size it does not know', () => {
    const { container, rerender } = render(
      <EntryObject entry={batch({ batchId: 'scheduled_action:1', entityLabel: 'Scheduled action #3' })} cut />,
    );
    expect(container.textContent).toBe('Scheduled action #3');
    expect(screen.getByText('Scheduled action #3').getAttribute('class')).toBe('truncate');
    rerender(<EntryObject entry={batch({})} />);
    expect(container.textContent).toBe('');
  });

  it('calls a batch of no recorded kind a bulk operation', () => {
    render(<EntryAction entry={batch({})} />);
    expect(document.body.textContent).toBe('bulk operation');
  });

  it("names the fields a bulk edit set, as fields of its members' type", () => {
    const { container, rerender } = render(
      <EntrySummary entry={batch({ batchId: 'bulk_edit:1', meta: { fields: ['enabled', 'name'] } })} />,
    );
    expect(container.textContent).toBe('Enabled, Name');
    rerender(
      <EntrySummary
        entry={batch({
          batchId: 'bulk_edit:1',
          meta: { fields: ['sku'], counts: { added: 1 } },
          batchCounts: [{ entityType: 'ProductVariant', action: 'updated', count: 2 }],
        })}
      />,
    );
    expect(container.textContent).toBe('SKU');
    rerender(<EntrySummary entry={batch({ batchId: 'bulk_edit:1', meta: { fields: [] } })} />);
    expect(container.textContent).toBe('');
  });
});

describe('ActorName', () => {
  it('marks an API key in the dashboard language once, whether or not the name was stored with a suffix', () => {
    setLocale('uk');
    const { container, rerender } = render(
      <Actor value={entry({ actorType: 'api_key', source: 'api_key', actorLabel: 'Feed Admin (API key)' })} />,
    );
    expect(container.textContent).toBe('Feed AdminAPI-ключ');
    rerender(<Actor value={entry({ actorType: 'api_key', source: 'api_key', actorLabel: 'Feed Admin' })} />);
    expect(container.textContent).toBe('Feed AdminAPI-ключ');
  });

  it('names the system by its source', () => {
    render(<Actor value={entry({ actorType: 'system', source: 'collection_rules', actorLabel: null })} />);
    expect(document.body.textContent).toBe('Collection rules');
  });
});
