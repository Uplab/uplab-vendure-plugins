// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerQueries } from '../testing/dashboard-mock';
import { entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { HistoryBlock, HistoryBlockTitle } from './history-block';

const page = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('@vendure/dashboard', async () => ({
  ...(await import('../testing/dashboard-mock')),
  usePage: () => page.current,
}));
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));
vi.mock('@lingui/react', () => import('../testing/lingui-mock'));

beforeEach(() => setLocale('uk'));
afterEach(() => {
  cleanup();
  setLocale('en');
  page.current = {};
});

/** The block on a page; returns the timeline query keys it asked for. */
function block(current: Record<string, unknown>) {
  page.current = current;
  const keys: unknown[][] = [];
  answerQueries((key) => {
    keys.push([...key]);
    return key[0] === 'change-history-timeline'
      ? { data: { changeHistoryEntityTimeline: { items: [entry()], endCursor: null, hasMore: false } } }
      : undefined;
  });
  const { container } = render(<HistoryBlock />);
  return { container, keys };
}

describe('HistoryBlockTitle', () => {
  it('reads «Історія змін», not the feed’s «Журнал змін»', () => {
    render(<HistoryBlockTitle />);
    expect(document.body.textContent).toBe('Історія змін');
  });
});

describe('HistoryBlock', () => {
  it.each([
    ['product-detail', 'Product'],
    ['product-variant-detail', 'ProductVariant'],
    ['collection-detail', 'Collection'],
    ['facet-detail', 'Facet'],
    ['promotion-detail', 'Promotion'],
    ['asset-detail', 'Asset'],
    ['facet-value-detail', 'FacetValue'],
  ])('shows the history of the entity on %s as a %s', (pageId, entityType) => {
    const { keys } = block({ pageId, entity: { id: 5, updatedAt: '2026-10-12T08:00:00.000Z' } });
    // The id as a string, and the last save as the refresh key: a save loads the history again.
    expect(keys).toContainEqual(['change-history-timeline', entityType, '5', '2026-10-12T08:00:00.000Z']);
    expect(screen.getByText('Іван Петренко')).toBeTruthy();
  });

  it('shows nothing on a page creating a new entity', () => {
    expect(block({ pageId: 'product-detail' }).container.innerHTML).toBe('');
    expect(block({ pageId: 'product-detail', entity: {} }).container.innerHTML).toBe('');
  });

  it('shows nothing on a page it does not know, or outside a page', () => {
    const { container, keys } = block({ pageId: 'order-detail', entity: { id: '1' } });
    expect(container.innerHTML).toBe('');
    expect(keys).toEqual([]);
    expect(block({ entity: { id: '1' } }).container.innerHTML).toBe('');
  });
});
