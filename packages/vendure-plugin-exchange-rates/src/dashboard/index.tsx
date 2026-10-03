import { defineDashboardExtension } from '@vendure/dashboard';
import { currencyExchangeRateDetailRoute } from './routes/currency-exchange-rate-detail';
import { currencyExchangeRateListRoute } from './routes/currency-exchange-rate-list';

defineDashboardExtension({
  routes: [currencyExchangeRateListRoute, currencyExchangeRateDetailRoute],
});
