// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerChangeHistoryFieldLabels,
  registerChangeHistoryValueRenderer,
  registerChangeHistoryValueText,
} from '../public';
import type { ChangeHistoryFieldChange, ChangeHistoryValueRendererProps } from '../registry';
import { changeHistoryAssetPreviewsDocument, operationDefinitionDocuments } from '../graphql';
import { answerQueries } from '../testing/dashboard-mock';
import { nb } from '../testing/fixtures';
import { setLocale } from '../testing/i18n';
import {
  CreatedGrid,
  CreatedValues,
  FieldChangesTable,
  GridRow,
  LastStateValue,
  UnboundedValues,
  useValueText,
  ValuesGrid,
  type FieldRef,
} from './values';

/** What the dashboard mock answers per test: the server's custom field options and the active channel. */
const dashboard = vi.hoisted(() => ({
  serverConfig: undefined as unknown,
  activeChannel: { defaultCurrencyCode: 'UAH' } as { defaultCurrencyCode: string } | undefined,
  /** Every request a query sent: its document and variables. */
  requests: [] as Array<[unknown, unknown]>,
}));
/** A regional dashboard locale (`uk_UA`); the catalogs stay the language's own. */
const lingui = vi.hoisted(() => ({ locale: undefined as string | undefined }));

vi.mock('@vendure/dashboard', async () => {
  const mock = await import('../testing/dashboard-mock');
  return {
    ...mock,
    useServerConfig: () => dashboard.serverConfig,
    useChannel: () => ({ activeChannel: dashboard.activeChannel }),
    api: {
      query: (document: unknown, variables: unknown) => {
        dashboard.requests.push([document, variables]);
        return Promise.resolve({});
      },
    },
    // An enabled query sends its request, so a test sees what it asks the API for.
    useQuery: (options: { queryKey: readonly unknown[]; enabled?: boolean; queryFn: () => Promise<unknown> }) => {
      if (options.enabled !== false) {
        void options.queryFn();
      }
      return mock.useQuery(options);
    },
  };
});
vi.mock('@lingui/react/macro', () => import('../testing/lingui-mock'));
vi.mock('@lingui/react', async () => {
  const mock = await import('../testing/lingui-mock');
  return {
    ...mock,
    useLingui: () => {
      const { i18n, t } = mock.useLingui();
      return { t, i18n: { _: i18n._, locale: lingui.locale ?? i18n.locale } };
    },
  };
});

const REGISTRY_KEY = Symbol.for('@uplab/vendure-plugin-change-history/registry');

beforeEach(() => {
  setLocale('uk');
  answerQueries(() => undefined);
});
afterEach(() => {
  cleanup();
  setLocale('en');
  dashboard.serverConfig = undefined;
  dashboard.activeChannel = { defaultCurrencyCode: 'UAH' };
  dashboard.requests.length = 0;
  lingui.locale = undefined;
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
});

function ValueText(props: {
  value: unknown;
  change?: ChangeHistoryFieldChange;
  field?: FieldRef;
  side?: 'from' | 'to';
}) {
  const text = useValueText();
  return <>{text(props.value, props.change, props.field, props.side)}</>;
}

/** The one-line text of a value, as the feed's summary shows it. */
function textOf(value: unknown, change?: ChangeHistoryFieldChange, field?: FieldRef, side?: 'from' | 'to'): string {
  const { container, unmount } = render(<ValueText value={value} change={change} field={field} side={side} />);
  const text = container.textContent ?? '';
  unmount();
  return text;
}

function table(changes: Record<string, ChangeHistoryFieldChange>, entityType = 'Product', showHeader?: boolean) {
  return render(<FieldChangesTable entityType={entityType} changes={changes} showHeader={showHeader} />);
}

/** The cells of the n-th body row: field, was, became (or field and the cell spanning both). */
const cells = (index = 0) => [...document.querySelectorAll('tbody tr')[index].querySelectorAll('td')];
const cellTexts = (index = 0) => cells(index).map((cell) => cell.textContent);

const previews = (...assets: Array<{ id: string; name: string }>) => ({
  data: { assets: { items: assets.map((asset) => ({ ...asset, preview: `/assets/${asset.id}.jpg` })) } },
});

describe('useValueText', () => {
  it('shows no value, an empty string, an empty list, an empty object and the root collection as a dash', () => {
    expect(textOf(null)).toBe('—');
    expect(textOf(undefined)).toBe('—');
    expect(textOf('')).toBe('—');
    expect(textOf([])).toBe('—');
    expect(textOf({})).toBe('—');
    expect(textOf('__root_collection__', { kind: 'ref' })).toBe('—');
  });

  it("formats money in the change's currency, else the channel's, else in dollars", () => {
    expect(textOf(1250, { kind: 'money', currencyCode: 'EUR' })).toBe('12.50 EUR');
    expect(textOf(1250, { kind: 'money', currencyCode: 5 })).toBe('12.50 UAH');
    expect(textOf(1250, { kind: 'money' })).toBe('12.50 UAH');
    dashboard.activeChannel = undefined;
    expect(textOf(1250, { kind: 'money' })).toBe('12.50 USD');
  });

  it('lists prices each in its own currency, a price without an amount as a dash', () => {
    expect(
      textOf([{ price: 1000, currencyCode: 'EUR' }, { price: 2000 }, { currencyCode: 'EUR' }, null], {
        kind: 'prices',
      }),
    ).toBe('10.00 EUR, 20.00 UAH, —, —');
  });

  it('formats a date, and shows a value that is no date as stored', () => {
    expect(textOf('2026-10-12T08:00:00.000Z', { kind: 'date' })).toBe('2026-10-12 08:00');
    expect(textOf(Date.parse('2026-01-02T03:04:00.000Z'), { kind: 'date' })).toBe('2026-01-02 03:04');
    expect(textOf('next week', { kind: 'date' })).toBe('next week');
  });

  it('names references by their labels, a numeric id as #id, and the root collection as a dash', () => {
    expect(textOf('12', { kind: 'ref' })).toBe('#12');
    expect(textOf(['1', 'winter', '__root_collection__'], { kind: 'refs', labels: { 1: 'Season: Winter' } })).toBe(
      'Season: Winter, winter, —',
    );
    expect(textOf(['3'], { kind: 'assets', labels: { 3: 'front.jpg' } })).toBe('front.jpg');
  });

  it('reads a core enum value in the dashboard language, an unknown one humanized', () => {
    const field = { entityType: 'ProductVariant', fieldKey: 'trackInventory' };
    expect(textOf('INHERIT', { kind: 'enum' }, field)).toBe('Успадкувати з глобальних налаштувань');
    expect(textOf('IMAGE', { kind: 'enum' }, { entityType: 'Asset', fieldKey: 'type' })).toBe('Зображення');
    expect(textOf('BACK_ORDER', { kind: 'enum' }, field)).toBe('Back order');
    expect(textOf('PRE_ORDER', { kind: 'enum' })).toBe('Pre order');
  });

  it("reads a custom field option by its label in the dashboard's language, with fallbacks", () => {
    const options = [
      {
        value: 'cotton',
        label: [
          { languageCode: 'en', value: 'Cotton' },
          { languageCode: 'uk', value: 'Бавовна' },
          { languageCode: 'uk_UA', value: 'Бавовна (UA)' },
        ],
      },
      { value: 'wool', label: [{ languageCode: 'en', value: 'Wool' }] },
      { value: 'silk', label: [{ languageCode: 'de', value: 'Seide' }] },
      { value: 'linen', label: null },
    ];
    dashboard.serverConfig = {
      entityCustomFields: [
        { entityName: 'Collection' },
        {
          entityName: 'Product',
          customFields: [
            { name: 'season', options: null },
            { name: 'material', options },
          ],
        },
      ],
    };
    const field = (fieldKey: string, entityType = 'Product') => ({ entityType, fieldKey });
    const enumText = (value: string, key = 'customFields.material', entityType?: string) =>
      textOf(value, { kind: 'enum' }, field(key, entityType));

    // The exact locale, the language of a regional locale, English, then any label.
    expect(enumText('cotton')).toBe('Бавовна');
    lingui.locale = 'uk-UA';
    expect(enumText('cotton')).toBe('Бавовна');
    lingui.locale = 'uk_UA';
    expect(enumText('cotton')).toBe('Бавовна (UA)');
    lingui.locale = undefined;
    expect(enumText('wool')).toBe('Wool');
    expect(enumText('silk')).toBe('Seide');
    // A translatable custom field's key carries its language.
    expect(enumText('cotton', 'customFields.material.uk')).toBe('Бавовна');
    // No label, no option, no field config, no entity config: the value humanized.
    expect(enumText('linen')).toBe('Linen');
    expect(enumText('hemp')).toBe('Hemp');
    expect(enumText('summer', 'customFields.season')).toBe('Summer');
    expect(enumText('cotton', 'customFields.fabric')).toBe('Cotton');
    expect(enumText('cotton', 'customFields.material', 'Collection')).toBe('Cotton');
    expect(enumText('cotton', 'customFields.material', 'Facet')).toBe('Cotton');
    // Only custom fields have options.
    expect(enumText('cotton', 'material')).toBe('Cotton');
    dashboard.serverConfig = {};
    expect(enumText('cotton')).toBe('Cotton');
  });

  it('shows rich text as plain text, clipped', () => {
    const words = Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ');
    const text = textOf(`<p>${words}</p>`, { kind: 'richtext' });
    expect(text.startsWith('word0 word1')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(81);
    expect(text).not.toContain('<p>');
  });

  it('says yes or no for a boolean, in the dashboard language', () => {
    expect(textOf(true, { kind: 'bool' })).toBe('Так');
    expect(textOf(false)).toBe('Ні');
  });

  it("shows an asset's file size in bytes as a size", () => {
    expect(textOf(1536, { kind: 'text' }, { entityType: 'Asset', fieldKey: 'fileSize' })).toBe('1.5 KB');
    expect(textOf(2048, { kind: 'text' }, { entityType: 'Asset', fieldKey: 'width' })).toBe('2,048');
  });

  it('groups the digits of a quantity, and shows an identifier as stored', () => {
    expect(textOf(5950013)).toBe('5,950,013');
    expect(textOf(5950013, { kind: 'text' }, { entityType: 'Product', fieldKey: 'customFields.quantity' })).toBe(
      '5,950,013',
    );
    expect(textOf(5950013, { kind: 'id' })).toBe('5950013');
    expect(textOf(5950013, { kind: 'text' }, { entityType: 'Product', fieldKey: 'customFields.erpId' })).toBe(
      '5950013',
    );
    expect(textOf(42, { kind: 'text' }, { entityType: 'Product', fieldKey: 'id' })).toBe('42');
  });

  it('reads an object of plain values as key: value, a list of plain values as a list, anything else as JSON', () => {
    expect(textOf({ Kyiv: 3, Lviv: null }, { kind: 'json' })).toBe(nb('Kyiv:~3, Lviv:~—'));
    expect(textOf([1, null, 'a'], { kind: 'json' })).toBe('1, null, a');
    expect(textOf({ point: { x: 1 } }, { kind: 'json' })).toBe('{"point":{"x":1}}');
    expect(textOf([{ code: 'a' }], { kind: 'json' })).toBe('[{"code":"a"}]');
    const long = textOf({ text: { value: 'x'.repeat(200) } }, { kind: 'json' });
    expect(long).toHaveLength(81);
    expect(long.endsWith('…')).toBe(true);
    expect(textOf('Oversize tee', { kind: 'text' })).toBe('Oversize tee');
    expect(textOf('abc', { kind: 'money' })).toBe('abc');
    expect(textOf('abc', { kind: 'prices' })).toBe('abc');
    expect(textOf(true, { kind: 'date' })).toBe('Так');
    expect(textOf(7, { kind: 'enum' })).toBe('7');
    expect(textOf(7, { kind: 'richtext' })).toBe('7');
  });

  it("lets a host's text of a kind say it, told which side and field the value is, and falls back on undefined", () => {
    const calls: Array<{ side: string; entityType: string; fieldKey: string }> = [];
    registerChangeHistoryValueText('weight', (value, { side, entityType, fieldKey }) => {
      calls.push({ side, entityType, fieldKey });
      return typeof value === 'number' ? `${value} g` : undefined;
    });
    const change = { kind: 'weight', from: 300, to: 350 };
    expect(textOf(300, change)).toBe('300 g');
    expect(textOf(350, change, { entityType: 'ProductVariant', fieldKey: 'customFields.weight' })).toBe('350 g');
    expect(textOf(350, change, undefined, 'from')).toBe('350 g');
    expect(calls).toEqual([
      { side: 'from', entityType: '', fieldKey: '' },
      { side: 'to', entityType: 'ProductVariant', fieldKey: 'customFields.weight' },
      { side: 'from', entityType: '', fieldKey: '' },
    ]);
    // The host gives up on a value: the built-in text shows it.
    expect(textOf('heavy', { kind: 'weight', from: 'light', to: 'heavy' })).toBe('heavy');
  });
});

describe('FieldChangesTable', () => {
  it('heads the columns field / was / became, or leaves the header out', () => {
    table({ 'name.uk': { kind: 'text', from: 'Tee', to: 'Long tee' } });
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Поле', 'Було', 'Стало']);
    expect(cellTexts()).toEqual(['Назва (uk)', 'Tee', 'Long tee']);
    cleanup();
    table({ 'name.uk': { kind: 'text', from: 'Tee', to: 'Long tee' } }, 'Product', false);
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
  });

  it('renders nothing without changes', () => {
    const { container } = table({});
    expect(container.innerHTML).toBe('');
  });

  it('marks the old value red and the new one green, a missing one as a dash', () => {
    table({ 'customFields.subtitle': { from: null, to: 'Warm' } });
    expect(cellTexts()).toEqual(['Subtitle', '—', 'Warm']);
    expect(screen.getByText('Warm').className).toContain('bg-green-50');
    cleanup();
    table({ 'customFields.subtitle': { kind: 'text', from: 'Warm', to: '' } });
    expect(screen.getByText('Warm').className).toContain('bg-red-50');
  });

  it('notes a value that was shortened when recorded', () => {
    table({ 'customFields.notes': { kind: 'text', from: 'Short', to: 'Long text…', truncated: true } });
    expect(cellTexts()).toEqual(['Notes', 'Short(скорочено)', 'Long text…(скорочено)']);
  });

  it('says yes or no for a boolean, and shows any other value of a boolean field as stored', () => {
    table({ enabled: { kind: 'bool', from: false, to: true } });
    expect(cellTexts()).toEqual(['Увімкнено', 'Ні', 'Так']);
    expect(screen.getByText('Так').className).toContain('bg-green-50');
    cleanup();
    table({ enabled: { kind: 'bool', from: null, to: 'maybe' } });
    expect(cellTexts()).toEqual(['Увімкнено', '—', 'maybe']);
  });

  it("draws a set change's removed and added members across both columns", () => {
    table({
      facetValues: { kind: 'refs', removed: ['1'], added: ['2', '3'], labels: { 1: 'Winter', 2: 'Summer' } },
    });
    const [field, both] = cells();
    expect(field.textContent).toBe('Значення фасетів');
    expect(both.colSpan).toBe(2);
    expect([...both.querySelectorAll('span > span')].map((chip) => chip.textContent)).toEqual([
      '− Winter',
      '+ Summer',
      '+ #3',
    ]);
    expect(screen.getByText('− Winter').className).toContain('bg-red-50');
    expect(screen.getByText('+ Summer').className).toContain('bg-green-50');
  });

  it('shows a set change without members as a dash', () => {
    table({ facetValues: { kind: 'refs' } });
    expect(cellTexts()).toEqual(['Значення фасетів', '—']);
  });

  it("leaves a set change to the host's renderer in two columns when one is registered", () => {
    registerChangeHistoryValueRenderer('refs', ({ change, side }: ChangeHistoryValueRendererProps) => (
      <b>{side === 'from' ? change.removed?.join('|') : change.added?.join('|')}</b>
    ));
    table({ facetValues: { kind: 'refs', removed: ['1'], added: ['2', '3'] } });
    expect(cellTexts()).toEqual(['Значення фасетів', '1', '2|3']);
  });

  it('says a compacted value changed, with its lengths when they were kept, across both columns', () => {
    table({
      'description.uk': { kind: 'richtext', stripped: true, fromLength: 1200, toLength: 1350 },
      'customFields.notes': { kind: 'text', stripped: true },
    });
    expect(cells(0)[1].colSpan).toBe(2);
    expect(cellTexts(0)).toEqual(['Опис (uk)', 'змінено (1,200 → 1,350 символів)']);
    expect(cellTexts(1)).toEqual(['Notes', 'змінено']);
  });

  it('adds the change of a stock level after the new one, nothing when it did not change', () => {
    table({
      stock: { kind: 'stock', from: 5, to: 13, location: 'Kyiv' },
      'customFields.reserved': { kind: 'stock', from: 4, to: 1 },
      'customFields.sold': { kind: 'stock', from: 5, to: 5 },
      'customFields.incoming': { kind: 'stock', from: null, to: 3 },
      'customFields.note': { kind: 'stock', from: 5, to: 'many' },
    });
    expect(cellTexts(0)).toEqual(['Запас (Kyiv)', '5', '13(+8)']);
    expect(cellTexts(1)).toEqual(['Reserved', '4', '1(−3)']);
    expect(cellTexts(2)).toEqual(['Sold', '5', '5']);
    expect(cellTexts(3)).toEqual(['Incoming', '—', '3(+3)']);
    expect(cellTexts(4)).toEqual(['Note', '5', 'many']);
  });

  it("lets a host's renderer of a kind draw both sides, a built-in kind included", () => {
    registerChangeHistoryValueRenderer('weight', ({ change, side, fieldKey, entityType }) => (
      <b>
        {entityType}.{fieldKey}: {String(change[side])} g
      </b>
    ));
    registerChangeHistoryValueRenderer('bool', ({ change, side }) => <i>{change[side] ? 'on' : 'off'}</i>);
    table(
      {
        'customFields.weight': { kind: 'weight', from: 300, to: 350 },
        enabled: { kind: 'bool', from: false, to: true },
      },
      'ProductVariant',
    );
    expect(cellTexts(0)).toEqual([
      'Weight',
      'ProductVariant.customFields.weight: 300 g',
      'ProductVariant.customFields.weight: 350 g',
    ]);
    expect(cellTexts(1)).toEqual(['Увімкнено', 'off', 'on']);
  });

  it('names a field by the label a host registered', () => {
    registerChangeHistoryFieldLabels('Product', { 'customFields.weight': 'Вага' });
    table({ 'customFields.weight': { kind: 'text', from: 1, to: 2 } });
    expect(cellTexts()).toEqual(['Вага', '1', '2']);
  });
});

describe('FieldChangesTable: images', () => {
  it('shows both sides as thumbnails, the removed and added ones ringed, and counts them', () => {
    const keys: unknown[][] = [];
    answerQueries((key) => {
      keys.push([...key]);
      return key[0] === 'change-history-asset-previews'
        ? previews({ id: '1', name: 'front.jpg' }, { id: '2', name: 'back.jpg' })
        : undefined;
    });
    table({
      assets: {
        kind: 'assets',
        from: ['1', '2'],
        to: ['2', '3', '4'],
        removed: ['1'],
        added: ['3', '4'],
        reordered: true,
        labels: { 3: 'new.jpg' },
      },
    });
    // One query for the images of both sides.
    expect(keys).toContainEqual(['change-history-asset-previews', ['1', '2', '3', '4']]);
    expect(dashboard.requests).toContainEqual([changeHistoryAssetPreviewsDocument, { ids: ['1', '2', '3', '4'] }]);
    const [, was, became] = cells();
    expect(
      within(was)
        .getAllByRole('img')
        .map((image) => image.getAttribute('alt')),
    ).toEqual(['front.jpg', 'back.jpg']);
    expect(within(was).getByRole('img', { name: 'front.jpg' }).parentElement?.className).toContain('ring-red-400');
    expect(within(was).getByRole('img', { name: 'back.jpg' }).parentElement?.className).toContain('ring-1');
    // A deleted image: a placeholder named by its label, else by its id.
    const added = within(became).getByRole('img', { name: 'new.jpg' });
    expect(added.tagName).toBe('SPAN');
    expect(added.parentElement?.getAttribute('title')).toBe('new.jpg');
    expect(added.parentElement?.className).toContain('ring-green-500');
    expect(within(became).getByRole('img', { name: '#4' }).parentElement?.getAttribute('title')).toBe('#4');
    expect(within(became).getByRole('img', { name: 'back.jpg' }).parentElement?.className).toContain('ring-1');
    expect(became.textContent).toBe('+2 −1 · порядок змінено');
    expect(was.textContent).toBe('');
  });

  it('says only that the order changed when no image came or went', () => {
    answerQueries((key) =>
      key[0] === 'change-history-asset-previews'
        ? previews({ id: '1', name: 'front.jpg' }, { id: '2', name: 'back.jpg' })
        : undefined,
    );
    table({ assets: { kind: 'assets', from: ['1', '2'], to: ['2', '1'], reordered: true } });
    const [, was, became] = cells();
    expect(became.textContent).toBe('порядок змінено');
    expect(
      within(was)
        .getAllByRole('img')
        .map((image) => image.parentElement?.className),
    ).toEqual([expect.stringContaining('ring-1'), expect.stringContaining('ring-1')]);
  });

  it('shows an image added to none as a dash before it, and no note when only the count of removed is news', () => {
    table({ featuredAsset: { kind: 'assets', from: [], to: '5', added: ['5'] } });
    expect(cellTexts()).toEqual(['Обраний ресурс', '—', '+1']);
    cleanup();
    table({ assets: { kind: 'assets', from: ['5', '6'], to: ['6'], removed: ['5'] } });
    expect(cellTexts()).toEqual(['Ресурси', '', '−1']);
    cleanup();
    table({ assets: { kind: 'assets', from: ['5'], to: ['5'] } });
    expect(cellTexts()).toEqual(['Ресурси', '', '']);
  });
});

describe('FieldChangesTable: rich text', () => {
  const words = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `w${from + index}`);

  it('shows the words around what changed, marked, the rest as «…», and the whole text on demand', () => {
    const before = [...words(0, 20), 'cotton', ...words(20, 40)].join(' ');
    const after = [...words(0, 20), 'linen', ...words(20, 40)].join(' ');
    table({ 'description.uk': { kind: 'richtext', from: `<p>${before}</p>`, to: `<p>${after}</p>` } });
    const [, was, became] = cells();
    expect(was.textContent).toBe(`«… ${words(12, 20).join(' ')} cotton ${words(20, 28).join(' ')} …»показати повністю`);
    expect(within(was).getByText('cotton').className).toContain('bg-red-50');
    expect(within(became).getByText('linen').className).toContain('bg-green-50');

    fireEvent.click(within(was).getByRole('button', { name: 'показати повністю' }));
    expect(was.textContent).toBe(`«${before}»згорнути`);
    // Each side opens on its own.
    expect(became.textContent).toContain('…');
    fireEvent.click(within(was).getByRole('button', { name: 'згорнути' }));
    expect(was.textContent).toContain('показати повністю');
  });

  it('marks a changed phrase as one run, and offers no toggle when nothing was left out', () => {
    table({ 'description.uk': { kind: 'richtext', from: '<p>Warm hoodie</p>', to: '<p>Warm soft cotton hoodie</p>' } });
    const [, was, became] = cells();
    expect(was.textContent).toBe('«Warm hoodie»');
    expect(within(became).getByText('soft cotton').className).toContain('bg-green-50');
    expect(became.textContent).toBe('«Warm soft cotton hoodie»');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('clips a text without the other side, shows it in full on demand, and an empty one as a dash', () => {
    const long = words(0, 40).join(' ');
    table({ 'description.uk': { kind: 'richtext', from: '<p></p>', to: `<p>${long}</p>` } });
    const [, was, became] = cells();
    expect(was.textContent).toBe('—');
    expect(became.textContent).toMatch(/^«w0 w1 .*…»показати повністю$/);
    fireEvent.click(within(became).getByRole('button', { name: 'показати повністю' }));
    expect(became.textContent).toBe(`«${long}»згорнути`);
    cleanup();
    table({ 'description.uk': { kind: 'richtext', from: null, to: '<p>Warm</p>' } });
    expect(cellTexts()).toEqual(['Опис (uk)', '—', '«Warm»']);
  });
});

describe('FieldChangesTable: JSON', () => {
  it('shows nested JSON as code lines, the changed ones marked, in a box of its own height', () => {
    table({ 'customFields.config': { kind: 'json', from: { a: { b: 1 } }, to: { a: { b: 2 } } } });
    const [, was, became] = cells();
    const box = was.firstElementChild as HTMLElement;
    expect(box.className).toContain('font-mono');
    expect(box.className).toContain('max-h-80');
    expect([...box.children].map((line) => line.textContent)).toEqual(['{', '  "a": {', '    "b": 1', '  }', '}']);
    expect(within(was).getByText('"b": 1', { exact: false }).className).toContain('bg-red-50');
    expect(within(became).getByText('"b": 2', { exact: false }).className).toContain('bg-green-50');
    expect(within(became).getByText('{').className).not.toContain('bg-green-50');
  });

  it('takes the room it needs inside an unbounded window', () => {
    render(
      <UnboundedValues>
        <FieldChangesTable
          entityType="Product"
          changes={{ 'customFields.config': { kind: 'json', from: { a: { b: 1 } }, to: { a: { b: 2 } } } }}
        />
      </UnboundedValues>,
    );
    expect((cells()[1].firstElementChild as HTMLElement).className).not.toContain('max-h-80');
  });

  it('reads an object of plain values as key: value lines of text, a missing side as a dash', () => {
    table({ focalPoint: { kind: 'json', from: { x: 0.5, y: 0.5 }, to: { x: 0.3, y: 0.5 } } });
    const [, was, became] = cells();
    expect(was.firstElementChild?.className).not.toContain('font-mono');
    expect(within(was).getByText('x: 0.5').className).toContain('bg-red-50');
    expect(within(became).getByText('x: 0.3').className).toContain('bg-green-50');
    expect(within(became).getByText('y: 0.5').className).not.toContain('bg-green-50');
    cleanup();
    table({ focalPoint: { kind: 'json', from: null, to: { x: 1 } } });
    expect(cellTexts()).toEqual(['Фокусна точка', '—', nb('x:~1')]);
    cleanup();
    table({ focalPoint: { kind: 'json', from: null, to: null } });
    expect(cellTexts()).toEqual(['Фокусна точка', '—', '—']);
  });
});

describe('FieldChangesTable: an object of plain values of a kind nothing renders', () => {
  const locations = {
    'Шоурум Дніпро': 0,
    'Шоурум Київ': 0,
    'Шоурум Львів': 0,
    'Шоурум Одеса': 0,
    'Основний склад': 3,
  };

  it('shows every key: value line unclipped, the changed key marked though it comes past 80 characters', () => {
    table({
      'customFields.minStock': { kind: 'stockThreshold', from: locations, to: { ...locations, 'Основний склад': 5 } },
    });
    const [, was, became] = cells();
    const lines = (cell: HTMLElement) => [...cell.querySelectorAll('div > div')].map((line) => line.textContent);
    expect(lines(was)).toEqual([
      nb('Шоурум Дніпро:~0'),
      nb('Шоурум Київ:~0'),
      nb('Шоурум Львів:~0'),
      nb('Шоурум Одеса:~0'),
      nb('Основний склад:~3'),
    ]);
    expect(lines(became).at(-1)).toBe(nb('Основний склад:~5'));
    expect(within(was).getByText('Основний склад: 3').className).toContain('bg-red-50');
    expect(within(became).getByText('Основний склад: 5').className).toContain('bg-green-50');
    expect(within(became).getByText('Шоурум Київ: 0').className).not.toContain('bg-green-50');
    expect(was.textContent).not.toContain('…');
  });

  it("keeps a host's text of the kind, and marks every line of a value that was not there before", () => {
    registerChangeHistoryValueText('stockThreshold', (value) =>
      value && typeof value === 'object' ? `${Object.keys(value).length} locations` : undefined,
    );
    table({ 'customFields.minStock': { kind: 'stockThreshold', from: { Kyiv: 1 }, to: { Kyiv: 1, Lviv: 2 } } });
    expect(cellTexts()).toEqual(['Min stock', '1 locations', '2 locations']);
    cleanup();
    delete (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for('@uplab/vendure-plugin-change-history/registry')
    ];
    table({ 'customFields.minStock': { kind: 'stockThreshold', from: null, to: { Kyiv: 1, Lviv: 2 } } });
    const [, was, became] = cells();
    expect(was.textContent).toBe('—');
    expect(within(became).getByText('Kyiv: 1').className).toContain('bg-green-50');
    expect(within(became).getByText('Lviv: 2').className).toContain('bg-green-50');
    cleanup();
    // A change recorded without a kind reads the same.
    table({ 'customFields.minStock': { from: { Kyiv: 1, Lviv: 2 }, to: { Kyiv: 2, Lviv: 2 } } });
    expect(within(cells()[2]).getByText('Kyiv: 2').className).toContain('bg-green-50');
  });

  it('names the key with the field when the two sides hold one key between them, as the feed line does', () => {
    table({
      'customFields.minStock': { kind: 'stockThreshold', from: { 'Шоурум Київ': null }, to: { 'Шоурум Київ': 13 } },
      'customFields.maxStock': { kind: 'stockThreshold', from: null, to: { 'Шоурум Київ': 1500 } },
      'customFields.reorder': { from: { Kyiv: 4 }, to: null },
    });
    expect(cellTexts(0)).toEqual([nb('Min stock~· Шоурум Київ'), '—', '13']);
    expect(cells(0)[2].querySelector('.bg-green-50')?.textContent).toBe('13');
    expect(cellTexts(1)).toEqual([nb('Max stock~· Шоурум Київ'), '—', '1,500']);
    expect(cellTexts(2)).toEqual([nb('Reorder~· Kyiv'), '4', '—']);
    cleanup();
    // A stock map keeps the stock's delta; a host's text or renderer of the kind keeps the whole value.
    table({ stock: { kind: 'stock', from: { Kyiv: 5 }, to: { Kyiv: 13 } } });
    expect(cellTexts()).toEqual([nb('Запас~· Kyiv'), '5', '13(+8)']);
    cleanup();
    registerChangeHistoryValueText('stockThreshold', (value) =>
      value && typeof value === 'object' ? `${Object.keys(value).length} locations` : undefined,
    );
    table({ 'customFields.minStock': { kind: 'stockThreshold', from: { Kyiv: 1 }, to: { Kyiv: 2 } } });
    expect(cellTexts()).toEqual(['Min stock', '1 locations', '1 locations']);
  });
});

describe('FieldChangesTable: filters, conditions and actions', () => {
  const definitions = {
    collectionFilters: {
      collectionFilters: [
        {
          code: 'facet-value-filter',
          description: 'Filter by facet values',
          args: [
            { name: 'facetValueIds', type: 'ID', list: true, label: 'Facet values', ui: null },
            { name: 'containsAny', type: 'boolean', list: false, label: null, ui: null },
          ],
        },
      ],
    },
    promotionConditions: {
      promotionConditions: [
        {
          code: 'minimum_order_amount',
          description: 'If order total is greater than { amount }',
          args: [
            { name: 'amount', type: 'int', list: false, label: 'Amount', ui: { component: 'currency-form-input' } },
            { name: 'taxInclusive', type: 'boolean', list: false, label: 'Tax inclusive', ui: null },
          ],
        },
      ],
    },
    promotionActions: {
      promotionActions: [
        {
          code: 'order_percentage_discount',
          description: 'Discount the order',
          args: [
            { name: 'discount', type: 'float', list: false, label: 'Discount', ui: { suffix: '%' } },
            { name: 'cap', type: 'float', list: false, label: 'Cap', ui: { suffix: '%' } },
            { name: 'startsAt', type: 'datetime', list: false, label: 'Starts', ui: null },
            { name: 'endsAt', type: 'datetime', list: false, label: 'Ends', ui: null },
            { name: 'limit', type: 'int', list: false, label: 'Limit', ui: { component: 'currency-form-input' } },
            { name: 'strict', type: 'boolean', list: false, label: 'Strict', ui: null },
            { name: 'skus', type: 'string', list: true, label: 'SKUs', ui: null },
            { name: 'note', type: 'string', list: true, label: 'Note', ui: null },
          ],
        },
      ],
    },
  };
  const answerDefinitions = () =>
    answerQueries((key) =>
      key[0] === 'change-history-operation-definitions'
        ? { data: definitions[key[1] as keyof typeof definitions] }
        : undefined,
    );

  /** The lines of one side: text, whether marked, whether indented under its operation. */
  const lines = (cell: HTMLElement) =>
    [...(cell.firstElementChild?.children ?? [])].map((line) => [
      line.textContent,
      line.className.includes('bg-') ? 'marked' : '',
      line.className.includes('pl-4') ? 'indented' : '',
    ]);

  it('reads filters by their descriptions and arguments, the facet values by name, the changed lines marked', () => {
    answerDefinitions();
    table(
      {
        filters: {
          kind: 'json',
          from: [
            {
              code: 'facet-value-filter',
              args: [
                { name: 'facetValueIds', value: '["31"]' },
                { name: 'containsAny', value: 'false' },
              ],
            },
          ],
          to: [
            {
              code: 'facet-value-filter',
              args: [
                { name: 'facetValueIds', value: '["31","32"]' },
                { name: 'containsAny', value: 'true' },
              ],
            },
          ],
          labels: { 31: 'Season: Winter', 32: 'Season: Summer' },
        },
      },
      'Collection',
    );
    const [, was, became] = cells();
    expect(lines(was)).toEqual([
      ['Filter by facet values', '', ''],
      ['Facet values: Season: Winter', 'marked', 'indented'],
      ['Contains any: Ні', 'marked', 'indented'],
    ]);
    expect(lines(became)).toEqual([
      ['Filter by facet values', '', ''],
      ['Facet values: Season: Winter, Season: Summer', 'marked', 'indented'],
      ['Contains any: Так', 'marked', 'indented'],
    ]);
    expect(was.firstElementChild?.className).not.toContain('font-mono');
    // Each list of operations is read on its own.
    for (const document of Object.values(operationDefinitionDocuments)) {
      expect(dashboard.requests).toContainEqual([document, {}]);
    }
  });

  it('fills an argument into its description, formats money, dates, flags and lists, and keeps units', () => {
    answerDefinitions();
    table(
      {
        conditions: {
          kind: 'json',
          from: null,
          to: [
            {
              code: 'minimum_order_amount',
              args: [
                { name: 'amount', value: '5000' },
                { name: 'taxInclusive', value: true },
              ],
            },
          ],
        },
        actions: {
          kind: 'json',
          from: null,
          to: [
            {
              code: 'order_percentage_discount',
              args: [
                { name: 'discount', value: '10' },
                { name: 'cap', value: '' },
                { name: 'startsAt', value: '2026-10-12T08:00:00.000Z' },
                { name: 'endsAt', value: 'soon' },
                { name: 'limit', value: 'none' },
                { name: 'strict', value: 'maybe' },
                { name: 'skus', value: [] },
                { name: 'note', value: 'plain' },
              ],
            },
          ],
        },
      },
      'Promotion',
    );
    expect(lines(cells(0)[2])).toEqual([
      ['If order total is greater than 50.00 UAH', 'marked', ''],
      ['Tax inclusive: Так', 'marked', 'indented'],
    ]);
    expect(cellTexts(0)[1]).toBe('—');
    expect(lines(cells(1)[2]).map(([text]) => text)).toEqual([
      'Discount the order',
      'Discount: 10%',
      'Cap: —',
      'Starts: 2026-10-12 08:00',
      'Ends: soon',
      'Limit: none',
      'Strict: maybe',
      'SKUs: —',
      'Note: plain',
    ]);
  });

  it('formats an amount in dollars when no channel is active', () => {
    answerDefinitions();
    dashboard.activeChannel = undefined;
    table(
      {
        conditions: {
          kind: 'json',
          from: null,
          to: [{ code: 'minimum_order_amount', args: [{ name: 'amount', value: 5000 }] }],
        },
      },
      'Promotion',
    );
    expect(lines(cells()[2])[0][0]).toBe('If order total is greater than 50.00 USD');
  });

  it('reads an operation the server does not describe by its code, its arguments by their names', () => {
    table(
      {
        filters: {
          kind: 'json',
          from: [{ code: 'variant-name-filter', args: [{ name: 'operator', value: 'contains' }] }],
          to: [
            {
              code: 'variant-name-filter',
              args: [
                { name: 'operator', value: 'contains' },
                { name: 'term', value: { text: 'tee' } },
                { name: 'ids', value: ['1', { id: 2 }, null] },
                { name: 'inherit', value: false },
              ],
            },
            { code: '', args: [] },
          ],
        },
      },
      'Collection',
    );
    const [, was, became] = cells();
    expect(lines(was)).toEqual([
      ['Variant name filter', '', ''],
      ['Operator: contains', '', 'indented'],
    ]);
    expect(lines(became).map(([text]) => text)).toEqual([
      'Variant name filter',
      'Operator: contains',
      'Term: {"text":"tee"}',
      'Ids: 1, {"id":2}, —',
      'Inherit: Ні',
      // An operation without a name keeps its line.
      ' ',
    ]);
  });

  it('shows a JSON list that is no list of operations as code lines', () => {
    table({ 'customFields.tiers': { kind: 'json', from: [{ min: 1 }], to: null } });
    expect(cells()[1].firstElementChild?.className).toContain('font-mono');
    expect(cellTexts()[2]).toBe('—');
  });
});

describe('CreatedValues', () => {
  const created: Record<string, ChangeHistoryFieldChange> = {
    'customFields.weight': { kind: 'text', to: 300 },
    'customFields.blank': { kind: 'text', to: '' },
    filters: {
      kind: 'json',
      to: [
        { code: 'a', args: [] },
        { code: 'b', args: [] },
      ],
    },
    parent: { kind: 'ref', to: '__root_collection__' },
    'customFields.config': { kind: 'json', to: { a: { b: 1 } } },
    prices: { kind: 'prices', to: [{ currencyCode: 'EUR' }] },
    facetValues: { kind: 'refs', added: ['1'], labels: { 1: 'Winter' } },
    optionGroups: { kind: 'refs' },
    'description.uk': { kind: 'richtext', stripped: true },
    enabled: { kind: 'bool', to: true },
    'slug.uk': { kind: 'text', to: 'hoodie' },
    'name.uk': { kind: 'text', to: 'Hoodie' },
  };

  it('lists the first six values on a line, name first, and the rest behind «…»', () => {
    setLocale('en');
    const { container } = render(<CreatedValues entityType="Collection" changes={created} />);
    expect(container.textContent).toBe(
      'Name (uk) Hoodie, Slug (uk) hoodie, Enabled Yes, Weight 300, Filters (2), Config…',
    );
    const more = screen.getByRole('button', { name: 'show all fields' });
    expect(more.getAttribute('title')).toBe('show all fields');
    fireEvent.click(more);
    expect(container.textContent).toBe(
      'Name (uk) Hoodie, Slug (uk) hoodie, Enabled Yes, Weight 300, Filters (2), Config, Facet values Winter, ' +
        'Description (uk)show less',
    );
    const less = screen.getByRole('button', { name: 'show less' });
    expect(less.getAttribute('title')).toBeNull();
    fireEvent.click(less);
    expect(container.textContent).toMatch(/Config…$/);
  });

  it('offers no toggle for six values or fewer, and renders nothing without a value worth showing', () => {
    setLocale('en');
    const { container } = render(
      <CreatedValues entityType="Product" changes={{ 'name.uk': { kind: 'text', to: 'Hoodie' } }} />,
    );
    expect(container.textContent).toBe('Name (uk) Hoodie');
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    const { container: empty } = render(
      <CreatedValues entityType="Product" changes={{ 'customFields.blank': { kind: 'text', to: '' } }} />,
    );
    expect(empty.innerHTML).toBe('');
  });
});

describe('CreatedGrid', () => {
  it("lists a created entity's values as a grid, a compacted one as changed", () => {
    setLocale('en');
    render(
      <CreatedGrid
        entityType="Product"
        changes={{
          'description.uk': { kind: 'richtext', stripped: true, fromLength: 0, toLength: 1350 },
          enabled: { kind: 'bool', to: true },
          'customFields.blank': { kind: 'text', to: null },
          'name.uk': { kind: 'text', to: 'Hoodie' },
          facetValues: { kind: 'refs', added: ['1'], labels: { 1: 'Winter' } },
        }}
      />,
    );
    const terms = [...document.querySelectorAll('dt')].map((term) => term.textContent);
    const values = [...document.querySelectorAll('dd')].map((value) => value.textContent);
    expect(terms).toEqual(['Name (uk)', 'Enabled', 'Description (uk)', 'Facet values']);
    expect(values).toEqual(['Hoodie', 'Yes', 'changed (0 → 1,350 characters)', 'Winter']);
  });

  it('renders nothing without a value worth showing', () => {
    const { container } = render(
      <CreatedGrid entityType="Product" changes={{ 'customFields.blank': { kind: 'text', to: [] } }} />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('ValuesGrid', () => {
  it('pairs each label with its value', () => {
    render(
      <ValuesGrid>
        <GridRow label="Name">Hoodie</GridRow>
        <GridRow label="Slug">hoodie</GridRow>
      </ValuesGrid>,
    );
    expect([...document.querySelectorAll('dl > div')].map((row) => row.textContent)).toEqual([
      'NameHoodie',
      'Slughoodie',
    ]);
  });
});

describe('LastStateValue', () => {
  const last = (fieldKey: string, value: unknown, fields?: unknown, entityType = 'Product') =>
    render(<LastStateValue entityType={entityType} fieldKey={fieldKey} value={value} fields={fields} />).container;

  it('shows an object of plain values of a kind nothing renders as all its key: value lines', () => {
    const value = { 'Шоурум Дніпро': 0, 'Шоурум Київ': 0, 'Шоурум Львів': 0, 'Шоурум Одеса': 0, 'Основний склад': 3 };
    const container = last('customFields.minStock', value, { 'customFields.minStock': { kind: 'stockThreshold' } });
    expect([...(container.firstElementChild?.children ?? [])].map((line) => line.textContent)).toEqual(
      Object.entries(value).map(([key, count]) => nb(`${key}:~${count}`)),
    );
    expect(container.querySelector('.bg-green-50')).toBeNull();
  });

  it('formats a value by the kind the server kept', () => {
    expect(last('price', 1250, { price: { kind: 'money' } }).textContent).toBe('12.50 UAH');
    cleanup();
    expect(last('parent', '5', { parent: { kind: 'ref', labels: { 5: 'Sale' } } }).textContent).toBe('Sale');
    cleanup();
    // A field the server kept no kind for is text.
    expect(last('customFields.markup', '<b>x</b>', { price: { kind: 'money' } }).textContent).toBe('<b>x</b>');
  });

  it('guesses the kind of an older entry: markup is rich text, an object JSON', () => {
    expect(last('description.uk', '<p>Warm</p>').textContent).toBe('«Warm»');
    cleanup();
    expect(last('focalPoint', { x: 0.5, y: 0.25 }).textContent).toBe(nb('x:~0.5y:~0.25'));
    expect(document.querySelector('.font-mono')).toBeNull();
    cleanup();
    expect(last('enabled', false).textContent).toBe('Ні');
  });

  it('shows nested JSON as unmarked code lines, and nothing as a dash', () => {
    const container = last('customFields.config', { a: { b: 1 } }, { 'customFields.config': { kind: 'json' } });
    expect(container.querySelector('.font-mono')).not.toBeNull();
    expect(container.querySelector('[class*="bg-green"]')).toBeNull();
    cleanup();
    expect(last('customFields.config', null, { 'customFields.config': { kind: 'json' } }).textContent).toBe('—');
  });

  it('reads a list of filters by their descriptions, unmarked', () => {
    answerQueries((key) =>
      key[0] === 'change-history-operation-definitions' && key[1] === 'collectionFilters'
        ? {
            data: {
              collectionFilters: [
                {
                  code: 'facet-value-filter',
                  description: 'Filter by facet values',
                  args: [{ name: 'facetValueIds', type: 'ID', list: true, label: 'Facet values', ui: null }],
                },
              ],
            },
          }
        : undefined,
    );
    const container = last(
      'filters',
      [{ code: 'facet-value-filter', args: [{ name: 'facetValueIds', value: '["31"]' }] }],
      { filters: { kind: 'json', labels: { 31: 'Season: Winter' } } },
      'Collection',
    );
    expect([...(container.firstElementChild?.children ?? [])].map((line) => line.textContent)).toEqual([
      'Filter by facet values',
      'Facet values: Season: Winter',
    ]);
    expect(container.querySelector('[class*="bg-green"]')).toBeNull();
  });

  it('shows images as thumbnails without highlights or counts', () => {
    answerQueries((key) =>
      key[0] === 'change-history-asset-previews' ? previews({ id: '1', name: 'front.jpg' }) : undefined,
    );
    const container = last('assets', ['1', '2'], { assets: { kind: 'assets', labels: { 2: 'gone.jpg' } } });
    expect(
      screen.getAllByRole('img').map((image) => image.getAttribute('alt') ?? image.getAttribute('aria-label')),
    ).toEqual(['front.jpg', 'gone.jpg']);
    expect(container.querySelector('.ring-2')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('clips a long text', () => {
    const text = last('customFields.notes', 'word '.repeat(100).trim(), {}).textContent ?? '';
    expect(text.length).toBeLessThanOrEqual(301);
    expect(text.endsWith('…')).toBe(true);
  });

  it("lets a host's renderer of the kind draw the value as its new side", () => {
    registerChangeHistoryValueRenderer('weight', ({ change, side, fieldKey, entityType }) => (
      <b>
        {side} {entityType}.{fieldKey}: {String(change.to)} g, was {String(change.from)}
      </b>
    ));
    expect(last('customFields.weight', 300, { 'customFields.weight': { kind: 'weight' } }).textContent).toBe(
      'to Product.customFields.weight: 300 g, was undefined',
    );
  });

  it('renders the value of a created entity with the kind of its change, without its old side', () => {
    const { container } = render(
      <LastStateValue
        entityType="Product"
        fieldKey="customFields.subtitle"
        value="Warm"
        change={{ from: 'Cold', to: 'Warm' }}
      />,
    );
    expect(container.textContent).toBe('Warm');
  });
});
