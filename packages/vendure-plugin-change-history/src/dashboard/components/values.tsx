import { Trans, useLingui } from '@lingui/react/macro';
import { api, useChannel, useLocalFormat, useQuery, VendureImage } from '@vendure/dashboard';
import { useState, type ReactNode } from 'react';
import { changeHistoryAssetPreviewsDocument } from '../graphql';
import { clipText, diffLines, formatDelta, idList, jsonLines, numericDelta, stripHtml } from '../format';
import type { ChangeHistoryFieldChange, ChangeHistoryValueRendererProps } from '../registry';
import { useLabels } from './use-labels';

type Side = 'from' | 'to';

const SIDE_CHIP: Record<Side, string> = {
  from: 'rounded bg-red-50 px-1 text-red-800 dark:bg-red-950/60 dark:text-red-200',
  to: 'rounded bg-green-50 px-1 text-green-800 dark:bg-green-950/60 dark:text-green-200',
};

function Empty() {
  return <span className="text-muted-foreground">—</span>;
}

function Chip({ side, children }: { side: Side; children: ReactNode }) {
  return <span className={`${SIDE_CHIP[side]} break-words`}>{children}</span>;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/** Core's invisible root collection: the parent of a top-level collection, shown as no parent. */
const ROOT_COLLECTION = '__root_collection__';

/** One value as text: what the feed's summary and a deleted entity's last state show. */
export function useValueText() {
  const { t } = useLingui();
  const { formatCurrency, formatDate } = useLocalFormat();
  const { activeChannel } = useChannel();
  const currency = activeChannel?.defaultCurrencyCode ?? 'USD';
  const yes = t({ message: 'Yes', context: 'change-history' });
  const no = t({ message: 'No', context: 'change-history' });
  return (value: unknown, change: ChangeHistoryFieldChange | undefined): string => {
    if (isBlank(value) || value === ROOT_COLLECTION) {
      return '—';
    }
    const kind = change?.kind;
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
        .map((id) => change?.labels?.[id] ?? `#${id}`)
        .map((label) => (label === ROOT_COLLECTION ? '—' : label))
        .join(', ');
    }
    if (kind === 'richtext' && typeof value === 'string') {
      return clipText(stripHtml(value), 80).text;
    }
    if (typeof value === 'boolean') {
      return value ? yes : no;
    }
    if (typeof value === 'object') {
      return clipText(JSON.stringify(value), 80).text;
    }
    return String(value);
  };
}

function BoolValue({ value, side }: { value: unknown; side: Side }) {
  if (typeof value !== 'boolean') {
    return isBlank(value) ? <Empty /> : <Chip side={side}>{String(value)}</Chip>;
  }
  return (
    <Chip side={side}>
      {value ? <Trans context="change-history">Yes</Trans> : <Trans context="change-history">No</Trans>}
    </Chip>
  );
}

function ScalarValue({ change, side }: { change: ChangeHistoryFieldChange; side: Side }) {
  const text = useValueText();
  const value = change[side];
  if (isBlank(value)) {
    return <Empty />;
  }
  return (
    <>
      <Chip side={side}>{text(value, change)}</Chip>
      {change.truncated && (
        <span className="ml-1 text-xs text-muted-foreground">
          <Trans context="change-history">(shortened)</Trans>
        </span>
      )}
    </>
  );
}

function RefsValue({ change, side }: { change: ChangeHistoryFieldChange; side: Side }) {
  // A set change: what left on the "was" side, what came on the "became" side.
  const ids = side === 'from' ? (change.removed ?? []) : (change.added ?? []);
  if (ids.length === 0) {
    return <Empty />;
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((id) => (
        <Chip key={id} side={side}>
          {change.labels?.[id] ?? `#${id}`}
        </Chip>
      ))}
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
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {ids.map((id) => {
        const asset = previews.get(id);
        const name = change.labels?.[id] ?? asset?.name ?? `#${id}`;
        const ring = highlight.has(id)
          ? side === 'from'
            ? 'ring-2 ring-red-400'
            : 'ring-2 ring-green-500'
          : 'ring-1 ring-border';
        return (
          <span key={id} title={name} className={`inline-block h-10 w-10 overflow-hidden rounded ${ring}`}>
            {asset ? (
              <VendureImage asset={asset} preset="tiny" className="h-10 w-10 object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center bg-muted p-0.5 text-[9px] leading-tight text-muted-foreground">
                {clipText(name, 14).text}
              </span>
            )}
          </span>
        );
      })}
      {side === 'to' && (change.added?.length || change.removed?.length || change.reordered !== undefined) ? (
        <span className="text-xs text-muted-foreground">
          {change.added?.length ? `+${change.added.length} ` : ''}
          {change.removed?.length ? `−${change.removed.length} ` : ''}
          {change.reordered ? (
            <Trans context="change-history">order changed</Trans>
          ) : (
            <Trans context="change-history">order unchanged</Trans>
          )}
        </span>
      ) : null}
    </span>
  );
}

function RichTextValue({ change, side }: { change: ChangeHistoryFieldChange; side: Side }) {
  const [open, setOpen] = useState(false);
  const value = change[side];
  if (typeof value !== 'string' || stripHtml(value) === '') {
    return <Empty />;
  }
  const text = stripHtml(value);
  const clipped = clipText(text, 120);
  return (
    <span className="whitespace-pre-wrap break-words">
      «{open ? text : clipped.text}»
      {clipped.clipped && (
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

function JsonValue({ change, side }: { change: ChangeHistoryFieldChange; side: Side }) {
  const lines = diffLines(jsonLines(change.from, change.labels), jsonLines(change.to, change.labels))[side];
  if (lines.length === 0) {
    return <Empty />;
  }
  return (
    <pre className="max-h-80 overflow-auto rounded border bg-muted/40 p-2 text-xs leading-relaxed">
      {lines.map((line, index) => (
        <div key={index} className={line.changed ? SIDE_CHIP[side] : undefined}>
          {line.text || ' '}
        </div>
      ))}
    </pre>
  );
}

function StockValue({ change, side }: { change: ChangeHistoryFieldChange; side: Side }) {
  const delta = side === 'to' ? numericDelta(change.from, change.to) : undefined;
  return (
    <>
      <ScalarValue change={change} side={side} />
      {delta !== undefined && delta !== 0 && <span className="ml-1 text-muted-foreground">({formatDelta(delta)})</span>}
    </>
  );
}

const BUILT_IN: Record<string, (props: { change: ChangeHistoryFieldChange; side: Side }) => ReactNode> = {
  bool: ({ change, side }) => <BoolValue value={change[side]} side={side} />,
  refs: RefsValue,
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
  const BuiltIn = BUILT_IN[kind];
  return BuiltIn ? <BuiltIn change={props.change} side={props.side} /> : <ScalarValue {...props} />;
}

function StrippedValue({ change }: { change: ChangeHistoryFieldChange }) {
  return (
    <span className="text-muted-foreground">
      <Trans context="change-history">changed</Trans>
      {typeof change.fromLength === 'number' && typeof change.toLength === 'number' && (
        <>
          {' '}
          ({change.fromLength.toLocaleString()} → {change.toLength.toLocaleString()}{' '}
          <Trans context="change-history">characters</Trans>)
        </>
      )}
    </span>
  );
}

/** «Field · Was · Became», one row per changed field. */
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
  const keys = Object.keys(changes);
  if (keys.length === 0) {
    return null;
  }
  return (
    <table className="w-full table-fixed border-collapse text-sm">
      {showHeader && (
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="w-1/4 py-1 pr-3 font-normal">
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
          const change = changes[key];
          return (
            <tr key={key} className="border-b border-border/50 align-top last:border-0">
              <td className="py-1.5 pr-3 text-muted-foreground break-words">{labels.field(entityType, key, change)}</td>
              {change.stripped ? (
                <td colSpan={2} className="py-1.5">
                  <StrippedValue change={change} />
                </td>
              ) : (
                <>
                  <td className="py-1.5 pr-3 break-words">
                    <ValueSide change={change} fieldKey={key} entityType={entityType} side="from" />
                  </td>
                  <td className="py-1.5 break-words">
                    <ValueSide change={change} fieldKey={key} entityType={entityType} side="to" />
                  </td>
                </>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const CREATED_PREVIEW = 6;

/** A created entity's values in one line («Name (uk) «Tee», Enabled ✗, …»), the rest behind a toggle. */
export function CreatedValues({
  entityType,
  changes,
}: {
  entityType: string;
  changes: Record<string, ChangeHistoryFieldChange>;
}) {
  const labels = useLabels();
  const text = useValueText();
  const [open, setOpen] = useState(false);
  const valueOf = (change: ChangeHistoryFieldChange) => (change.kind === 'refs' ? (change.added ?? []) : change.to);
  // Only the values it was created with; a long JSON value (filters, conditions) is named, not printed.
  const keys = Object.keys(changes).filter((key) => {
    const value = valueOf(changes[key]);
    return changes[key].stripped || (!isBlank(value) && value !== ROOT_COLLECTION && text(value, changes[key]) !== '—');
  });
  if (keys.length === 0) {
    return null;
  }
  const shown = open ? keys : keys.slice(0, CREATED_PREVIEW);
  return (
    <div className="text-sm text-muted-foreground">
      {shown.map((key, index) => {
        const change = changes[key];
        const short = change.stripped || change.kind === 'json';
        return (
          <span key={key}>
            {index > 0 && ', '}
            {labels.field(entityType, key, change)}
            {!short && <span className="text-foreground"> {text(valueOf(change), change)}</span>}
          </span>
        );
      })}
      {keys.length > CREATED_PREVIEW && (
        <button type="button" className="ml-1 text-primary hover:underline" onClick={() => setOpen(!open)}>
          {open ? <Trans context="change-history">show less</Trans> : '…'}
        </button>
      )}
    </div>
  );
}
