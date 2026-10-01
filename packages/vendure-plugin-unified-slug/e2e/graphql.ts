import gql from 'graphql-tag';

type Document = ReturnType<typeof gql>;

export const CREATE_PRODUCT: Document = gql`
  mutation CreateProduct($input: CreateProductInput!) {
    createProduct(input: $input) {
      id
      translations {
        languageCode
        name
        slug
      }
    }
  }
`;

export const UPDATE_PRODUCT: Document = gql`
  mutation UpdateProduct($input: UpdateProductInput!) {
    updateProduct(input: $input) {
      id
      enabled
      translations {
        languageCode
        name
        slug
      }
    }
  }
`;

export const UPDATE_PRODUCTS: Document = gql`
  mutation UpdateProducts($input: [UpdateProductInput!]!) {
    updateProducts(input: $input) {
      id
      translations {
        languageCode
        name
        slug
      }
    }
  }
`;

export const CREATE_COLLECTION: Document = gql`
  mutation CreateCollection($input: CreateCollectionInput!) {
    createCollection(input: $input) {
      id
      translations {
        languageCode
        name
        slug
      }
    }
  }
`;

export const UPDATE_COLLECTION: Document = gql`
  mutation UpdateCollection($input: UpdateCollectionInput!) {
    updateCollection(input: $input) {
      id
      translations {
        languageCode
        name
        slug
      }
    }
  }
`;

export const UNIFIED_SLUG_GENERATE: Document = gql`
  query UnifiedSlugGenerate($input: UnifiedSlugGenerateInput!) {
    unifiedSlugGenerate(input: $input)
  }
`;

export const UNIFIED_SLUG_SETTINGS: Document = gql`
  query UnifiedSlugSettings {
    unifiedSlugSettings {
      watchFormFields
    }
  }
`;

export const SLUG_FOR_ENTITY: Document = gql`
  query SlugForEntity($input: SlugForEntityInput!) {
    slugForEntity(input: $input)
  }
`;

export interface TranslationRow {
  languageCode: string;
  name: string;
  slug: string;
}

/** `{ en: 'summer-dress', uk: 'summer-dress' }` — one line to assert on, independent of row order. */
export function slugsByLanguage(translations: TranslationRow[]): Record<string, string> {
  return Object.fromEntries(
    [...translations].sort((a, b) => a.languageCode.localeCompare(b.languageCode)).map((t) => [t.languageCode, t.slug]),
  );
}
