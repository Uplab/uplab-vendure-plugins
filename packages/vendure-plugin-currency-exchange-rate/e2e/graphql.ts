import gql from 'graphql-tag';

type Document = ReturnType<typeof gql>;

const FIELDS = `
  id
  code
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
