// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FormProvider, useForm, type UseFormReturn } from 'react-hook-form';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, showPage, toast } from '../testing/dashboard-mock';
import { setLocale } from '../testing/i18n';
import { UnifiedSlugInput } from './unified-slug-input';

vi.mock('@vendure/dashboard', () => import('../testing/dashboard-mock'));
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));

interface Row {
  id?: string;
  languageCode: string;
  name: string;
  slug: string;
}

interface Values {
  translations?: Row[];
  customFields?: { brand?: string };
}

interface GenerateInput {
  entityName: string;
  name: string;
  entityId?: string;
  context: Record<string, unknown>;
}

const READ_ONLY = 'Однаковий slug для всіх мов';
const MANUAL = 'Введіть slug вручну';
const REGENERATE = 'Перегенерувати slug з назви';
const EDIT = 'Редагувати slug вручну';
const AUTO = 'Генерувати slug автоматично';
/** Longer than the field's 500 ms debounce of the name. */
const PAST_DEBOUNCE = 700;

let form: UseFormReturn<Values>;

function Harness({ values, name, disabled }: { values: Values; name: string; disabled?: boolean }) {
  const methods = useForm<Values>({ defaultValues: values });
  form = methods;
  return (
    <FormProvider {...methods}>
      {(values.translations ?? []).map((row, index) => (
        <input
          key={row.languageCode}
          aria-label={`Name (${row.languageCode})`}
          {...methods.register(`translations.${index}.name`)}
        />
      ))}
      <UnifiedSlugInput
        name={name}
        disabled={disabled}
        value=""
        onChange={() => undefined}
        onBlur={onBlur}
        ref={inputRef}
      />
    </FormProvider>
  );
}

const onBlur = vi.fn();
const inputRef = vi.fn();

function renderField(values: Values, { name = 'translations.0.slug', disabled = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness values={values} name={name} disabled={disabled} />
    </QueryClientProvider>,
  );
}

/** Answers the field's two queries: the strategy's settings, and the slug for a name. */
function answer({
  settings = () => Promise.resolve({ unifiedSlugSettings: { watchFormFields: [] as string[] } }),
  generate = (input: GenerateInput) => Promise.resolve(input.name.toLowerCase().replace(/\s+/g, '-')),
}: {
  settings?: () => Promise<unknown>;
  generate?: (input: GenerateInput) => Promise<string>;
} = {}) {
  api.query.mockImplementation(async (document, variables) =>
    document.includes('unifiedSlugGenerate(')
      ? { unifiedSlugGenerate: await generate(variables?.input as GenerateInput) }
      : settings(),
  );
}

const generateCalls = () =>
  api.query.mock.calls.filter(([document]) => document.includes('unifiedSlugGenerate(')).map(([, v]) => v?.input);

const settled = () => new Promise((resolve) => setTimeout(resolve, PAST_DEBOUNCE));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const typeName = (languageCode: string, name: string) =>
  fireEvent.change(screen.getByLabelText(`Name (${languageCode})`), { target: { value: name } });

const slugs = () => (form.getValues('translations') ?? []).map((row) => row.slug);

const spinner = () => document.querySelector('.animate-spin');

/** A product saved in English and Ukrainian, edited on the Ukrainian tab. */
const savedProduct: Values = {
  translations: [
    { id: '1', languageCode: 'en', name: 'Oversize tee', slug: 'oversize-tee' },
    { id: '2', languageCode: 'uk', name: 'Футболка оверсайз', slug: '' },
  ],
};

/** A product being created: the dashboard seeds a row per language, none saved yet. */
const newProduct: Values = {
  translations: [
    { languageCode: 'en', name: '', slug: '' },
    { languageCode: 'uk', name: '', slug: '' },
  ],
};

beforeEach(() => {
  setLocale('uk');
  showPage({ defaultLanguageCode: 'en', pageId: 'product-detail' });
  answer();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setLocale('en');
});

describe('UnifiedSlugInput', () => {
  it('shows the channel default language’s slug on every language tab, read-only', () => {
    showPage({ defaultLanguageCode: 'en', pageId: 'product-detail', entity: { id: '5' } });
    renderField(savedProduct, { name: 'translations.1.slug' });

    const input = screen.getByPlaceholderText(READ_ONLY);
    expect(input).toHaveProperty('value', 'oversize-tee');
    expect(input).toHaveProperty('disabled', true);
    expect(input.className).toContain('bg-muted');
    expect(screen.getByRole('button', { name: REGENERATE })).toBeTruthy();
    expect(screen.getByRole('button', { name: EDIT })).toBeTruthy();
  });

  it('hands name, ref and onBlur to the input, so the form can focus and validate it', () => {
    renderField(savedProduct, { name: 'translations.1.slug' });

    const input = screen.getByPlaceholderText(READ_ONLY);
    expect(input.getAttribute('name')).toBe('translations.1.slug');
    expect(inputRef).toHaveBeenCalledWith(input);
    fireEvent.blur(input);
    expect(onBlur).toHaveBeenCalled();
  });

  it('never regenerates a saved slug, even when the name changes', async () => {
    renderField(savedProduct, { name: 'translations.1.slug' });

    typeName('en', 'Boxy tee');
    await settled();

    expect(generateCalls()).toEqual([]);
    expect(screen.getByPlaceholderText(READ_ONLY)).toHaveProperty('value', 'oversize-tee');
  });

  it('generates the slug from a new product’s name once it settles, into the tab being edited only', async () => {
    renderField(newProduct);

    typeName('en', 'Oversize');
    typeName('en', 'Oversize Tee');

    await waitFor(() => expect(screen.getByPlaceholderText(READ_ONLY)).toHaveProperty('value', 'oversize-tee'));
    expect(generateCalls()).toEqual([
      { entityName: 'Product', name: 'Oversize Tee', entityId: undefined, context: {} },
    ]);
    // The untouched, unsaved Ukrainian row is dropped on save: writing into it would save it nameless.
    expect(slugs()).toEqual(['oversize-tee', '']);
  });

  it('shows a spinner and disables regenerating while the slug is being generated', async () => {
    const slug = deferred<string>();
    answer({ generate: () => slug.promise });
    renderField(newProduct);
    expect(spinner()).toBeNull();

    typeName('en', 'Oversize tee');

    await waitFor(() => expect(spinner()).not.toBeNull());
    expect(screen.getByRole('button', { name: REGENERATE })).toHaveProperty('disabled', true);

    slug.resolve('oversize-tee');
    await waitFor(() => expect(spinner()).toBeNull());
    expect(screen.getByRole('button', { name: REGENERATE })).toHaveProperty('disabled', false);
    expect(slugs()).toEqual(['oversize-tee', '']);
  });

  it('waits for the slug strategy’s settings, then sends the form values it watches', async () => {
    const settings = deferred<unknown>();
    answer({ settings: () => settings.promise });
    renderField({ ...newProduct, customFields: { brand: 'Coosh' } });

    typeName('en', 'Oversize tee');
    await settled();
    expect(generateCalls()).toEqual([]);

    settings.resolve({ unifiedSlugSettings: { watchFormFields: ['customFields.brand'] } });

    await waitFor(() =>
      expect(generateCalls()).toEqual([
        {
          entityName: 'Product',
          name: 'Oversize tee',
          entityId: undefined,
          context: { 'customFields.brand': 'Coosh' },
        },
      ]),
    );
  });

  it('still generates when the slug strategy’s settings cannot be loaded', async () => {
    answer({ settings: () => Promise.reject(new Error('Forbidden')) });
    renderField(newProduct);

    typeName('en', 'Oversize tee');

    await waitFor(() => expect(slugs()).toEqual(['oversize-tee', '']));
    expect(generateCalls()).toEqual([
      { entityName: 'Product', name: 'Oversize tee', entityId: undefined, context: {} },
    ]);
  });

  it('generates for an existing collection saved without a slug, once its name is changed', async () => {
    showPage({ defaultLanguageCode: 'en', pageId: 'collection-detail', entity: { id: 7 } });
    renderField(
      {
        translations: [
          { id: '1', languageCode: 'en', name: 'Summer', slug: '' },
          { id: '2', languageCode: 'uk', name: 'Літо', slug: '' },
        ],
      },
      { name: 'translations.1.slug' },
    );
    await settled();
    expect(generateCalls()).toEqual([]);

    // Named in the channel's default language, so that name is the source even on the Ukrainian tab.
    typeName('en', 'Summer sale');

    await waitFor(() => expect(slugs()).toEqual(['summer-sale', 'summer-sale']));
    expect(generateCalls()).toEqual([{ entityName: 'Collection', name: 'Summer sale', entityId: '7', context: {} }]);
  });

  it('lets the admin type the slug by hand, into every saved row and the tab being edited', () => {
    renderField(
      {
        translations: [
          { id: '1', languageCode: 'en', name: 'Oversize tee', slug: 'oversize-tee' },
          { id: '2', languageCode: 'uk', name: 'Футболка', slug: 'oversize-tee' },
          { languageCode: 'pl', name: '', slug: '' },
        ],
      },
      { name: 'translations.1.slug' },
    );

    fireEvent.click(screen.getByRole('button', { name: EDIT }));

    const input = screen.getByPlaceholderText(MANUAL);
    expect(input).toHaveProperty('disabled', false);
    expect(input.className).not.toContain('bg-muted');
    expect(screen.queryByRole('button', { name: REGENERATE })).toBeNull();
    fireEvent.change(input, { target: { value: 'boxy-tee' } });
    expect(slugs()).toEqual(['boxy-tee', 'boxy-tee', '']);

    fireEvent.click(screen.getByRole('button', { name: AUTO }));

    expect(screen.getByPlaceholderText(READ_ONLY)).toHaveProperty('value', 'boxy-tee');
    expect(screen.getByRole('button', { name: REGENERATE })).toBeTruthy();
  });

  it('stops generating once the admin edits the slug by hand', async () => {
    renderField(newProduct);

    fireEvent.click(screen.getByRole('button', { name: EDIT }));
    typeName('en', 'Oversize tee');
    await settled();

    expect(generateCalls()).toEqual([]);
    expect(slugs()).toEqual(['', '']);
  });

  it('regenerates the slug from the name as it is now, on request', async () => {
    showPage({ defaultLanguageCode: 'en', pageId: 'product-detail', entity: { id: '5' } });
    renderField(savedProduct, { name: 'translations.1.slug' });

    typeName('en', 'Boxy tee');
    fireEvent.click(screen.getByRole('button', { name: REGENERATE }));

    await waitFor(() => expect(slugs()).toEqual(['boxy-tee', 'boxy-tee']));
    expect(generateCalls()).toEqual([{ entityName: 'Product', name: 'Boxy tee', entityId: '5', context: {} }]);
  });

  it('keeps the slug when the server generates an empty one', async () => {
    answer({ generate: () => Promise.resolve('') });
    renderField(savedProduct, { name: 'translations.1.slug' });

    fireEvent.click(screen.getByRole('button', { name: REGENERATE }));

    await waitFor(() => expect(generateCalls()).toHaveLength(1));
    expect(slugs()).toEqual(['oversize-tee', '']);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports a failed regeneration and keeps the slug', async () => {
    answer({ generate: () => Promise.reject(new Error('Network error')) });
    renderField(savedProduct, { name: 'translations.1.slug' });

    fireEvent.click(screen.getByRole('button', { name: REGENERATE }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не вдалося згенерувати slug'));
    expect(slugs()).toEqual(['oversize-tee', '']);
  });

  it('is read-only, with no buttons, when the form disables it', () => {
    renderField(savedProduct, { name: 'translations.1.slug', disabled: true });

    expect(screen.getByPlaceholderText(READ_ONLY)).toHaveProperty('disabled', true);
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('stays empty and offers no regeneration in a form without translations, before the channel loads', async () => {
    showPage({});
    renderField({}, { name: 'slug' });

    expect(screen.getByPlaceholderText(READ_ONLY)).toHaveProperty('value', '');
    expect(screen.queryByRole('button', { name: REGENERATE })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: EDIT }));
    fireEvent.change(screen.getByPlaceholderText(MANUAL), { target: { value: 'tee' } });
    await settled();

    expect(form.getValues('translations')).toBeUndefined();
    expect(screen.getByPlaceholderText(MANUAL)).toHaveProperty('value', '');
    expect(generateCalls()).toEqual([]);
  });
});
