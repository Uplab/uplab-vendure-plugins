import {
  Asset,
  Collection,
  Facet,
  FacetValue,
  Product,
  ProductVariant,
  Promotion,
  RequestContext,
  Type,
} from '@vendure/core';
import { EntityManager, In } from 'typeorm';
import { chunks } from '../common/utils';
import { labelsOf } from '../entity-definitions/labels';

/** The recorded types that are core tables, with the relation that prefixes their label. */
const CORE_ENTITIES: Record<string, { entity: Type<unknown>; parent?: string }> = {
  Product: { entity: Product },
  ProductVariant: { entity: ProductVariant },
  Collection: { entity: Collection },
  Facet: { entity: Facet },
  FacetValue: { entity: FacetValue, parent: 'facet' },
  Asset: { entity: Asset },
  Promotion: { entity: Promotion },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EntityRef {
  entityType: string;
  entityId: string;
}

export const refKey = (ref: EntityRef) => `${ref.entityType}:${ref.entityId}`;

/** The ids of `refs` per core type, limited to values its primary key can hold (`entityId` is a varchar). */
function idsByType(manager: EntityManager, refs: EntityRef[]): Array<[string, Type<unknown>, string[], string?]> {
  const result: Array<[string, Type<unknown>, string[], string?]> = [];
  for (const [type, { entity, parent }] of Object.entries(CORE_ENTITIES)) {
    const ids = [...new Set(refs.filter((ref) => ref.entityType === type).map((ref) => ref.entityId))];
    if (ids.length === 0) {
      continue;
    }
    const keyType = String(manager.connection.getMetadata(entity).primaryColumns[0].type);
    const usable = ids.filter((id) =>
      /int|number/i.test(keyType) ? /^\d+$/.test(id) : keyType === 'uuid' ? UUID.test(id) : true,
    );
    result.push([type, entity, usable, parent]);
  }
  return result;
}

/**
 * Keys (`Type:id`) of the core entities among `refs` that no longer exist or are soft-deleted. Other types
 * (batches, runs, host types) are never reported. One query per type and chunk.
 */
export async function deletedRefs(manager: EntityManager, refs: EntityRef[]): Promise<Set<string>> {
  const deleted = new Set<string>();
  for (const [type, entity, ids] of idsByType(manager, refs)) {
    const softDeletable = !!manager.connection.getMetadata(entity).findColumnWithPropertyName('deletedAt');
    const alive = new Set<string>();
    for (const chunk of chunks(ids)) {
      const query = manager
        .getRepository(entity)
        .createQueryBuilder('row')
        .select('row.id', 'id')
        .where({ id: In(chunk) });
      if (softDeletable) {
        query.andWhere('row.deletedAt IS NULL');
      }
      for (const row of await query.getRawMany<{ id: unknown }>()) {
        alive.add(String(row.id));
      }
    }
    for (const ref of refs) {
      if (ref.entityType === type && !alive.has(ref.entityId)) {
        deleted.add(refKey(ref));
      }
    }
  }
  return deleted;
}

export interface RefLabel {
  label?: string;
  sku?: string;
}

/**
 * Current labels of the core entities among `refs`, in the request's language: the name (a facet value as
 * "Facet: Value"), plus the SKU of a variant. Soft-deleted rows are labelled too; ids that are gone get none.
 */
export async function currentLabels(
  ctx: RequestContext,
  manager: EntityManager,
  refs: EntityRef[],
): Promise<Map<string, RefLabel>> {
  const result = new Map<string, RefLabel>();
  for (const [type, entity, ids, parent] of idsByType(manager, refs)) {
    for (const chunk of chunks(ids)) {
      const labels = await labelsOf(ctx, manager, entity, chunk, parent);
      for (const [id, label] of Object.entries(labels)) {
        result.set(`${type}:${id}`, { label });
      }
      if (entity === ProductVariant) {
        const rows = await manager
          .getRepository(ProductVariant)
          .createQueryBuilder('variant')
          .select('variant.id', 'id')
          .addSelect('variant.sku', 'sku')
          .where({ id: In(chunk) })
          .getRawMany<{ id: unknown; sku: string }>();
        for (const row of rows) {
          const key = `${type}:${String(row.id)}`;
          result.set(key, { ...result.get(key), sku: row.sku });
        }
      }
    }
  }
  return result;
}
