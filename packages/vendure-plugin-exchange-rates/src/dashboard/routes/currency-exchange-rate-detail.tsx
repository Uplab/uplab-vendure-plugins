import { Trans, useLingui } from '@lingui/react/macro';
import {
  Badge,
  Button,
  DashboardRouteDefinition,
  DetailFormGrid,
  FormFieldWrapper,
  Input,
  Page,
  PageActionBar,
  PageActionBarRight,
  PageBlock,
  PageLayout,
  PageTitle,
  PermissionGuard,
  Switch,
  detailPageRouteLoader,
  toast,
  useDetailPage,
  useLocalFormat,
} from '@vendure/dashboard';
import { useMemo } from 'react';
import { getCurrencyExchangeRateDetailDocument, updateCurrencyExchangeRateDocument } from '../graphql';

const pageId = 'currency-exchange-rate-detail';

export const currencyExchangeRateDetailRoute: DashboardRouteDefinition = {
  path: '/currency-exchange-rates/$id',
  loader: detailPageRouteLoader({
    pageId,
    queryDocument: getCurrencyExchangeRateDetailDocument,
    breadcrumb: (_isNew, entity) => [
      { path: '/currency-exchange-rates', label: <Trans>Currency exchange rates</Trans> },
      entity?.code ?? '',
    ],
  }),
  component: (route) => <CurrencyExchangeRateDetailPage route={route} />,
};

type Route = Parameters<DashboardRouteDefinition['component']>[0];

function CurrencyExchangeRateDetailPage({ route }: { route: Route }) {
  const { t } = useLingui();
  const params = route.useParams();
  const { formatNumber, formatDate } = useLocalFormat();

  const { form, submitHandler, entity, isPending, resetForm } = useDetailPage({
    pageId,
    entityName: 'CurrencyExchangeRate',
    queryDocument: getCurrencyExchangeRateDetailDocument,
    updateDocument: updateCurrencyExchangeRateDocument,
    setValuesForUpdate: (rate) => ({
      id: rate.id,
      enabled: rate.enabled,
      useCustomRate: rate.useCustomRate,
      customRate: rate.customRate ?? null,
    }),
    params: { id: params.id },
    onSuccess: () => {
      toast.success(t`Currency exchange rate updated`);
      resetForm();
    },
    onError: (error) => {
      toast.error(t`Failed to update currency exchange rate`, {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  const useCustomRate = form.watch('useCustomRate');

  const customRateRules = useMemo(
    () => ({
      validate: (value: number | null | undefined) => {
        if (!form.getValues('useCustomRate')) {
          return true;
        }
        if (!value || value <= 0) {
          return t`Enter a custom rate greater than 0`;
        }
        return true;
      },
    }),
    [form, t],
  );

  return (
    <Page pageId={pageId} form={form} submitHandler={submitHandler} entity={entity}>
      <PageTitle>{entity?.code ?? t`Currency exchange rate`}</PageTitle>
      <PageActionBar>
        <PageActionBarRight>
          <PermissionGuard requires={['UpdateSettings']}>
            <Button type="submit" disabled={!form.formState.isDirty || !form.formState.isValid || isPending}>
              <Trans>Update</Trans>
            </Button>
          </PermissionGuard>
        </PageActionBarRight>
      </PageActionBar>
      <PageLayout>
        <PageBlock
          column="side"
          blockId="currency-exchange-rate-info"
          title={<Trans>Details</Trans>}
          description={<Trans>Reference information for this currency</Trans>}
        >
          <dl className="space-y-3 text-sm">
            <div className="flex flex-col">
              <dt className="text-muted-foreground">
                <Trans>Code</Trans>
              </dt>
              <dd className="font-mono text-base">{entity?.code ?? '\u2014'}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted-foreground">
                <Trans>Base currency</Trans>
              </dt>
              <dd className="font-mono text-base">{entity?.baseCurrency ?? '\u2014'}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted-foreground">
                <Trans>Status</Trans>
              </dt>
              <dd>
                <Badge variant={entity?.enabled ? 'success' : 'secondary'}>
                  {entity?.enabled ? t`Enabled` : t`Disabled`}
                </Badge>
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted-foreground">
                <Trans>Last updated</Trans>
              </dt>
              <dd>{entity?.updatedAt ? formatDate(entity.updatedAt) : '\u2014'}</dd>
            </div>
          </dl>
        </PageBlock>
        <PageBlock column="main" blockId="currency-exchange-rate-form">
          <div className="space-y-6">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                <Trans>Fetched rate</Trans>
              </p>
              <p className="text-2xl font-semibold">{entity ? formatNumber(entity.rate) : '\u2014'}</p>
              {entity && (
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    {entity.baseCurrency} per 1 {entity.code}
                  </Trans>
                </p>
              )}
            </div>
            <DetailFormGrid>
              <FormFieldWrapper
                control={form.control}
                name="enabled"
                label={<Trans>Enabled</Trans>}
                render={({ field }) => <Switch checked={!!field.value} onCheckedChange={field.onChange} />}
              />
              <FormFieldWrapper
                control={form.control}
                name="useCustomRate"
                label={<Trans>Use custom rate</Trans>}
                rules={{ deps: ['customRate'] }}
                render={({ field }) => <Switch checked={!!field.value} onCheckedChange={field.onChange} />}
              />
              <FormFieldWrapper
                control={form.control}
                name="customRate"
                label={<Trans>Custom rate</Trans>}
                description={
                  <Trans>In the same units, used instead of the fetched rate while “Use custom rate” is on</Trans>
                }
                rules={customRateRules}
                render={({ field }) => (
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={field.value ?? ''}
                    onChange={(event) => field.onChange(event.target.value === '' ? null : Number(event.target.value))}
                    disabled={!useCustomRate}
                  />
                )}
              />
            </DetailFormGrid>
          </div>
        </PageBlock>
      </PageLayout>
    </Page>
  );
}
