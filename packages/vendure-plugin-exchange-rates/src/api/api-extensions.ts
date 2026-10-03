import gql from 'graphql-tag';

type Document = ReturnType<typeof gql>;

const commonApiExtensions: Document = gql`
  type CurrencyExchangeRate implements Node {
    id: ID!
    createdAt: DateTime!
    updatedAt: DateTime!
    code: String!
    "The currency rate is expressed in: rate = units of it per one unit of code."
    baseCurrency: String!
    rate: Float!
    enabled: Boolean!
  }

  type CurrencyExchangeRateList implements PaginatedList {
    items: [CurrencyExchangeRate!]!
    totalItems: Int!
  }

  extend type Query {
    currencyExchangeRates(options: CurrencyExchangeRateListOptions): CurrencyExchangeRateList!
  }

  input CurrencyExchangeRateListOptions
`;

export const shopApiExtensions: Document = gql`
  ${commonApiExtensions}
`;

export const adminApiExtensions: Document = gql`
  ${commonApiExtensions}

  extend type CurrencyExchangeRate {
    useCustomRate: Boolean!
    customRate: Float
  }

  extend type Query {
    currencyExchangeRate(id: ID!): CurrencyExchangeRate
  }

  extend type Mutation {
    updateCurrencyExchangeRate(input: UpdateCurrencyExchangeRateInput!): CurrencyExchangeRate!
  }

  input UpdateCurrencyExchangeRateInput {
    id: ID!
    enabled: Boolean!
    useCustomRate: Boolean!
    customRate: Float
  }
`;
