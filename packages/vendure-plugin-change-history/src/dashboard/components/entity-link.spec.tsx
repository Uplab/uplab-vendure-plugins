// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MouseEventHandler, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerChangeHistoryEntityType } from '../public';
import { entry } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import { EntityLink } from './entity-link';

// The router's link with its click handler (a click on it must not reach the row around it); like the router,
// it navigates in the app, not the browser.
vi.mock('@vendure/dashboard', async () => ({
  ...(await import('../testing/dashboard-mock')),
  Link: ({
    to,
    children,
    className,
    onClick,
  }: {
    to: string;
    children?: ReactNode;
    className?: string;
    onClick?: MouseEventHandler<HTMLAnchorElement>;
  }) => (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));
vi.mock('@lingui/react', () => import('../testing/lingui-mock'));

const REGISTRY_KEY = Symbol.for('@uplab/vendure-plugin-change-history/registry');

afterEach(() => {
  cleanup();
  setLocale('en');
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
});

describe('EntityLink', () => {
  it("links a core entity to its detail page, and a host's type to the host's own route", () => {
    const { rerender } = render(<EntityLink entry={entry()} />);
    expect(screen.getByRole('link', { name: 'Oversize tee' }).getAttribute('href')).toBe('/products/1');

    registerChangeHistoryEntityType('ProductOrder', {
      label: 'Product order',
      route: (value) => `/product-order/${value.entityId}`,
    });
    rerender(<EntityLink entry={entry({ entityType: 'ProductOrder', entityId: '5', entityLabel: 'Hoodies' })} />);
    expect(screen.getByRole('link', { name: 'Hoodies' }).getAttribute('href')).toBe('/product-order/5');
  });

  it('shows an entity nobody routes as text, by its id when it has no label', () => {
    const { container } = render(
      <EntityLink entry={entry({ entityType: 'Supplier', entityId: '77', entityLabel: null })} cut />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toBe('77');
    expect(container.firstElementChild?.getAttribute('class')).toContain('flex min-w-0');
  });

  it('marks a deleted entity, unless the line already says so', () => {
    setLocale('uk');
    const gone = entry({ entityDeleted: true });
    const { container, rerender } = render(<EntityLink entry={gone} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toBe('Oversize teeВидалено');
    rerender(<EntityLink entry={gone} deletedBadge={false} />);
    expect(container.textContent).toBe('Oversize tee');
  });

  it("puts a variant's SKU under its name in a narrow cell, and cuts a label without one as a whole", () => {
    const variant = (entityLabel: string) => entry({ entityType: 'ProductVariant', entityLabel });
    const { rerender } = render(<EntityLink entry={variant('Oversize tee S (TS-S)')} cut />);
    // One line when both fit, else the code wraps under the name: neither part is crushed to a letter.
    const code = screen.getByText('(TS-S)');
    const name = screen.getByText('Oversize tee S');
    expect(code.parentElement).toBe(name.parentElement);
    expect(code.parentElement?.className.split(' ')).toEqual(
      expect.arrayContaining(['inline-flex', 'flex-wrap', 'min-w-0', 'max-w-full']),
    );
    for (const part of [name, code]) {
      // Each line is cut only when it alone is wider than the cell; neither keeps its room at the other's cost.
      expect(part.className.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full', 'truncate']));
      expect(part.className).not.toContain('shrink-0');
    }

    // A long SKU: the whole label in the tooltip.
    const long = 'Oversize tee Basic (TEE-NIGHT-SKY-ORGANIC-WHITE-XL)';
    rerender(<EntityLink entry={variant(long)} cut />);
    const label = screen.getByText('(TEE-NIGHT-SKY-ORGANIC-WHITE-XL)');
    expect(label.getAttribute('class')).toContain('truncate');
    expect(label.parentElement?.getAttribute('title')).toBe(long);

    rerender(<EntityLink entry={variant('Oversize tee S')} cut />);
    expect(screen.getByText('Oversize tee S').getAttribute('class')).toContain('truncate');
    expect(screen.getByRole('link').getAttribute('class')).toContain('flex min-w-0 max-w-full');

    rerender(
      <EntityLink entry={variant('Oversize tee S (TS-S)')} cut>
        <b>open</b>
      </EntityLink>,
    );
    expect(screen.getByRole('link').textContent).toBe('open');
  });

  it("keeps a deleted variant's badge beside its label, the label wrapping its SKU under the name", () => {
    setLocale('uk');
    const { container } = render(
      <EntityLink
        entry={entry({
          entityType: 'ProductVariant',
          entityLabel: 'Oversize tee L (TS-OVS-BLK-L)',
          entityDeleted: true,
        })}
        cut
      />,
    );
    expect(container.textContent).toBe('Oversize tee L(TS-OVS-BLK-L)Видалено');
    const code = screen.getByText('(TS-OVS-BLK-L)');
    expect(code.parentElement?.className).toContain('flex-wrap');
    // The label shrinks inside the line; the badge does not.
    expect(code.parentElement?.parentElement?.className).toContain('min-w-0');
    expect(screen.getByText('Видалено').parentElement?.className).toBe('shrink-0');
  });

  it('opens the entity without also opening the row it sits in', () => {
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <EntityLink entry={entry()} className="text-sm" />
      </div>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Oversize tee' }));
    expect(onRow).not.toHaveBeenCalled();
  });
});
