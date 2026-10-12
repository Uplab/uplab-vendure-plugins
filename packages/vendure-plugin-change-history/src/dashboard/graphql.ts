import { graphql } from '@vendure/dashboard';
import type { DocumentNode } from 'graphql';
import type { ChangeHistoryDetailData, ChangeHistoryEntryData } from './registry';

// The dashboard's `graphql()` is typed against core's schema only, so these documents carry
// hand-written result types instead. The shape matches `TypedDocumentNode`, which the pages expect.
type TypedDocument<Result, Variables> = DocumentNode & { __apiType?: (variables: Variables) => Result };

const typedDocument = <Result, Variables>(source: string) =>
  (graphql as (source: string) => DocumentNode)(source) as TypedDocument<Result, Variables>;

export interface EntryList {
  items: ChangeHistoryEntryData[];
  totalItems: number;
}

export interface ListOptions {
  skip?: number;
  take?: number;
  sort?: Record<string, 'ASC' | 'DESC'>;
  filter?: Record<string, unknown>;
}

const ENTRY_FIELDS = `
  fragment ChangeHistoryEntryFields on ChangeHistoryEntry {
    id
    createdAt
    entityType
    entityId
    entityLabel
    parentType
    parentId
    action
    source
    actorType
    actorId
    actorLabel
    batchId
    derivedFromId
    changes
    meta
    summary
    compactedAt
    isCompacted
    derivedCount
    batchCounts {
      entityType
      action
      count
    }
    entityDeleted
    parentDeleted
  }
`;

const DETAIL_FIELDS = `
  fragment ChangeHistoryDetailFields on ChangeHistoryDetail {
    id
    entryId
    entityType
    entityId
    entityLabel
    sku
    parentType
    parentId
    kind
    scope
    scopeLabel
    from
    to
  }
`;

/** The feed, and any list of entries (derived entries, batch members, the widget). */
export const changeHistoryEntriesDocument = typedDocument<
  { changeHistoryEntries: EntryList },
  { options?: ListOptions }
>(`
  query ChangeHistoryEntries($options: ChangeHistoryEntryListOptions) {
    changeHistoryEntries(options: $options) {
      items {
        ...ChangeHistoryEntryFields
      }
      totalItems
    }
  }
  ${ENTRY_FIELDS}
`);

/** One entry for the dialog, with a page of its derived entries and of its batch's members. */
export const changeHistoryEntryDocument = typedDocument<
  {
    changeHistoryEntry: (ChangeHistoryEntryData & { derivedEntries: EntryList; batchMembers: EntryList }) | null;
  },
  { id: string; derivedOptions?: ListOptions; memberOptions?: ListOptions }
>(`
  query ChangeHistoryEntry(
    $id: ID!
    $derivedOptions: ChangeHistoryEntryListOptions
    $memberOptions: ChangeHistoryEntryListOptions
  ) {
    changeHistoryEntry(id: $id) {
      ...ChangeHistoryEntryFields
      derivedEntries(options: $derivedOptions) {
        items {
          ...ChangeHistoryEntryFields
        }
        totalItems
      }
      batchMembers(options: $memberOptions) {
        items {
          ...ChangeHistoryEntryFields
        }
        totalItems
      }
    }
  }
  ${ENTRY_FIELDS}
`);

export const changeHistoryEntityTimelineDocument = typedDocument<
  {
    changeHistoryEntityTimeline: {
      items: Array<ChangeHistoryEntryData & { details: ChangeHistoryDetailData[] | null }>;
      endCursor: string | null;
      hasMore: boolean;
    };
  },
  { entityType: string; entityId: string; includeChildren?: boolean; first?: number; after?: string | null }
>(`
  query ChangeHistoryEntityTimeline(
    $entityType: String!
    $entityId: String!
    $includeChildren: Boolean
    $first: Int
    $after: String
  ) {
    changeHistoryEntityTimeline(
      entityType: $entityType
      entityId: $entityId
      includeChildren: $includeChildren
      first: $first
      after: $after
    ) {
      items {
        ...ChangeHistoryEntryFields
        details {
          ...ChangeHistoryDetailFields
        }
        detailsTotal
        detailsEntityCount
      }
      endCursor
      hasMore
    }
  }
  ${ENTRY_FIELDS}
  ${DETAIL_FIELDS}
`);

export const changeHistoryRunDetailsDocument = typedDocument<
  { changeHistoryRunDetails: { items: ChangeHistoryDetailData[]; totalItems: number } },
  { entryId: string; skip?: number; take?: number }
>(`
  query ChangeHistoryRunDetails($entryId: ID!, $skip: Int, $take: Int) {
    changeHistoryRunDetails(entryId: $entryId, skip: $skip, take: $take) {
      items {
        ...ChangeHistoryDetailFields
      }
      totalItems
    }
  }
  ${DETAIL_FIELDS}
`);

export interface FilterOptions {
  actors: Array<{ id: string; type: string; label: string }>;
  sources: string[];
  actions: string[];
  entityTypes: string[];
}

export const changeHistoryFilterOptionsDocument = typedDocument<
  { changeHistoryFilterOptions: FilterOptions },
  Record<string, never>
>(`
  query ChangeHistoryFilterOptions {
    changeHistoryFilterOptions {
      actors {
        id
        type
        label
      }
      sources
      actions
      entityTypes
    }
  }
`);

export interface OperationDefinition {
  code: string;
  description: string;
  args: Array<{ name: string; type: string; list: boolean; label: string | null; ui: Record<string, unknown> | null }>;
}

const operationDefinitionsDocument = <Field extends string>(field: Field) =>
  typedDocument<Record<Field, OperationDefinition[]>, Record<string, never>>(`
    query ChangeHistoryOperationDefinitions_${field} {
      ${field} {
        code
        description
        args {
          name
          type
          list
          label
          ui
        }
      }
    }
  `);

/**
 * The configurable operations a filter, condition or action value can name: each list is read on its own,
 * so a role that may not read one (promotions) still gets the others.
 */
export const operationDefinitionDocuments = {
  collectionFilters: operationDefinitionsDocument('collectionFilters'),
  promotionConditions: operationDefinitionsDocument('promotionConditions'),
  promotionActions: operationDefinitionsDocument('promotionActions'),
};

/** Previews of the assets in an `assets` / `ref` change; a deleted asset is simply missing. */
export const changeHistoryAssetPreviewsDocument = typedDocument<
  { assets: { items: Array<{ id: string; name: string; preview: string }> } },
  { ids: string[] }
>(`
  query ChangeHistoryAssetPreviews($ids: [String!]!) {
    assets(options: { filter: { id: { in: $ids } }, take: 100 }) {
      items {
        id
        name
        preview
      }
    }
  }
`);
