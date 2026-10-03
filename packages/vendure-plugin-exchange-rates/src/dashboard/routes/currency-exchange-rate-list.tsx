import { Trans, useLingui } from '@lingui/react/macro';
import { Badge, DashboardRouteDefinition, DetailPageButton, ListPage, useLocalFormat } from '@vendure/dashboard';
import { useMemo } from 'react';
import { formatRate } from '../format-rate';
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
  const { t, i18n } = useLingui();
  const { formatDate } = useLocalFormat();

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
        // Shown inside the rate cell.
        baseCurrency: false,
        customRate: false,
        // The dashboard pins `updatedAt` to the front; the detail page shows it instead.
        updatedAt: false,
      }}
      defaultColumnOrder={['code', 'rate', 'enabled', 'useCustomRate']}
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
          meta: { dependencies: ['customRate', 'useCustomRate', 'baseCurrency'] },
          cell: ({ row }) => {
            const value = row.original.useCustomRate
              ? (row.original.customRate ?? row.original.rate)
              : row.original.rate;
            return (
              <span>
                {formatRate(i18n.locale, value ?? 0)}{' '}
                <span className="text-muted-foreground">{row.original.baseCurrency}</span>
              </span>
            );
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
          header: () => <Trans>Custom rate</Trans>,
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
