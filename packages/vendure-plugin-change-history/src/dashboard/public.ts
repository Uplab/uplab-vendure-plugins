/**
 * `@uplab/vendure-plugin-change-history/dashboard` — what a host's own dashboard extension calls to label
 * and render its values in the change history.
 *
 * Registration only: plain functions, one constant and types. No React component and no Lingui macro is
 * imported here — the host's tooling compiles this file under its own options, and in the Vite dev server
 * it may be pre-bundled.
 *
 * A registration the dashboard could not render (an empty key, a missing label, an unknown tone) is reported
 * with `console.error` and skipped; it never throws, so a mistake cannot blank the dashboard.
 *
 * @example
 * ```ts
 * import { msg } from '@lingui/core/macro';
 * import { registerChangeHistoryFieldLabels } from '@uplab/vendure-plugin-change-history/dashboard';
 *
 * registerChangeHistoryFieldLabels('Product', { 'customFields.subtitle': msg`Subtitle` });
 * ```
 */
import type { ComponentType } from 'react';
import {
  type ChangeHistoryDetailRendererProps,
  type ChangeHistoryEntityTypeDefinition,
  type ChangeHistoryLabel,
  type ChangeHistoryLabelDefinition,
  type ChangeHistorySourceDefinition,
  type ChangeHistoryValueRendererProps,
  getChangeHistoryRegistry,
} from './registry';

export type {
  ChangeHistoryBatchCount,
  ChangeHistoryDetailData,
  ChangeHistoryDetailRendererProps,
  ChangeHistoryEntityTypeDefinition,
  ChangeHistoryEntryData,
  ChangeHistoryFieldChange,
  ChangeHistoryLabel,
  ChangeHistoryLabelDefinition,
  ChangeHistorySourceDefinition,
  ChangeHistorySourceTone,
  ChangeHistoryValueRendererProps,
} from './registry';

/**
 * `order` of the change history's item in the dashboard's System section. To place an item of your own
 * right after it, give that item `order: CHANGE_HISTORY_NAV_ORDER + 1`.
 */
export const CHANGE_HISTORY_NAV_ORDER = 600;

const TONES = ['human', 'system', 'scheduled'];

function requireKey(what: string, key: unknown): string {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error(`[ChangeHistory] ${what} must be a non-empty string`);
  }
  return key;
}

function requireLabel(what: string, definition: { label?: ChangeHistoryLabel } | undefined): void {
  const label = definition?.label;
  if (!(typeof label === 'string' || (typeof label === 'object' && label !== null && typeof label.id === 'string'))) {
    throw new Error(`[ChangeHistory] ${what} needs a label (a string or a msg\`…\` descriptor)`);
  }
}

/**
 * Runs a registration; one the dashboard could not render is reported on the console and skipped. A throw
 * would escape the host's extension module at its top level and leave the whole dashboard blank.
 */
function register(apply: () => void): void {
  try {
    apply();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
}

function requireComponent(what: string, component: unknown): void {
  // Function components, classes, and the objects memo() / forwardRef() return.
  if (component == null || (typeof component !== 'function' && typeof component !== 'object')) {
    throw new Error(`[ChangeHistory] ${what} must be a React component`);
  }
}

/**
 * Labels for fields of an entity type, keyed as in `changes` (`customFields.price`, `name`, …; the language
 * suffix of translatable fields is added by the renderer). Overrides the package's labels.
 */
export function registerChangeHistoryFieldLabels(entityType: string, labels: Record<string, ChangeHistoryLabel>): void {
  register(() => {
    requireKey('entityType', entityType);
    const entries = Object.entries(labels ?? {});
    for (const [key, label] of entries) {
      requireLabel(`field "${key}"`, { label });
    }
    const registry = getChangeHistoryRegistry();
    const forType = registry.fieldLabels.get(entityType) ?? new Map<string, ChangeHistoryLabel>();
    for (const [key, label] of entries) {
      forType.set(key, label);
    }
    registry.fieldLabels.set(entityType, forType);
  });
}

/** Renders one side of a changed value of the given kind — a host kind, or a replacement for a built-in one. */
export function registerChangeHistoryValueRenderer(
  kind: string,
  component: ComponentType<ChangeHistoryValueRendererProps>,
): void {
  register(() => {
    requireKey('kind', kind);
    requireComponent(`renderer of kind "${kind}"`, component);
    getChangeHistoryRegistry().valueRenderers.set(kind, component);
  });
}

/** Renders the detail rows of a run whose rows have the given kind. */
export function registerChangeHistoryDetailRenderer(
  kind: string,
  component: ComponentType<ChangeHistoryDetailRendererProps>,
): void {
  register(() => {
    requireKey('kind', kind);
    requireComponent(`detail renderer of kind "${kind}"`, component);
    getChangeHistoryRegistry().detailRenderers.set(kind, component);
  });
}

/**
 * Label, tone and icon of a host source (`erp_stock_sync`, …), and the labels of its runs' `counts` keys.
 * `tone: 'system'` shows the grey robot badge, `'scheduled'` the clock, `'human'` the person.
 */
export function registerChangeHistorySource(source: string, definition: ChangeHistorySourceDefinition): void {
  register(() => {
    requireKey('source', source);
    requireLabel(`source "${source}"`, definition);
    if (!TONES.includes(definition.tone)) {
      throw new Error(`[ChangeHistory] source "${source}": tone must be one of ${TONES.join(', ')}`);
    }
    if (definition.icon !== undefined) {
      requireComponent(`icon of source "${source}"`, definition.icon);
    }
    for (const [key, label] of Object.entries(definition.countLabels ?? {})) {
      requireLabel(`count "${key}" of source "${source}"`, { label });
    }
    getChangeHistoryRegistry().sources.set(source, definition);
  });
}

/** Label of a host action (`archived`, …). */
export function registerChangeHistoryAction(action: string, definition: ChangeHistoryLabelDefinition): void {
  register(() => {
    requireKey('action', action);
    requireLabel(`action "${action}"`, definition);
    getChangeHistoryRegistry().actions.set(action, definition);
  });
}

/** Label of a host batch kind (`bulk_edit`, …). */
export function registerChangeHistoryBatchKind(kind: string, definition: ChangeHistoryLabelDefinition): void {
  register(() => {
    requireKey('kind', kind);
    requireLabel(`batch kind "${kind}"`, definition);
    getChangeHistoryRegistry().batchKinds.set(kind, definition);
  });
}

/** A host entity type: label in the type filter, and the link of its entries. */
export function registerChangeHistoryEntityType(type: string, definition: ChangeHistoryEntityTypeDefinition): void {
  register(() => {
    requireKey('type', type);
    requireLabel(`entity type "${type}"`, definition);
    getChangeHistoryRegistry().entityTypes.set(type, definition);
  });
}
