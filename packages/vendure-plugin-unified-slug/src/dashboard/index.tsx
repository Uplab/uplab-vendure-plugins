import { defineDashboardExtension } from '@vendure/dashboard';
import { UnifiedSlugInput } from './components/unified-slug-input';

/**
 * Replaces the per-language slug field on the product and collection detail pages with a single one.
 *
 * Core wraps every translatable field in an `OverriddenFormComponent` keyed by `pageId` + `blockId` +
 * field name (`@vendure/dashboard/src/lib/framework/form-engine/overridden-form-component.tsx`), and
 * both detail pages render `slug` inside the `main-form` block.
 */
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
