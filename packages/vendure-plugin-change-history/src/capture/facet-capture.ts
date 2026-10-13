import { Inject, Injectable } from '@nestjs/common';
import { FacetEvent, FacetValue, FacetValueEvent, ID, Product, ProductVariant, RequestContext } from '@vendure/core';
import { EntityManager } from 'typeorm';
import { CHANGE_HISTORY_PLUGIN_OPTIONS } from '../constants';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
import { ChangeHistoryContextService } from '../services/change-history-context.service';
import { ChangeHistoryStrategies } from '../services/change-history-strategies.service';
import { ResolvedChangeHistoryPluginOptions } from '../types';
import { CapturePipeline } from './capture-pipeline';
import { logFailure } from './entry-writer.service';

type Usage = {
  usedByProducts: number;
  usedByVariants: number;
};

/**
 * Facets and facet values. A deleted value keeps how many products and variants used it
 * (`meta.usedByProducts` / `meta.usedByVariants`, from the committed rows — the transaction has already
 * removed them). Deleting a facet removes its values by a database cascade, without events: each value gets
 * its own `deleted` entry, derived from the facet's.
 */
@Injectable()
export class FacetCapture {
  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly context: ChangeHistoryContextService,
    private readonly strategies: ChangeHistoryStrategies,
    private readonly definitions: ChangeHistoryDefinitions,
    private readonly pipeline: CapturePipeline,
  ) {}

  async onFacetEvent(event: FacetEvent): Promise<void> {
    const { ctx, entity } = event;
    const id = String(entity.id);
    if (event.type !== 'deleted') {
      await this.pipeline.run(ctx, this.definitions.facet, [id], {
        mode: event.type,
        action: event.type,
        input: event.input,
        event,
      });
      return;
    }
    await this.pipeline.run(ctx, this.definitions.facet, [id], {
      mode: 'deleted',
      action: 'deleted',
      event,
      entities: new Map([[id, entity]]),
    });
    const values = entity.values ?? [];
    if (values.length > 0) {
      // Core loaded the values to check their usage; with the facet attached for the "Facet: Value" label.
      await this.deleteValues(
        event,
        values.map((value) => Object.assign(new FacetValue(value), { facet: entity })),
      );
    }
  }

  async onFacetValueEvent(event: FacetValueEvent): Promise<void> {
    const { ctx, entity } = event;
    if (event.type !== 'deleted') {
      await this.pipeline.run(ctx, this.definitions.facetValue, [entity.id], {
        mode: event.type,
        action: event.type,
        input: event.input,
        event,
      });
      return;
    }
    await this.deleteValues(event, [entity]);
  }

  private async deleteValues(event: FacetEvent | FacetValueEvent, values: FacetValue[]): Promise<void> {
    if (!this.options.enabled) {
      return;
    }
    try {
      const ids = values.map((value) => String(value.id));
      await this.pipeline.run(event.ctx, this.definitions.facetValue, ids, {
        mode: 'deleted',
        action: 'deleted',
        event,
        entities: new Map(values.map((value) => [String(value.id), value])),
        metaById: await this.usageOf(event.ctx, ids),
      });
    } catch (e) {
      logFailure('deleted FacetValue', e);
    }
  }

  /**
   * Products and variants that used each value, counted on the committed rows. Nothing without a before-state
   * or outside a transaction (the rows are gone by then).
   */
  private async usageOf(ctx: RequestContext, ids: string[]): Promise<Map<string, Usage>> {
    const usage = new Map<string, Usage>();
    if (!this.context.transactionOf(ctx)) {
      return usage;
    }
    const counted = await this.strategies.beforeState
      .withCommittedReader(ctx, async (manager) => ({
        products: await countUses(manager, Product, ids),
        variants: await countUses(manager, ProductVariant, ids),
      }))
      .catch(() => undefined);
    if (!counted || !('products' in counted)) {
      return usage;
    }
    for (const id of ids) {
      usage.set(id, { usedByProducts: counted.products.get(id) ?? 0, usedByVariants: counted.variants.get(id) ?? 0 });
    }
    return usage;
  }
}

/** Non-deleted products (or variants) per facet value id. */
async function countUses(
  manager: EntityManager,
  entity: typeof Product | typeof ProductVariant,
  ids: string[],
): Promise<Map<string, number>> {
  const rows = await manager
    .createQueryBuilder(entity, 'owner')
    .innerJoin('owner.facetValues', 'facetValue')
    .select('facetValue.id', 'id')
    .addSelect('COUNT(DISTINCT owner.id)', 'count')
    .where('facetValue.id IN (:...ids)', { ids })
    .andWhere('owner.deletedAt IS NULL')
    .groupBy('facetValue.id')
    .getRawMany<{ id: ID; count: string | number }>();
  return new Map(rows.map((row) => [String(row.id), Number(row.count)]));
}
