import gql from 'graphql-tag';

type Document = ReturnType<typeof gql>;

export const CITIES: Document = gql`
  query Cities($input: NovaPoshtaCitiesInput!) {
    novaPoshtaCities(input: $input) {
      Ref
      Description
    }
  }
`;

export const WAREHOUSES: Document = gql`
  query Warehouses($input: NovaPoshtaWarehousesInput!) {
    novaPoshtaWarehouses(input: $input) {
      Ref
      Description
    }
  }
`;

export const INTERNATIONAL_CITIES: Document = gql`
  query InternationalCities($input: NovaPoshtaInternationalCitiesInput!) {
    novaPoshtaInternationalCities(input: $input) {
      City
    }
  }
`;

export const INTERNATIONAL_WAREHOUSES: Document = gql`
  query InternationalWarehouses($input: NovaPoshtaInternationalWarehousesInput!) {
    novaPoshtaInternationalWarehouses(input: $input) {
      WarehouseRef
      FullDescription
    }
  }
`;

export const AVAILABLE_COUNTRIES: Document = gql`
  query AvailableCountries {
    availableCountries {
      id
      code
      customFields {
        novaPoshtaCountryRef
      }
    }
  }
`;

export const SYNC_COUNTRIES: Document = gql`
  mutation SyncCountries {
    novaPoshtaSyncCountries {
      matched
      updated
    }
  }
`;

export const UPDATE_COUNTRY: Document = gql`
  mutation UpdateCountry($input: UpdateCountryInput!) {
    updateCountry(input: $input) {
      id
      customFields {
        novaPoshtaWarehouseCategories
      }
    }
  }
`;
