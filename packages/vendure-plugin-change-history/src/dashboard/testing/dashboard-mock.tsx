/**
 * The parts of `@vendure/dashboard` the change history uses, as plain elements for render tests. Queries do
 * not run: a test answers them with `answerQueries`, by the first element of the query key.
 *
 * Used with `vi.mock('@vendure/dashboard', () => import('./testing/dashboard-mock'))`.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface QueryAnswer {
  data?: unknown;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
}

type Answer = (queryKey: readonly unknown[]) => QueryAnswer | undefined;

let answer: Answer = () => undefined;
/** Every `refetch` / `fetchNextPage` call, by the query key's first element. */
export const refetches: string[] = [];

export function answerQueries(next: Answer): void {
  answer = next;
  refetches.length = 0;
}

function result(queryKey: readonly unknown[], enabled: boolean | undefined) {
  const given = enabled === false ? undefined : answer(queryKey);
  const refetch = () => {
    refetches.push(String(queryKey[0]));
    return Promise.resolve();
  };
  return {
    data: given?.data,
    isLoading: given?.isLoading ?? false,
    isError: given?.isError ?? false,
    error: given?.error ?? null,
    isFetching: false,
    refetch,
  };
}

export function useQuery({ queryKey, enabled }: { queryKey: readonly unknown[]; enabled?: boolean }) {
  return result(queryKey, enabled);
}

export function useInfiniteQuery({ queryKey }: { queryKey: readonly unknown[] }) {
  const base = result(queryKey, true);
  return {
    ...base,
    data: base.data === undefined ? undefined : { pages: [base.data] },
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: () => {
      refetches.push(`${String(queryKey[0])}:next`);
      return Promise.resolve();
    },
  };
}

export const keepPreviousData = <T,>(previous: T) => previous;

export const api = { query: () => Promise.resolve({}) };

export const graphql = (source: string) => ({ kind: 'Document', source });

export function useLocalFormat() {
  return {
    formatDate: (value: string | Date) => new Date(value).toISOString().slice(0, 16).replace('T', ' '),
    formatCurrency: (value: number, currency: string) => `${(value / 100).toFixed(2)} ${currency}`,
    // Grouped like the dashboard's own (`5,950,013`), so a test sees where a number is formatted.
    formatNumber: (value: number) => value.toLocaleString('en-US'),
  };
}

export const useChannel = () => ({ activeChannel: { defaultCurrencyCode: 'UAH' } });
export const useServerConfig = () => undefined;
export const usePage = () => ({});
export const useWidgetFilters = () => ({
  dateRange: { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-12T00:00:00Z') },
});

export function Badge({ children, className }: { children?: ReactNode; className?: string; variant?: string }) {
  return (
    <span data-badge className={className}>
      {children}
    </span>
  );
}

export function Button({
  children,
  variant: _variant,
  size: _size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) {
  return (
    <button type="button" {...props}>
      {children}
    </button>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div data-skeleton className={className} />;
}

export function Link({ to, children, className }: { to: string; children?: ReactNode; className?: string }) {
  return (
    <a href={to} className={className}>
      {children}
    </a>
  );
}

export function HistoryEntryDate({ date }: { date: string; className?: string }) {
  return <time>{date}</time>;
}

export function VendureImage({ asset }: { asset: { name: string } }) {
  return <img alt={asset.name} />;
}

export function Dialog({ open, children }: { open: boolean; children?: ReactNode }) {
  return open ? <>{children}</> : null;
}

export function DialogContent({ children }: { children?: ReactNode; className?: string; initialFocus?: unknown }) {
  return <div role="dialog">{children}</div>;
}

export function DialogHeader({ children, ...props }: { children?: ReactNode; className?: string }) {
  return <header {...props}>{children}</header>;
}

export function DialogTitle({ children }: { children?: ReactNode; className?: string }) {
  return <h2>{children}</h2>;
}

export function DialogFooter({ children }: { children?: ReactNode; className?: string }) {
  return <footer>{children}</footer>;
}

export function DashboardBaseWidget({
  title,
  actions,
  children,
}: {
  id: string;
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section>
      <h2>{title}</h2>
      {actions}
      {children}
    </section>
  );
}
