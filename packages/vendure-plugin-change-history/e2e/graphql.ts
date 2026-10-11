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
