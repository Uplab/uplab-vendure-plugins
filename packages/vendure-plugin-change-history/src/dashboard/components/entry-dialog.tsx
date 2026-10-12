import { Trans, useLingui } from '@lingui/react/macro';
import {
  api,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  keepPreviousData,
  Skeleton,
  useLocalFormat,
  useQuery,
} from '@vendure/dashboard';
import { ArrowLeft, ArrowRight, Info, X } from 'lucide-react';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { batchTotal, capitalizeFirst, repeatsShown } from '../format';
import { changeHistoryEntryDocument, changeHistoryRunDetailsDocument } from '../graphql';
import type { ChangeHistoryEntryData } from '../registry';
import { actorOf, EntryBadges, runLabelOf } from './actor';
import { DetailRows } from './details';
import { DeletedBadge, EntityLink, useEntityRoute } from './entity-link';
import { QueryError } from './query-error';
import {
  BatchSummary,
  batchKindOfEntry,
  DerivedBadge,
  batchOwnLabel,
  batchSubject,
  EntryAction,
  EntryCounts,
  EntryObject,
  EntrySummary,
  EntryType,
  hasCounts,
  repeatsItsBatch,
  RunCounts,
  runSubjectEntry,
} from './summary';
import { EntityTimeline } from './timeline';
import { useLabels, type Labels } from './use-labels';
import { CreatedGrid, FieldChangesTable, GridRow, LastStateValue, UnboundedValues, ValuesGrid } from './values';

const LIST_PAGE = 20;
const RUN_PAGE = 100;

/** «21–40 / 57» with previous / next. */
function Pager({
  skip,
  take,
  total,
  onChange,
}: {
  skip: number;
  take: number;
  total: number;
  onChange: (skip: number) => void;
}) {
  const { t } = useLingui();
  if (total <= take) {
    return null;
  }
  const previous = t({ message: 'Previous page', context: 'change-history' });
  const next = t({ message: 'Next page', context: 'change-history' });
  return (
    <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
      <span>
        {skip + 1}–{Math.min(skip + take, total)} / {total}
      </span>
      <Button
        variant="outline"
        size="icon-xs"
        aria-label={previous}
        title={previous}
        disabled={skip === 0}
        onClick={() => onChange(Math.max(0, skip - take))}
      >
        <ArrowLeft />
      </Button>
      <Button
        variant="outline"
        size="icon-xs"
        aria-label={next}
        title={next}
        disabled={skip + take >= total}
        onClick={() => onChange(skip + take)}
      >
        <ArrowRight />
      </Button>
    </div>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The members of a batch: the feed's columns, one row each, sized to their content. A member's «what changed»
 * is left out where it would repeat the window's title (the collection, the channel); what it caused stays.
 */
function EntryRows({ entries }: { entries: ChangeHistoryEntryData[] }) {
  const { formatDate } = useLocalFormat();
  return (
    <table className="text-sm">
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id} className="border-b border-border/50 align-top last:border-0">
            <td className="py-1 pr-4 whitespace-nowrap text-muted-foreground">
              {formatDate(entry.createdAt, { timeStyle: 'short' })}
            </td>
            <td className="py-1 pr-4 whitespace-nowrap text-muted-foreground">
              <EntryType entry={entry} />
            </td>
            <td className="py-1 pr-4">
              <EntryObject entry={entry} />
            </td>
            <td className="py-1 pr-4 whitespace-nowrap">
              <EntryAction entry={entry} />
            </td>
            <td className="py-1">
              {repeatsItsBatch(entry) ? (
                entry.derivedCount > 0 && <DerivedBadge count={entry.derivedCount} />
              ) : (
                <EntrySummary entry={entry} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunDetails({ entry }: { entry: ChangeHistoryEntryData }) {
  const [skip, setSkip] = useState(0);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['change-history-run-details', entry.id, skip],
    queryFn: () => api.query(changeHistoryRunDetailsDocument, { entryId: entry.id, skip, take: RUN_PAGE }),
    placeholderData: keepPreviousData,
  });
  const page = data?.changeHistoryRunDetails;
  if (isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }
  if (isError) {
    return <QueryError error={error} onRetry={() => refetch()} retrying={isFetching} />;
  }
  if (!page || page.totalItems === 0) {
    return entry.isCompacted ? null : (
      <div className="text-sm text-muted-foreground">
        <Trans context="change-history">No rows.</Trans>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <DetailRows rows={page.items} entry={entry} mode="dialog" />
      <Pager skip={skip} take={RUN_PAGE} total={page.totalItems} onChange={setSkip} />
    </div>
  );
}

/** A deleted entity's values at the moment it was deleted (`meta.lastState`). */
function LastState({ entry }: { entry: ChangeHistoryEntryData }) {
  const labels = useLabels();
  const state = entry.meta?.lastState;
  if (!state || typeof state !== 'object') {
    return null;
  }
  const values = Object.entries(state as Record<string, unknown>).filter(
    ([, value]) =>
      value !== null &&
      value !== undefined &&
      value !== '' &&
      !(Array.isArray(value) && !value.length) &&
      !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0),
  );
  return (
    <Section title={<Trans context="change-history">Last state</Trans>}>
      <ValuesGrid>
        {values.map(([key, value]) => {
          const stripped = value && typeof value === 'object' && (value as { stripped?: boolean }).stripped;
          return (
            <GridRow key={key} label={labels.field(entry.entityType, key)}>
              {stripped ? (
                '…'
              ) : (
                <LastStateValue
                  entityType={entry.entityType}
                  fieldKey={key}
                  value={value}
                  fields={entry.meta?.lastStateFields}
                />
              )}
            </GridRow>
          );
        })}
      </ValuesGrid>
    </Section>
  );
}

/** The collection or channel a membership entry names; the other entries have nothing here. */
function Membership({ entry }: { entry: ChangeHistoryEntryData }) {
  const labels = useLabels();
  if ((entry.action === 'collection_added' || entry.action === 'collection_removed') && entry.parentId) {
    const name = typeof entry.meta?.collectionLabel === 'string' ? entry.meta.collectionLabel : entry.parentId;
    return (
      <ValuesGrid>
        <GridRow label={labels.type('Collection')}>
          <EntityLink
            entry={{
              ...entry,
              entityType: 'Collection',
              entityId: entry.parentId,
              entityLabel: name,
              entityDeleted: entry.parentDeleted === true,
            }}
          />
        </GridRow>
      </ValuesGrid>
    );
  }
  // An entry of a channel operation, or the batch of one (several products at once).
  const channelBatch = entry.entityType === 'Batch' && batchKindOfEntry(entry).startsWith('channel_');
  if (entry.action === 'channel_assigned' || entry.action === 'channel_removed' || channelBatch) {
    return (
      <ValuesGrid>
        <GridRow label={<Trans context="change-history">Channel</Trans>}>
          {typeof entry.meta?.channelCode === 'string' ? entry.meta.channelCode : '—'}
        </GridRow>
      </ValuesGrid>
    );
  }
  return null;
}

/**
 * The window's title. A run: its label. A batch: its subject («Collection «Sale»»), else its own label
 * («Scheduled action #3»), else its kind's label, else «Bulk operation» — never the raw kind (`archive`)
 * that a host stored as the label of an unlabelled batch.
 */
function titleOf(entry: ChangeHistoryEntryData, labels: Labels): { text: string; subject: ChangeHistoryEntryData } {
  const subject = batchSubject(entry) ?? entry;
  if (entry.entityType === 'Run') {
    return { text: runLabelOf(entry, actorOf(entry, labels)), subject };
  }
  if (entry.entityType === 'Batch' && subject === entry) {
    const own = batchOwnLabel(entry);
    const known = labels.knownBatchKind(batchKindOfEntry(entry));
    return { text: capitalizeFirst(own ?? known ?? labels.type('Batch')), subject };
  }
  return { text: `${labels.type(subject.entityType)} «${subject.entityLabel ?? subject.entityId}»`, subject };
}

function DialogBody({
  entryId,
  onFullHistory,
  focusRef,
}: {
  entryId: string;
  onFullHistory: () => void;
  focusRef: RefObject<HTMLDivElement | null>;
}) {
  const labels = useLabels();
  const { formatDate } = useLocalFormat();
  const entityRoute = useEntityRoute();
  const [derivedSkip, setDerivedSkip] = useState(0);
  const [memberSkip, setMemberSkip] = useState(0);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['change-history-entry', entryId, derivedSkip, memberSkip],
    queryFn: () =>
      api.query(changeHistoryEntryDocument, {
        id: entryId,
        derivedOptions: { skip: derivedSkip, take: LIST_PAGE, sort: { createdAt: 'ASC' } },
        memberOptions: { skip: memberSkip, take: LIST_PAGE, sort: { createdAt: 'ASC' } },
      }),
    placeholderData: keepPreviousData,
  });
  if (isLoading) {
    return (
      <div ref={focusRef} tabIndex={-1} className="outline-none">
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (isError) {
    return (
      <div ref={focusRef} tabIndex={-1} className="pr-8 outline-none">
        <QueryError error={error} onRetry={() => refetch()} retrying={isFetching} />
      </div>
    );
  }
  const entry = data?.changeHistoryEntry;
  if (!entry) {
    return (
      <div ref={focusRef} tabIndex={-1} className="text-sm text-muted-foreground outline-none">
        <Trans context="change-history">This entry no longer exists.</Trans>
      </div>
    );
  }
  const actor = actorOf(entry, labels);
  const { text: title, subject } = titleOf(entry, labels);
  const changes = entry.changes ?? {};
  const hasChanges = Object.keys(changes).length > 0;
  const route = entityRoute(subject);
  const isRun = entry.entityType === 'Run';
  const isBatch = entry.entityType === 'Batch';
  const deleted = entry.entityDeleted || (entry.action === 'deleted' && !isRun && !isBatch);
  // Each name once on the header: the scheduled action that ran itself is title, actor, kind and source.
  const shown = [title];
  const show = (text: string) => {
    if (repeatsShown(text, shown)) {
      return false;
    }
    shown.push(text);
    return true;
  };
  const actionText = isBatch ? labels.batchKind(batchKindOfEntry(entry)) : '';
  const showActor = !isRun && show(actor.name);
  const showAction = !isBatch || show(actionText);
  const showSource = show(actor.source.label);
  const memberType = entry.batchCounts?.length === 1 ? entry.batchCounts[0].entityType : undefined;
  return (
    <>
      <DialogHeader ref={focusRef} tabIndex={-1} className="shrink-0 pr-8 outline-none">
        <DialogTitle className="flex flex-wrap items-center gap-2">
          <span>{title}</span>
          {!isRun &&
            (deleted ? (
              <DeletedBadge />
            ) : (
              route && (
                <EntityLink entry={subject} className="text-sm font-normal">
                  <Trans context="change-history">open</Trans> →
                </EntityLink>
              )
            ))}
        </DialogTitle>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
          {showActor && <span className="text-foreground">{actor.name}</span>}
          {showActor && <span>·</span>}
          {showAction && (
            <>
              <EntryAction entry={entry} />
              <span>·</span>
            </>
          )}
          <span>{formatDate(entry.createdAt, { dateStyle: 'short', timeStyle: 'medium' })}</span>
          {showSource && (
            <>
              <span>·</span>
              <span>
                <Trans context="change-history">Source:</Trans> {actor.source.label}
              </span>
            </>
          )}
          <EntryBadges actor={actor} shown={shown} />
        </div>
        {entry.derivedFrom && (
          <div className="text-sm text-muted-foreground">
            <CausedBy cause={entry.derivedFrom} />
          </div>
        )}
      </DialogHeader>

      <div className="-mx-6 min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-1">
        <UnboundedValues>
          {entry.isCompacted && (
            <div className="flex gap-2 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
              <Info className="h-4 w-4 shrink-0" />
              <Trans context="change-history">
                Detailed values are kept for a limited time; the complete record of this entry is in the archive.
              </Trans>
            </div>
          )}

          {isRun && (
            <>
              {runSubjectEntry(entry) && (
                <ValuesGrid>
                  <GridRow label={<Trans context="change-history">Object</Trans>}>
                    <EntityLink entry={runSubjectEntry(entry)!} />
                  </GridRow>
                </ValuesGrid>
              )}
              <div className="text-sm">
                <RunCounts entry={entry} includeZero separator=" · " />
              </div>
              <RunDetails entry={entry} />
            </>
          )}

          {/* The collection or channel first: a channel operation names it once, above its members. */}
          <Membership entry={entry} />
          {isBatch && (
            <Section
              title={
                <>
                  {labels.typePlural(memberType)}:{' '}
                  {entry.isCompacted ? batchTotal(entry.batchCounts) : entry.batchMembers.totalItems}
                  {Array.isArray(entry.meta?.fields) && entry.meta.fields.length > 0 && (
                    <span className="font-normal text-muted-foreground">
                      {' · '}
                      <BatchSummary entry={entry} />
                    </span>
                  )}
                </>
              }
            >
              {entry.batchMembers.items.length > 0 ? (
                <>
                  <EntryRows entries={entry.batchMembers.items} />
                  <Pager
                    skip={memberSkip}
                    take={LIST_PAGE}
                    total={entry.batchMembers.totalItems}
                    onChange={setMemberSkip}
                  />
                </>
              ) : null}
            </Section>
          )}

          {hasChanges && entry.action === 'created' && <CreatedGrid entityType={entry.entityType} changes={changes} />}
          {hasChanges && entry.action !== 'created' && (
            <FieldChangesTable entityType={entry.entityType} changes={changes} />
          )}
          {!hasChanges && !isRun && !isBatch && hasCounts(entry) && (
            <div className="text-sm">
              <EntryCounts entry={entry} />
            </div>
          )}
          {!hasChanges && !!entry.meta?.noBefore && entry.action === 'updated' && (
            <div className="text-sm text-muted-foreground">
              <Trans context="change-history">details unavailable</Trans>
            </div>
          )}

          {entry.action === 'deleted' && <LastState entry={entry} />}

          {entry.derivedCount > 0 && (
            <Section
              title={
                <>
                  <Trans context="change-history">Derived changes:</Trans> {entry.derivedCount}
                </>
              }
            >
              {entry.derivedEntries.items.length > 0 && (
                <div className="space-y-3">
                  {entry.derivedEntries.items.map((derived) => (
                    <div key={derived.id} className="space-y-1">
                      <div className="text-sm">
                        {labels.type(derived.entityType)}{' '}
                        <EntityLink entry={derived} deletedBadge={derived.action !== 'deleted'} /> ·{' '}
                        <span className="text-muted-foreground">
                          <EntryAction entry={derived} />
                        </span>
                      </div>
                      {derived.changes &&
                        Object.keys(derived.changes).length > 0 &&
                        (derived.action === 'created' ? (
                          <CreatedGrid entityType={derived.entityType} changes={derived.changes} />
                        ) : (
                          <FieldChangesTable
                            entityType={derived.entityType}
                            changes={derived.changes}
                            showHeader={false}
                          />
                        ))}
                    </div>
                  ))}
                  <Pager
                    skip={derivedSkip}
                    take={LIST_PAGE}
                    total={entry.derivedEntries.totalItems}
                    onChange={setDerivedSkip}
                  />
                </div>
              )}
            </Section>
          )}
        </UnboundedValues>
      </div>

      {deleted && (
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onFullHistory}>
            <Trans context="change-history">Full history</Trans>
          </Button>
        </DialogFooter>
      )}
    </>
  );
}

/**
 * What a derived entry follows from — «Caused by: Product «Tee» · assigned to channel» — opening the cause's
 * entry window. Shown only when the reader can see the cause (`derivedFrom` is `null` when it is gone, or of a
 * type they may not read).
 */
export function CausedBy({ cause }: { cause: NonNullable<ChangeHistoryEntryData['derivedFrom']> }) {
  const labels = useLabels();
  const [open, setOpen] = useState(false);
  return (
    <span>
      <Trans context="change-history">Caused by:</Trans>{' '}
      <button
        type="button"
        className="rounded-sm text-left text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        {labels.type(cause.entityType)} «{cause.entityLabel ?? cause.entityId}» · {labels.action(cause.action)}
      </button>
      <EntryDialog entryId={open ? cause.id : undefined} onClose={() => setOpen(false)} />
    </span>
  );
}

/**
 * A window opened from inside another (a cause, «show all») gets no backdrop of its own, so the one beneath
 * steps back instead: a little smaller and dimmed, while the window on top carries a shadow.
 */
const NESTED =
  'transition-[scale] data-[nested-dialog-open]:scale-[0.96] data-[nested-dialog-open]:after:absolute data-[nested-dialog-open]:after:inset-0 data-[nested-dialog-open]:after:rounded-[inherit] data-[nested-dialog-open]:after:bg-black/20 dark:data-[nested-dialog-open]:after:bg-black/50 data-[nested]:shadow-2xl';

/** The entry window: opened from a feed row, a widget line or an entry link. */
export function EntryDialog({ entryId, onClose }: { entryId: string | undefined; onClose: () => void }) {
  const { t } = useLingui();
  const labels = useLabels();
  const focusRef = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<{ entityType: string; entityId: string; label: string } | undefined>();
  const { data } = useQuery({
    queryKey: ['change-history-entry', entryId, 0, 0],
    queryFn: () =>
      api.query(changeHistoryEntryDocument, {
        id: entryId!,
        derivedOptions: { skip: 0, take: LIST_PAGE, sort: { createdAt: 'ASC' } },
        memberOptions: { skip: 0, take: LIST_PAGE, sort: { createdAt: 'ASC' } },
      }),
    enabled: !!entryId,
  });
  const entry = data?.changeHistoryEntry;
  const close = () => {
    setHistory(undefined);
    onClose();
  };
  return (
    <Dialog open={!!entryId} onOpenChange={(open) => !open && close()}>
      {/* The header stays while the body scrolls; focus lands on the header, not on the close button. */}
      <DialogContent
        className={`flex max-h-[85vh] flex-col gap-4 overflow-hidden sm:max-w-4xl ${NESTED}`}
        initialFocus={focusRef}
        showCloseButton={false}
      >
        {entryId && !history && (
          <DialogBody
            entryId={entryId}
            focusRef={focusRef}
            onFullHistory={() => {
              // Only a deleted entity offers its full history (never a batch or a run); its entry may still
              // be loading when the window has just switched to it.
              if (!entry) {
                return;
              }
              setHistory({
                entityType: entry.entityType,
                entityId: entry.entityId,
                label: titleOf(entry, labels).text,
              });
            }}
          />
        )}
        {history && (
          <>
            <DialogHeader ref={focusRef} tabIndex={-1} className="shrink-0 pr-8 outline-none">
              <DialogTitle className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t({ message: 'Back', context: 'change-history' })}
                  title={t({ message: 'Back', context: 'change-history' })}
                  onClick={() => setHistory(undefined)}
                >
                  <ArrowLeft />
                </Button>
                <Trans context="change-history">Full history</Trans> · {history.label}
              </DialogTitle>
            </DialogHeader>
            <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
              <EntityTimeline subject={history} />
            </div>
          </>
        )}
        {/* Core's close button, named in the dashboard's language (core's says «Close» in every language). */}
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute right-4 top-4"
              aria-label={t({ message: 'Close', context: 'change-history' })}
            />
          }
        >
          <X />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
