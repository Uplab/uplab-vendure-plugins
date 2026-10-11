import { Trans } from '@lingui/react/macro';
import {
  api,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  keepPreviousData,
  Skeleton,
  useLocalFormat,
  useQuery,
} from '@vendure/dashboard';
import { ArrowLeft, ArrowRight, Info } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { changeHistoryEntryDocument, changeHistoryRunDetailsDocument } from '../graphql';
import type { ChangeHistoryEntryData } from '../registry';
import { ActorBadge, actorOf } from './actor';
import { DetailRows } from './details';
import { DeletedBadge, EntityLink, useEntityRoute } from './entity-link';
import {
  BatchSummary,
  batchSubject,
  EntryAction,
  EntryCounts,
  EntryObject,
  EntrySummary,
  EntryType,
  hasCounts,
  RunCounts,
} from './summary';
import { EntityTimeline } from './timeline';
import { useLabels } from './use-labels';
import { CreatedValues, FieldChangesTable, LastStateValue } from './values';

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
  if (total <= take) {
    return null;
  }
  return (
    <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
      <span>
        {skip + 1}–{Math.min(skip + take, total)} / {total}
      </span>
      <Button variant="outline" size="icon-xs" disabled={skip === 0} onClick={() => onChange(Math.max(0, skip - take))}>
        <ArrowLeft />
      </Button>
      <Button variant="outline" size="icon-xs" disabled={skip + take >= total} onClick={() => onChange(skip + take)}>
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

/** Members of a batch or entries derived from one: the feed's columns, one row each. */
function EntryRows({ entries }: { entries: ChangeHistoryEntryData[] }) {
  const { formatDate } = useLocalFormat();
  return (
    <table className="w-full text-sm">
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id} className="border-b border-border/50 align-top last:border-0">
            <td className="py-1 pr-3 whitespace-nowrap text-muted-foreground">
              {formatDate(entry.createdAt, { timeStyle: 'short' })}
            </td>
            <td className="py-1 pr-3 text-muted-foreground">
              <EntryType entry={entry} />
            </td>
            <td className="py-1 pr-3">
              <EntryObject entry={entry} />
            </td>
            <td className="py-1 pr-3">
              <EntryAction entry={entry} />
            </td>
            <td className="py-1">
              <EntrySummary entry={entry} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunDetails({ entry }: { entry: ChangeHistoryEntryData }) {
  const [skip, setSkip] = useState(0);
  const { data, isLoading } = useQuery({
    queryKey: ['change-history-run-details', entry.id, skip],
    queryFn: () => api.query(changeHistoryRunDetailsDocument, { entryId: entry.id, skip, take: RUN_PAGE }),
    placeholderData: keepPreviousData,
  });
  const page = data?.changeHistoryRunDetails;
  if (isLoading) {
    return <Skeleton className="h-24 w-full" />;
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
    ([, value]) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && !value.length),
  );
  return (
    <Section title={<Trans context="change-history">Last state</Trans>}>
      <dl className="grid grid-cols-[minmax(8rem,1fr)_3fr] gap-x-3 gap-y-1 text-sm">
        {values.map(([key, value]) => {
          const stripped = value && typeof value === 'object' && (value as { stripped?: boolean }).stripped;
          return (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{labels.field(entry.entityType, key)}</dt>
              <dd className="min-w-0 break-words">
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
              </dd>
            </div>
          );
        })}
      </dl>
    </Section>
  );
}

function DialogBody({ entryId, onFullHistory }: { entryId: string; onFullHistory: () => void }) {
  const labels = useLabels();
  const { formatDate } = useLocalFormat();
  const entityRoute = useEntityRoute();
  const [derivedSkip, setDerivedSkip] = useState(0);
  const [memberSkip, setMemberSkip] = useState(0);
  const { data, isLoading, isError, error } = useQuery({
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
    return <Skeleton className="h-32 w-full" />;
  }
  if (isError) {
    return <div className="text-sm text-destructive">{error instanceof Error ? error.message : String(error)}</div>;
  }
  const entry = data?.changeHistoryEntry;
  if (!entry) {
    return (
      <div className="text-sm text-muted-foreground">
        <Trans context="change-history">This entry no longer exists.</Trans>
      </div>
    );
  }
  const actor = actorOf(entry, labels);
  const subject = batchSubject(entry) ?? entry;
  const changes = entry.changes ?? {};
  const hasChanges = Object.keys(changes).length > 0;
  const route = entityRoute(subject);
  const isRun = entry.entityType === 'Run';
  const isBatch = entry.entityType === 'Batch';
  const deleted = entry.entityDeleted || (entry.action === 'deleted' && !isRun && !isBatch);
  return (
    <div className="space-y-5">
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2">
          {isRun ? (
            <span>{actor.name}</span>
          ) : (
            <>
              <span>
                {labels.type(subject.entityType)} «{subject.entityLabel ?? subject.entityId}»
              </span>
              {deleted ? (
                <DeletedBadge />
              ) : (
                route && (
                  <EntityLink entry={subject} className="text-sm font-normal text-primary">
                    <Trans context="change-history">open</Trans> →
                  </EntityLink>
                )
              )}
            </>
          )}
        </DialogTitle>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
          {!isRun && <span className="text-foreground">{actor.name}</span>}
          {!isRun && <span>·</span>}
          <EntryAction entry={entry} />
          <span>·</span>
          <span>{formatDate(entry.createdAt, { dateStyle: 'short', timeStyle: 'medium' })}</span>
          <span>·</span>
          <span>
            <Trans context="change-history">Source:</Trans> {actor.source.label}
          </span>
          <ActorBadge actor={actor} />
        </div>
      </DialogHeader>

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
          <div className="text-sm">
            <RunCounts entry={entry} includeZero separator=" · " />
          </div>
          <RunDetails entry={entry} />
        </>
      )}

      {isBatch && (
        <Section
          title={
            <>
              <EntryAction entry={entry} /> · <BatchSummary entry={entry} />
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

      {hasChanges && entry.action === 'created' && <CreatedValues entityType={entry.entityType} changes={changes} />}
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
                    {labels.type(derived.entityType)} <EntityLink entry={derived} /> ·{' '}
                    <span className="text-muted-foreground">
                      <EntryAction entry={derived} />
                    </span>
                  </div>
                  {derived.changes && Object.keys(derived.changes).length > 0 && (
                    <FieldChangesTable entityType={derived.entityType} changes={derived.changes} showHeader={false} />
                  )}
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

      {deleted && (
        <DialogFooter>
          <Button variant="outline" onClick={onFullHistory}>
            <Trans context="change-history">Full history</Trans>
          </Button>
        </DialogFooter>
      )}
    </div>
  );
}

/** The entry window: opened from a feed row, a widget line or an entry link. */
export function EntryDialog({ entryId, onClose }: { entryId: string | undefined; onClose: () => void }) {
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        {entryId && !history && (
          <DialogBody
            entryId={entryId}
            onFullHistory={() =>
              entry &&
              setHistory({
                entityType: batchSubject(entry)?.entityType ?? entry.entityType,
                entityId: batchSubject(entry)?.entityId ?? entry.entityId,
                label: entry.entityLabel ?? entry.entityId,
              })
            }
          />
        )}
        {history && (
          <div className="space-y-3">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Button variant="ghost" size="icon-sm" onClick={() => setHistory(undefined)}>
                  <ArrowLeft />
                </Button>
                <Trans context="change-history">Full history</Trans> · {history.label}
              </DialogTitle>
            </DialogHeader>
            <EntityTimeline subject={history} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
