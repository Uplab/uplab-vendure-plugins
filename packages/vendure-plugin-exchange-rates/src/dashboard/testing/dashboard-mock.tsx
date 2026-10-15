/**
 * The parts of `@vendure/dashboard` the exchange-rate pages use, as plain elements for render tests.
 *
 * - `ListPage` renders the visible columns of the rows given to `showListRows`, through the page's own
 *   `customizeColumns`, and keeps its props in `listPage.props`.
 * - `useDetailPage` builds a real react-hook-form form (`mode: 'onChange'`, as the dashboard's) from the
 *   entity given to `showDetailPage`, keeps its options in `detailPage.options` and every submitted form in
 *   `detailPage.submitted`.
 * - `PermissionGuard` renders its children only for the permissions given to `grantPermissions`.
 *
 * Used with `vi.mock('@vendure/dashboard', () => import('./testing/dashboard-mock'))`.
 */
import {
  cloneElement,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  Controller,
  useForm,
  type Control,
  type ControllerFieldState,
  type ControllerRenderProps,
  type FieldValues,
} from 'react-hook-form';
import { vi } from 'vitest';
import type { CurrencyExchangeRateFields } from '../graphql';

export const graphql = (source: string) => ({ kind: 'Document', source });

export const toast = {
  success: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string, options?: { description?: string }) => void>(),
};

export function useLocalFormat() {
  return { formatDate: (value: string) => new Date(value).toISOString().slice(0, 16).replace('T', ' ') };
}

let granted: string[] = [];

/** The permissions of the administrator the next render sees. */
export function grantPermissions(next: string[]): void {
  granted = next;
}

export function PermissionGuard({ requires, children }: { requires: string[]; children?: ReactNode }) {
  return requires.every((permission) => granted.includes(permission)) ? <>{children}</> : null;
}

/** The loader's options, as given: a test reads the breadcrumb from them. */
export const detailPageRouteLoader = <T,>(options: T) => options;

interface DetailPageOptions {
  pageId: string;
  entityName: string;
  queryDocument: unknown;
  updateDocument: unknown;
  setValuesForUpdate: (entity: CurrencyExchangeRateFields) => FieldValues;
  params: { id: string };
  onSuccess: (data: unknown) => void;
  onError: (error: unknown) => void;
}

let shown: { entity?: CurrencyExchangeRateFields; isPending?: boolean } = {};

/** The entity the detail page has loaded (none while loading), and whether an update is in flight. */
export function showDetailPage(next: { entity?: CurrencyExchangeRateFields; isPending?: boolean }): void {
  shown = next;
}

export const detailPage = {
  options: undefined as DetailPageOptions | undefined,
  submitted: [] as FieldValues[],
  resetForm: vi.fn(),
};

export function useDetailPage(options: DetailPageOptions) {
  detailPage.options = options;
  const form = useForm({
    mode: 'onChange',
    defaultValues: shown.entity ? options.setValuesForUpdate(shown.entity) : {},
  });
  const submitHandler = form.handleSubmit((values) => {
    detailPage.submitted.push(values);
  });
  // Read during render, as the dashboard's `useDetailPage` does, so react-hook-form keeps both up to date.
  const { isDirty: _isDirty, isValid: _isValid } = form.formState;
  return {
    form,
    submitHandler,
    entity: shown.entity,
    isPending: shown.isPending ?? false,
    resetForm: detailPage.resetForm,
  };
}

export function Page({
  children,
  submitHandler,
}: {
  children?: ReactNode;
  submitHandler: ComponentProps<'form'>['onSubmit'];
}) {
  return <form onSubmit={submitHandler}>{children}</form>;
}

export function PageTitle({ children }: { children?: ReactNode }) {
  return <h1>{children}</h1>;
}

/** Layout only: the children, unwrapped. */
function Layout({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

export const PageActionBar = (props: { children?: ReactNode }) => <Layout {...props} />;
export const PageActionBarRight = (props: { children?: ReactNode }) => <Layout {...props} />;
export const PageLayout = (props: { children?: ReactNode }) => <Layout {...props} />;
export const DetailFormGrid = (props: { children?: ReactNode }) => <Layout {...props} />;

export function PageBlock({
  title,
  description,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section>
      {title && <h2>{title}</h2>}
      {description && <p>{description}</p>}
      {children}
    </section>
  );
}

export function Badge({
  children,
  variant,
  className,
}: {
  children?: ReactNode;
  variant?: string;
  className?: string;
}) {
  return (
    <span data-variant={variant} className={className}>
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

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />;
}

export function Switch({
  id,
  checked,
  onCheckedChange,
}: {
  id?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button type="button" role="switch" id={id} aria-checked={checked} onClick={() => onCheckedChange(!checked)} />
  );
}

/** Like the dashboard's: a label tied to the control by id, the description, and the field's error. */
export function FormFieldWrapper({
  control,
  name,
  label,
  description,
  rules,
  render,
}: {
  control: Control<FieldValues>;
  name: string;
  label?: ReactNode;
  description?: ReactNode;
  rules?: object;
  render: (args: { field: ControllerRenderProps; fieldState: ControllerFieldState }) => ReactElement;
}) {
  return (
    <Controller
      control={control}
      name={name}
      rules={rules}
      render={({ field, fieldState }) => {
        const id = `field-${name}`;
        return (
          <div>
            {label && <label htmlFor={id}>{label}</label>}
            {cloneElement(render({ field, fieldState }) as ReactElement<{ id?: string }>, { id })}
            {description && <p>{description}</p>}
            {fieldState.invalid && <p role="alert">{fieldState.error?.message}</p>}
          </div>
        );
      }}
    />
  );
}

export function DetailPageButton({ id, label }: { id: string; label: ReactNode }) {
  return <a href={`./${id}`}>{label}</a>;
}

interface Column {
  header?: () => ReactNode;
  cell?: (context: { row: { original: Record<string, unknown> } }) => ReactNode;
}

interface ListPageProps {
  pageId: string;
  title: ReactNode;
  listQuery: unknown;
  route: unknown;
  defaultSort: unknown;
  defaultVisibility: Record<string, boolean>;
  defaultColumnOrder: string[];
  onSearchTermChange: (term: string) => unknown;
  facetedFilters: unknown;
  customizeColumns: Record<string, Column>;
}

let rows: Record<string, unknown>[] = [];

/** The rows the list query returns to the next render. */
export function showListRows(next: Record<string, unknown>[]): void {
  rows = next;
}

export const listPage = { props: undefined as ListPageProps | undefined };

export function ListPage(props: ListPageProps) {
  listPage.props = props;
  const columns = props.defaultColumnOrder.filter((id) => props.defaultVisibility[id]);
  return (
    <section>
      <h1>{props.title}</h1>
      <table>
        <thead>
          <tr>
            {columns.map((id) => (
              <th key={id}>{props.customizeColumns[id]?.header?.() ?? id}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((id) => (
                <td key={id}>{props.customizeColumns[id]?.cell?.({ row: { original: row } }) ?? String(row[id])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
