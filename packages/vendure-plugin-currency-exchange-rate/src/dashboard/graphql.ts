import { graphql } from '@vendure/dashboard';
import type { DocumentNode } from 'graphql';

// The dashboard's `graphql()` is typed against core's schema only, so these documents carry
// hand-written result types instead. The shape matches `TypedDocumentNode`, which the pages expect.
type TypedDocument<Result, Variables> = DocumentNode & { __apiType?: (variables: Variables) => Result };

export interface CurrencyExchangeRateFields {
  id: string;
  createdAt: string;
  updatedAt: string;
  code: string;
  rate: number;
  enabled: boolean;
  useCustomRate: boolean;
  customRate: number | null;
}

const FIELDS = `
  fragment CurrencyExchangeRateFields on CurrencyExchangeRate {
    id
    createdAt
    updatedAt
    code
    rate
    enabled
    useCustomRate
    customRate
  }
`;

export const getCurrencyExchangeRateListDocument = (graphql as (source: string) => DocumentNode)(`
  query GetCurrencyExchangeRateList($options: CurrencyExchangeRateListOptions) {
    currencyExchangeRates(options: $options) {
      items {
        ...CurrencyExchangeRateFields
      }
      totalItems
    }
  }
  ${FIELDS}
`) as TypedDocument<
  { currencyExchangeRates: { items: CurrencyExchangeRateFields[]; totalItems: number } },
  { options?: Record<string, unknown> }
>;

export const getCurrencyExchangeRateDetailDocument = (graphql as (source: string) => DocumentNode)(`
  query GetCurrencyExchangeRateDetail($id: ID!) {
    currencyExchangeRate(id: $id) {
      ...CurrencyExchangeRateFields
    }
  }
  ${FIELDS}
`) as TypedDocument<{ currencyExchangeRate: CurrencyExchangeRateFields | null }, { id: string }>;

export const updateCurrencyExchangeRateDocument = (graphql as (source: string) => DocumentNode)(`
  mutation UpdateCurrencyExchangeRate($input: UpdateCurrencyExchangeRateInput!) {
    updateCurrencyExchangeRate(input: $input) {
      ...CurrencyExchangeRateFields
    }
  }
  ${FIELDS}
`) as TypedDocument<
  { updateCurrencyExchangeRate: CurrencyExchangeRateFields },
  { input: { id: string; enabled: boolean; useCustomRate: boolean; customRate?: number | null } }
>;
