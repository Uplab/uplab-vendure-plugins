import { Trans, useLingui } from '@lingui/react/macro';
import { api, Button, HistoryEntryDate, Skeleton, useInfiniteQuery, useQuery } from '@vendure/dashboard';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { capitalizeFirst } from '../format';
import { changeHistoryEntityTimelineDocument, changeHistoryEntryDocument } from '../graphql';
import { batchKindOf } from '../labels';
import type { ChangeHistoryDetailData, ChangeHistoryEntryData } from '../registry';
import { actorOf, EntryBadges, runLabelOf, TONE_ICON_CLASSES, type EntryBadge } from './actor';
import { DetailRows } from './details';
import { EntityLink } from './entity-link';
import { EntryDialog } from './entry-dialog';
import { QueryError } from './query-error';
import {
  BatchSummary,
  batchKindOfEntry,
  batchSubject,
  EntryAction,
  EntryCounts,
  EntrySummary,
  hasCounts,
  runSubjectEntry,
} from './summary';
import { useLabels } from './use-labels';
import { CreatedValues, FieldChangesTable } from './values';

const PAGE_SIZE = 20;
/** Batch members and derived entries shown inline; the rest open in the entry window, which pages. */
const INLINE_LIMIT = 50;

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
      aria-expanded={open}
      onClick={onClick}
      className="inline-flex items-center gap-0.5 text-sm text-primary hover:underline"
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

/** «Expand» / «Collapse» (the same words wherever something folds open in place). */
function ExpandToggle({ open, onClick, children }: { open: boolean; onClick: () => void; children?: ReactNode }) {
  return (
    <Toggle open={open} onClick={onClick}>
      {open ? <Trans context="change-history">collapse</Trans> : <Trans context="change-history">expand</Trans>}
      {children}
    </Toggle>
  );
}

/** «show all (240)»: the whole list, paged, in the entry window. */
function ShowAll({ entryId, total }: { entryId: string; total: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="mt-1 text-sm text-primary hover:underline" onClick={() => setOpen(true)}>
        <Trans context="change-history">show all</Trans> ({total})
      </button>
      <EntryDialog entryId={open ? entryId : undefined} onClose={() => setOpen(false)} />
    </>
  );
}

const Dot = () => <span className="text-muted-foreground">·</span>;

/**
 * The round icon, the title line and the time of one timeline item. The line reads what happened first,
 * then who and when: «Updated · Jane Doe · 4 hours ago» — in Ukrainian the impersonal «Оновлено» cannot
 * follow the name.
 */
function ItemFrame({
  entry,
  lead,
  showActor = true,
  badges,
  extra,
  children,
}: {
  entry: ChangeHistoryEntryData;
  lead: ReactNode;
  showActor?: boolean;
  badges?: Array<EntryBadge | false | null | undefined>;
  extra?: ReactNode;
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
          {lead}
          {showActor && (
            <>
              <Dot />
              <span className={actor.tone === 'system' ? 'text-muted-foreground' : 'text-foreground'}>
                {actor.name}
              </span>
            </>
          )}
          <Dot />
          <HistoryEntryDate
            date={entry.createdAt}
            className="cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-2"
          />
          <EntryBadges actor={actor} badges={badges} />
          {extra}
        </div>
        {children && <div className="mt-1.5">{children}</div>}
      </div>
    </div>
  );
}

/** Entries derived from one (the variants a product save rewrote), loaded when unfolded. */
function DerivedEntries({ entry }: { entry: ChangeHistoryEntryData }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['change-history-derived', entry.id],
    queryFn: () =>
      api.query(changeHistoryEntryDocument, {
        id: entry.id,
        derivedOptions: { take: INLINE_LIMIT, sort: { createdAt: 'ASC' } },
        memberOptions: { take: 1 },
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
  // What the reader may see: a derived entry of a type they may not read is not listed, nor counted.
  const items = data?.changeHistoryEntry?.derivedEntries.items ?? [];
  const total = data?.changeHistoryEntry?.derivedEntries.totalItems ?? 0;
  return (
    <div className="mt-1">
      <Toggle open={open} onClick={() => setOpen(!open)}>
        <Trans context="change-history">Derived changes:</Trans> {entry.derivedCount}
      </Toggle>
      {open && (
        <div className="mt-1 space-y-2 border-l pl-3">
          {isLoading && <Skeleton className="h-6 w-full" />}
          {isError && <QueryError error={error} onRetry={() => refetch()} retrying={isFetching} />}
          {items.map((derived) => (
            <div key={derived.id}>
              <div className="text-sm">
                <EntityLink entry={derived} deletedBadge={derived.action !== 'deleted'} /> ·{' '}
                <span className="text-muted-foreground">
                  <EntryAction entry={derived} />
                </span>
              </div>
              {derived.changes &&
                Object.keys(derived.changes).length > 0 &&
                (derived.action === 'created' ? (
                  <CreatedValues entityType={derived.entityType} changes={derived.changes} />
                ) : (
                  <FieldChangesTable entityType={derived.entityType} changes={derived.changes} showHeader={false} />
                ))}
            </div>
          ))}
          {total > items.length && <ShowAll entryId={entry.id} total={total} />}
        </div>
      )}
    </div>
  );
}

/** A batch head: the counts, and its members when unfolded. */
function BatchItem({ entry }: { entry: ChangeHistoryEntryData }) {
  const labels = useLabels();
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['change-history-batch-members', entry.id],
    queryFn: () =>
      api.query(changeHistoryEntryDocument, {
        id: entry.id,
        memberOptions: { take: INLINE_LIMIT, sort: { createdAt: 'ASC' } },
        derivedOptions: { take: 1 },
      }),
    enabled: open,
  });
  // The members the reader may see; the rest of them page in the entry window.
  const members = data?.changeHistoryEntry?.batchMembers.items ?? [];
  const total = data?.changeHistoryEntry?.batchMembers.totalItems ?? 0;
  const subject = batchSubject(entry);
  return (
    <ItemFrame
      entry={entry}
      lead={
        <>
          <span className="font-medium">{capitalizeFirst(labels.batchKind(batchKindOfEntry(entry)))}</span>
          {subject && (
            <>
              <Dot />
              <EntityLink entry={subject} />
            </>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <BatchSummary entry={entry} />
        {!entry.isCompacted && <ExpandToggle open={open} onClick={() => setOpen(!open)} />}
      </div>
      {open && (
        <ul className="mt-1 space-y-0.5 border-l pl-3 text-sm">
          {isLoading && <Skeleton className="h-6 w-full" />}
          {isError && (
            <li>
              <QueryError error={error} onRetry={() => refetch()} retrying={isFetching} />
            </li>
          )}
          {members.map((member) => (
            <li key={member.id}>
              <EntityLink entry={member} deletedBadge={member.action !== 'deleted'} /> ·{' '}
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
          {!isLoading && !isError && total > members.length && (
            <li>
              <ShowAll entryId={entry.id} total={total} />
            </li>
          )}
        </ul>
      )}
    </ItemFrame>
  );
}

/**
 * An external run: one collapsed item with its count line when it touched several entities (a product
 * page), the rows themselves when they are all the subject's (a variant page). The server sends the first
 * rows only; the rest open in the entry window.
 */
function RunItem({ entry, subject }: { entry: TimelineEntry; subject: TimelineSubject }) {
  const labels = useLabels();
  const rows = entry.details ?? [];
  const onlySubject = rows.every((row) => row.entityType === subject.entityType && row.entityId === subject.entityId);
  const [open, setOpen] = useState(false);
  const about = runSubjectEntry(entry);
  const lead = (
    <>
      <span className="font-medium">{runLabelOf(entry, actorOf(entry, labels))}</span>
      {about && (
        <>
          <Dot />
          <EntityLink entry={about} />
        </>
      )}
    </>
  );
  const total = entry.detailsTotal ?? 0;
  if (rows.length === 0) {
    return <ItemFrame entry={entry} lead={lead} showActor={false} />;
  }
  const all = total > rows.length ? <ShowAll entryId={entry.id} total={total} /> : null;
  if (onlySubject) {
    return (
      <ItemFrame entry={entry} lead={lead} showActor={false}>
        <DetailRows rows={rows} entry={entry} mode="timeline" />
        {all}
      </ItemFrame>
    );
  }
  return (
    <ItemFrame
      entry={entry}
      lead={
        <>
          {lead}
          <Dot />
          <span className="text-muted-foreground">
            <DetailRows rows={rows} entry={entry} mode="summary" />
          </span>
        </>
      }
      showActor={false}
      extra={<ExpandToggle open={open} onClick={() => setOpen(!open)} />}
    >
      {open ? (
        <>
          <DetailRows rows={rows} entry={entry} mode="timeline" />
          {all}
        </>
      ) : null}
    </ItemFrame>
  );
}

function EntryItem({ entry, subject }: { entry: ChangeHistoryEntryData; subject: TimelineSubject }) {
  const { t } = useLingui();
  const labels = useLabels();
  const isOther = entry.entityType !== subject.entityType || entry.entityId !== subject.entityId;
  const membership = entry.action === 'collection_added' || entry.action === 'collection_removed';
  // A member of a batch shows its kind; a scheduled action's source label can say the same, so it shows once.
  const batchKind = batchKindOf(entry.batchId);
  const changes = entry.changes ?? {};
  const hasChanges = Object.keys(changes).length > 0;
  return (
    <ItemFrame
      entry={entry}
      lead={
        <>
          <span className="font-medium">{capitalizeFirst(labels.action(entry.action))}</span>
          {membership && entry.parentId && (
            <EntityLink
              entry={{
                ...entry,
                entityType: 'Collection',
                entityId: entry.parentId,
                entityDeleted: entry.parentDeleted === true,
              }}
            >
              «{typeof entry.meta?.collectionLabel === 'string' ? entry.meta.collectionLabel : entry.parentId}»
            </EntityLink>
          )}
          {isOther && !membership && (
            <>
              <Dot />
              <span>
                {labels.type(entry.entityType)} <EntityLink entry={entry} deletedBadge={entry.action !== 'deleted'} />
              </span>
            </>
          )}
        </>
      }
      badges={[
        !!entry.derivedFromId && { key: 'derived', text: t({ message: 'Derived', context: 'change-history' }) },
        !!batchKind && batchKind !== 'collection_rules' && { key: 'batch', text: labels.batchKind(batchKind) },
      ]}
    >
      {hasChanges && entry.action === 'created' && <CreatedValues entityType={entry.entityType} changes={changes} />}
      {hasChanges && entry.action !== 'created' && (
        <FieldChangesTable entityType={entry.entityType} changes={changes} showHeader={false} />
      )}
      {!hasChanges && hasCounts(entry) && (
        <div className="text-sm">
          <EntryCounts entry={entry} />
        </div>
      )}
      {!hasChanges && entry.action.startsWith('channel_') && typeof entry.meta?.channelCode === 'string' && (
        <div className="text-sm text-muted-foreground">
          <Trans context="change-history">Channel</Trans>: {entry.meta.channelCode}
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
  const { data, isLoading, isError, error, refetch, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery({
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
  if (isError && items.length === 0) {
    return <QueryError error={error} onRetry={() => refetch()} retrying={isFetching} />;
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
      {isError && <QueryError className="mt-2 justify-center" error={error} onRetry={() => fetchNextPage()} />}
      {hasNextPage && !isError && (
        <div className="mt-2 flex justify-center">
          <Button variant="outline" size="sm" disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
            <Trans context="change-history">Show more</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}
