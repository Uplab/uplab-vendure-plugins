import { type CustomFieldConfig, LanguageCode } from '@vendure/core';
import { NOVA_POSHTA_WAREHOUSE_CATEGORIES } from './constants';
import type { NovaPoshtaWarehouseCategory } from './types';

const categoryLabels: Record<NovaPoshtaWarehouseCategory, { en: string; uk: string }> = {
  PostBranch: { en: 'Post branches', uk: 'Поштові відділення' },
  CargoBranch: { en: 'Cargo branches', uk: 'Вантажні відділення' },
  PUDO: { en: 'Pick-up points', uk: 'Пункти видачі' },
  Poshtomat: { en: 'Parcel lockers', uk: 'Поштомати' },
};

/** `Region` custom fields: they show on the country page of the dashboard. */
export const regionCustomFields: CustomFieldConfig[] = [
  {
    name: 'novaPoshtaCountryRef',
    type: 'string',
    nullable: true,
    label: [
      { languageCode: LanguageCode.en, value: 'Nova Poshta: country ref' },
      { languageCode: LanguageCode.uk, value: 'Нова пошта: ref країни' },
    ],
    description: [
      { languageCode: LanguageCode.en, value: 'Filled in by the country sync.' },
      { languageCode: LanguageCode.uk, value: 'Заповнюється синхронізацією країн.' },
    ],
    readonly: true,
  },
  {
    name: 'novaPoshtaWarehouseCategories',
    type: 'string',
    list: true,
    public: false,
    label: [
      { languageCode: LanguageCode.en, value: 'Nova Poshta: warehouse types' },
      { languageCode: LanguageCode.uk, value: 'Нова пошта: типи відділень' },
    ],
    description: [
      {
        languageCode: LanguageCode.en,
        value: 'Which types customers can pick in this country. Empty shows all of them.',
      },
      {
        languageCode: LanguageCode.uk,
        value: 'Які типи показувати покупцю для цієї країни. Порожньо — показувати всі.',
      },
    ],
    options: NOVA_POSHTA_WAREHOUSE_CATEGORIES.map((value) => ({
      value,
      label: [
        { languageCode: LanguageCode.en, value: categoryLabels[value].en },
        { languageCode: LanguageCode.uk, value: categoryLabels[value].uk },
      ],
    })),
  },
];
