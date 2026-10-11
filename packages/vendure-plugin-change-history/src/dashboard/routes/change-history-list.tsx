import { Trans } from '@lingui/react/macro';
import { DashboardRouteDefinition, ListPage, useLocalFormat } from '@vendure/dashboard';
import { changeHistoryEntriesDocument } from '../graphql';
import { CHANGE_HISTORY_NAV_ORDER } from '../public';

const pageId = 'change-history-list';

/**
 * The change history feed. A first version: the plain list of entries, newest first; filters, labels
 * from the registries and the entry dialog come with the full dashboard.
 */
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

function ChangeHistoryListPage({ route }: { route: Parameters<DashboardRouteDefinition['component']>[0] }) {
  const { formatDate } = useLocalFormat();

  return (
    <ListPage
      pageId={pageId}
      title={<Trans context="change-history">Change history</Trans>}
      listQuery={changeHistoryEntriesDocument}
      route={route}
      defaultSort={[{ id: 'createdAt', desc: true }]}
      defaultVisibility={{
        createdAt: true,
        entityType: true,
        entityLabel: true,
        action: true,
        actorLabel: true,
        summary: true,
        entityId: false,
        source: false,
        actorType: false,
      }}
      defaultColumnOrder={['createdAt', 'entityType', 'entityLabel', 'action', 'actorLabel', 'summary']}
      onSearchTermChange={(term) => (term ? { entityLabel: { contains: term } } : {})}
      customizeColumns={{
        createdAt: {
          header: () => <Trans context="change-history">When</Trans>,
          cell: ({ row }) => formatDate(row.original.createdAt, { dateStyle: 'short', timeStyle: 'short' }),
        },
        entityType: {
          header: () => <Trans context="change-history">Type</Trans>,
        },
        entityLabel: {
          header: () => <Trans context="change-history">Entity</Trans>,
          cell: ({ row }) => row.original.entityLabel ?? row.original.entityId,
        },
        action: {
          header: () => <Trans context="change-history">Action</Trans>,
        },
        actorLabel: {
          header: () => <Trans context="change-history">Who</Trans>,
          cell: ({ row }) => row.original.actorLabel ?? row.original.source,
        },
        summary: {
          header: () => <Trans context="change-history">Summary</Trans>,
        },
      }}
    />
  );
}
