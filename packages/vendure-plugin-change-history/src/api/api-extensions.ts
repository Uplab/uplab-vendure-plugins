import gql from 'graphql-tag';

type Document = ReturnType<typeof gql>;

// `entityType`, `action` and `source` are strings, not enums: hosts add their own values without a
// schema change, and the dashboard labels them.
export const adminApiExtensions: Document = gql`
  type ChangeHistoryEntry implements Node {
    id: ID!
    createdAt: DateTime!
    entityType: String!
    entityId: String!
    entityLabel: String
    parentType: String
    parentId: String
    action: String!
    source: String!
    actorType: String!
    actorId: ID
    actorLabel: String
    batchId: String
    channelId: ID
    derivedFromId: ID
    changes: JSON
    meta: JSON!
    summary: String!
    compactedAt: DateTime
  }

  type ChangeHistoryEntryList implements PaginatedList {
    items: [ChangeHistoryEntry!]!
    totalItems: Int!
  }

  input ChangeHistoryEntryListOptions

  extend type Query {
    changeHistoryEntries(options: ChangeHistoryEntryListOptions): ChangeHistoryEntryList!
  }
`;
