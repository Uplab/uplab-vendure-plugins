/**
 * The parts of `@vendure/dashboard` the slug field uses, as plain elements for render tests. `api.query` is
 * a mock the test answers; the channel and the page are set with `showPage`.
 *
 * Used with `vi.mock('@vendure/dashboard', () => import('./testing/dashboard-mock'))`.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, Ref } from 'react';
import { vi } from 'vitest';

export const api = {
  query: vi.fn<(document: string, variables?: Record<string, unknown>) => Promise<unknown>>(),
};

export const toast = { error: vi.fn<(message: string) => void>() };

interface PageContext {
  /** The active channel's default language, `undefined` while the channel loads. */
  defaultLanguageCode?: string;
  pageId?: string;
  entity?: { id?: string | number };
}

let context: PageContext = {};

/** The channel and detail page the next render sees. */
export function showPage(next: PageContext): void {
  context = next;
}

export const useChannel = () => ({
  activeChannel: context.defaultLanguageCode ? { defaultLanguageCode: context.defaultLanguageCode } : undefined,
});

export const usePage = () => (context.pageId ? { pageId: context.pageId, entity: context.entity } : undefined);

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

export function Input({ ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} {...props} />;
}
