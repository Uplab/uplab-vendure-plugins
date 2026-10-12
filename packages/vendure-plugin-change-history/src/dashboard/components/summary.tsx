import { Trans } from '@lingui/react/macro';
import { Badge } from '@vendure/dashboard';
import { Layers } from 'lucide-react';
import {
  batchTotal,
  countEntries,
  countsLine,
  durationSeconds,
  formatDelta,
  numericDelta,
  orderCreatedKeys,
  refLabel,
} from '../format';
import { batchKindOf } from '../labels';
import type { ChangeHistoryEntryData, ChangeHistoryFieldChange } from '../registry';
import { EntityLink } from './entity-link';
import { useLabels } from './use-labels';
import { useValueText } from './values';

const LIST_KINDS = new Set(['refs', 'assets', 'json', 'richtext']);
const MAX_FIELDS = 4;

/** The entity a batch head stands for: its parent (a collection for collection rules), when it has one. */
export function batchSubject(entry: ChangeHistoryEntryData): ChangeHistoryEntryData | undefined {
  if (entry.entityType !== 'Batch' || !entry.parentType || !entry.parentId) {
    return undefined;
  }
  return {
    ...entry,
    entityType: entry.parentType,
    entityId: entry.parentId,
    entityDeleted: entry.parentDeleted === true,
  };
}

/** A batch head's kind: `meta.kind`, else the kind in its `batchId` (`<kind>:<uuid>`). */
export const batchKindOfEntry = (entry: ChangeHistoryEntryData): string =>
  typeof entry.meta?.kind === 'string' ? entry.meta.kind : (batchKindOf(entry.batchId) ?? entry.entityType);

/**
 * A batch's own label («Scheduled action #3»), or `undefined` when it has none: a host that passed no label
 * stored the kind (`archive`) there, which is not shown.
 */
export function batchOwnLabel(entry: ChangeHistoryEntryData): string | undefined {
  return entry.entityLabel && entry.entityLabel !== batchKindOfEntry(entry) ? entry.entityLabel : undefined;
}

/** «Product», «Variant», …; a batch with a parent shows its parent's type. */
export function EntryType({ entry }: { entry: ChangeHistoryEntryData }) {
  const labels = useLabels();
  const subject = batchSubject(entry);
  return <span>{labels.type(subject?.entityType ?? entry.entityType)}</span>;
}

/** The action; a batch head says what kind of batch it is. */
export function EntryAction({ entry }: { entry: ChangeHistoryEntryData }) {
  const labels = useLabels();
  return (
    <span>
      {entry.entityType === 'Batch' ? labels.batchKind(batchKindOfEntry(entry)) : labels.action(entry.action)}
    </span>
  );
}

/**
 * The object of a feed row: a link to the entity, the batch's subject and size, or what a run was about (its
 * recorded label: «stock sync after order #1042»). `cut` lets a narrow cell shorten the name, never a
 * variant's SKU.
 */
export function EntryObject({ entry, cut = false }: { entry: ChangeHistoryEntryData; cut?: boolean }) {
  if (entry.entityType === 'Run') {
    return entry.entityLabel ? (
      <span className={cut ? 'block truncate' : undefined}>{entry.entityLabel}</span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  }
  if (entry.entityType === 'Batch') {
    const subject = batchSubject(entry);
    const total = batchTotal(entry.batchCounts);
    return (
      <span className="inline-flex max-w-full items-center gap-1.5">
        {subject ? (
          <EntityLink entry={subject} cut={cut} />
        ) : (
          batchOwnLabel(entry) && <span className={cut ? 'truncate' : undefined}>{batchOwnLabel(entry)}</span>
        )}
        {total > 0 && (
          <Badge variant="outline" className="gap-1 font-normal">
            <Layers className="h-3 w-3" />
            {total}
          </Badge>
        )}
      </span>
    );
  }
  return <EntityLink entry={entry} cut={cut} />;
}

/** «updated: 37» — a count after its label, so that a noun («errors») reads as well as a participle. */
const countText = (label: string, count: number) => `${label}: ${count}`;

/** «updated: 37, zeroed: 2 · 4 s» — a run's counts with the source's labels. */
export function RunCounts({
  entry,
  includeZero = false,
  separator = ', ',
}: {
  entry: ChangeHistoryEntryData;
  includeZero?: boolean;
  separator?: string;
}) {
  const labels = useLabels();
  const counts = countEntries(entry.meta?.counts, includeZero);
  const seconds = durationSeconds(entry.meta?.durationMs);
  return (
    <span>
      {counts.map(([key, count]) => countText(labels.count(entry.source, key), count)).join(separator)}
      {seconds !== undefined && (
        <span className="text-muted-foreground">
          {counts.length > 0 && ' · '}
          {seconds} <Trans context="change-history">s</Trans>
        </span>
      )}
    </span>
  );
}

/** Whether a host action's entry carries counts to show (`meta.counts`, e.g. a reorder's moved / total). */
export function hasCounts(entry: ChangeHistoryEntryData): boolean {
  const { parts, total } = countsLine(entry.meta?.counts);
  return parts.length > 0 || total !== undefined;
}

/** «moved: 3 (total: 12)»: the counts of a host action with the source's labels, the total last. */
export function EntryCounts({ entry }: { entry: ChangeHistoryEntryData }) {
  const labels = useLabels();
  const { parts, total } = countsLine(entry.meta?.counts);
  const totalText = total !== undefined ? countText(labels.count(entry.source, 'total'), total) : '';
  return (
    <span>
      {parts.map(([key, count]) => countText(labels.count(entry.source, key), count)).join(', ')}
      {totalText && (parts.length > 0 ? ` (${totalText})` : totalText)}
    </span>
  );
}

/** A batch head's line: «+12 / −3» for collection rules, the fields a bulk edit set, or its members by type. */
export function BatchSummary({ entry }: { entry: ChangeHistoryEntryData }) {
  const labels = useLabels();
  const counts = entry.meta?.counts as Record<string, unknown> | undefined;
  if (counts && typeof counts.added === 'number' && typeof counts.removed === 'number') {
    return (
      <span>
        +{counts.added} / −{counts.removed}
      </span>
    );
  }
  const memberType = entry.batchCounts?.[0]?.entityType ?? 'Product';
  if (Array.isArray(entry.meta?.fields) && entry.meta.fields.length > 0) {
    return <span>{entry.meta.fields.map((key) => labels.field(memberType, String(key))).join(', ')}</span>;
  }
  return (
    <span>
      {(entry.batchCounts ?? [])
        .map((count) => `${labels.type(count.entityType)} · ${countText(labels.action(count.action), count.count)}`)
        .join(', ')}
    </span>
  );
}

function DerivedBadge({ count }: { count: number }) {
  return (
    <Badge variant="outline" className="ml-1.5 font-normal">
      <Trans context="change-history">Derived changes:</Trans> {count}
    </Badge>
  );
}

/** «Name (uk): Tee → Oversized tee» for one short field, else the changed fields' names. */
function ChangesSummary({
  entry,
  changes,
}: {
  entry: ChangeHistoryEntryData;
  changes: Record<string, ChangeHistoryFieldChange>;
}) {
  const labels = useLabels();
  const text = useValueText();
  const keys = Object.keys(changes);
  const only = keys.length === 1 ? changes[keys[0]] : undefined;
  if (only && only.kind === 'refs' && !only.stripped) {
    // «Facet values: +Color: White, −Color: Black»
    const ids = (list: string[] | undefined, sign: string) =>
      (list ?? []).map((id) => `${sign}${refLabel(only.labels, id)}`);
    return (
      <span>
        {labels.field(entry.entityType, keys[0], only)}:{' '}
        {[...ids(only.added, '+'), ...ids(only.removed, '−')].join(', ')}
      </span>
    );
  }
  if (only && !LIST_KINDS.has(only.kind ?? 'text') && !only.stripped) {
    const field = { entityType: entry.entityType, fieldKey: keys[0] };
    const delta = only.kind === 'stock' ? numericDelta(only.from, only.to) : undefined;
    return (
      <span>
        {labels.field(entry.entityType, keys[0], only)}: {text(only.from, only, field)} → {text(only.to, only, field)}
        {delta !== undefined && delta !== 0 && ` (${formatDelta(delta)})`}
      </span>
    );
  }
  const names = keys.slice(0, MAX_FIELDS).map((key) => labels.field(entry.entityType, key, changes[key]));
  return (
    <span>
      {names.join(', ')}
      {keys.length > MAX_FIELDS && ', …'}
    </span>
  );
}

/** «Name (en): Tee» — what a created entity is called, from the values it was created with. */
function CreatedSummary({
  entry,
  changes,
}: {
  entry: ChangeHistoryEntryData;
  changes: Record<string, ChangeHistoryFieldChange>;
}) {
  const labels = useLabels();
  const text = useValueText();
  const key = orderCreatedKeys(Object.keys(changes)).find((candidate) => {
    const change = changes[candidate];
    return !LIST_KINDS.has(change.kind ?? 'text') && !change.stripped && text(change.to, change) !== '—';
  });
  if (!key) {
    return <span className="text-muted-foreground">—</span>;
  }
  const change = changes[key];
  return (
    <span>
      {labels.field(entry.entityType, key, change)}:{' '}
      {text(change.to, change, { entityType: entry.entityType, fieldKey: key })}
    </span>
  );
}

/** The one-line «what changed» of a feed row or a widget line. */
export function EntrySummary({ entry }: { entry: ChangeHistoryEntryData }) {
  if (entry.entityType === 'Run') {
    return <RunCounts entry={entry} />;
  }
  if (entry.entityType === 'Batch') {
    return <BatchSummary entry={entry} />;
  }
  const changes = entry.changes ?? {};
  const derived = entry.derivedCount > 0 ? <DerivedBadge count={entry.derivedCount} /> : null;
  if (entry.action === 'collection_added' || entry.action === 'collection_removed') {
    return <span>{typeof entry.meta?.collectionLabel === 'string' ? `«${entry.meta.collectionLabel}»` : '—'}</span>;
  }
  if (entry.action === 'channel_assigned' || entry.action === 'channel_removed') {
    return <span>{typeof entry.meta?.channelCode === 'string' ? entry.meta.channelCode : '—'}</span>;
  }
  if (Object.keys(changes).length > 0 && entry.action !== 'created') {
    return (
      <span>
        <ChangesSummary entry={entry} changes={changes} />
        {derived}
      </span>
    );
  }
  if (entry.action === 'created' && Object.keys(changes).length > 0) {
    return (
      <span>
        <CreatedSummary entry={entry} changes={changes} />
        {derived}
      </span>
    );
  }
  if (hasCounts(entry)) {
    return (
      <span>
        <EntryCounts entry={entry} />
        {derived}
      </span>
    );
  }
  if (entry.meta?.noBefore && entry.action !== 'created' && entry.action !== 'deleted') {
    return (
      <span className="text-muted-foreground">
        <Trans context="change-history">details unavailable</Trans>
      </span>
    );
  }
  return <span className="text-muted-foreground">—{derived}</span>;
}
