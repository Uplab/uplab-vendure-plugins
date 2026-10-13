import { useLingui } from '@lingui/react';
import { usePage } from '@vendure/dashboard';
import { EntityTimeline } from './timeline';

/** The detail pages that get the block, and the entity type each one shows. */
const BLOCK_PAGES: Record<string, string> = {
  'product-detail': 'Product',
  'product-variant-detail': 'ProductVariant',
  'collection-detail': 'Collection',
  'facet-detail': 'Facet',
  'promotion-detail': 'Promotion',
  'asset-detail': 'Asset',
  'facet-value-detail': 'FacetValue',
};

const BLOCK_TITLE = { id: 'change-history.block.title', message: 'Change history' };

/** «Історія змін» — an explicit id: the feed's title has the same English text but another translation. */
export function HistoryBlockTitle() {
  const { i18n } = useLingui();
  return <>{i18n._(BLOCK_TITLE)}</>;
}

interface PageEntity {
  id: string;
  updatedAt?: string;
}

/** «Change history» at the bottom of a detail page; nothing on a page creating a new entity. */
export function HistoryBlock() {
  const { pageId, entity } = usePage() as { pageId?: string; entity?: PageEntity };
  const entityType = pageId ? BLOCK_PAGES[pageId] : undefined;
  if (!entityType || !entity?.id) {
    return null;
  }
  // `updatedAt` changes with every save of the page, which loads the history again.
  return <EntityTimeline subject={{ entityType, entityId: String(entity.id) }} refreshKey={entity.updatedAt} />;
}
