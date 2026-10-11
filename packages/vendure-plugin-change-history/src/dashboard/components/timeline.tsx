import { Trans } from '@lingui/react/macro';
import { api, Badge, Button, HistoryEntryDate, Skeleton, useInfiniteQuery, useQuery } from '@vendure/dashboard';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { changeHistoryEntityTimelineDocument, changeHistoryEntriesDocument } from '../graphql';
import { batchKindOf } from '../labels';
import type { ChangeHistoryDetailData, ChangeHistoryEntryData } from '../registry';
import { ActorBadge, actorOf, TONE_ICON_CLASSES } from './actor';
import { DetailRows } from './details';
import { DeletedBadge, EntityLink } from './entity-link';
import { EntryDialog } from './entry-dialog';
import { BatchSummary, batchSubject, EntryAction, EntryCounts, EntrySummary, hasCounts } from './summary';
import { useLabels } from './use-labels';
import { CreatedValues, FieldChangesTable } from './values';

const PAGE_SIZE = 20;

export interface TimelineSubject {
  entityType: string;
  entityId: string;
}

type TimelineEntry = ChangeHistoryEntryData & { details?: ChangeHistoryDetailData[] | null };

function Toggle({ open, onClick, children }: { open: boolean; onClick: () => void; children: ReactNode }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-0.5 text-sm text-primary hover:underline"
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

/** The round icon, the title line and the time of one timeline item. */
function ItemFrame({
  entry,
  title,
  badges,
  children,
}: {
  entry: ChangeHistoryEntryData;
  title: ReactNode;
  badges?: ReactNode;
  children?: ReactNode;
}) {
  const labels = useLabels();
  const actor = actorOf(entry, labels);
  const { Icon } = actor;
  return (
    <div className="relative flex gap-3 rounded-lg p-3 transition-colors hover:bg-muted/30">
      <div
        className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${TONE_ICON_CLASSES[actor.tone]}`}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
          <span className={`font-medium ${actor.tone === 'system' ? 'text-muted-foreground' : ''}`}>{actor.name}</span>
          {title}
          <HistoryEntryDate
            date={entry.createdAt}
            className="cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-2"
          />
          <ActorBadge actor={actor} />
          {badges}
        </div>
        {children && <div className="mt-1.5">{children}</div>}
      </div>
    </div>
  );
}

/** Entries derived from one (the variants a product save rewrote), loaded when unfolded. */
function DerivedEntries({ entry }: { entry: ChangeHistoryEntryData }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['change-history-derived', entry.id],
    queryFn: () =>
      api.query(changeHistoryEntriesDocument, {
        options: { take: 50, filter: { derivedFromId: { eq: entry.id } }, sort: { createdAt: 'ASC' } },
      }),
    enabled: open,
  });
  if (entry.isCompacted) {
    return (
      <div className="text-sm text-muted-foreground">
        <Trans context="change-history">Derived changes:</Trans> {entry.derivedCount}
      </div>
    );
  }
  return (
    <div className="mt-1">
      <Toggle open={open} onClick={() => setOpen(!open)}>
        <Trans context="change-history">Derived changes:</Trans> {entry.derivedCount}
      </Toggle>
      {open && (
        <div className="mt-1 space-y-2 border-l pl-3">
          {isLoading && <Skeleton className="h-6 w-full" />}
          {data?.changeHistoryEntries.items.map((derived) => (
            <div key={derived.id}>
              <div className="text-sm">
                <EntityLink entry={derived} className="font-mono text-xs" /> ·{' '}
                <span className="text-muted-foreground">
                  <EntryAction entry={derived} />
                </span>
              </div>
              {derived.changes && Object.keys(derived.changes).length > 0 && (
                <FieldChangesTable entityType={derived.entityType} changes={derived.changes} showHeader={false} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A batch head: the counts, and its members when unfolded. */
function BatchItem({ entry }: { entry: ChangeHistoryEntryData }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['change-history-batch-members', entry.id],
    queryFn: () =>
      api.query(changeHistoryEntriesDocument, {
        options: { take: 50, filter: { batchId: { eq: entry.batchId } }, sort: { createdAt: 'ASC' } },
      }),
    enabled: open && !!entry.batchId,
  });
  const members = (data?.changeHistoryEntries.items ?? []).filter((member) => member.entityType !== 'Batch');
  const subject = batchSubject(entry);
  return (
    <ItemFrame
      entry={entry}
      title={
        <span className="text-muted-foreground">
          <EntryAction entry={entry} />
          {subject && (
            <>
              {' · '}
              <EntityLink entry={subject} />
            </>
          )}
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <BatchSummary entry={entry} />
        {!entry.isCompacted && (
          <Toggle open={open} onClick={() => setOpen(!open)}>
            <Trans context="change-history">open</Trans>
          </Toggle>
        )}
      </div>
      {open && (
        <ul className="mt-1 space-y-0.5 border-l pl-3 text-sm">
          {isLoading && <Skeleton className="h-6 w-full" />}
          {members.map((member) => (
            <li key={member.id}>
              <EntityLink entry={member} /> ·{' '}
              <span className="text-muted-foreground">
                <EntryAction entry={member} />
              </span>
              {member.action !== 'collection_added' && member.action !== 'collection_removed' && (
                <span className="text-muted-foreground">
                  {' · '}
                  <EntrySummary entry={member} />
                </span>
              )}
            </li>
          ))}
          {(data?.changeHistoryEntries.totalItems ?? 0) > 50 && <li className="text-muted-foreground">…</li>}
        </ul>
      )}
    </ItemFrame>
  );
}

/** «show all (240)»: the whole run, paged, in the entry window — the item carries its first rows only. */
function AllRows({ entry, shown }: { entry: TimelineEntry; shown: number }) {
  const [open, setOpen] = useState(false);
  const total = entry.detailsTotal ?? 0;
  if (total <= shown) {
    return null;
  }
  return (
    <>
      <button type="button" className="mt-1 text-sm text-primary hover:underline" onClick={() => setOpen(true)}>
        <Trans context="change-history">show all</Trans> ({total})
      </button>
      <EntryDialog entryId={open ? entry.id : undefined} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * An external run: one collapsed item with its count line when it touched several entities (a product
 * page), the rows themselves when they are all the subject's (a variant page). The server sends the first
 * rows only; the rest open in the entry window.
 */
function RunItem({ entry, subject }: { entry: TimelineEntry; subject: TimelineSubject }) {
  const rows = entry.details ?? [];
  const onlySubject = rows.every((row) => row.entityType === subject.entityType && row.entityId === subject.entityId);
  const [open, setOpen] = useState(false);
  if (rows.length === 0) {
    return <ItemFrame entry={entry} title={null} />;
  }
  if (onlySubject) {
    return (
      <ItemFrame entry={entry} title={null}>
        <DetailRows rows={rows} entry={entry} mode="timeline" />
        <AllRows entry={entry} shown={rows.length} />
      </ItemFrame>
    );
  }
  return (
    <ItemFrame
      entry={entry}
      title={
        <span className="text-muted-foreground">
          <DetailRows rows={rows} entry={entry} mode="summary" />
        </span>
      }
      badges={
        <Toggle open={open} onClick={() => setOpen(!open)}>
          {open ? <Trans context="change-history">collapse</Trans> : <Trans context="change-history">expand</Trans>}
        </Toggle>
      }
    >
      {open ? (
        <>
          <DetailRows rows={rows} entry={entry} mode="timeline" />
          <AllRows entry={entry} shown={rows.length} />
        </>
      ) : null}
    </ItemFrame>
  );
}

function EntryItem({ entry, subject }: { entry: ChangeHistoryEntryData; subject: TimelineSubject }) {
  const labels = useLabels();
  const isOther = entry.entityType !== subject.entityType || entry.entityId !== subject.entityId;
  const membership = entry.action === 'collection_added' || entry.action === 'collection_removed';
  const batchKind = batchKindOf(entry.batchId);
  const changes = entry.changes ?? {};
  const hasChanges = Object.keys(changes).length > 0;
  return (
    <ItemFrame
      entry={entry}
      title={
        <span className="text-muted-foreground">
          {labels.action(entry.action)}
          {membership && entry.parentId && (
            <>
              {' '}
              <EntityLink
                entry={{
                  ...entry,
                  entityType: 'Collection',
                  entityId: entry.parentId,
                  entityDeleted: entry.parentDeleted === true,
                }}
                className="text-foreground"
              >
                «{typeof entry.meta?.collectionLabel === 'string' ? entry.meta.collectionLabel : entry.parentId}»
              </EntityLink>
            </>
          )}
          {isOther && !membership && (
            <>
              {' · '}
              <span className="text-foreground">
                {labels.type(entry.entityType)} <EntityLink entry={entry} />
              </span>
            </>
          )}
        </span>
      }
      badges={
        <>
          {entry.derivedFromId && (
            <Badge variant="outline" className="font-normal">
              <Trans context="change-history">derived</Trans>
            </Badge>
          )}
          {batchKind && batchKind !== 'collection_rules' && (
            <Badge variant="outline" className="font-normal">
              {labels.batchKind(batchKind)}
            </Badge>
          )}
          {entry.action === 'deleted' && !isOther && <DeletedBadge />}
        </>
      }
    >
      {hasChanges && entry.action === 'created' && <CreatedValues entityType={entry.entityType} changes={changes} />}
      {hasChanges && entry.action !== 'created' && (
        <FieldChangesTable entityType={entry.entityType} changes={changes} />
      )}
      {!hasChanges && hasCounts(entry) && (
        <div className="text-sm">
          <EntryCounts entry={entry} />
        </div>
      )}
      {!hasChanges && !!entry.meta?.noBefore && entry.action !== 'created' && entry.action !== 'deleted' && (
        <span className="text-sm text-muted-foreground">
          <Trans context="change-history">details unavailable</Trans>
        </span>
      )}
      {entry.derivedCount > 0 && <DerivedEntries entry={entry} />}
    </ItemFrame>
  );
}

function TimelineItem({ entry, subject }: { entry: TimelineEntry; subject: TimelineSubject }) {
  if (entry.entityType === 'Run') {
    return <RunItem entry={entry} subject={subject} />;
  }
  if (entry.entityType === 'Batch') {
    return <BatchItem entry={entry} />;
  }
  return <EntryItem entry={entry} subject={subject} />;
}

/** One entity's history, newest first, 20 items a page with «Show more» by cursor. */
export function EntityTimeline({ subject, refreshKey }: { subject: TimelineSubject; refreshKey?: unknown }) {
  const { data, isLoading, isError, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['change-history-timeline', subject.entityType, subject.entityId, refreshKey],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      api.query(changeHistoryEntityTimelineDocument, {
        entityType: subject.entityType,
        entityId: subject.entityId,
        first: PAGE_SIZE,
        after: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) =>
      page.changeHistoryEntityTimeline.hasMore ? page.changeHistoryEntityTimeline.endCursor : undefined,
  });
  const items = data?.pages.flatMap((page) => page.changeHistoryEntityTimeline.items) ?? [];
  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-6 w-1/2" />
      </div>
    );
  }
  if (isError) {
    return <div className="text-sm text-destructive">{error instanceof Error ? error.message : String(error)}</div>;
  }
  if (items.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        <Trans context="change-history">No changes recorded yet.</Trans>
      </div>
    );
  }
  return (
    <div className="relative">
      <div className="absolute bottom-0 left-6 top-6 w-px bg-gradient-to-b from-border via-border/50 to-transparent" />
      <div className="space-y-0.5">
        {items.map((entry) => (
          <TimelineItem key={entry.id} entry={entry} subject={subject} />
        ))}
      </div>
      {hasNextPage && (
        <div className="mt-2 flex justify-center">
          <Button variant="outline" size="sm" disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
            <Trans context="change-history">Show more</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}
