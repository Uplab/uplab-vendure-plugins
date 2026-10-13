import type { ComponentType } from 'react';

/**
 * A label: a Lingui `MessageDescriptor` (`msg\`…\``), translated by the host's catalogs, or a plain
 * string, shown verbatim.
 */
export type ChangeHistoryLabel =
  string | { id: string; message?: string; comment?: string; values?: Record<string, unknown> };

/** One changed field of an entry, as the API returns it in `changes`. */
export interface ChangeHistoryFieldChange {
  from?: unknown;
  to?: unknown;
  kind?: string;
  added?: string[];
  removed?: string[];
  reordered?: boolean;
  labels?: Record<string, string>;
  truncated?: boolean;
  stripped?: boolean;
  fromLength?: number;
  toLength?: number;
  [extra: string]: unknown;
}

/** An entry as the dashboard receives it from the Admin API. */
export interface ChangeHistoryEntryData {
  id: string;
  createdAt: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  parentType: string | null;
  parentId: string | null;
  action: string;
  source: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  batchId: string | null;
  derivedFromId: string | null;
  /** The entry that caused this one; `null` when there is none, it is gone, or the reader may not read it. */
  derivedFrom?: Pick<ChangeHistoryEntryData, 'id' | 'entityType' | 'entityId' | 'entityLabel' | 'action'> | null;
  changes: Record<string, ChangeHistoryFieldChange> | null;
  meta: Record<string, unknown>;
  summary: string;
  compactedAt: string | null;
  /** Compaction ran: long values are stripped, derived and member rows deleted (their counts kept). */
  isCompacted: boolean;
  /** Entries derived from this one (a variant price rewritten by a product save). */
  derivedCount: number;
  /** Members of a batch head by type and action; `null` for other entries. */
  batchCounts: ChangeHistoryBatchCount[] | null;
  /** The recorded catalogue entity no longer exists. */
  entityDeleted: boolean;
  /** The parent (a rules batch head's or a membership row's collection, a variant's product) no longer exists. */
  parentDeleted: boolean;
  /** Only on a run item of an entity timeline: the first 50 rows of that entity (and its children). */
  details?: ChangeHistoryDetailData[] | null;
  /** Only on a run item of an entity timeline: how many rows of that entity (and its children) the run has. */
  detailsTotal?: number | null;
  /** Only on a run item of an entity timeline: how many entities those rows touch. */
  detailsEntityCount?: number | null;
}

export interface ChangeHistoryBatchCount {
  entityType: string;
  action: string;
  count: number;
}

/** A detail row of a run, as the dashboard receives it from the Admin API. */
export interface ChangeHistoryDetailData {
  id: string;
  entryId: string;
  entityType: string;
  entityId: string;
  /** The current name (a variant's in the request language), `null` when the entity is gone. */
  entityLabel: string | null;
  /** The current SKU of a variant. */
  sku: string | null;
  parentType: string | null;
  parentId: string | null;
  kind: string;
  scope: string | null;
  scopeLabel: string | null;
  from: unknown;
  to: unknown;
}

/** Props of a value renderer (`registerChangeHistoryValueRenderer`): one side of one changed field. */
export interface ChangeHistoryValueRendererProps {
  change: ChangeHistoryFieldChange;
  fieldKey: string;
  entityType: string;
  side: 'from' | 'to';
}

/**
 * A value of a kind as one line of text (`registerChangeHistoryValueText`): what the feed's «What changed»
 * cell, the widget, batch member rows and a created entity's value line show. `change` is the whole change the
 * value belongs to (both sides), so a formatter may describe only what differs; `side` says which value this
 * is. Return `undefined` to fall back to the built-in text.
 */
export type ChangeHistoryValueText = (
  value: unknown,
  context: { change: ChangeHistoryFieldChange; side: 'from' | 'to'; entityType: string; fieldKey: string },
) => string | undefined;

/**
 * Props of a detail renderer (`registerChangeHistoryDetailRenderer`): rows of a run, all of one `kind`.
 *
 * - `dialog`: one page of the whole run, in the entry dialog (the dialog pages it).
 * - `timeline`: the rows of the page's entity (and its children) inside its history block.
 * - `summary`: the count line of the collapsed timeline item («3 variants · 4 rows»), inline text —
 *   render your own plural forms here. `rows` may be the first 50 only: count from `entry.detailsTotal` and
 *   `entry.detailsEntityCount`.
 */
export interface ChangeHistoryDetailRendererProps {
  rows: ChangeHistoryDetailData[];
  entry: ChangeHistoryEntryData;
  mode: 'dialog' | 'timeline' | 'summary';
}

/** `human`, `system` or `scheduled` — picks the badge's icon and colour. */
export type ChangeHistorySourceTone = 'human' | 'system' | 'scheduled';

export interface ChangeHistorySourceDefinition {
  label: ChangeHistoryLabel;
  tone: ChangeHistorySourceTone;
  /** The actor's icon (e.g. a `lucide-react` icon); default: the tone's icon. */
  icon?: ComponentType<{ className?: string }>;
  /** Labels for the keys of a run's `counts` (the package labels created/updated/deleted/failed/added/removed). */
  countLabels?: Record<string, ChangeHistoryLabel>;
}

export interface ChangeHistoryLabelDefinition {
  label: ChangeHistoryLabel;
}

export interface ChangeHistoryEntityTypeDefinition {
  label: ChangeHistoryLabel;
  /** Link target of an entry's entity, or `undefined` for no link. */
  route?: (entry: ChangeHistoryEntryData) => string | undefined;
}

export interface ChangeHistoryRegistry {
  /** entity type → field key → label */
  fieldLabels: Map<string, Map<string, ChangeHistoryLabel>>;
  valueRenderers: Map<string, ComponentType<ChangeHistoryValueRendererProps>>;
  valueTexts: Map<string, ChangeHistoryValueText>;
  detailRenderers: Map<string, ComponentType<ChangeHistoryDetailRendererProps>>;
  sources: Map<string, ChangeHistorySourceDefinition>;
  actions: Map<string, ChangeHistoryLabelDefinition>;
  batchKinds: Map<string, ChangeHistoryLabelDefinition>;
  entityTypes: Map<string, ChangeHistoryEntityTypeDefinition>;
}

/**
 * The store lives on `globalThis` under a registry-wide symbol, not in this module: in the Vite dev
 * server the host's import of `./dashboard` may be pre-bundled into a second copy of this file, and both
 * copies must see the same registrations.
 */
const REGISTRY_KEY = Symbol.for('@uplab/vendure-plugin-change-history/registry');

export function getChangeHistoryRegistry(): ChangeHistoryRegistry {
  const holder = globalThis as unknown as Record<symbol, ChangeHistoryRegistry | undefined>;
  let registry = holder[REGISTRY_KEY];
  if (!registry) {
    registry = {
      fieldLabels: new Map(),
      valueRenderers: new Map(),
      valueTexts: new Map(),
      detailRenderers: new Map(),
      sources: new Map(),
      actions: new Map(),
      batchKinds: new Map(),
      entityTypes: new Map(),
    };
    holder[REGISTRY_KEY] = registry;
  }
  return registry;
}
