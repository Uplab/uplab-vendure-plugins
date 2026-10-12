// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerChangeHistoryDetailRenderer } from '../public';
import type { ChangeHistoryDetailData, ChangeHistoryDetailRendererProps } from '../registry';
import { entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { DetailRows } from './details';

vi.mock('@vendure/dashboard', () => import('../testing/dashboard-mock'));
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));
vi.mock('@lingui/react', () => import('../testing/lingui-mock'));

const REGISTRY_KEY = Symbol.for('@uplab/vendure-plugin-change-history/registry');

beforeEach(() => setLocale('uk'));
afterEach(() => {
  cleanup();
  setLocale('en');
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
});

/** A stock row of a sync run: a variant's level at one location. */
function row(over: Partial<ChangeHistoryDetailData> = {}): ChangeHistoryDetailData {
  return {
    id: '1',
    entryId: '7',
    entityType: 'ProductVariant',
    entityId: '11',
    entityLabel: 'Худі M',
    sku: 'HD-M',
    parentType: 'Product',
    parentId: '1',
    kind: 'stock',
    scope: '2',
    scopeLabel: 'Київ',
    from: 5,
    to: 13,
    ...over,
  };
}

const run = entry({ entityType: 'Run', entityLabel: 'ERP: залишки', action: 'run', source: 'erp' });

function rows(value: ChangeHistoryDetailData[], mode: ChangeHistoryDetailRendererProps['mode'], over = {}) {
  return render(<DetailRows rows={value} entry={{ ...run, ...over }} mode={mode} />);
}

const bodyRows = () =>
  [...document.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));

describe('DetailRows in the entry dialog', () => {
  it('heads the columns and shows each row with its change', () => {
    rows([row(), row({ id: '2', scope: '3', scopeLabel: 'Львів', from: 4, to: 1 })], 'dialog');
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'SKU / ID',
      'Назва',
      'Місце',
      'Було',
      'Стало',
    ]);
    expect(bodyRows()).toEqual([
      ['HD-M', 'Худі M', 'Київ', '5', '13(+8)'],
      ['HD-M', 'Худі M', 'Львів', '4', '1(−3)'],
    ]);
    expect(screen.getByText('(+8)').className).toContain('text-green-700');
    expect(screen.getByText('(−3)').className).toContain('text-red-700');
  });

  it("falls back to the entity's id, a dash for a missing name, scope or value, and JSON for an object", () => {
    rows(
      [
        row({ sku: null, entityLabel: null, scopeLabel: null, scope: 'default', from: null, to: '' }),
        row({ id: '2', scopeLabel: null, scope: null, from: { qty: 1 }, to: 'many' }),
        row({ id: '3', from: 7, to: 7 }),
      ],
      'dialog',
    );
    expect(bodyRows()).toEqual([
      ['11', '—', 'default', '—', '—'],
      ['HD-M', 'Худі M', '—', '{"qty":1}', 'many'],
      ['HD-M', 'Худі M', 'Київ', '7', '7'],
    ]);
  });
});

describe('DetailRows in a timeline', () => {
  it('shows scope and change only when the rows are of one entity', () => {
    rows([row(), row({ id: '2', scopeLabel: null, scope: '3', from: 2, to: 0 })], 'timeline');
    expect(document.querySelector('thead')).toBeNull();
    expect(bodyRows()).toEqual([
      ['Київ', '5', '13(+8)'],
      ['3', '2', '0(−2)'],
    ]);
    expect(screen.getByText('5').className).toContain('bg-red-50');
    expect(screen.getByText('13').className).toContain('bg-green-50');
  });

  it('names the entity of each row when the rows touch several, by SKU, else name, else id', () => {
    rows(
      [
        row(),
        row({ id: '2', entityId: '12', sku: null, entityLabel: 'Худі L', from: 1, to: 1 }),
        row({ id: '3', entityId: '13', sku: null, entityLabel: null, scopeLabel: null, scope: null, to: null }),
      ],
      'timeline',
    );
    expect(bodyRows()).toEqual([
      ['HD-MКиїв', '5', '13(+8)'],
      ['Худі LКиїв', '1', '1'],
      ['13', '5', '—(−5)'],
    ]);
  });
});

describe('DetailRows as a count line', () => {
  it('counts the entities and rows of one type, from the server when it counted them all', () => {
    const { container, unmount } = rows([row(), row({ id: '2', entityId: '12' }), row({ id: '3' })], 'summary');
    expect(container.textContent).toBe('Варіанти: 2 · Рядки: 3');
    unmount();
    const { container: counted } = rows([row()], 'summary', { detailsEntityCount: 40, detailsTotal: 120 });
    expect(counted.textContent).toBe('Варіанти: 40 · Рядки: 120');
  });

  it('calls entities of mixed types objects', () => {
    const { container } = rows(
      [row(), row({ id: '2', entityType: 'Product', entityId: '1', kind: 'price' })],
      'summary',
    );
    expect(container.textContent).toBe('Об’єкти: 2 · Рядки: 2');
  });

  it("uses a host's renderer of the one kind, and the package's own over mixed kinds", () => {
    registerChangeHistoryDetailRenderer('stock', ({ rows: value, mode }) => (
      <span>
        {mode}: {value.length} stock rows
      </span>
    ));
    const { container, unmount } = rows([row(), row({ id: '2' })], 'summary');
    expect(container.textContent).toBe('summary: 2 stock rows');
    unmount();
    const { container: mixed } = rows([row(), row({ id: '2', kind: 'price' })], 'summary');
    expect(mixed.textContent).toBe('Варіанти: 1 · Рядки: 2');
  });
});

describe('DetailRows by kind', () => {
  it("draws each kind's rows with its host renderer or the package's own, in the order the kinds first appear", () => {
    registerChangeHistoryDetailRenderer('price', ({ rows: value, mode, entry: given }) => (
      <p>
        {given.entityLabel} {mode}: {value.map((item) => `${String(item.from)}→${String(item.to)}`).join(', ')}
      </p>
    ));
    const { container } = rows(
      [
        row({ id: '1', kind: 'price', from: 100, to: 120 }),
        row({ id: '2' }),
        row({ id: '3', kind: 'price', from: 5, to: 4 }),
      ],
      'dialog',
    );
    const groups = [...(container.firstElementChild?.children ?? [])];
    expect(groups.map((group) => group.tagName)).toEqual(['P', 'TABLE']);
    expect(groups[0].textContent).toBe('ERP: залишки dialog: 100→120, 5→4');
    expect(bodyRows()).toEqual([['HD-M', 'Худі M', 'Київ', '5', '13(+8)']]);
  });
});
