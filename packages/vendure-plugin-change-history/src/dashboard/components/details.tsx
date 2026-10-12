import { Trans } from '@lingui/react/macro';
import { formatDelta, groupByKind, numericDelta, rowEntities } from '../format';
import { ROWS_LABEL } from '../labels';
import type { ChangeHistoryDetailData, ChangeHistoryDetailRendererProps, ChangeHistoryEntryData } from '../registry';
import { useLabels } from './use-labels';

function plain(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function Delta({ row }: { row: ChangeHistoryDetailData }) {
  const delta = numericDelta(row.from, row.to);
  if (delta === undefined || delta === 0) {
    return null;
  }
  return (
    <span className={`ml-1 ${delta > 0 ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
      ({formatDelta(delta)})
    </span>
  );
}

const objectOf = (row: ChangeHistoryDetailData) => row.sku ?? row.entityLabel ?? row.entityId;

/**
 * The package's renderer for detail rows of any kind: «SKU · Name · Scope · Was · Became (±delta)» in the
 * dialog, «[SKU] Scope  was → became» in a timeline, «Variants: 3 · Rows: 4» as the count line (numbers next
 * to the nouns, so no plural forms are needed). A host overrides it per kind.
 */
function DefaultDetailRenderer({ rows, entry, mode }: ChangeHistoryDetailRendererProps) {
  const labels = useLabels();
  const entities = rowEntities(rows);
  if (mode === 'summary') {
    // A timeline item carries its first rows only; the server counts them all.
    return (
      <span>
        {labels.typePlural(entities.type)}: {entry.detailsEntityCount ?? entities.count} · {labels.tr(ROWS_LABEL)}:{' '}
        {entry.detailsTotal ?? rows.length}
      </span>
    );
  }
  if (mode === 'timeline') {
    const showObject = entities.count > 1;
    return (
      <table className="w-full table-fixed text-sm">
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border/50 last:border-0">
              <td className="w-[30%] py-1 pr-3 text-muted-foreground break-words">
                {showObject && <span className="mr-2 text-xs text-foreground">{objectOf(row)}</span>}
                {row.scopeLabel ?? row.scope ?? ''}
              </td>
              <td className="py-1 pr-3">
                <span className="rounded bg-red-50 px-1 text-red-800 dark:bg-red-950/60 dark:text-red-200">
                  {plain(row.from)}
                </span>
              </td>
              <td className="py-1">
                <span className="rounded bg-green-50 px-1 text-green-800 dark:bg-green-950/60 dark:text-green-200">
                  {plain(row.to)}
                </span>
                <Delta row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  // The header stays on top while the window scrolls through a long run.
  const th = 'bg-background py-1 font-normal';
  return (
    <table className="w-full border-collapse text-sm">
      <thead className="sticky -top-px z-10 bg-background shadow-[0_1px_0_var(--border)]">
        <tr className="text-left text-xs text-muted-foreground">
          <th className={`${th} pr-3`}>
            <Trans context="change-history">SKU / ID</Trans>
          </th>
          <th className={`${th} pr-3`}>
            <Trans context="change-history">Name</Trans>
          </th>
          <th className={`${th} pr-3`}>
            <Trans context="change-history">Scope</Trans>
          </th>
          <th className={`${th} pr-3 text-right`}>
            <Trans context="change-history">Was</Trans>
          </th>
          <th className={`${th} text-right`}>
            <Trans context="change-history">Became</Trans>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-b border-border/50 last:border-0">
            <td className="py-1 pr-3 text-xs whitespace-nowrap">{row.sku ?? row.entityId}</td>
            <td className="py-1 pr-3">{row.entityLabel ?? <span className="text-muted-foreground">—</span>}</td>
            <td className="py-1 pr-3 whitespace-nowrap">{row.scopeLabel ?? row.scope ?? '—'}</td>
            <td className="py-1 pr-3 text-right whitespace-nowrap">{plain(row.from)}</td>
            <td className="py-1 text-right whitespace-nowrap">
              {plain(row.to)}
              <Delta row={row} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Rows of a run, each kind drawn by its registered renderer or the default one. */
export function DetailRows({
  rows,
  entry,
  mode,
}: {
  rows: ChangeHistoryDetailData[];
  entry: ChangeHistoryEntryData;
  mode: ChangeHistoryDetailRendererProps['mode'];
}) {
  const labels = useLabels();
  const groups = groupByKind(rows);
  if (mode === 'summary') {
    // One count line: a single kind's own renderer, or the default one over mixed kinds.
    const Renderer = (groups.length === 1 && labels.detailRenderer(groups[0][0])) || DefaultDetailRenderer;
    return <Renderer rows={rows} entry={entry} mode="summary" />;
  }
  return (
    <div className="space-y-2">
      {groups.map(([kind, kindRows]) => {
        const Renderer = labels.detailRenderer(kind) ?? DefaultDetailRenderer;
        return <Renderer key={kind} rows={kindRows} entry={entry} mode={mode} />;
      })}
    </div>
  );
}
