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

  it("keeps a variant's SKU whole in a narrow cell, and cuts a label without one as a whole", () => {
    const variant = (entityLabel: string) => entry({ entityType: 'ProductVariant', entityLabel });
    const { rerender } = render(<EntityLink entry={variant('Oversize tee S (TS-S)')} cut />);
    // The code does not shrink: it is cut only past the room the cell leaves it, after the name's first letter.
    const code = screen.getByText('(TS-S)').getAttribute('class')?.split(' ');
    expect(code).toEqual(expect.arrayContaining(['shrink-0', 'truncate', 'max-w-[calc(100%-1.25em)]']));
    expect(screen.getByText('Oversize tee S').getAttribute('class')).toContain('truncate');
    expect(screen.getByText('Oversize tee S').getAttribute('class')).not.toContain('shrink-0');

    // A long SKU: both parts can be cut, the whole label in the tooltip.
    const long = 'Oversize tee Basic (TEE-NIGHT-SKY-ORGANIC-WHITE-XL)';
    rerender(<EntityLink entry={variant(long)} cut />);
    const label = screen.getByText('(TEE-NIGHT-SKY-ORGANIC-WHITE-XL)');
    expect(label.getAttribute('class')).toContain('truncate');
    expect(label.parentElement?.getAttribute('title')).toBe(long);
    expect(label.parentElement?.getAttribute('class')).toContain('min-w-0 max-w-full');

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

  it("keeps a deleted variant's normal SKU whole next to its badge: the name gives way, all but its first letter", () => {
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
    // The code may take all of the label but about one letter (1.25em, less the 0.3em gap): far more than a
    // 14-character SKU needs in the feed's narrowest Object cell, so only a code of 30 characters is cut.
    expect(code.className.split(' ')).toEqual(
      expect.arrayContaining(['shrink-0', 'truncate', 'max-w-[calc(100%-1.25em)]']),
    );
    expect(code.className).not.toMatch(/max-w-\[calc\(100%-[2-9]/);
    expect(screen.getByText('Oversize tee L').className).toBe('min-w-0 truncate');
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
