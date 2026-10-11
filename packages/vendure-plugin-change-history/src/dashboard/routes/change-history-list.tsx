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
  PageActionBarLeft,
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
import { useMemo, type MouseEvent, type ReactNode } from 'react';
import { ActorName, actorOf } from '../components/actor';
import { EntryDialog } from '../components/entry-dialog';
import { EntryAction, EntryObject, EntrySummary, EntryType } from '../components/summary';
import { useLabels } from '../components/use-labels';
import {
  encodeActor,
  feedFilter,
  feedSearchParams,
  parseFeedSearch,
  parseListSearch,
  periodBounds,
  type FeedSearch,
} from '../format';
import { changeHistoryEntriesDocument, changeHistoryFilterOptionsDocument, type ListOptions } from '../graphql';
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

/** Every field the feed selects, apart from the visible columns, is only an input of their cells. */
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

const ROW_FIELDS = [
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
    <div data-change-history-entry={id} className={className} title={title}>
      {children}
    </div>
  );
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
  // A switch or the period changes the rows: back to the first page.
  const setFilters = (patch: Partial<FeedSearch>) =>
    setSearch({ ...feedSearchParams({ ...state, ...patch }), page: undefined });

  const queryClient = useQueryClient();

  // The faceted filter reads its options once per `optionsFn`, so each one loads the (cached) options itself.
  const facetedFilters = useMemo(() => {
    const load = () =>
      queryClient
        .fetchQuery({
          queryKey: ['change-history-filter-options'],
          queryFn: () => api.query(changeHistoryFilterOptionsDocument, {}),
          staleTime: 60_000,
        })
        .then((result) => result.changeHistoryFilterOptions);
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
              label: actor.type === 'api_key' ? `${actor.label} (${labels.source('api_key').label})` : actor.label,
            })),
          ),
      },
    };
  }, [queryClient, labels, t]);

  const period: DefinedDateRange | undefined = useMemo(
    () => (state.from && state.to ? { from: new Date(state.from), to: new Date(state.to) } : undefined),
    [state.from, state.to],
  );
  // The picker needs a range to show; without one it shows its own «select a date range» prompt.
  const emptyRange = useMemo(() => ({}) as DefinedDateRange, []);

  const { page, perPage, filters: columnFilters } = parseListSearch(search);
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
      setState({ entry: id });
    }
  };

  return (
    <Page pageId={pageId}>
      <PageTitle>
        <Trans context="change-history">Change history</Trans>
      </PageTitle>
      <PageActionBar>
        <PageActionBarLeft>
          <div className="flex items-center gap-1">
            <DateRangePicker
              dateRange={period ?? emptyRange}
              onDateRangeChange={(range) => setFilters(periodBounds(range.from, range.to))}
            />
            {period && (
              <Button
                variant="ghost"
                size="icon-sm"
                title={t({ message: 'Clear the period', context: 'change-history' })}
                onClick={() => setFilters({ from: undefined, to: undefined })}
              >
                <X />
              </Button>
            )}
          </div>
        </PageActionBarLeft>
        <PageActionBarRight>
          <div className="flex flex-wrap items-center gap-4">
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
        </PageActionBarRight>
      </PageActionBar>
      <PageLayout>
        <FullWidthPageBlock blockId="list-table">
          <div onClick={openRow} className="[&_tbody_tr]:cursor-pointer">
            <PaginatedListDataTable
              listQuery={changeHistoryEntriesDocument}
              page={page}
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
              transformQueryKey={(key) => [...key, state.collapseBatches, state.hideSystem, state.from, state.to]}
              transformVariables={(variables: { options?: ListOptions }) => ({
                ...variables,
                options: { ...variables.options, filter: feedFilter(variables.options?.filter, state) },
              })}
              onSearchTermChange={(term) => (term ? { entityLabel: { contains: term } } : {})}
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
              }}
              defaultColumnOrder={['createdAt', 'actorLabel', 'entityType', 'entityLabel', 'action', 'summary']}
              customizeColumns={{
                ...Object.fromEntries(HIDDEN_FIELDS.map((field) => [field, { meta: { disabled: true } }])),
                createdAt: {
                  header: () => <Trans context="change-history">Time</Trans>,
                  enableColumnFilter: false,
                  cell: ({ row }) => (
                    <Cell id={row.original.id}>
                      <button
                        type="button"
                        className="whitespace-nowrap text-muted-foreground hover:underline"
                        onClick={() => setState({ entry: row.original.id })}
                      >
                        {formatDate(row.original.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                      </button>
                    </Cell>
                  ),
                },
                actorLabel: {
                  header: () => <Trans context="change-history">Who</Trans>,
                  enableColumnFilter: false,
                  meta: { dependencies: [...ROW_FIELDS] },
                  cell: ({ row }) => (
                    <Cell id={row.original.id} className="whitespace-nowrap">
                      <ActorName actor={actorOf(row.original, labels)} />
                    </Cell>
                  ),
                },
                entityType: {
                  header: () => <Trans context="change-history">Type</Trans>,
                  enableSorting: false,
                  meta: { dependencies: [...ROW_FIELDS] },
                  cell: ({ row }) => (
                    <Cell id={row.original.id} className="whitespace-nowrap">
                      <EntryType entry={row.original} />
                    </Cell>
                  ),
                },
                entityLabel: {
                  header: () => <Trans context="change-history">Object</Trans>,
                  enableColumnFilter: false,
                  meta: { dependencies: [...ROW_FIELDS] },
                  // Long names (a variant with its SKU) are cut, the whole name in the tooltip.
                  cell: ({ row }) => (
                    <Cell
                      id={row.original.id}
                      className="max-w-[16rem] truncate"
                      title={row.original.entityLabel ?? undefined}
                    >
                      <EntryObject entry={row.original} />
                    </Cell>
                  ),
                },
                action: {
                  header: () => <Trans context="change-history">Action</Trans>,
                  enableSorting: false,
                  meta: { dependencies: [...ROW_FIELDS] },
                  cell: ({ row }) => (
                    <Cell id={row.original.id} className="max-w-[12rem] truncate">
                      <EntryAction entry={row.original} />
                    </Cell>
                  ),
                },
                summary: {
                  header: () => <Trans context="change-history">What changed</Trans>,
                  enableColumnFilter: false,
                  enableSorting: false,
                  meta: { dependencies: [...ROW_FIELDS] },
                  cell: ({ row }) => (
                    <Cell id={row.original.id} className="min-w-[12rem] max-w-xl truncate">
                      <EntrySummary entry={row.original} />
                    </Cell>
                  ),
                },
                source: {
                  header: () => <Trans context="change-history">Source</Trans>,
                  enableSorting: false,
                  cell: ({ row }) => (
                    <Cell id={row.original.id}>{labels.source(row.original.source, row.original.actorType).label}</Cell>
                  ),
                },
                actorId: {
                  header: () => <Trans context="change-history">Who</Trans>,
                  enableSorting: false,
                  meta: { dependencies: ['actorType', 'actorLabel'] },
                  cell: ({ row }) => <Cell id={row.original.id}>{row.original.actorLabel ?? '—'}</Cell>,
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
