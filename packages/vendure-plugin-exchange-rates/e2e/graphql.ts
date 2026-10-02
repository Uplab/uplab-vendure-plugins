import gql from 'graphql-tag';

type Document = ReturnType<typeof gql>;

const FIELDS = `
  id
  code
  baseCurrency
  rate
  enabled
`;

export const SHOP_RATES: Document = gql`
  query ShopRates {
    currencyExchangeRates(options: { sort: { code: ASC } }) {
      items { ${FIELDS} }
      totalItems
    }
  }
`;

export const ADMIN_RATES: Document = gql`
  query AdminRates {
    currencyExchangeRates(options: { sort: { code: ASC } }) {
      items { ${FIELDS} useCustomRate customRate }
      totalItems
    }
  }
`;

export const UPDATE_RATE: Document = gql`
  mutation UpdateRate($input: UpdateCurrencyExchangeRateInput!) {
    updateCurrencyExchangeRate(input: $input) { ${FIELDS} useCustomRate customRate }
  }
`;

export const SHOP_RATES_OR: Document = gql`
  query ShopRatesOr($code: String!) {
    currencyExchangeRates(options: { filter: { code: { eq: $code } }, filterOperator: OR }) {
      items { ${FIELDS} }
      totalItems
    }
  }
`;

export const ADMIN_RATE: Document = gql`
  query AdminRate($id: ID!) {
    currencyExchangeRate(id: $id) { ${FIELDS} useCustomRate customRate }
  }
`;

export const SHOP_RATES_NESTED_OR: Document = gql`
  query ShopRatesNestedOr($code: String!) {
    currencyExchangeRates(options: { filter: { _or: [{ code: { eq: $code } }, { enabled: { eq: false } }] } }) {
      totalItems
    }
  }
`;

export const UPDATE_DEFAULT_CURRENCY: Document = gql`
  mutation UpdateDefaultCurrency($id: ID!, $currency: CurrencyCode!) {
    updateChannel(input: { id: $id, defaultCurrencyCode: $currency, availableCurrencyCodes: [USD, EUR] }) {
      ... on Channel {
        defaultCurrencyCode
      }
    }
  }
`;

export const ACTIVE_CHANNEL: Document = gql`
  query ActiveChannel {
    activeChannel {
      id
    }
  }
`;
