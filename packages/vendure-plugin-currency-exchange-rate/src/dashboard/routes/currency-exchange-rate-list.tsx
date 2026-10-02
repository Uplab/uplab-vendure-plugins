import { Trans, useLingui } from '@lingui/react/macro';
import { Badge, DashboardRouteDefinition, DetailPageButton, ListPage, useLocalFormat } from '@vendure/dashboard';
import { useMemo } from 'react';
import { getCurrencyExchangeRateListDocument } from '../graphql';

const pageId = 'currency-exchange-rate-list';

export const currencyExchangeRateListRoute: DashboardRouteDefinition = {
  path: '/currency-exchange-rates',
  navMenuItem: {
    sectionId: 'settings',
    id: 'currency-exchange-rates',
    title: 'Currency exchange rates',
    requiresPermission: 'ReadSettings',
  },
  loader: () => ({
    breadcrumb: () => <Trans>Currency exchange rates</Trans>,
    title: () => <Trans>Currency exchange rates</Trans>,
  }),
  component: (route) => <CurrencyExchangeRateListPage route={route} />,
};

function CurrencyExchangeRateListPage({ route }: { route: Parameters<DashboardRouteDefinition['component']>[0] }) {
  const { t } = useLingui();
  const { formatNumber, formatDate } = useLocalFormat();

  const booleanOptions = useMemo(
    () => [
      { value: true, label: t`Enabled` },
      { value: false, label: t`Disabled` },
    ],
    [t],
  );

  return (
    <ListPage
      pageId={pageId}
      title={<Trans>Currency exchange rates</Trans>}
      listQuery={getCurrencyExchangeRateListDocument}
      route={route}
      defaultSort={[{ id: 'code', desc: false }]}
      defaultVisibility={{
        code: true,
        rate: true,
        enabled: true,
        useCustomRate: true,
        updatedAt: true,
      }}
      defaultColumnOrder={['code', 'rate', 'enabled', 'useCustomRate', 'updatedAt']}
      onSearchTermChange={(term) => (term ? { code: { contains: term } } : {})}
      facetedFilters={{
        enabled: {
          title: t`Enabled`,
          options: booleanOptions,
        },
        useCustomRate: {
          title: t`Custom rate`,
          options: booleanOptions,
        },
      }}
      customizeColumns={{
        code: {
          cell: ({ row }) => <DetailPageButton id={row.original.id} label={row.original.code} />,
        },
        rate: {
          meta: { dependencies: ['customRate', 'useCustomRate'] },
          cell: ({ row }) => {
            const value = row.original.useCustomRate
              ? (row.original.customRate ?? row.original.rate)
              : row.original.rate;
            return <span>{formatNumber(value ?? 0)}</span>;
          },
        },
        enabled: {
          cell: ({ row }) => (
            <Badge variant={row.original.enabled ? 'success' : 'secondary'}>
              {row.original.enabled ? t`Enabled` : t`Disabled`}
            </Badge>
          ),
        },
        useCustomRate: {
          cell: ({ row }) => (
            <Badge variant={row.original.useCustomRate ? 'success' : 'secondary'}>
              {row.original.useCustomRate ? t`Using custom rate` : t`Fetched rate`}
            </Badge>
          ),
        },
        updatedAt: {
          cell: ({ row }) => formatDate(row.original.updatedAt),
        },
      }}
    />
  );
}
