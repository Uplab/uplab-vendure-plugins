import { defineDashboardExtension } from '@vendure/dashboard';
import { changeHistoryListRoute } from './routes/change-history-list';

defineDashboardExtension({
  routes: [changeHistoryListRoute],
});
