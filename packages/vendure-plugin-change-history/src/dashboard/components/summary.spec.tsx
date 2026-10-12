// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { registerChangeHistoryBatchKind, registerChangeHistoryValueText } from '../public';
import { ActorName, actorOf } from './actor';
import { EntryAction, EntryObject, EntrySummary, EntryType } from './summary';
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
