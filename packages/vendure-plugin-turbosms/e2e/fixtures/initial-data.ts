import { LanguageCode, type InitialData } from '@vendure/core';

/**
 * The smallest amount of data a Vendure server needs to be populated with.
 */
export const initialData: InitialData = {
  defaultLanguage: LanguageCode.en,
  defaultZone: 'Europe',
  taxRates: [{ name: 'Standard Tax', percentage: 20 }],
  shippingMethods: [{ name: 'Standard Shipping', price: 500 }],
  paymentMethods: [],
  countries: [{ name: 'Ukraine', code: 'UA', zone: 'Europe' }],
  collections: [],
};
