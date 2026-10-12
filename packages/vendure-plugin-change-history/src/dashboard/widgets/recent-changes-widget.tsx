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
import { useState, type MouseEvent } from 'react';
import { ActorName, actorOf } from '../components/actor';
import { EntryDialog } from '../components/entry-dialog';
import { QueryError } from '../components/query-error';
import { EntryAction, EntryObject, EntrySummary, EntryType } from '../components/summary';
import { useLabels } from '../components/use-labels';
import { feedFilter, feedSearchParams, periodBounds, titleWhenCut } from '../format';
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
  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
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
  const isToday = (createdAt: string) => new Date(createdAt).toDateString() === new Date().toDateString();
  return (
    <DashboardBaseWidget
      id={RECENT_CHANGES_WIDGET_ID}
      title={t({ message: 'Recent changes', context: 'change-history' })}
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t({ message: 'Refresh', context: 'change-history' })}
          title={t({ message: 'Refresh', context: 'change-history' })}
          disabled={isFetching}
          onClick={() => refetch()}
        >
          <RefreshCw className={isFetching ? 'animate-spin' : undefined} />
        </Button>
      }
    >
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading && <Skeleton className="h-24 w-full" />}
          {isError && (
            <QueryError className="justify-center py-6" error={error} onRetry={() => refetch()} retrying={isFetching} />
          )}
          {!isLoading && !isError && items.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              <Trans context="change-history">No changes in this period.</Trans>
            </div>
          )}
          {/* The time column is as wide as its longest time in the dashboard's language («08:55», «10:10 AM»,
              «12.10, 08:55»): the lines share it as a subgrid. */}
          <ul className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 divide-y">
            {items.map((entry) => {
              const actor = actorOf(entry, labels);
              const open = (event: MouseEvent) => {
                event.stopPropagation();
                setEntryId(entry.id);
              };
              return (
                <li
                  key={entry.id}
                  className={`col-span-2 grid cursor-pointer grid-cols-subgrid gap-x-3 px-1 py-1.5 text-sm hover:bg-muted/40 ${actor.tone === 'system' ? 'bg-muted/20' : ''}`}
                  onClick={open}
                >
                  {/* Today's changes by time; older ones by day and time, so one day's changes stay apart. The
                      time opens the entry from the keyboard too, as in the feed. */}
                  <button
                    type="button"
                    className="self-start whitespace-nowrap rounded-sm text-left text-xs leading-5 tabular-nums text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={open}
                  >
                    {formatDate(
                      entry.createdAt,
                      isToday(entry.createdAt)
                        ? { timeStyle: 'short' }
                        : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' },
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <ActorName actor={actor} className="font-medium" />
                      <span className="text-muted-foreground">·</span>
                      {/* «Collection Sale», not just «Sale»: the type tells a collection from a promotion. */}
                      <span className="shrink-0 text-muted-foreground">
                        <EntryType entry={entry} />
                      </span>
                      <span className="flex min-w-0">
                        <EntryObject entry={entry} cut />
                      </span>
                    </div>
                    {/* Up to two lines of what changed, the whole line in the tooltip when it is longer. */}
                    <div
                      className="line-clamp-2 break-words text-xs text-muted-foreground"
                      onMouseEnter={(event) => titleWhenCut(event.currentTarget)}
                    >
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
