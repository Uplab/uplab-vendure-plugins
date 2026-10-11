import { Trans, useLingui } from '@lingui/react/macro';
import {
  api,
  Button,
  DashboardBaseWidget,
  Link,
  Skeleton,
  useLocalFormat,
  useQuery,
  useWidgetFilters,
} from '@vendure/dashboard';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ActorName, actorOf } from '../components/actor';
import { EntryDialog } from '../components/entry-dialog';
import { EntryAction, EntryObject, EntrySummary } from '../components/summary';
import { useLabels } from '../components/use-labels';
import { feedFilter, feedSearchParams, periodBounds } from '../format';
import { changeHistoryEntriesDocument } from '../graphql';

export const RECENT_CHANGES_WIDGET_ID = 'change-history-recent';

/**
 * «Recent changes» on the Insights page: the last 10 rows of what the feed shows by default (batches and
 * runs one row each, derived rows hidden, system rows included) within the page's date range.
 */
export function RecentChangesWidget() {
  const { t } = useLingui();
  const labels = useLabels();
  const { formatDate } = useLocalFormat();
  const { dateRange } = useWidgetFilters();
  const [entryId, setEntryId] = useState<string>();
  // Whole days: the Insights picker gives local midnights, which would leave the last day out.
  const { from, to } = periodBounds(dateRange.from, dateRange.to);
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['change-history-recent', from, to],
    queryFn: () =>
      api.query(changeHistoryEntriesDocument, {
        options: {
          take: 10,
          sort: { createdAt: 'DESC' },
          filter: feedFilter(undefined, { collapseBatches: true, hideSystem: false, from, to }),
        },
      }),
  });
  const items = data?.changeHistoryEntries.items ?? [];
  return (
    <DashboardBaseWidget
      id={RECENT_CHANGES_WIDGET_ID}
      title={t({ message: 'Recent changes', context: 'change-history' })}
      actions={
        <Button variant="ghost" size="icon-sm" disabled={isFetching} onClick={() => refetch()}>
          <RefreshCw className={isFetching ? 'animate-spin' : undefined} />
        </Button>
      }
    >
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading && <Skeleton className="h-24 w-full" />}
          {!isLoading && items.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              <Trans context="change-history">No changes in this period.</Trans>
            </div>
          )}
          <ul className="divide-y">
            {items.map((entry) => {
              const actor = actorOf(entry, labels);
              return (
                <li
                  key={entry.id}
                  className={`flex cursor-pointer gap-3 px-1 py-1.5 text-sm hover:bg-muted/40 ${actor.tone === 'system' ? 'bg-muted/20' : ''}`}
                  onClick={() => setEntryId(entry.id)}
                >
                  <span className="w-12 shrink-0 text-muted-foreground">
                    {formatDate(
                      entry.createdAt,
                      new Date(entry.createdAt).toDateString() === new Date().toDateString()
                        ? { timeStyle: 'short' }
                        : { day: '2-digit', month: '2-digit' },
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <ActorName actor={actor} className="font-medium" />
                      {entry.entityType !== 'Run' && (
                        <>
                          <span className="text-muted-foreground">·</span>
                          <span className="truncate">
                            <EntryObject entry={entry} />
                          </span>
                        </>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      <EntryAction entry={entry} /> · <EntrySummary entry={entry} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="pt-2 text-right">
          <Link
            to={'/change-history' as never}
            search={feedSearchParams({ collapseBatches: true, hideSystem: false, from, to }) as never}
            className="text-sm text-primary hover:underline"
          >
            <Trans context="change-history">All changes</Trans> →
          </Link>
        </div>
      </div>
      <EntryDialog entryId={entryId} onClose={() => setEntryId(undefined)} />
    </DashboardBaseWidget>
  );
}
