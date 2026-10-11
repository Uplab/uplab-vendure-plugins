import { ID, LanguageCode, RequestContext, Type } from '@vendure/core';
import { EntityManager, In } from 'typeorm';
import { CustomFieldSpec, normaliseCustomFieldValue, normaliseScalar } from '../custom-fields/custom-field-specs';
import { idsOfChange } from '../diff/diff';
import {
  ChangeHistoryCoreEntityType,
  ChangeHistoryEntityOverrides,
  ChangeHistoryFieldChange,
  ChangeHistoryFieldChanges,
  ChangeHistoryFieldExtractor,
  ChangeHistoryValueKind,
} from '../types';
import { BASE_GROUP, ChangeHistoryEntityDefinition, LoadedState } from './entity-definition';
import { labelsOf } from './labels';

/** Group of the relation custom fields (input key `customFields`). */
const RELATIONS_GROUP = 'relations';

export type LabelLoader = (
  ctx: RequestContext,
  manager: EntityManager,
  ids: string[],
) => Promise<Record<string, string>>;

/** A column of the entity's own row. */
interface ColumnField {
  key: string;
  kind: ChangeHistoryValueKind;
  read: (row: CatalogRow) => unknown;
  labels?: LabelLoader;
}

/** A relation loaded as its own query, only when the save could have changed it. */
export interface RelationGroup {
  /** Group name, also the key in the history view. */
  key: string;
  /** TypeORM relation property. */
  relation: string;
  /** Top-level mutation input keys that can change it. */
  inputKeys: string[];
  kind: ChangeHistoryValueKind;
  read: (row: CatalogRow) => unknown;
  labels?: LabelLoader;
  /** Ids to label in a change (default: the ids of the change itself). */
  labelIds?: (change: ChangeHistoryFieldChange) => string[];
}

export interface CatalogDefinitionConfig {
  entityType: ChangeHistoryCoreEntityType;
  entity: Type<unknown>;
  parentType?: ChangeHistoryCoreEntityType;
  parentId?: (row: CatalogRow) => ID | undefined;
  /** Translated fields and their kinds, e.g. `{ name: 'text', description: 'richtext' }`. */
  translatedFields: Record<string, ChangeHistoryValueKind>;
  columns: ColumnField[];
  relations: RelationGroup[];
  customFields: CustomFieldSpec[];
  extractors: ChangeHistoryFieldExtractor[];
  overrides: ChangeHistoryEntityOverrides;
  /** Default label (the host can override it through `entities.*.label`). */
  label: (row: CatalogRow, ctx: RequestContext) => string;
}

export type CatalogRow = Record<string, unknown> & {
  id: ID;
  deletedAt?: Date | null;
  translations?: Array<
    Record<string, unknown> & { languageCode: LanguageCode; customFields?: Record<string, unknown> }
  >;
  customFields?: Record<string, unknown>;
};

const extractorGroup = (key: string) => `extractor:${key}`;

/**
 * The definition shared by the translatable catalogue entities (Product, ProductVariant): own columns,
 * translations, custom fields (scalars on the row and the translations, relations as ids), relation groups
 * loaded on demand and host field extractors.
 */
export class CatalogEntityDefinition implements ChangeHistoryEntityDefinition {
  readonly entityType: ChangeHistoryCoreEntityType;
  readonly parentType?: ChangeHistoryCoreEntityType;
  readonly fullScope: ReadonlySet<string>;
  private readonly kinds = new Map<string, ChangeHistoryValueKind>();
  private readonly translatedKinds = new Map<string, ChangeHistoryValueKind>();
  private readonly groups = new Map<string, string>();
  private readonly labelLoaders = new Map<string, { load: LabelLoader; ids?: RelationGroup['labelIds'] }>();
  private readonly ignored: string[];

  constructor(private readonly config: CatalogDefinitionConfig) {
    this.entityType = config.entityType;
    this.parentType = config.parentType;
    const fieldKinds = config.overrides.fieldKinds ?? {};
    for (const [field, kind] of Object.entries(config.translatedFields)) {
      this.translatedKinds.set(field, kind);
    }
    for (const column of config.columns) {
      this.kinds.set(column.key, column.kind);
      if (column.labels) {
        this.labelLoaders.set(column.key, { load: column.labels });
      }
    }
    for (const relation of config.relations) {
      this.kinds.set(relation.key, relation.kind);
      this.groups.set(relation.key, relation.key);
      if (relation.labels) {
        this.labelLoaders.set(relation.key, { load: relation.labels, ids: relation.labelIds });
      }
    }
    for (const spec of config.customFields) {
      (spec.translatable ? this.translatedKinds : this.kinds).set(spec.key, spec.kind);
      if (spec.relation) {
        this.groups.set(spec.key, RELATIONS_GROUP);
        const target = spec.relation;
        this.labelLoaders.set(spec.key, { load: (ctx, manager, ids) => labelsOf(ctx, manager, target, ids) });
      }
    }
    for (const extractor of config.extractors) {
      this.kinds.set(extractor.key, extractor.kind);
      this.groups.set(extractor.key, extractorGroup(extractor.key));
      const { labels } = extractor;
      if (labels) {
        this.labelLoaders.set(extractor.key, {
          load: (ctx, manager, ids) => labels.call(extractor, ctx, ids, manager),
        });
      }
    }
    for (const [key, kind] of Object.entries(fieldKinds)) {
      (this.kinds.has(key) || !this.translatedKinds.has(key) ? this.kinds : this.translatedKinds).set(key, kind);
    }
    this.ignored = config.overrides.ignoreFields ?? [];
    this.fullScope = new Set([
      BASE_GROUP,
      ...config.relations.map((r) => r.key),
      ...(config.customFields.some((s) => s.relation) ? [RELATIONS_GROUP] : []),
      ...config.extractors.map((e) => extractorGroup(e.key)),
    ]);
  }

  scopeFor(input: unknown): Set<string> {
    const inputs = Array.isArray(input) ? input : [input];
    const keys = new Set(
      inputs.flatMap((item) => (item && typeof item === 'object' ? Object.keys(item as object) : [])),
    );
    if (keys.size === 0) {
      return new Set(this.fullScope);
    }
    const scope = new Set([BASE_GROUP]);
    for (const relation of this.config.relations) {
      if (relation.inputKeys.some((key) => keys.has(key))) {
        scope.add(relation.key);
      }
    }
    if (keys.has('customFields') && this.fullScope.has(RELATIONS_GROUP)) {
      scope.add(RELATIONS_GROUP);
    }
    for (const extractor of this.config.extractors) {
      if (!extractor.inputKeys || extractor.inputKeys.some((key) => keys.has(key))) {
        scope.add(extractorGroup(extractor.key));
      }
    }
    return scope;
  }

  groupOf(key: string): string {
    return this.groups.get(key) ?? BASE_GROUP;
  }

  kindOf(key: string): ChangeHistoryValueKind {
    return this.kinds.get(key) ?? this.translatedKinds.get(key.slice(0, key.lastIndexOf('.'))) ?? 'text';
  }

  async load(
    ctx: RequestContext,
    ids: ID[],
    manager: EntityManager,
    scope: ReadonlySet<string>,
  ): Promise<Map<string, LoadedState>> {
    const states = new Map<string, LoadedState>();
    if (ids.length === 0) {
      return states;
    }
    const rows = await this.loadRows(ids, manager, scope);

    const extracted = new Map<string, Map<string, unknown>>();
    for (const extractor of this.config.extractors) {
      if (scope.has(extractorGroup(extractor.key))) {
        extracted.set(extractor.key, await extractor.load(ctx, ids, manager));
      }
    }

    for (const row of rows) {
      const parentId = this.config.parentId?.(row);
      states.set(String(row.id), {
        values: this.normalise(row, scope, extracted),
        groups: scope,
        label: this.labelOf(row, ctx),
        parentId: parentId != null ? String(parentId) : undefined,
        deleted: row.deletedAt != null,
      });
    }
    return states;
  }

  /** One row as the flat history view: own columns, translations, custom fields, relations, extractors. */
  private normalise(
    row: CatalogRow,
    scope: ReadonlySet<string>,
    extracted: Map<string, Map<string, unknown>>,
  ): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const column of this.config.columns) {
      values[column.key] = normaliseScalar(column.read(row));
    }
    const translatedFields = Object.keys(this.config.translatedFields);
    const translatedCustomFields = this.config.customFields.filter((spec) => spec.translatable);
    for (const translation of row.translations ?? []) {
      const lang = translation.languageCode;
      for (const field of translatedFields) {
        values[`${field}.${lang}`] = normaliseScalar(translation[field]);
      }
      for (const spec of translatedCustomFields) {
        values[`${spec.key}.${lang}`] = normaliseScalar(translation.customFields?.[spec.name]);
      }
    }
    for (const spec of this.config.customFields) {
      if (!spec.translatable && (!spec.relation || scope.has(RELATIONS_GROUP))) {
        values[spec.key] = normaliseCustomFieldValue(spec, row.customFields?.[spec.name]);
      }
    }
    for (const relation of this.config.relations.filter((r) => scope.has(r.key))) {
      values[relation.key] = relation.read(row);
    }
    for (const [key, byId] of extracted) {
      values[key] = normaliseScalar(byId.get(String(row.id)));
    }
    for (const key of Object.keys(values).filter((k) => this.isIgnored(k))) {
      delete values[key];
    }
    return values;
  }

  private isIgnored(key: string): boolean {
    return this.ignored.some((ignored) => key === ignored || key.startsWith(`${ignored}.`));
  }

  async addLabels(ctx: RequestContext, manager: EntityManager, changes: ChangeHistoryFieldChanges): Promise<void> {
    for (const [key, change] of Object.entries(changes)) {
      const loader = this.labelLoaders.get(key);
      if (!loader) {
        continue;
      }
      const ids = (loader.ids ?? idsOfChange)(change);
      if (ids.length === 0) {
        continue;
      }
      const labels = await loader.load(ctx, manager, ids);
      if (Object.keys(labels).length > 0) {
        change.labels = labels;
      }
    }
  }

  /**
   * The rows with their translations, then each relation in scope — one `find` per relation, one after the
   * other. A single `find` with several relations would run its relation queries concurrently on the one
   * connection (TypeORM's `relationLoadStrategy: 'query'`), which `pg` deprecates.
   */
  private async loadRows(ids: ID[], manager: EntityManager, scope: ReadonlySet<string>): Promise<CatalogRow[]> {
    const repository = manager.getRepository(this.config.entity);
    const find = (relation: string) =>
      repository.find({
        where: { id: In(ids) },
        relations: [relation],
        loadEagerRelations: false,
        relationLoadStrategy: 'query',
      } as never) as Promise<CatalogRow[]>;
    const rows = await find('translations');
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const relations = this.config.relations.filter((r) => scope.has(r.key)).map((r) => r.relation);
    if (scope.has(RELATIONS_GROUP)) {
      relations.push(...this.config.customFields.filter((s) => s.relation).map((s) => `customFields.${s.name}`));
    }
    for (const relation of relations) {
      const [head, property] = relation.split('.');
      for (const partial of await find(relation)) {
        const row = byId.get(String(partial.id));
        if (!row) {
          continue;
        }
        if (property) {
          row[head] = { ...(row[head] as object), [property]: (partial[head] as Record<string, unknown>)?.[property] };
        } else {
          row[head] = partial[head];
        }
      }
    }
    return rows;
  }

  private labelOf(row: CatalogRow, ctx: RequestContext): string {
    const custom = this.config.overrides.label;
    if (custom) {
      try {
        const label = custom(row, ctx);
        if (typeof label === 'string' && label !== '') {
          return label;
        }
      } catch {
        // A failing host label falls back to the built-in one.
      }
    }
    return this.config.label(row, ctx);
  }
}
