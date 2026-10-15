// @vitest-environment jsdom
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerChangeHistorySource } from '../public';
import { entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { ActorName, actorOf, EntryBadges, runLabelOf } from './actor';
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

const actor = (value: ReturnType<typeof entry>) => {
  const labels = renderHook(() => useLabels()).result.current;
  return actorOf(value, labels);
};

describe('actorOf', () => {
  it('reads a person by name, a run by its source, and a registered system source as the system', () => {
    expect(actor(entry())).toMatchObject({ tone: 'human', name: 'Іван Петренко' });
    expect(actor(entry({ actorLabel: null }))).toMatchObject({ tone: 'human', name: 'Dashboard' });
    registerChangeHistorySource('erp', { label: 'ERP', tone: 'system' });
    expect(actor(entry({ source: 'erp', actorType: 'admin' }))).toMatchObject({ tone: 'system', name: 'ERP' });
    expect(actor(entry({ entityType: 'Run', source: 'admin' }))).toMatchObject({ tone: 'human', name: 'Dashboard' });
  });

  it('shows a scheduled source with its own icon and its label as the badge', () => {
    const Icon = () => <svg data-testid="calendar" />;
    registerChangeHistorySource('scheduled_action', { label: 'Scheduled action', tone: 'scheduled', icon: Icon });
    const view = actor(entry({ source: 'scheduled_action', actorType: 'admin' }));
    expect(view.tone).toBe('scheduled');
    render(
      <>
        <ActorName actor={view} wrap />
        <EntryBadges actor={view} badges={[{ key: 'kind', text: 'scheduled action' }, false]} />
      </>,
    );
    expect(screen.getByTestId('calendar')).toBeTruthy();
    expect(screen.getByText('Іван Петренко').getAttribute('class')).toContain('line-clamp-2');
    // The kind says what the source badge already says: it shows once.
    expect([...document.querySelectorAll('[data-badge]')].map((badge) => badge.textContent)).toEqual([
      'Scheduled action',
    ]);
  });

  it("marks a system source's change with a grey badge that exists on Vendure 3.7 and 3.8 alike", () => {
    registerChangeHistorySource('erp', { label: 'ERP', tone: 'system' });
    render(<EntryBadges actor={actor(entry({ source: 'erp', actorType: 'admin' }))} />);
    const badge = screen.getByText('System change');
    // Not `secondary`: Vendure 3.8's Badge dropped it and would render the badge unstyled.
    expect(badge.getAttribute('data-variant')).toBe('outline');
    expect(badge.getAttribute('class')).toContain('bg-secondary text-secondary-foreground');
  });
});

describe('runLabelOf', () => {
  it("names a run by its own label, else by its source's", () => {
    registerChangeHistorySource('erp', { label: 'ERP sync', tone: 'system' });
    const run = (entityLabel: string | null) =>
      entry({ entityType: 'Run', action: 'run', source: 'erp', actorType: 'system', entityLabel });
    expect(runLabelOf(run('ERP: stock after order #1042'), actor(run(null)))).toBe('ERP: stock after order #1042');
    expect(runLabelOf(run(null), actor(run(null)))).toBe('ERP sync');
  });
});
