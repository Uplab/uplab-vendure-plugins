/**
 * The injection token under which the plugin options are provided.
 */
export const NOVA_POSHTA_PLUGIN_OPTIONS = Symbol('NOVA_POSHTA_PLUGIN_OPTIONS');

export const NOVA_POSHTA_LOGGER_CTX = 'NovaPoshtaPlugin';

export const DEFAULT_NOVA_POSHTA_API_URL = 'https://api.novaposhta.ua/v2.0/json/';

/** How long a request to Nova Poshta may take before it is aborted, in milliseconds. */
export const DEFAULT_NOVA_POSHTA_TIMEOUT = 10_000;

export const DEFAULT_COUNTRY_SYNC_SCHEDULE = '0 7 * * *';

export const COUNTRY_SYNC_TASK_ID = 'sync-nova-poshta-countries';

/**
 * @description
 * The values of the `WarehouseCategory` filter of Nova Poshta's `International.getWarehouses`, offered
 * per country in the `novaPoshtaWarehouseCategories` custom field.
 */
export const NOVA_POSHTA_WAREHOUSE_CATEGORIES = ['PostBranch', 'CargoBranch', 'PUDO', 'Poshtomat'] as const;
