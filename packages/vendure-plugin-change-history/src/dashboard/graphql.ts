import { graphql } from '@vendure/dashboard';
import type { DocumentNode } from 'graphql';

// The dashboard's `graphql()` is typed against core's schema only, so these documents carry
// hand-written result types instead. The shape matches `TypedDocumentNode`, which the pages expect.
type TypedDocument<Result, Variables> = DocumentNode & { __apiType?: (variables: Variables) => Result };

const typedDocument = <Result, Variables>(source: string) =>
  (graphql as (source: string) => DocumentNode)(source) as TypedDocument<Result, Variables>;

export interface ChangeHistoryFeedRow {
  id: string;
  createdAt: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  action: string;
  source: string;
  actorType: string;
  actorLabel: string | null;
  summary: string;
}

export const changeHistoryEntriesDocument = typedDocument<
  { changeHistoryEntries: { items: ChangeHistoryFeedRow[]; totalItems: number } },
  { options?: Record<string, unknown> }
>(`
  query ChangeHistoryEntries($options: ChangeHistoryEntryListOptions) {
    changeHistoryEntries(options: $options) {
      items {
        id
        createdAt
        entityType
        entityId
        entityLabel
        action
        source
        actorType
        actorLabel
        summary
      }
      totalItems
    }
  }
`);
