import { graphql } from '@vendure/dashboard';
import type { DocumentNode } from 'graphql';

// The dashboard's `graphql()` is typed against core's schema only, so these documents carry
// hand-written result types instead. The shape matches `TypedDocumentNode`, which the pages expect.
type TypedDocument<Result, Variables> = DocumentNode & { __apiType?: (variables: Variables) => Result };

const typedDocument = <Result, Variables>(source: string) =>
  (graphql as (source: string) => DocumentNode)(source) as TypedDocument<Result, Variables>;

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

export const getCurrencyExchangeRateListDocument = typedDocument<
  { currencyExchangeRates: { items: CurrencyExchangeRateFields[]; totalItems: number } },
  { options?: Record<string, unknown> }
>(`
  query GetCurrencyExchangeRateList($options: CurrencyExchangeRateListOptions) {
    currencyExchangeRates(options: $options) {
      items {
        ...CurrencyExchangeRateFields
      }
      totalItems
    }
  }
  ${FIELDS}
`);

export const getCurrencyExchangeRateDetailDocument = typedDocument<
  { currencyExchangeRate: CurrencyExchangeRateFields | null },
  { id: string }
>(`
  query GetCurrencyExchangeRateDetail($id: ID!) {
    currencyExchangeRate(id: $id) {
      ...CurrencyExchangeRateFields
    }
  }
  ${FIELDS}
`);

export const updateCurrencyExchangeRateDocument = typedDocument<
  { updateCurrencyExchangeRate: CurrencyExchangeRateFields },
  { input: { id: string; enabled: boolean; useCustomRate: boolean; customRate?: number | null } }
>(`
  mutation UpdateCurrencyExchangeRate($input: UpdateCurrencyExchangeRateInput!) {
    updateCurrencyExchangeRate(input: $input) {
      ...CurrencyExchangeRateFields
    }
  }
  ${FIELDS}
`);
