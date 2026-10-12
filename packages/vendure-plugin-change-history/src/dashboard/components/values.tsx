import { useLingui as useLinguiContext } from '@lingui/react';
import { Trans, useLingui } from '@lingui/react/macro';
import { api, useChannel, useLocalFormat, useQuery, useServerConfig, VendureImage } from '@vendure/dashboard';
import { ImageOff } from 'lucide-react';
import { createContext, Fragment, useContext, useState, type ReactNode } from 'react';
import {
  argumentList,
  capitalizeFirst,
  clipText,
  diffLines,
  diffWindow,
  fillDescription,
  flatEntries,
  formatBytes,
  formatDelta,
  idList,
  isIdKey,
  isOperationList,
  jsonDiff,
  jsonLines,
  labelled,
  lastStateChange,
  mapRows,
  numericDelta,
  operationLines,
  orderCreatedKeys,
  NBSP,
  refLabel,
  richTextDiff,
  soleEntry,
  stripHtml,
  withFacetValueLabels,
  type DescribedOperation,
  type DiffLine,
  type MapRow,
  type OperationValue,
} from '../format';
import { humanizeKey } from '../labels';
import { changeHistoryAssetPreviewsDocument, operationDefinitionDocuments, type OperationDefinition } from '../graphql';
import type { ChangeHistoryFieldChange, ChangeHistoryValueRendererProps } from '../registry';
import { useLabels } from './use-labels';

type Side = 'from' | 'to';

const SIDE_COLOURS: Record<Side, string> = {
  from: 'bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-200',
  to: 'bg-green-50 text-green-800 dark:bg-green-950/60 dark:text-green-200',
};

/** A whole value: a chip with room around its text. */
const SIDE_CHIP: Record<Side, string> = {
  from: `rounded px-1 ${SIDE_COLOURS.from}`,
  to: `rounded px-1 ${SIDE_COLOURS.to}`,
};

/**
 * Changed words inside running text: only the background marks them, so they keep the spacing of the words
 * around them (`dense 220 g/m²`, not `dense  220  g/m²`); a mark broken over two lines keeps its corners.
 */
const WORD_MARK: Record<Side, string> = {
  from: `rounded-sm box-decoration-clone ${SIDE_COLOURS.from}`,
  to: `rounded-sm box-decoration-clone ${SIDE_COLOURS.to}`,
};

/**
 * Whether long values sit in a box of their own height (the timeline, where a block holds many items) or
 * take the room they need (the entry window, which scrolls as a whole).
 */
const BoundedValues = createContext(true);

/** Long values in `children` take the room they need: the surrounding window scrolls. */
export function UnboundedValues({ children }: { children: ReactNode }) {
  return <BoundedValues.Provider value={false}>{children}</BoundedValues.Provider>;
}

function Empty() {
  return <span className="text-muted-foreground">—</span>;
}

function Chip({ side, children }: { side: Side; children: ReactNode }) {
  return <span className={`${SIDE_CHIP[side]} break-words`}>{children}</span>;
}

/** Nothing to show: no value, an empty string, an empty list or an empty object. */
function isBlank(value: unknown): boolean {
  if (value === null || value === undefined || value === '') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return typeof value === 'object' && Object.keys(value).length === 0;
}

/** Core's invisible root collection: the parent of a top-level collection, shown as no parent. */
const ROOT_COLLECTION = '__root_collection__';

/** The field a value belongs to: an enum, a custom field's options and a file size read from it. */
export interface FieldRef {
  entityType: string;
  fieldKey: string;
}

interface CustomFieldOption {
  value: string;
  label?: Array<{ languageCode: string; value: string }> | null;
}

/** The option labels of a string custom field with `options`, in the dashboard's language. */
function useOptionLabels() {
  const serverConfig = useServerConfig() as
    | {
        entityCustomFields?: Array<{
          entityName: string;
          customFields?: Array<{ name: string; options?: CustomFieldOption[] | null }>;
        }>;
      }
    | undefined;
  const { i18n } = useLinguiContext();
  return (field: FieldRef | undefined, value: string): string | undefined => {
    if (!field?.fieldKey.startsWith('customFields.')) {
      return undefined;
    }
    const name = field.fieldKey.slice('customFields.'.length).replace(/\.[a-z]{2}(_[A-Za-z]{2,4})?$/, '');
    const option = serverConfig?.entityCustomFields
      ?.find((entity) => entity.entityName === field.entityType)
      ?.customFields?.find((config) => config.name === name)
      ?.options?.find((candidate) => candidate.value === value);
    const labels = option?.label ?? [];
    const language = i18n.locale.split(/[-_]/)[0];
    return (
      labels.find((label) => label.languageCode === i18n.locale)?.value ??
      labels.find((label) => label.languageCode === language)?.value ??
      labels.find((label) => label.languageCode === 'en')?.value ??
      labels[0]?.value
    );
  };
}

/** One value as text: what the feed's summary and a deleted entity's last state show. */
export function useValueText() {
  const { t } = useLingui();
  const labels = useLabels();
  const optionLabel = useOptionLabels();
  const { formatCurrency, formatDate, formatNumber } = useLocalFormat();
  const { activeChannel } = useChannel();
  const currency = activeChannel?.defaultCurrencyCode ?? 'USD';
  const yes = t({ message: 'Yes', context: 'change-history' });
  const no = t({ message: 'No', context: 'change-history' });
  return (value: unknown, change: ChangeHistoryFieldChange | undefined, field?: FieldRef, side?: Side): string => {
    if (isBlank(value) || value === ROOT_COLLECTION) {
      return '—';
    }
    const kind = change?.kind;
    const host = kind ? labels.valueText(kind) : undefined;
    if (host && change) {
      const hostText = host(value, {
        change,
        side: side ?? (value === change.from ? 'from' : 'to'),
        entityType: field?.entityType ?? '',
        fieldKey: field?.fieldKey ?? '',
      });
      if (typeof hostText === 'string') {
        return hostText;
      }
    }
    if (kind === 'money' && typeof value === 'number') {
      return formatCurrency(value, typeof change?.currencyCode === 'string' ? change.currencyCode : currency);
    }
    if (kind === 'prices' && Array.isArray(value)) {
      return value
        .map((price: { price?: number; currencyCode?: string }) =>
          typeof price?.price === 'number' ? formatCurrency(price.price, price.currencyCode ?? currency) : '—',
        )
        .join(', ');
    }
    if (kind === 'date' && (typeof value === 'string' || typeof value === 'number')) {
      const date = new Date(value);
      return Number.isNaN(date.getTime())
        ? String(value)
        : formatDate(date, { dateStyle: 'short', timeStyle: 'short' });
    }
    if (kind === 'ref' || kind === 'refs' || kind === 'assets') {
      return idList(value)
        .map((id) => refLabel(change?.labels, id))
        .map((label) => (label === ROOT_COLLECTION ? '—' : label))
        .join(', ');
    }
    if (kind === 'enum' && typeof value === 'string') {
      return (
        (field && labels.enumValue(field.entityType, field.fieldKey, value)) ??
        optionLabel(field, value) ??
        humanizeKey(value.toLowerCase())
      );
    }
    if (kind === 'richtext' && typeof value === 'string') {
      return clipText(stripHtml(value), 80).text;
    }
    if (typeof value === 'boolean') {
      return value ? yes : no;
    }
    if (typeof value === 'number' && field?.entityType === 'Asset' && field.fieldKey === 'fileSize') {
      return formatBytes(value, formatNumber);
    }
    if (typeof value === 'number') {
      // An identifier (an ERP id) reads as stored: `5950013`, not `5 950 013`.
      return kind === 'id' || (field && isIdKey(field.fieldKey)) ? String(value) : formatNumber(value);
    }
    const flat = flatEntries(value);
    if (flat) {
      return clipText(flat.map(([key, inner]) => labelled(key, inner)).join(', '), 80).text;
    }
    if (Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object')) {
      return clipText(value.map(String).join(', '), 80).text;
    }
    if (typeof value === 'object') {
      return clipText(JSON.stringify(value), 80).text;
    }
    return String(value);
  };
}

type BuiltInProps = ChangeHistoryValueRendererProps;

function BoolValue({ change, side }: BuiltInProps) {
  const value = change[side];
  if (typeof value !== 'boolean') {
    return isBlank(value) ? <Empty /> : <Chip side={side}>{String(value)}</Chip>;
  }
  return (
    <Chip side={side}>
      {value ? <Trans context="change-history">Yes</Trans> : <Trans context="change-history">No</Trans>}
    </Chip>
  );
}

function ScalarValue({ change, side, entityType, fieldKey }: BuiltInProps) {
  const labels = useLabels();
  const text = useValueText();
  const value = change[side];
  if (isBlank(value)) {
    return <Empty />;
  }
  // An object of plain values (thresholds per location) of a kind without a renderer or a text of its own: all
  // its `key: value` lines, the changed ones marked — not the one-line text, which is cut.
  if (flatEntries(value) && !labels.valueText(change.kind ?? 'text')) {
    return <ValueLines lines={jsonDiff(change)[side]} side={side} mono={false} />;
  }
  return (
    <>
      <Chip side={side}>{text(value, change, { entityType, fieldKey }, side)}</Chip>
      {change.truncated && (
        <span className="ml-1 text-xs text-muted-foreground">
          <Trans context="change-history">(shortened)</Trans>
        </span>
      )}
    </>
  );
}

/**
 * A set change (facet values, option groups): what was removed and what was added, each marked — the set's
 * other members are not recorded, so neither side claims the entity had nothing.
 */
function RefsChange({ change }: { change: ChangeHistoryFieldChange }) {
  const removed = change.removed ?? [];
  const added = change.added ?? [];
  const chips = (ids: string[], side: Side, sign: string) =>
    ids.map((id) => (
      <Chip key={`${side}-${id}`} side={side}>
        {sign} {refLabel(change.labels, id)}
      </Chip>
    ));
  if (removed.length === 0 && added.length === 0) {
    return <Empty />;
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {chips(removed, 'from', '−')}
      {chips(added, 'to', '+')}
    </span>
  );
}

function useAssetPreviews(ids: string[]) {
  return useQuery({
    queryKey: ['change-history-asset-previews', ids],
    queryFn: () => api.query(changeHistoryAssetPreviewsDocument, { ids }),
    enabled: ids.length > 0,
    staleTime: 60_000,
  });
}

function AssetsValue({ change, side }: { change: ChangeHistoryFieldChange; side: Side }) {
  const ids = idList(change[side]);
  const highlight = new Set(side === 'from' ? (change.removed ?? []) : (change.added ?? []));
  const { data } = useAssetPreviews([...new Set([...idList(change.from), ...idList(change.to)])]);
  const previews = new Map((data?.assets.items ?? []).map((asset) => [String(asset.id), asset]));
  if (ids.length === 0) {
    return <Empty />;
  }
  const counts = [
    change.added?.length ? `+${change.added.length}` : '',
    change.removed?.length ? `−${change.removed.length}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {ids.map((id) => {
        const asset = previews.get(id);
        const name = change.labels?.[id] ?? asset?.name ?? refLabel(undefined, id);
        let ring = 'ring-1 ring-border';
        if (highlight.has(id)) {
          ring = side === 'from' ? 'ring-2 ring-red-400' : 'ring-2 ring-green-500';
        }
        return (
          <span key={id} title={name} className={`inline-block h-10 w-10 overflow-hidden rounded ${ring}`}>
            {asset ? (
              <VendureImage asset={asset} preset="tiny" className="h-10 w-10 object-cover" />
            ) : (
              // A deleted image has no preview: a placeholder, its name in the tooltip.
              <span
                role="img"
                aria-label={name}
                className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground"
              >
                <ImageOff className="h-4 w-4" />
              </span>
            )}
          </span>
        );
      })}
      {/* The order is news only when it changed; added and removed images show as counts. */}
      {side === 'to' && (counts || change.reordered) ? (
        <span className="text-xs text-muted-foreground">
          {counts}
          {counts && change.reordered ? ' · ' : ''}
          {change.reordered && <Trans context="change-history">order changed</Trans>}
        </span>
      ) : null}
    </span>
  );
}

/** Words of one side of a diff, the changed ones marked, unchanged stretches as «…» unless shown in full. */
function DiffWords({ words, side, full }: { words: DiffLine[]; side: Side; full: boolean }) {
  // Neighbouring words of one kind read as one run: a changed phrase is one mark, not a mark per word.
  const runs: Array<DiffLine | { gap: true }> = [];
  for (const segment of full ? words : diffWindow(words, 8)) {
    const last = runs.at(-1);
    if (last && !('gap' in last) && !('gap' in segment) && last.changed === segment.changed) {
      last.text = `${last.text} ${segment.text}`;
    } else {
      runs.push('gap' in segment ? segment : { ...segment });
    }
  }
  return (
    <>
      {runs.map((run, index) => {
        const space = index > 0 ? ' ' : '';
        if ('gap' in run) {
          return (
            <span key={index} className="text-muted-foreground">
              {space}…
            </span>
          );
        }
        return (
          <span key={index}>
            {space}
            {run.changed ? <span className={WORD_MARK[side]}>{run.text}</span> : run.text}
          </span>
        );
      })}
    </>
  );
}

/**
 * Rich text as plain text. Both sides of a change show the words around what changed, marked; «show in
 * full» shows the whole texts. A value without the other side (a last state) is clipped instead.
 */
function RichTextValue({ change, side }: { change: ChangeHistoryFieldChange; side: Side }) {
  const [open, setOpen] = useState(false);
  const value = change[side];
  if (typeof value !== 'string' || stripHtml(value) === '') {
    return <Empty />;
  }
  const other = change[side === 'from' ? 'to' : 'from'];
  const text = stripHtml(value);
  let body: ReactNode;
  let cut: boolean;
  if (typeof other === 'string' && stripHtml(other) !== '') {
    const words = richTextDiff(change)[side];
    cut = diffWindow(words, 8).some((segment) => 'gap' in segment);
    body = <DiffWords words={words} side={side} full={open} />;
  } else {
    const clipped = clipText(text, 120);
    cut = clipped.clipped;
    body = open ? text : clipped.text;
  }
  return (
    <span className="whitespace-pre-wrap break-words">
      «{body}»
      {cut && (
        <button type="button" className="ml-1 text-primary hover:underline" onClick={() => setOpen(!open)}>
          {open ? (
            <Trans context="change-history">show less</Trans>
          ) : (
            <Trans context="change-history">show in full</Trans>
          )}
        </button>
      )}
    </span>
  );
}

/** Lines of a value; `mono` for JSON, plain text for `key: value` and operation lines. */
function ValueLines({ lines, side, mono = true }: { lines: DiffLine[]; side?: Side; mono?: boolean }) {
  const bounded = useContext(BoundedValues);
  if (lines.length === 0) {
    return <Empty />;
  }
  const box = mono
    ? 'rounded border bg-muted/40 p-2 font-mono text-xs leading-relaxed'
    : 'space-y-0.5 text-sm leading-snug';
  return (
    <div className={`${box} ${bounded ? 'max-h-80 overflow-auto' : ''} whitespace-pre-wrap break-words`}>
      {lines.map((line, index) => {
        // An operation's argument lines are indented under its title, wrapped lines included.
        const indented = !mono && line.text.startsWith('    ');
        const chip = line.changed && side ? SIDE_CHIP[side] : '';
        return (
          <div key={index} className={`${chip} ${indented ? 'pl-4' : ''}`}>
            {(indented ? line.text.trimStart() : line.text) || ' '}
          </div>
        );
      })}
    </div>
  );
}

/** Every operation the server offers, by code: filters, conditions and actions, each list read on its own. */
function useOperationDefinitionList(field: keyof typeof operationDefinitionDocuments, enabled: boolean) {
  return useQuery({
    queryKey: ['change-history-operation-definitions', field],
    queryFn: () => api.query(operationDefinitionDocuments[field], {}),
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
  }).data as Record<string, OperationDefinition[]> | undefined;
}

function useOperationDefinitions(enabled: boolean): Map<string, OperationDefinition> {
  const lists = [
    useOperationDefinitionList('collectionFilters', enabled),
    useOperationDefinitionList('promotionConditions', enabled),
    useOperationDefinitionList('promotionActions', enabled),
  ];
  const definitions = new Map<string, OperationDefinition>();
  for (const list of lists.flatMap((data) => Object.values(data ?? {}))) {
    for (const definition of list) {
      definitions.set(definition.code, definition);
    }
  }
  return definitions;
}

/** How a filter, condition or action reads: its description and `label: value` per argument. */
function useDescribeOperation(enabled: boolean) {
  const { t } = useLingui();
  const definitions = useOperationDefinitions(enabled);
  const { formatCurrency, formatDate } = useLocalFormat();
  const { activeChannel } = useChannel();
  const currency = activeChannel?.defaultCurrencyCode ?? 'USD';
  const one = (raw: unknown, definition: OperationDefinition['args'][number] | undefined): string => {
    if (raw === null || raw === undefined || raw === '') {
      return '—';
    }
    const ui = definition?.ui ?? {};
    if (definition?.type === 'boolean' || raw === 'true' || raw === 'false' || typeof raw === 'boolean') {
      if (raw === 'true' || raw === true) {
        return t({ message: 'Yes', context: 'change-history' });
      }
      if (raw === 'false' || raw === false) {
        return t({ message: 'No', context: 'change-history' });
      }
    }
    if (ui.component === 'currency-form-input' && Number.isFinite(Number(raw))) {
      return formatCurrency(Number(raw), currency);
    }
    if (definition?.type === 'datetime' && typeof raw === 'string' && !Number.isNaN(Date.parse(raw))) {
      return formatDate(raw, { dateStyle: 'short', timeStyle: 'short' });
    }
    return typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
  };
  return (operation: OperationValue): DescribedOperation => {
    const definition = definitions.get(operation.code);
    const args = operation.args.map(({ name, value }) => {
      const argument = definition?.args.find((candidate) => candidate.name === name);
      const list = argument?.list || Array.isArray(value) ? argumentList(value) : undefined;
      const text = list ? list.map((item) => one(item, argument)).join(', ') || '—' : one(value, argument);
      // A unit (`%`) follows the value on its own line; a description has it after the placeholder already.
      const suffix = typeof argument?.ui?.suffix === 'string' && text !== '—' ? argument.ui.suffix : '';
      return { name, label: argument?.label || humanizeKey(name), text, suffixed: text + suffix };
    });
    // «If order total is greater than { amount }» reads with the amount in it; the other arguments follow.
    const { text, used } = fillDescription(
      definition?.description || humanizeKey(operation.code),
      Object.fromEntries(args.map((arg) => [arg.name, arg.text])),
    );
    return {
      title: capitalizeFirst(text),
      args: args.filter((arg) => !used.includes(arg.name)).map((arg) => [arg.label, arg.suffixed]),
    };
  };
}

/** A list of filters, conditions or actions as their descriptions and arguments, the changed lines marked. */
function OperationsValue({
  change,
  side,
  plain = false,
}: {
  change: ChangeHistoryFieldChange;
  side: Side;
  plain?: boolean;
}) {
  const describe = useDescribeOperation(true);
  const lines = (value: unknown) =>
    isOperationList(value)
      ? operationLines(withFacetValueLabels(value, change.labels) as OperationValue[], describe)
      : [];
  if (plain) {
    return <ValueLines lines={lines(change[side]).map((text) => ({ text, changed: false }))} mono={false} />;
  }
  const diff = diffLines(lines(change.from), lines(change.to));
  return <ValueLines lines={diff[side]} side={side} mono={false} />;
}

/** Whether a JSON change is best read as `key: value` lines (a focal point, a per-location number). */
const isFlat = (value: unknown) => value == null || flatEntries(value) !== undefined;

function JsonValue({ change, side }: { change: ChangeHistoryFieldChange; side: Side }) {
  if ((isOperationList(change.from) || change.from == null) && (isOperationList(change.to) || change.to == null)) {
    return <OperationsValue change={change} side={side} />;
  }
  const flat = isFlat(change.from) && isFlat(change.to);
  return <ValueLines lines={jsonDiff(change)[side]} side={side} mono={!flat} />;
}

function StockValue(props: BuiltInProps) {
  const { change, side } = props;
  const delta = side === 'to' ? numericDelta(change.from, change.to) : undefined;
  return (
    <>
      <ScalarValue {...props} />
      {delta !== undefined && delta !== 0 && <span className="ml-1 text-muted-foreground">({formatDelta(delta)})</span>}
    </>
  );
}

const BUILT_IN: Record<string, (props: BuiltInProps) => ReactNode> = {
  bool: BoolValue,
  assets: AssetsValue,
  richtext: RichTextValue,
  json: JsonValue,
  stock: StockValue,
};

/** One side of a changed field: the host's renderer for its kind, else the built-in one. */
function ValueSide(props: ChangeHistoryValueRendererProps) {
  const labels = useLabels();
  const kind = props.change.kind ?? 'text';
  const Host = labels.valueRenderer(kind);
  if (Host) {
    return <Host {...props} />;
  }
  const BuiltIn = BUILT_IN[kind] ?? ScalarValue;
  return <BuiltIn {...props} />;
}

function StrippedValue({ change }: { change: ChangeHistoryFieldChange }) {
  const { formatNumber } = useLocalFormat();
  return (
    <span className="text-muted-foreground">
      <Trans context="change-history">changed</Trans>
      {typeof change.fromLength === 'number' && typeof change.toLength === 'number' && (
        <>
          {' '}
          ({formatNumber(change.fromLength)} → {formatNumber(change.toLength)}{' '}
          <Trans context="change-history">characters</Trans>)
        </>
      )}
    </span>
  );
}

/** Whether a set change is drawn across both value columns (removed and added in one cell). */
const spansBoth = (change: ChangeHistoryFieldChange, hasHost: boolean) =>
  change.stripped || (change.kind === 'refs' && !hasHost);

type Labels = ReturnType<typeof useLabels>;

/**
 * Whether the built-in cells draw a change whose sides are objects of scalars (a per-location map) key by key: no
 * host renderer or text for its kind, not compacted, and a kind whose built-in cell shows plain values — any kind
 * the package does not draw itself (a host's own kind included), `stock`, and `json` when asked.
 */
function drawsMaps(change: ChangeHistoryFieldChange, labels: Labels, json: boolean): boolean {
  const kind = change.kind ?? 'text';
  const builtIn = BUILT_IN[kind] ?? ScalarValue;
  const plain = builtIn === ScalarValue || builtIn === StockValue || (json && builtIn === JsonValue);
  return !change.stripped && plain && !labels.valueRenderer(kind) && !labels.valueText(kind);
}

/**
 * The one key of a map of scalars the built-in cells draw, when its two sides hold that key alone: the row then
 * names the key with the field and shows plain values, «Min stock · Kyiv | — | 13», as the feed's «Min stock:
 * Kyiv: — → 13» does. A map of more keys (and a `json` one) is drawn key by key, `MapChange`.
 */
function soleKeyOf(change: ChangeHistoryFieldChange, labels: Labels) {
  return drawsMaps(change, labels, false) ? soleEntry(change.from, change.to) : undefined;
}

/** The rows of a map change the built-in cells draw key by key (`MapChange`), else `undefined`. */
function mapRowsOf(change: ChangeHistoryFieldChange, labels: Labels, locale: string) {
  return drawsMaps(change, labels, true) ? mapRows(change.from, change.to, locale) : undefined;
}

/**
 * The text of one value of a map, by the field's kind like any value (numbers grouped, money in its currency,
 * flags as yes / no); a number under a key named like an identifier as stored.
 */
function useMapValueText(entityType: string, fieldKey: string) {
  const text = useValueText();
  return (change: ChangeHistoryFieldChange, row: MapRow, side: Side) =>
    text(row[side], isIdKey(row.key) ? { ...change, kind: 'id' } : change, { entityType, fieldKey }, side);
}

/** Above this many keys, a map change shows its changed keys only, the unchanged ones behind a toggle. */
const MAP_ROWS_SHOWN = 8;

/** One side of a map change's row: `key: value`, the side's chip when the key changed, dimmed when it did not. */
function MapCell({ row, side, text }: { row: MapRow; side: Side; text: string }) {
  // The first column keeps the gap the «Was» column leaves before «Became»; every line is padded like a chip, so
  // the keys of marked and unmarked rows start in one line.
  const column = side === 'from' ? 'pr-3' : '';
  if (!row.changed) {
    return (
      <div className={`${column} break-words text-muted-foreground`}>
        <span className="px-1">{labelled(row.key, text)}</span>
      </div>
    );
  }
  if (row[side] === null) {
    return (
      <div className={`${column} break-words`}>
        <span className="px-1">
          {row.key}:{NBSP}
          <span className="text-muted-foreground">—</span>
        </span>
      </div>
    );
  }
  return (
    <div className={`${column} break-words`}>
      <span className={`${SIDE_CHIP[side]} box-decoration-clone`}>{labelled(row.key, text)}</span>
    </div>
  );
}

/**
 * A change of an object of scalars across both value columns, one row per key of either side (sorted by name,
 * `mapRows`), so each key reads was → became on one line: `key: value` in the text font, «—» where a side has no
 * value, the changed rows marked red / green like any changed value, the unchanged ones dimmed. Of more than
 * `MAP_ROWS_SHOWN` keys only the changed ones show, the rest on demand.
 */
function MapChange({
  change,
  rows,
  entityType,
  fieldKey,
}: {
  change: ChangeHistoryFieldChange;
  rows: MapRow[];
  entityType: string;
  fieldKey: string;
}) {
  const bounded = useContext(BoundedValues);
  const text = useMapValueText(entityType, fieldKey);
  const [open, setOpen] = useState(false);
  const unchanged = rows.filter((row) => !row.changed).length;
  // Hiding one row behind a toggle saves nothing; a change of unchanged keys alone shows them all.
  const collapsible = rows.length > MAP_ROWS_SHOWN && unchanged > 1 && unchanged < rows.length;
  const shown = collapsible && !open ? rows.filter((row) => row.changed) : rows;
  return (
    <>
      <div className={`grid grid-cols-2 gap-y-0.5 leading-snug ${bounded ? 'max-h-80 overflow-auto' : ''}`}>
        {shown.map((row) => (
          <Fragment key={row.key}>
            <MapCell row={row} side="from" text={text(change, row, 'from')} />
            <MapCell row={row} side="to" text={text(change, row, 'to')} />
          </Fragment>
        ))}
      </div>
      {collapsible && (
        <button type="button" className="ml-1 mt-0.5 text-primary hover:underline" onClick={() => setOpen(!open)}>
          {open ? (
            <Trans context="change-history">show less</Trans>
          ) : (
            <>
              +{unchanged} <Trans context="change-history">unchanged</Trans>
            </>
          )}
        </button>
      )}
    </>
  );
}

/** The value cells of a changed field: a set change or a compacted value across both, a map key by key, else a side each. */
function ChangeCells({
  change,
  rows,
  both,
  entityType,
  fieldKey,
}: {
  change: ChangeHistoryFieldChange;
  rows: MapRow[] | undefined;
  both: boolean;
  entityType: string;
  fieldKey: string;
}) {
  if (rows) {
    return (
      <td colSpan={2} className="py-1.5">
        <MapChange change={change} rows={rows} entityType={entityType} fieldKey={fieldKey} />
      </td>
    );
  }
  if (both) {
    return (
      <td colSpan={2} className="py-1.5 break-words">
        {change.stripped ? <StrippedValue change={change} /> : <RefsChange change={change} />}
      </td>
    );
  }
  return (
    <>
      <td className="py-1.5 pr-3 break-words">
        <ValueSide change={change} fieldKey={fieldKey} entityType={entityType} side="from" />
      </td>
      <td className="py-1.5 break-words">
        <ValueSide change={change} fieldKey={fieldKey} entityType={entityType} side="to" />
      </td>
    </>
  );
}

/**
 * «Field · Was · Became», one row per changed field. The timeline leaves the header out (`showHeader`):
 * the red and green sides say which is which, and a block holds many items.
 */
export function FieldChangesTable({
  entityType,
  changes,
  showHeader = true,
}: {
  entityType: string;
  changes: Record<string, ChangeHistoryFieldChange>;
  showHeader?: boolean;
}) {
  const labels = useLabels();
  const { i18n } = useLinguiContext();
  const keys = Object.keys(changes);
  if (keys.length === 0) {
    return null;
  }
  return (
    <table className="w-full table-fixed border-collapse text-sm">
      <colgroup>
        <col className="w-[30%] min-w-[9rem]" />
        <col />
        <col />
      </colgroup>
      {showHeader && (
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1 pr-3 font-normal">
              <Trans context="change-history">Field</Trans>
            </th>
            <th className="py-1 pr-3 font-normal">
              <Trans context="change-history">Was</Trans>
            </th>
            <th className="py-1 font-normal">
              <Trans context="change-history">Became</Trans>
            </th>
          </tr>
        </thead>
      )}
      <tbody>
        {keys.map((key) => {
          const recorded = changes[key];
          const both = spansBoth(recorded, !!labels.valueRenderer(recorded.kind ?? 'text'));
          const sole = both ? undefined : soleKeyOf(recorded, labels);
          const rows = both || sole ? undefined : mapRowsOf(recorded, labels, i18n.locale);
          const change = sole ? { ...recorded, from: sole.from, to: sole.to } : recorded;
          const field = labels.field(entityType, key, recorded);
          return (
            <tr key={key} className="border-b border-border/50 align-top last:border-0">
              <td className="py-1.5 pr-3 text-muted-foreground break-words">
                {sole ? `${field}${NBSP}· ${sole.key}` : field}
              </td>
              <ChangeCells change={change} rows={rows} both={both} entityType={entityType} fieldKey={key} />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const CREATED_PREVIEW = 6;

const createdValueOf = (change: ChangeHistoryFieldChange) =>
  change.kind === 'refs' ? (change.added ?? []) : change.to;

/** The keys of a created entity's values worth showing, name / slug / enabled first. */
function useCreatedKeys(entityType: string, changes: Record<string, ChangeHistoryFieldChange>): string[] {
  const text = useValueText();
  return orderCreatedKeys(
    Object.keys(changes).filter((key) => {
      const change = changes[key];
      const value = createdValueOf(change);
      return (
        change.stripped ||
        (!isBlank(value) && value !== ROOT_COLLECTION && text(value, change, { entityType, fieldKey: key }) !== '—')
      );
    }),
  );
}

/** A created entity's values in one line («Name (uk) Tee, Enabled Yes, …»), the rest behind a toggle. */
export function CreatedValues({
  entityType,
  changes,
}: {
  entityType: string;
  changes: Record<string, ChangeHistoryFieldChange>;
}) {
  const { t } = useLingui();
  const labels = useLabels();
  const text = useValueText();
  const [open, setOpen] = useState(false);
  const keys = useCreatedKeys(entityType, changes);
  if (keys.length === 0) {
    return null;
  }
  const shown = open ? keys : keys.slice(0, CREATED_PREVIEW);
  return (
    <div className="text-sm text-muted-foreground">
      {shown.map((key, index) => {
        const change = changes[key];
        // A long JSON value (filters, conditions) is named with its size, not printed.
        const value = createdValueOf(change);
        const size = change.kind === 'json' && Array.isArray(value) ? value.length : undefined;
        return (
          <span key={key}>
            {index > 0 && ', '}
            {labels.field(entityType, key, change)}
            {size !== undefined && <span className="text-foreground"> ({size})</span>}
            {!change.stripped && change.kind !== 'json' && (
              <span className="text-foreground"> {text(value, change, { entityType, fieldKey: key })}</span>
            )}
          </span>
        );
      })}
      {keys.length > CREATED_PREVIEW && (
        <button
          type="button"
          className="ml-1 text-primary hover:underline"
          aria-label={open ? undefined : t({ message: 'show all fields', context: 'change-history' })}
          title={open ? undefined : t({ message: 'show all fields', context: 'change-history' })}
          onClick={() => setOpen(!open)}
        >
          {open ? <Trans context="change-history">show less</Trans> : '…'}
        </button>
      )}
    </div>
  );
}

/** «Field — value» rows, the field names in a column: a created entity's values and a deleted one's last state. */
export function ValuesGrid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[minmax(8rem,1fr)_3fr] gap-x-3 gap-y-1.5 text-sm">{children}</dl>;
}

export function GridRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** A created entity's values as a grid in the entry window: name, slug and enabled first. */
export function CreatedGrid({
  entityType,
  changes,
}: {
  entityType: string;
  changes: Record<string, ChangeHistoryFieldChange>;
}) {
  const labels = useLabels();
  const keys = useCreatedKeys(entityType, changes);
  if (keys.length === 0) {
    return null;
  }
  return (
    <ValuesGrid>
      {keys.map((key) => {
        const change = changes[key];
        return (
          <GridRow key={key} label={labels.field(entityType, key, change)}>
            {change.stripped ? (
              <StrippedValue change={change} />
            ) : (
              <LastStateValue entityType={entityType} fieldKey={key} value={createdValueOf(change)} change={change} />
            )}
          </GridRow>
        );
      })}
    </ValuesGrid>
  );
}

/**
 * One value of a deleted entity's last state (or of a created entity), rendered like the «became» side of a
 * diff without its colour: the host's renderer for its kind, images as thumbnails, rich text as clipped
 * text, JSON as lines, everything else as formatted text (money, dates, references by name).
 */
export function LastStateValue({
  entityType,
  fieldKey,
  value,
  fields,
  change: given,
}: {
  entityType: string;
  fieldKey: string;
  value: unknown;
  fields?: unknown;
  /** The change the value comes from (a created entity's); else it is read from `fields`. */
  change?: ChangeHistoryFieldChange;
}) {
  const labels = useLabels();
  const text = useValueText();
  const mapText = useMapValueText(entityType, fieldKey);
  const { i18n } = useLinguiContext();
  const change: ChangeHistoryFieldChange = given
    ? { ...given, from: undefined, to: value }
    : lastStateChange(fieldKey, value, fields);
  const kind = change.kind ?? 'text';
  const Host = labels.valueRenderer(kind);
  if (Host) {
    return <Host change={change} fieldKey={fieldKey} entityType={entityType} side="to" />;
  }
  // An object of scalars reads as its `key: value` lines, sorted and formatted as in a change of it.
  const rows = drawsMaps(change, labels, true) && flatEntries(value) ? mapRows(null, value, i18n.locale) : undefined;
  if (rows) {
    return (
      <ValueLines
        lines={rows.map((row) => ({ text: labelled(row.key, mapText(change, row, 'to')), changed: false }))}
        mono={false}
      />
    );
  }
  if (kind === 'json') {
    if (isOperationList(value)) {
      return <OperationsValue change={change} side="to" plain />;
    }
    return (
      <ValueLines
        lines={jsonLines(value, change.labels).map((line) => ({ text: line, changed: false }))}
        mono={!isFlat(value)}
      />
    );
  }
  if (kind === 'richtext') {
    return <RichTextValue change={change} side="to" />;
  }
  if (kind === 'assets') {
    return <AssetsValue change={{ ...change, added: [], removed: [] }} side="to" />;
  }
  return <span>{clipText(text(value, change, { entityType, fieldKey }), 300).text}</span>;
}
