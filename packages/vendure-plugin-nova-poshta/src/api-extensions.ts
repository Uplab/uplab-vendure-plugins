import gql from 'graphql-tag';

type Document = ReturnType<typeof gql>;

export const shopApiExtensions: Document = gql`
  input NovaPoshtaCitiesInput {
    term: String!
    limit: Int!
  }

  input NovaPoshtaWarehousesInput {
    cityId: String!
    term: String
    limit: Int
  }

  input NovaPoshtaInternationalCitiesInput {
    term: String!
    "Nova Poshta's country ref: Country.customFields.novaPoshtaCountryRef"
    country: String!
    limit: Int!
  }

  input NovaPoshtaInternationalWarehousesInput {
    city: String!
    "Nova Poshta's country ref: Country.customFields.novaPoshtaCountryRef"
    country: String!
    limit: Int
  }

  type NovaPoshtaCity {
    Ref: String!
    Description: String!
  }

  type NovaPoshtaWarehouse {
    Ref: String!
    Description: String!
  }

  type NovaPoshtaInternationalCity {
    City: String!
  }

  type NovaPoshtaInternationalWarehouse {
    WarehouseRef: String!
    FullDescription: String!
  }

  extend type Query {
    novaPoshtaCities(input: NovaPoshtaCitiesInput!): [NovaPoshtaCity!]!
    novaPoshtaWarehouses(input: NovaPoshtaWarehousesInput!): [NovaPoshtaWarehouse!]!
    novaPoshtaInternationalCities(input: NovaPoshtaInternationalCitiesInput!): [NovaPoshtaInternationalCity!]!
    novaPoshtaInternationalWarehouses(
      input: NovaPoshtaInternationalWarehousesInput!
    ): [NovaPoshtaInternationalWarehouse!]!
  }
`;

export const adminApiExtensions: Document = gql`
  type NovaPoshtaCountrySyncResult {
    matched: Int!
    updated: Int!
  }

  extend type Mutation {
    "Writes Nova Poshta's country refs into Country.customFields.novaPoshtaCountryRef now, without waiting for the daily task."
    novaPoshtaSyncCountries: NovaPoshtaCountrySyncResult!
  }
`;
