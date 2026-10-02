import { defineDashboardExtension } from '@vendure/dashboard';
import { UnifiedSlugInput } from './components/unified-slug-input';

// Both detail pages render `slug` inside their `main-form` block.
defineDashboardExtension({
  detailForms: [
    {
      pageId: 'product-detail',
      inputs: [{ blockId: 'main-form', field: 'slug', component: UnifiedSlugInput }],
    },
    {
      pageId: 'collection-detail',
      inputs: [{ blockId: 'main-form', field: 'slug', component: UnifiedSlugInput }],
    },
  ],
});
