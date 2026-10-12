import gql from 'graphql-tag';

type Document = ReturnType<typeof gql>;

export const CHANGE_HISTORY_ENTRIES: Document = gql`
  query ChangeHistoryEntries($options: ChangeHistoryEntryListOptions) {
    changeHistoryEntries(options: $options) {
      items {
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
        channelId
        derivedFromId
        changes
        meta
        summary
        compactedAt
      }
      totalItems
    }
  }
`;

export const CREATE_PRODUCT: Document = gql`
  mutation CreateProduct($name: String!) {
    createProduct(input: { translations: [{ languageCode: en, name: $name, slug: $name, description: "" }] }) {
      id
    }
  }
`;

export const CREATE_PRODUCT_WITH: Document = gql`
  mutation CreateProductWith($input: CreateProductInput!) {
    createProduct(input: $input) {
      id
    }
  }
`;

export const UPDATE_PRODUCT: Document = gql`
  mutation UpdateProduct($input: UpdateProductInput!) {
    updateProduct(input: $input) {
      id
    }
  }
`;

export const DELETE_PRODUCT: Document = gql`
  mutation DeleteProduct($id: ID!) {
    deleteProduct(id: $id) {
      result
    }
  }
`;

export const CREATE_VARIANTS: Document = gql`
  mutation CreateVariants($input: [CreateProductVariantInput!]!) {
    createProductVariants(input: $input) {
      id
    }
  }
`;

export const UPDATE_VARIANTS: Document = gql`
  mutation UpdateVariants($input: [UpdateProductVariantInput!]!) {
    updateProductVariants(input: $input) {
      id
    }
  }
`;

export const DELETE_VARIANT: Document = gql`
  mutation DeleteVariant($id: ID!) {
    deleteProductVariant(id: $id) {
      result
    }
  }
`;

export const CREATE_FACET: Document = gql`
  mutation CreateFacet($input: CreateFacetInput!) {
    createFacet(input: $input) {
      id
      values {
        id
        code
      }
    }
  }
`;

export const CREATE_OPTION_GROUP: Document = gql`
  mutation CreateOptionGroup($input: CreateProductOptionGroupInput!) {
    createProductOptionGroup(input: $input) {
      id
      options {
        id
      }
    }
  }
`;

export const ADD_OPTION_GROUP: Document = gql`
  mutation AddOptionGroup($productId: ID!, $optionGroupId: ID!) {
    addOptionGroupToProduct(productId: $productId, optionGroupId: $optionGroupId) {
      id
    }
  }
`;

export const ROLES: Document = gql`
  query Roles {
    roles {
      items {
        id
        code
      }
    }
  }
`;

export const CREATE_API_KEY: Document = gql`
  mutation CreateApiKey($input: CreateApiKeyInput!) {
    createApiKey(input: $input) {
      apiKey
    }
  }
`;

export const CREATE_VARIANT: Document = gql`
  mutation CreateVariant($productId: ID!, $sku: String!) {
    createProductVariants(
      input: [
        {
          productId: $productId
          sku: $sku
          price: 1000
          optionIds: []
          translations: [{ languageCode: en, name: $sku }]
        }
      ]
    ) {
      id
    }
  }
`;

export const CREATE_COLLECTION: Document = gql`
  mutation CreateCollection($input: CreateCollectionInput!) {
    createCollection(input: $input) {
      id
    }
  }
`;

export const UPDATE_COLLECTION: Document = gql`
  mutation UpdateCollection($input: UpdateCollectionInput!) {
    updateCollection(input: $input) {
      id
    }
  }
`;

export const MOVE_COLLECTION: Document = gql`
  mutation MoveCollection($input: MoveCollectionInput!) {
    moveCollection(input: $input) {
      id
    }
  }
`;

export const DELETE_COLLECTION: Document = gql`
  mutation DeleteCollection($id: ID!) {
    deleteCollection(id: $id) {
      result
    }
  }
`;

export const UPDATE_FACET: Document = gql`
  mutation UpdateFacet($input: UpdateFacetInput!) {
    updateFacet(input: $input) {
      id
    }
  }
`;

export const UPDATE_FACET_VALUES: Document = gql`
  mutation UpdateFacetValues($input: [UpdateFacetValueInput!]!) {
    updateFacetValues(input: $input) {
      id
    }
  }
`;

export const DELETE_FACET: Document = gql`
  mutation DeleteFacet($id: ID!, $force: Boolean) {
    deleteFacet(id: $id, force: $force) {
      result
    }
  }
`;

export const DELETE_FACET_VALUES: Document = gql`
  mutation DeleteFacetValues($ids: [ID!]!, $force: Boolean) {
    deleteFacetValues(ids: $ids, force: $force) {
      result
    }
  }
`;

export const CREATE_ASSETS: Document = gql`
  mutation CreateAssets($input: [CreateAssetInput!]!) {
    createAssets(input: $input) {
      ... on Asset {
        id
      }
    }
  }
`;

export const UPDATE_ASSET: Document = gql`
  mutation UpdateAsset($input: UpdateAssetInput!) {
    updateAsset(input: $input) {
      id
    }
  }
`;

export const DELETE_ASSET: Document = gql`
  mutation DeleteAsset($input: DeleteAssetInput!) {
    deleteAsset(input: $input) {
      result
    }
  }
`;

export const DELETE_ASSETS: Document = gql`
  mutation DeleteAssets($input: DeleteAssetsInput!) {
    deleteAssets(input: $input) {
      result
    }
  }
`;

export const ASSIGN_ASSETS_TO_CHANNEL: Document = gql`
  mutation AssignAssetsToChannel($input: AssignAssetsToChannelInput!) {
    assignAssetsToChannel(input: $input) {
      id
    }
  }
`;

export const ASSIGN_COLLECTIONS_TO_CHANNEL: Document = gql`
  mutation AssignCollectionsToChannel($input: AssignCollectionsToChannelInput!) {
    assignCollectionsToChannel(input: $input) {
      id
    }
  }
`;

export const REMOVE_COLLECTIONS_FROM_CHANNEL: Document = gql`
  mutation RemoveCollectionsFromChannel($input: RemoveCollectionsFromChannelInput!) {
    removeCollectionsFromChannel(input: $input) {
      id
    }
  }
`;

export const CREATE_PROMOTION: Document = gql`
  mutation CreatePromotion($input: CreatePromotionInput!) {
    createPromotion(input: $input) {
      ... on Promotion {
        id
      }
    }
  }
`;

export const UPDATE_PROMOTION: Document = gql`
  mutation UpdatePromotion($input: UpdatePromotionInput!) {
    updatePromotion(input: $input) {
      ... on Promotion {
        id
      }
    }
  }
`;

export const DELETE_PROMOTION: Document = gql`
  mutation DeletePromotion($id: ID!) {
    deletePromotion(id: $id) {
      result
    }
  }
`;

export const CREATE_CHANNEL: Document = gql`
  mutation CreateChannel($input: CreateChannelInput!) {
    createChannel(input: $input) {
      ... on Channel {
        id
      }
    }
  }
`;

export const ASSIGN_PRODUCTS_TO_CHANNEL: Document = gql`
  mutation AssignProductsToChannel($input: AssignProductsToChannelInput!) {
    assignProductsToChannel(input: $input) {
      id
    }
  }
`;

export const REMOVE_PRODUCTS_FROM_CHANNEL: Document = gql`
  mutation RemoveProductsFromChannel($input: RemoveProductsFromChannelInput!) {
    removeProductsFromChannel(input: $input) {
      id
    }
  }
`;

export const UNSETTLED_JOBS: Document = gql`
  query UnsettledJobs {
    jobs(options: { filter: { isSettled: { eq: false } } }) {
      totalItems
    }
  }
`;

export const ACTIVE_CHANNEL_ZONES: Document = gql`
  query ActiveChannelZones {
    activeChannel {
      defaultShippingZone {
        id
      }
      defaultTaxZone {
        id
      }
    }
  }
`;

const ENTRY_FIELDS = `
  id
  createdAt
  entityType
  entityId
  entityLabel
  subjectLabel
  parentType
  parentId
  action
  source
  actorType
  actorId
  actorLabel
  batchId
  derivedFromId
  summary
  meta
  isCompacted
  derivedCount
  batchCounts {
    entityType
    action
    count
  }
  entityDeleted
  parentDeleted
`;

const DETAIL_FIELDS = `
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
`;

export const CHANGE_HISTORY_FEED: Document = gql`
  query ChangeHistoryFeed($options: ChangeHistoryEntryListOptions) {
    changeHistoryEntries(options: $options) {
      items {
        ${ENTRY_FIELDS}
      }
      totalItems
    }
  }
`;

export const CHANGE_HISTORY_ENTRY: Document = gql`
  query ChangeHistoryEntry($id: ID!, $derived: ChangeHistoryEntryListOptions, $members: ChangeHistoryEntryListOptions) {
    changeHistoryEntry(id: $id) {
      ${ENTRY_FIELDS}
      derivedFrom {
        id
        entityType
        entityLabel
        action
      }
      derivedEntries(options: $derived) {
        items {
          id
          entityLabel
        }
        totalItems
      }
      batchMembers(options: $members) {
        items {
          id
          entityLabel
        }
        totalItems
      }
    }
  }
`;

export const CHANGE_HISTORY_TIMELINE: Document = gql`
  query ChangeHistoryTimeline(
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
        ${ENTRY_FIELDS}
        details {
          ${DETAIL_FIELDS}
        }
        detailsTotal
        detailsEntityCount
      }
      endCursor
      hasMore
    }
  }
`;

export const CHANGE_HISTORY_RUN_DETAILS: Document = gql`
  query ChangeHistoryRunDetails($entryId: ID!, $skip: Int, $take: Int) {
    changeHistoryRunDetails(entryId: $entryId, skip: $skip, take: $take) {
      items {
        ${DETAIL_FIELDS}
      }
      totalItems
    }
  }
`;

export const CHANGE_HISTORY_FILTER_OPTIONS: Document = gql`
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
`;

export const CREATE_ROLE: Document = gql`
  mutation CreateRole($input: CreateRoleInput!) {
    createRole(input: $input) {
      id
    }
  }
`;

export const CREATE_ADMINISTRATOR: Document = gql`
  mutation CreateAdministrator($input: CreateAdministratorInput!) {
    createAdministrator(input: $input) {
      id
    }
  }
`;
