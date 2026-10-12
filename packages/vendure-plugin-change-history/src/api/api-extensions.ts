import gql from 'graphql-tag';

type Document = ReturnType<typeof gql>;

// `entityType`, `action` and `source` are strings, not enums: hosts add their own values without a
// schema change, and the dashboard labels them.
export const adminApiExtensions: Document = gql`
  type ChangeHistoryEntry implements Node {
    id: ID!
    createdAt: DateTime!
    entityType: String!
    "The database id as stored (a string for every id strategy)."
    entityId: String!
    "The entity's name when the change was recorded (a variant's with its SKU). Null for a batch recorded without a label: name it by meta.kind."
    entityLabel: String
    parentType: String
    parentId: String
    action: String!
    source: String!
    "admin, api_key or system: hide system changes with actorType in [admin, api_key]."
    actorType: String!
    "The administrator's id (for api_key: the key's owner)."
    actorId: ID
    "The administrator's name when the change was recorded (for api_key: the key owner's name; actorType says it was a key)."
    actorLabel: String
    batchId: String
    channelId: ID
    "The entry, written earlier in the same transaction, that caused this one."
    derivedFromId: ID
    changes: JSON
    "Context of the entry: lastState of a deletion, kind and label of a batch head, counts of a run and its subject ({ label, type?, id? }), …"
    meta: JSON!
    "A short English machine summary for logs and exports, not display text: render from changes and meta."
    summary: String!
    compactedAt: DateTime
    "Whether compaction ran: long values are stripped, derived and member rows deleted (their counts kept)."
    isCompacted: Boolean!
    "Entries derived from this one (the count kept by compaction once they are deleted)."
    derivedCount: Int!
    "Members of a batch head by type and action (the counts kept by compaction); null for other entries."
    batchCounts: [ChangeHistoryBatchCount!]
    "The recorded catalogue entity no longer exists or is soft-deleted. Always false for batches, runs and host types."
    entityDeleted: Boolean!
    "The parent (a rules batch head's collection, a membership row's collection, a variant's product) no longer exists or is soft-deleted. Always false without a catalogue parent."
    parentDeleted: Boolean!
    "Only on a run item of changeHistoryEntityTimeline: the first 50 rows of the timeline's entity (and its children); page the rest with changeHistoryRunDetails."
    details: [ChangeHistoryDetail!]
    "Only on a run item of changeHistoryEntityTimeline: how many rows of the timeline's entity (and its children) the run has."
    detailsTotal: Int
    "Only on a run item of changeHistoryEntityTimeline: how many entities those rows touch."
    detailsEntityCount: Int
    "Entries derived from this one, newest first; page with skip / take, totalItems counts them all."
    derivedEntries(options: ChangeHistoryEntryListOptions): ChangeHistoryEntryList!
    "The members of a batch head (the head excluded), newest first; page with skip / take, totalItems counts them all. Empty for other entries."
    batchMembers(options: ChangeHistoryEntryListOptions): ChangeHistoryEntryList!
  }

  type ChangeHistoryBatchCount {
    entityType: String!
    action: String!
    count: Int!
  }

  "One row of an external run: a value changed outside Vendure's events."
  type ChangeHistoryDetail {
    id: ID!
    entryId: ID!
    entityType: String!
    entityId: String!
    "Current name in the request's language (a facet value as 'Facet: Value'); null when the entity is gone."
    entityLabel: String
    "Current SKU of a variant."
    sku: String
    parentType: String
    parentId: String
    kind: String!
    scope: String
    scopeLabel: String
    from: JSON
    to: JSON
  }

  type ChangeHistoryDetailList {
    items: [ChangeHistoryDetail!]!
    totalItems: Int!
  }

  type ChangeHistoryEntryList implements PaginatedList {
    items: [ChangeHistoryEntry!]!
    totalItems: Int!
  }

  input ChangeHistoryEntryListOptions

  type ChangeHistoryEntityTimeline {
    items: [ChangeHistoryEntry!]!
    "Pass as after for the next page; null when the page is empty."
    endCursor: String
    hasMore: Boolean!
  }

  type ChangeHistoryActor {
    id: ID!
    "admin or api_key: an API key is listed under its owner's id."
    type: String!
    "The name the actor was last recorded with."
    label: String!
  }

  type ChangeHistoryFilterOptions {
    actors: [ChangeHistoryActor!]!
    sources: [String!]!
    actions: [String!]!
    entityTypes: [String!]!
  }

  extend type Query {
    "The feed. Newest first by default; derived entries are left out unless the filter names derivedFromId. Ties of the sort are broken by id, so offset pages never skip or repeat an entry."
    changeHistoryEntries(options: ChangeHistoryEntryListOptions): ChangeHistoryEntryList!
    changeHistoryEntry(id: ID!): ChangeHistoryEntry
    "One entity's history, newest first, keyset-paged. entityId is the database id as stored in ChangeHistoryEntry.entityId."
    changeHistoryEntityTimeline(
      entityType: String!
      entityId: String!
      includeChildren: Boolean = true
      first: Int = 20
      after: String
    ): ChangeHistoryEntityTimeline!
    "A run's rows with current labels, sorted by SKU (or name), name, scope; only the rows of entity types the user may read. take is at most 500."
    changeHistoryRunDetails(entryId: ID!, skip: Int = 0, take: Int = 100): ChangeHistoryDetailList!
    "Distinct values of the last summaryDays, for the filter dropdowns (cached for 60 s)."
    changeHistoryFilterOptions: ChangeHistoryFilterOptions!
  }
`;
