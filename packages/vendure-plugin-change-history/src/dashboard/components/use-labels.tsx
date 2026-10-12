import { useLingui } from '@lingui/react';
import { useMemo } from 'react';
import {
  actionLabelOf,
  batchKindLabelOf,
  countLabelOf,
  entityTypeLabelOf,
  entityTypePluralLabelOf,
  enumValueLabelOf,
  fieldLabelOf,
  knownBatchKindLabelOf,
  sourceOf,
} from '../labels';
import type { ChangeHistoryFieldChange, ChangeHistoryLabel, ChangeHistorySourceDefinition } from '../registry';
import { getChangeHistoryRegistry } from '../registry';

export interface ResolvedSource extends Omit<ChangeHistorySourceDefinition, 'label'> {
  label: string;
}

/**
 * Labels in the dashboard's language, read from the registry at render time, so a host's registrations
 * apply whichever extension loaded first.
 */
export function useLabels() {
  const { i18n } = useLingui();
  return useMemo(() => {
    const registry = getChangeHistoryRegistry();
    const tr = (label: ChangeHistoryLabel): string => (typeof label === 'string' ? label : i18n._(label));
    return {
      tr,
      /** «Name (uk)», «Stock (Default Stock Location)». */
      field(entityType: string, key: string, change?: ChangeHistoryFieldChange): string {
        const { label, language } = fieldLabelOf(registry, entityType, key);
        const qualifier =
          change?.kind === 'stock' && typeof change.location === 'string' && change.location
            ? change.location
            : language;
        const suffix = qualifier ? ` (${qualifier})` : '';
        return tr(label) + suffix;
      },
      type: (type: string) => tr(entityTypeLabelOf(registry, type)),
      typePlural: (type: string | undefined) => tr(entityTypePluralLabelOf(type)),
      action: (action: string) => tr(actionLabelOf(registry, action)),
      /** A batch kind's label; a kind nobody labelled reads «bulk operation», never the raw key (`archive`). */
      batchKind: (kind: string) => tr(batchKindLabelOf(registry, kind)),
      /** The label of a registered or built-in batch kind; `undefined` for a kind nobody labelled. */
      knownBatchKind(kind: string): string | undefined {
        const known = knownBatchKindLabelOf(registry, kind);
        return known === undefined ? undefined : tr(known);
      },
      /** A core enum value in the dashboard's language, or `undefined` when the package does not know it. */
      enumValue(entityType: string, key: string, value: string): string | undefined {
        const known = enumValueLabelOf(entityType, key, value);
        return known ? tr(known) : undefined;
      },
      count: (source: string, key: string) => tr(countLabelOf(registry, source, key)),
      source(source: string, actorType?: string): ResolvedSource {
        const definition = sourceOf(registry, source, actorType);
        return { ...definition, label: tr(definition.label) };
      },
      entityRoute: (type: string) => registry.entityTypes.get(type)?.route,
      valueRenderer: (kind: string) => registry.valueRenderers.get(kind),
      detailRenderer: (kind: string) => registry.detailRenderers.get(kind),
    };
    // `i18n.locale` changes with the dashboard's language. The registry is one store on `globalThis`;
    // its maps are read on every call.
  }, [i18n, i18n.locale]);
}

export type Labels = ReturnType<typeof useLabels>;
