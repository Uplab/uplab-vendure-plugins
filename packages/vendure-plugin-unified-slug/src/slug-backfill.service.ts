import { Injectable } from '@nestjs/common';
import { CollectionTranslation, ProductTranslation, RequestContext, TransactionalConnection } from '@vendure/core';
import { type BackfillEntity, type BackfillRow, planSlugBackfill, type SlugBackfillEntry } from './plan-slug-backfill';
import { SlugGenerationService } from './slug-generation.service';
import type { UnifiedSlugEntityName } from './types';

/**
 * @description
 * What {@link backfillUnifiedSlugs} did, or would do on a dry run. Entities already on one slug are
 * not listed.
 */
export interface SlugBackfillReport {
  dryRun: boolean;
  scanned: number;
  filled: number;
  rewritten: number;
  generated: number;
  conflicts: number;
  noSlug: number;
  entries: Array<SlugBackfillEntry & { entityName: UnifiedSlugEntityName }>;
}

interface RawRow extends BackfillRow {
  baseId: BackfillEntity['id'];
}

const TRANSLATION_ENTITIES = { Product: ProductTranslation, Collection: CollectionTranslation } as const;

/**
 * Brings rows written before the plugin onto one slug per entity. Reads and writes go through the
 * caller's transaction (`ctx`), so a real run is all or nothing.
 */
@Injectable()
export class SlugBackfillService {
  constructor(
    private readonly connection: TransactionalConnection,
    private readonly slugGenerationService: SlugGenerationService,
  ) {}

  async backfill(
    ctx: RequestContext,
    options: { entityNames: readonly UnifiedSlugEntityName[]; dryRun: boolean },
  ): Promise<SlugBackfillReport> {
    const report: SlugBackfillReport = {
      dryRun: options.dryRun,
      scanned: 0,
      filled: 0,
      rewritten: 0,
      generated: 0,
      conflicts: 0,
      noSlug: 0,
      entries: [],
    };
    const counters = {
      FILLED: 'filled',
      REWRITTEN: 'rewritten',
      GENERATED: 'generated',
      CONFLICT: 'conflicts',
      NO_SLUG: 'noSlug',
    } as const;

    for (const entityName of options.entityNames) {
      const entities = await this.loadEntities(ctx, entityName);
      report.scanned += entities.length;
      const entries = await planSlugBackfill(entities, ctx.channel.defaultLanguageCode, (entityId, nameRow) =>
        nameRow?.name
          ? this.slugGenerationService.generate(ctx, { entityName, name: nameRow.name, entityId, context: {} })
          : Promise.resolve(''),
      );
      for (const entry of entries) {
        report[counters[entry.outcome]]++;
        report.entries.push({ ...entry, entityName });
        if (!options.dryRun && entry.slug && entry.rowIds.length > 0) {
          await this.connection
            .getRepository(ctx, TRANSLATION_ENTITIES[entityName])
            .createQueryBuilder()
            .update()
            .set({ slug: entry.slug })
            .whereInIds(entry.rowIds)
            .execute();
        }
      }
    }
    return report;
  }

  /** Every translation row, grouped by entity. Soft-deleted products and the root collection are skipped. */
  private async loadEntities(ctx: RequestContext, entityName: UnifiedSlugEntityName): Promise<BackfillEntity[]> {
    const qb = this.connection
      .getRepository(ctx, TRANSLATION_ENTITIES[entityName])
      .createQueryBuilder('translation')
      .innerJoin('translation.base', 'base')
      .select('translation.id', 'id')
      .addSelect('base.id', 'baseId')
      .addSelect('translation.languageCode', 'languageCode')
      .addSelect('translation.slug', 'slug')
      .addSelect('translation.name', 'name')
      .orderBy('base.id', 'ASC')
      .addOrderBy('translation.languageCode', 'ASC');
    if (entityName === 'Product') {
      qb.where('base.deletedAt IS NULL');
    } else {
      qb.where('base.isRoot = :isRoot', { isRoot: false });
    }
    const rows = await qb.getRawMany<RawRow>();

    const byEntity = new Map<string, BackfillEntity>();
    for (const { baseId, ...row } of rows) {
      const entity = byEntity.get(String(baseId)) ?? { id: baseId, rows: [] };
      entity.rows.push(row);
      byEntity.set(String(baseId), entity);
    }
    return [...byEntity.values()];
  }
}
