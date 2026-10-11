import { ID, RequestContext } from '@vendure/core';
import type { EntityManager } from 'typeorm';
import { ChangeHistoryCoreEntityType, ChangeHistoryFieldChanges, ChangeHistoryValueKind } from '../types';

/**
 * The always-loaded part of an entity's history view: its own row and its translations. Every other group
 * (a junction, a relation, an extractor) is loaded only when the save could have changed it.
 */
export const BASE_GROUP = 'base';

/** One entity's history view as loaded from one side (committed or in-transaction). */
export interface LoadedState {
  /** Flat, stable values: scalars, `name.<lang>`, sorted id lists, `customFields.*`, extractor keys. */
  values: Record<string, unknown>;
  /** The groups `values` covers. A key is compared only when both sides cover its group. */
  groups: ReadonlySet<string>;
  /** Snapshot label (name in the request language; variants add the SKU). */
  label: string;
  parentId?: string;
  /** The row is soft-deleted on this side. */
  deleted: boolean;
}

/**
 * Template-method hooks of one core entity: what the capture pipeline varies per entity type. Internal —
 * hosts tune a definition through `entities.*` and field extractors, they do not replace it.
 */
export interface ChangeHistoryEntityDefinition {
  readonly entityType: ChangeHistoryCoreEntityType;
  /** The type of the parent entity (Variant → Product), for the parent link and the derived rule. */
  readonly parentType?: ChangeHistoryCoreEntityType;
  /** Every group: what `created`, `deleted` and `capture()` load. */
  readonly fullScope: ReadonlySet<string>;
  /** The groups an `updated` event with this mutation input could have changed. */
  scopeFor(input: unknown): Set<string>;
  /** Loads and normalises the given ids with `manager` (the committed reader or the transaction's). */
  load(
    ctx: RequestContext,
    ids: ID[],
    manager: EntityManager,
    scope: ReadonlySet<string>,
  ): Promise<Map<string, LoadedState>>;
  groupOf(key: string): string;
  kindOf(key: string): ChangeHistoryValueKind;
  /** Adds display labels to the changed references, after the diff (only changed ids are looked up). */
  addLabels(ctx: RequestContext, manager: EntityManager, changes: ChangeHistoryFieldChanges): Promise<void>;
}
