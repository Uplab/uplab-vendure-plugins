// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../testing/i18n';
import { QueryError } from './query-error';

vi.mock('@vendure/dashboard', () => import('../testing/dashboard-mock'));
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));
vi.mock('@lingui/react', () => import('../testing/lingui-mock'));

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('QueryError', () => {
  it('says the history could not be loaded, keeps the technical message for the tooltip, and retries', () => {
    setLocale('uk');
    const onRetry = vi.fn();
    render(<QueryError error={new Error('Failed to fetch')} onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Не вдалося завантажити історію змін.Повторити');
    expect(alert.getAttribute('title')).toBe('Failed to fetch');
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('tells a missing permission apart, also when the server answers with an error code only', () => {
    render(<QueryError error={{ response: { errors: [{ extensions: { code: 'FORBIDDEN' } }] } }} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('You do not have permission to view this history.');
    expect(alert.hasAttribute('title')).toBe(false);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it("names the feed's filter options when they are what failed", () => {
    render(<QueryError error={new Error('boom')} what="filters" className="mt-2" />);
    expect(screen.getByRole('alert').textContent).toBe('The filter options could not be loaded.');
    expect(screen.getByRole('alert').getAttribute('class')).toContain('mt-2');
  });

  it('spins and disables the retry while it runs', () => {
    render(<QueryError error={new Error('boom')} onRetry={() => undefined} retrying />);
    const button = screen.getByRole('button', { name: 'Retry' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');
  });
});
