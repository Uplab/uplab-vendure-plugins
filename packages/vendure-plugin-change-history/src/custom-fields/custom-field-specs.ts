import { CustomFieldConfig, Type } from '@vendure/core';
import { ChangeHistoryEntityOverrides, ChangeHistoryValueKind } from '../types';

/** How one custom field of an entity enters its history view. */
export interface CustomFieldSpec {
  name: string;
  /** `customFields.<name>`; translatable fields add `.<languageCode>`. */
  key: string;
  /** Stored on the translation rows (`localeString` / `localeText`). */
  translatable: boolean;
  /** Target entity of a `relation` field: the value is its id (or sorted ids for a list). */
  relation?: Type<unknown>;
  list: boolean;
  kind: ChangeHistoryValueKind;
}

const RICH_TEXT_COMPONENTS = new Set(['rich-text-form-input', 'html-editor-form-input']);

function kindOf(config: CustomFieldConfig): ChangeHistoryValueKind {
  const component = (config.ui as { component?: string } | undefined)?.component;
  if (config.type === 'relation') {
    return config.list ? 'refs' : 'ref';
  }
  if (config.list || config.type === 'struct' || component === 'json-editor-form-input') {
    return 'json';
  }
  if (component && RICH_TEXT_COMPONENTS.has(component)) {
    return 'richtext';
  }
  if (component === 'currency-form-input') {
    return 'money';
  }
  switch (config.type) {
    case 'boolean':
      return 'bool';
    case 'datetime':
      return 'date';
    case 'string':
      return (config as { options?: unknown[] }).options?.length ? 'enum' : 'text';
    default:
      return 'text';
  }
}

/**
 * The custom fields an entity's history view contains, from `config.customFields`. A field declared
 * `readonly` or `internal` is written by code, not by people, and is left out — unless the host lists it in
 * `includeReadonlyCustomFields`. `fieldKinds` overrides the kind derived from the type.
 */
export function customFieldSpecs(
  configs: CustomFieldConfig[] | undefined,
  overrides: ChangeHistoryEntityOverrides = {},
): CustomFieldSpec[] {
  const included = new Set(overrides.includeReadonlyCustomFields ?? []);
  return (configs ?? [])
    .filter((config) => !(config.readonly || config.internal) || included.has(config.name))
    .map((config) => {
      const key = `customFields.${config.name}`;
      return {
        name: config.name,
        key,
        translatable: config.type === 'localeString' || config.type === 'localeText',
        relation: config.type === 'relation' ? (config as { entity: Type<unknown> }).entity : undefined,
        list: config.list === true,
        kind: overrides.fieldKinds?.[key] ?? kindOf(config),
      };
    });
}

/** A custom field value in its stored, comparable form: dates as ISO strings, relations as id strings. */
export function normaliseCustomFieldValue(spec: CustomFieldSpec, value: unknown): unknown {
  if (spec.relation) {
    if (spec.list) {
      return Array.isArray(value)
        ? value
            .map((item: { id: unknown }) => String(item.id))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        : [];
    }
    return value && typeof value === 'object' ? String((value as { id: unknown }).id) : null;
  }
  return normaliseScalar(value);
}

/** `Date` → ISO string, `undefined` → `null`, everything else unchanged. */
export function normaliseScalar(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normaliseScalar);
  }
  return value ?? null;
}
