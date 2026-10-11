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
