import { defineDashboardExtension, type DashboardPageBlockDefinition } from '@vendure/dashboard';
import { HistoryBlock, HistoryBlockTitle } from './components/history-block';
import { changeHistoryListRoute } from './routes/change-history-list';
import { RecentChangesWidget, RECENT_CHANGES_WIDGET_ID } from './widgets/recent-changes-widget';

const PERMISSION = 'ReadChangeHistory';

/** «Change history» in the main column, after the page's last core block. */
const block = (id: string, pageId: string, afterBlockId: string): DashboardPageBlockDefinition => ({
  id,
  title: <HistoryBlockTitle />,
  location: { pageId, column: 'main', position: { blockId: afterBlockId, order: 'after' } },
  component: HistoryBlock,
  shouldRender: (context) => !!context.entity,
  requiresPermission: PERMISSION,
});

defineDashboardExtension({
  routes: [changeHistoryListRoute],
  pageBlocks: [
    // A product shows either its variants table or the variant generator; only one of the two renders.
    block('change-history-product', 'product-detail', 'product-variants-table'),
    block('change-history-product-new-variants', 'product-detail', 'generate-variants'),
    block('change-history-product-variant', 'product-variant-detail', 'stock'),
    block('change-history-collection', 'collection-detail', 'contents'),
    block('change-history-facet', 'facet-detail', 'facet-values'),
    block('change-history-promotion', 'promotion-detail', 'actions'),
  ],
  widgets: [
    {
      id: RECENT_CHANGES_WIDGET_ID,
      name: 'Recent changes',
      component: RecentChangesWidget,
      defaultSize: { w: 6, h: 6 },
      minSize: { w: 4, h: 4 },
      requiresPermissions: [PERMISSION],
    },
  ],
});
