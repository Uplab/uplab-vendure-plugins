import { Trans, useLingui } from '@lingui/react/macro';
import {
  api,
  Button,
  DashboardRouteDefinition,
  DateRangePicker,
  FullWidthPageBlock,
  Label,
  Page,
  PageActionBar,
  PageActionBarRight,
  PageLayout,
  PageTitle,
  PaginatedListDataTable,
  Switch,
  useLocalFormat,
  useNavigate,
  useQueryClient,
  type DefinedDateRange,
} from '@vendure/dashboard';
import { X } from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { ActorName, actorOf } from '../components/actor';
import { EntryDialog } from '../components/entry-dialog';
import { QueryError } from '../components/query-error';
import { EntryAction, EntryObject, EntrySummary, EntryType } from '../components/summary';
import { useLabels } from '../components/use-labels';
import {
  actorLabelText,
  actorOptionLabel,
  clampPage,
  encodeActor,
  FEED_QUERY_MARKER,
  feedFilter,
  feedSearchParams,
  parseFeedSearch,
  parseListSearch,
  periodBounds,
  searchFilter,
  splitDateTime,
  titleWhenCut,
  type FeedSearch,
} from '../format';
import {
  changeHistoryEntriesDocument,
  changeHistoryFilterOptionsDocument,
  type FilterOptions,
  type ListOptions,
} from '../graphql';
import { getChangeHistoryRegistry } from '../registry';
import { CHANGE_HISTORY_NAV_ORDER } from '../public';

const pageId = 'change-history-list';

type Route = Parameters<DashboardRouteDefinition['component']>[0];

/** The change history feed under System; filters, switches, period and the open entry live in the URL. */
export const changeHistoryListRoute: DashboardRouteDefinition = {
  path: '/change-history',
  navMenuItem: {
    sectionId: 'system',
    id: 'change-history',
    order: CHANGE_HISTORY_NAV_ORDER,
    // The dashboard translates nav titles by message id, so this is an explicit id (see i18n/*.po).
    title: 'change-history.nav.title',
    requiresPermission: 'ReadChangeHistory',
  },
  loader: () => ({
    breadcrumb: () => <Trans context="change-history">Change history</Trans>,
    title: () => <Trans context="change-history">Change history</Trans>,
  }),
  component: (route) => <ChangeHistoryListPage route={route} />,
};

/**
 * Every field the feed selects, apart from the visible columns, is only an input of their cells. Disabled
 * columns leave the list query: each is selected through the `dependencies` of the cells that read it.
 */
const HIDDEN_FIELDS = [
  'entityId',
  'parentType',
  'parentId',
  'actorType',
  'batchId',
  'derivedFromId',
  'changes',
  'meta',
  'compactedAt',
  'isCompacted',
  'derivedCount',
  'batchCounts',
  'entityDeleted',
  'parentDeleted',
] as const;

/** What a row's cells read; `id` above all — every cell carries it, and a click opens that entry. */
const ROW_FIELDS = [
  'id',
  'entityType',
  'entityId',
  'entityLabel',
  'parentType',
  'parentId',
  'action',
  'source',
  'actorType',
  'actorId',
  'actorLabel',
  'batchId',
  'derivedFromId',
  'changes',
  'meta',
  'isCompacted',
  'derivedCount',
  'batchCounts',
  'entityDeleted',
  'parentDeleted',
] as const;

const SORTED = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

const NO_OPTIONS: FilterOptions = { actors: [], sources: [], actions: [], entityTypes: [] };

/**
 * Every cell carries its row's entry id, so a click anywhere on the row opens the entry whichever columns are
 * shown.
 */
function Cell({
  id,
  className,
  title,
  children,
}: {
  id: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-change-history-entry={id}
      className={className}
      title={title}
      onMouseEnter={title ? undefined : (event) => titleWhenCut(event.currentTarget)}
    >
      {children}
    </div>
  );
}

interface FeedQueryState {
  error?: unknown;
  totalItems?: number;
  fetching: boolean;
}

/**
 * The state of the feed's own list query, read from the query cache (the table runs the query and shows
 * neither its error nor its total): a failed request shows an error with a retry instead of «No results»,
 * and a page past the end is corrected.
 */
function useFeedQueryState(queryClient: ReturnType<typeof useQueryClient>): FeedQueryState & { retry: () => void } {
  const [state, setState] = useState<FeedQueryState>({ fetching: false });
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const read = () => {
      const query = cache
        .findAll({ predicate: (candidate) => candidate.queryKey.includes(FEED_QUERY_MARKER) })
        .filter((candidate) => candidate.getObserversCount() > 0)
        .sort(
          (a, b) => b.state.dataUpdatedAt + b.state.errorUpdatedAt - (a.state.dataUpdatedAt + a.state.errorUpdatedAt),
        )[0];
      const data = query?.state.data as { changeHistoryEntries?: { totalItems?: number } } | undefined;
      const next: FeedQueryState = {
        error: query?.state.status === 'error' ? query.state.error : undefined,
        totalItems: query?.state.status === 'success' ? data?.changeHistoryEntries?.totalItems : undefined,
        fetching: query?.state.fetchStatus === 'fetching',
      };
      setState((previous) =>
        previous.error === next.error && previous.totalItems === next.totalItems && previous.fetching === next.fetching
          ? previous
          : next,
      );
    };
    read();
    // The cache notifies while another component renders (a query is created in its render): read after it.
    let scheduled = false;
    let active = true;
    const unsubscribe = cache.subscribe((event) => {
      if (scheduled || !event.query.queryKey.includes(FEED_QUERY_MARKER)) {
        return;
      }
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (active) {
          read();
        }
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [queryClient]);
  const retry = () =>
    void queryClient.refetchQueries({
      predicate: (candidate) => candidate.queryKey.includes(FEED_QUERY_MARKER),
      type: 'active',
    });
  return { ...state, retry };
}

function ChangeHistoryListPage({ route }: { route: Route }) {
  const { t } = useLingui();
  const labels = useLabels();
  const { formatDate } = useLocalFormat();
  const search = route.useSearch() as Record<string, unknown>;
  const navigate = useNavigate();
  const state = parseFeedSearch(search);

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({ to: '.' as never, search: ((prev: Record<string, unknown>) => ({ ...prev, ...patch })) as never });
  const setState = (patch: Partial<FeedSearch>) => setSearch(feedSearchParams({ ...state, ...patch }));
  const openEntry = (id: string) => setState({ entry: id });
  // A switch or the period changes the rows: back to the first page.
  const setFilters = (patch: Partial<FeedSearch>) =>
    setSearch({ ...feedSearchParams({ ...state, ...patch }), page: undefined });

  const queryClient = useQueryClient();
  // A failed options request: the filters' popovers would say «No results», so the page says what failed.
  const [optionsError, setOptionsError] = useState<unknown>();
  const [optionsAttempt, setOptionsAttempt] = useState(0);

  // The faceted filter reads its options once per `optionsFn`, so each one loads the (cached) options itself.
  const facetedFilters = useMemo(() => {
    const load = () =>
      queryClient
        .fetchQuery({
          queryKey: ['change-history-filter-options'],
          queryFn: () => api.query(changeHistoryFilterOptionsDocument, {}),
          staleTime: 60_000,
          retry: 1,
        })
        .then((result) => {
          setOptionsError(undefined);
          return result.changeHistoryFilterOptions;
        })
        .catch((error: unknown) => {
          // The banner says it failed; the filters offer what the dashboard knows (registered types).
          setOptionsError(error);
          return NO_OPTIONS;
        });
    const sorted = (options: Array<{ value: string; label: string }>) => options.sort(SORTED);
    return {
      entityType: {
        title: t({ message: 'Type', context: 'change-history' }),
        optionsFn: async () => {
          const types = new Set([...(await load()).entityTypes, ...getChangeHistoryRegistry().entityTypes.keys()]);
          return sorted([...types].map((type) => ({ value: type, label: labels.type(type) })));
        },
      },
      action: {
        title: t({ message: 'Action', context: 'change-history' }),
        optionsFn: async () =>
          sorted((await load()).actions.map((action) => ({ value: action, label: labels.action(action) }))),
      },
      source: {
        title: t({ message: 'Source', context: 'change-history' }),
        optionsFn: async () =>
          sorted((await load()).sources.map((source) => ({ value: source, label: labels.source(source).label }))),
      },
      actorId: {
        title: t({ message: 'Who', context: 'change-history' }),
        optionsFn: async () =>
          sorted(
            (await load()).actors.map((actor) => ({
              value: encodeActor(actor.type, actor.id),
              label: actorOptionLabel(actor, labels.source('api_key').label),
            })),
          ),
      },
    };
    // A retry gives the filters new loaders: the faceted filter asks each one once.
  }, [queryClient, labels, t, optionsAttempt]);

  const period: DefinedDateRange | undefined = useMemo(
    () => (state.from && state.to ? { from: new Date(state.from), to: new Date(state.to) } : undefined),
    [state.from, state.to],
  );
  // The picker needs a range to show; without one it shows its own «select a date range» prompt.
  const emptyRange = useMemo(() => ({}) as DefinedDateRange, []);

  const { page, perPage, filters: columnFilters } = parseListSearch(search);
  const feedQuery = useFeedQueryState(queryClient);
  // A page past the end (a stale link, a filter that shrank the list) moves to the last page. The table keeps
  // the page it was opened with, so it opens again, on the last page (its pager then reads «Page 4 of 4»).
  const lastValidPage =
    feedQuery.totalItems !== undefined && !feedQuery.fetching ? clampPage(page, perPage, feedQuery.totalItems) : page;
  const [tableKey, setTableKey] = useState(0);
  useEffect(() => {
    if (lastValidPage !== page) {
      setSearch({ page: lastValidPage });
      setTableKey((key) => key + 1);
    }
    // `setSearch` is a new function on every render; the page numbers are what matters.
  }, [lastValidPage, page]);
  const sorting =
    typeof search.sort === 'string' && search.sort ? parseSort(search.sort) : [{ id: 'createdAt', desc: true }];

  /**
   * A click anywhere on a row opens its entry (every cell carries the id); links and buttons inside the row keep
   * their own action.
   */
  const openRow = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('a, button, input, [role="checkbox"], [role="menuitem"]')) {
      return;
    }
    const cell = target.closest('tr')?.querySelector<HTMLElement>('[data-change-history-entry]');
    const id = cell?.dataset.changeHistoryEntry;
    if (id) {
      openEntry(id);
    }
  };

  return (
    <Page pageId={pageId}>
      <PageTitle>
        <Trans context="change-history">Change history</Trans>
      </PageTitle>
      {/* Left for the items a host registers for this page; the feed's own controls are above the table. */}
      <PageActionBar>
        <PageActionBarRight />
      </PageActionBar>
      <PageLayout>
        <FullWidthPageBlock blockId="list-table">
          {/*
            The period and the switches sit above the table, not in the page's action bar: that bar neither
            wraps nor shrinks, so on a narrow page it pushed over the title, and a phone-sized dashboard drops
            its plain items altogether. Here they wrap under one another, the period first.
          */}
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-1">
              <DateRangePicker
                dateRange={period ?? emptyRange}
                onDateRangeChange={(range) => setFilters(periodBounds(range.from, range.to))}
              />
              {period && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t({ message: 'Clear the period', context: 'change-history' })}
                  title={t({ message: 'Clear the period', context: 'change-history' })}
                  onClick={() => setFilters({ from: undefined, to: undefined })}
                >
                  <X />
                </Button>
              )}
            </div>
            <Label className="flex items-center gap-2 font-normal">
              <Switch
                checked={state.collapseBatches}
                onCheckedChange={(checked: boolean) => setFilters({ collapseBatches: checked })}
              />
              <Trans context="change-history">Collapse bulk operations</Trans>
            </Label>
            <Label className="flex items-center gap-2 font-normal">
              <Switch
                checked={state.hideSystem}
                onCheckedChange={(checked: boolean) => setFilters({ hideSystem: checked })}
              />
              <Trans context="change-history">Hide system changes</Trans>
            </Label>
          </div>
          {!!feedQuery.error && (
            <QueryError
              className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 p-2"
              error={feedQuery.error}
              onRetry={feedQuery.retry}
              retrying={feedQuery.fetching}
            />
          )}
          {!!optionsError && !feedQuery.error && (
            <QueryError
              className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 p-2"
              error={optionsError}
              what="filters"
              onRetry={() => {
                setOptionsError(undefined);
                setOptionsAttempt((attempt) => attempt + 1);
              }}
            />
          )}
          {/* After a failed request the table's «No results» would claim there were no changes: it is hidden. */}
          {/*
            The column widths follow this box (a container query), not the viewport: a host's sidebar and padding
            decide how wide the feed is. Short labels stay on one line where there is room; long ones (a host's
            types, actions and sources) wrap. Every column but the date has a cap per box width («What changed»
            its minimum), and the caps, the date (the header's width below 900 px, where the time goes under the
            date) and the cells' padding add up to no more than the box, so from a 760 px box on the table never
            gets wider than it: 757 px below 900, 883 from 900, 931 from 940, 995 from 1000, 1075 from 1100, then
            1131, 1163, 1211 and 1243 from 1150, 1200, 1250 and 1300. A step changes one of them: keep the sum.
          */}
          <div
            onClick={openRow}
            className={`@container [&_tbody_tr]:cursor-pointer ${feedQuery.error ? '[&_tbody]:hidden' : ''}`}
          >
            <PaginatedListDataTable
              key={tableKey}
              listQuery={changeHistoryEntriesDocument}
              page={lastValidPage}
              itemsPerPage={perPage}
              sorting={sorting}
              columnFilters={columnFilters}
              includeSelectionColumn={false}
              onPageChange={(_table, nextPage, nextPerPage) =>
                (nextPage !== page || nextPerPage !== perPage) && setSearch({ page: nextPage, perPage: nextPerPage })
              }
              onSortChange={(_table, nextSorting) => setSearch({ sort: sortToString(nextSorting) || undefined })}
              onFilterChange={(_table, filters) =>
                JSON.stringify(filters) !== JSON.stringify(columnFilters) &&
                setSearch({ filters: filters.length ? filters : undefined, page: 1 })
              }
              transformQueryKey={(key) => [
                ...key,
                FEED_QUERY_MARKER,
                state.collapseBatches,
                state.hideSystem,
                state.from,
                state.to,
              ]}
              transformVariables={(variables: { options?: ListOptions }) => ({
                ...variables,
                options: { ...variables.options, filter: feedFilter(variables.options?.filter, state) },
              })}
              onSearchTermChange={searchFilter}
              facetedFilters={facetedFilters}
              defaultVisibility={{
                createdAt: true,
                actorLabel: true,
                entityType: true,
                entityLabel: true,
                action: true,
                summary: true,
                source: false,
                actorId: false,
                id: false,
              }}
              defaultColumnOrder={['createdAt', 'actorLabel', 'entityType', 'entityLabel', 'action', 'summary']}
              customizeColumns={{
                ...Object.fromEntries(HIDDEN_FIELDS.map((field) => [field, { meta: { disabled: true } }])),
                // Selected, never shown and not offered in the column settings: a disabled column would leave the
                // list query, and a row without its id opens nothing.
                id: { enableHiding: false, enableSorting: false, enableColumnFilter: false },
                // Core's header («Created at»): the column settings list the column by that name too.
                createdAt: {
                  enableColumnFilter: false,
                  meta: { dependencies: ['id'] },
                  // Below a 900 px table the time goes under the date: each stays whole, the line breaks between them.
                  cell: ({ row }) => {
                    const at = formatDate(row.original.createdAt, { dateStyle: 'short', timeStyle: 'short' });
                    const parts = splitDateTime(at, formatDate(row.original.createdAt, { timeStyle: 'short' }));
                    return (
                      <Cell id={row.original.id}>
                        <button
                          type="button"
                          className="whitespace-normal text-left text-muted-foreground hover:underline @min-[900px]:whitespace-nowrap"
                          onClick={() => openEntry(row.original.id)}
                        >
                          {parts ? (
                            <>
                              <span className="whitespace-nowrap">{parts[0]}</span>{' '}
                              <span className="whitespace-nowrap">{parts[1]}</span>
                            </>
                          ) : (
                            at
                          )}
                        </button>
                      </Cell>
                    );
                  },
                },
                actorLabel: {
                  header: () => <Trans context="change-history">Who</Trans>,
                  enableColumnFilter: false,
                  meta: { dependencies: [...ROW_FIELDS] },
                  // A long name («Odoo: stock refresh after an order») takes two lines, the whole name in the tooltip.
                  cell: ({ row }) => {
                    const actor = actorOf(row.original, labels);
                    return (
                      <Cell
                        id={row.original.id}
                        className="min-w-[6rem] max-w-[7rem] whitespace-normal @min-[900px]:max-w-[8rem] @min-[1000px]:max-w-[9rem] @min-[1100px]:min-w-[8rem] @min-[1100px]:max-w-[12rem]"
                        title={actor.name}
                      >
                        <ActorName actor={actor} className="max-w-full" wrap />
                      </Cell>
                    );
                  },
                },
                entityType: {
                  header: () => <Trans context="change-history">Type</Trans>,
                  enableSorting: false,
                  meta: { dependencies: [...ROW_FIELDS] },
                  cell: ({ row }) => (
                    <Cell
                      id={row.original.id}
                      className="min-w-[5rem] max-w-[6.5rem] whitespace-normal break-words @min-[900px]:max-w-[7rem] @min-[1000px]:max-w-[7.5rem] @min-[1150px]:max-w-[11rem]"
                    >
                      <EntryType entry={row.original} />
                    </Cell>
                  ),
                },
                entityLabel: {
                  header: () => <Trans context="change-history">Object</Trans>,
                  enableColumnFilter: false,
                  meta: { dependencies: [...ROW_FIELDS] },
                  // Long names are cut — a variant's name, not its SKU — the whole name in the tooltip. From a
                  // 940 px table on, a normal SKU stays whole beside a «Deleted» badge, in English or Ukrainian.
                  cell: ({ row }) => (
                    <Cell
                      id={row.original.id}
                      className="flex min-w-0 max-w-[8rem] @min-[900px]:max-w-[11rem] @min-[940px]:max-w-[14rem] @min-[1300px]:max-w-[16rem]"
                      title={row.original.entityLabel ?? undefined}
                    >
                      <EntryObject entry={row.original} cut />
                    </Cell>
                  ),
                },
                action: {
                  header: () => <Trans context="change-history">Action</Trans>,
                  enableSorting: false,
                  meta: { dependencies: [...ROW_FIELDS] },
                  cell: ({ row }) => (
                    <Cell
                      id={row.original.id}
                      className="min-w-[6rem] max-w-[6.5rem] whitespace-normal break-words @min-[900px]:max-w-[7.5rem] @min-[1000px]:max-w-[8rem] @min-[1100px]:max-w-[10rem] @min-[1250px]:max-w-[13rem]"
                    >
                      <EntryAction entry={row.original} />
                    </Cell>
                  ),
                },
                summary: {
                  header: () => <Trans context="change-history">What changed</Trans>,
                  enableColumnFilter: false,
                  enableSorting: false,
                  meta: { dependencies: [...ROW_FIELDS] },
                  // The table cells do not wrap: this column alone does, takes the width the compact columns
                  // leave and shows up to three lines, the whole text in the tooltip when it is longer. A run of
                  // text held together by no-break spaces («Price: 1,299.00 → 1,399.00») breaks inside only when
                  // it is wider than the column, and so does a badge («Derived changes: 5»): neither sets the
                  // table's width.
                  cell: ({ row }) => (
                    <Cell
                      id={row.original.id}
                      className="line-clamp-3 min-w-[7rem] whitespace-normal wrap-anywhere [&_[data-slot=badge]]:h-auto [&_[data-slot=badge]]:whitespace-normal @min-[900px]:min-w-[8rem] @min-[1000px]:min-w-[10rem] @min-[1200px]:min-w-[12rem]"
                    >
                      <EntrySummary entry={row.original} />
                    </Cell>
                  ),
                },
                source: {
                  header: () => <Trans context="change-history">Source</Trans>,
                  enableSorting: false,
                  meta: { dependencies: ['id', 'actorType'] },
                  cell: ({ row }) => (
                    <Cell id={row.original.id}>{labels.source(row.original.source, row.original.actorType).label}</Cell>
                  ),
                },
                // Only the «Who» filter's column: never shown, and not offered in the column settings (the
                // «Who» column above shows the same person).
                actorId: {
                  header: () => <Trans context="change-history">Who</Trans>,
                  enableSorting: false,
                  enableHiding: false,
                  meta: { dependencies: ['id', 'actorType', 'actorLabel'] },
                  cell: ({ row }) => (
                    <Cell id={row.original.id}>
                      {actorLabelText(row.original.actorType, row.original.actorLabel) ?? '—'}
                    </Cell>
                  ),
                },
              }}
            />
          </div>
        </FullWidthPageBlock>
      </PageLayout>
      <EntryDialog entryId={state.entry} onClose={() => setState({ entry: undefined })} />
    </Page>
  );
}

function parseSort(sort: string) {
  return sort
    .split(',')
    .filter(Boolean)
    .map((part) => ({ id: part.replace(/^-/, ''), desc: part.startsWith('-') }));
}

function sortToString(sorting: Array<{ id: string; desc: boolean }>) {
  return sorting.map((sort) => `${sort.desc ? '-' : ''}${sort.id}`).join(',');
}
