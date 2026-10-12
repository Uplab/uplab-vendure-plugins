// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { ActorName, actorOf } from './actor';
import { EntryObject, EntrySummary } from './summary';
import { useLabels } from './use-labels';

vi.mock('@vendure/dashboard', () => import('../testing/dashboard-mock'));
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));
vi.mock('@lingui/react', () => import('../testing/lingui-mock'));

afterEach(() => {
  cleanup();
  setLocale('en');
});

function Actor({ value }: { value: ReturnType<typeof entry> }) {
  return <ActorName actor={actorOf(value, useLabels())} />;
}

describe('EntrySummary', () => {
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
