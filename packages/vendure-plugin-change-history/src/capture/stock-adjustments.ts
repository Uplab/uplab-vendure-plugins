import { Inject, Injectable } from '@nestjs/common';
import { ID, ProductVariantPrice, StockLevel, StockLocation, StockMovement, StockMovementEvent } from '@vendure/core';
import { EntityManager, In } from 'typeorm';
import { chunks } from '../common/utils';
import { CHANGE_HISTORY_ACTIONS, CHANGE_HISTORY_PLUGIN_OPTIONS } from '../constants';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
import { BASE_GROUP } from '../entity-definitions/entity-definition';
import { ChangeHistoryContextService } from '../services/change-history-context.service';
import { ResolvedChangeHistoryPluginOptions } from '../types';
import { CapturePipeline } from './capture-pipeline';
import { ChangeHistoryWriter, EntryDraft, logFailure } from './entry-writer.service';

const BASE_SCOPE: ReadonlySet<string> = new Set([BASE_GROUP]);
/** `StockMovementType.ADJUSTMENT` (the enum lives in `@vendure/common`, which is not a peer of this package). */
const ADJUSTMENT = 'ADJUSTMENT';

/**
 * Manual stock changes: one `stock_adjusted` entry per `ADJUSTMENT` movement, with the location and
 * `from` → `to` of its stock on hand. Core publishes the event after it updated the stock level, so `to` is
 * the current value and `from = to − delta`. Sales, allocations and releases are not recorded, nor is the
 * initial stock of a variant that is being created (core adjusts it before the variant has prices, and before
 * the variant's `created` event).
 */
@Injectable()
export class StockAdjustmentCapture {
  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly context: ChangeHistoryContextService,
    private readonly definitions: ChangeHistoryDefinitions,
    private readonly pipeline: CapturePipeline,
    private readonly writer: ChangeHistoryWriter,
  ) {}

  async record(event: StockMovementEvent): Promise<void> {
    if (!this.options.enabled || event.type !== ADJUSTMENT) {
      return;
    }
    try {
      const transaction = this.context.transactionStateOf(event.ctx);
      await this.writer.write(
        event.ctx,
        CHANGE_HISTORY_ACTIONS.stock_adjusted,
        async (tctx) => {
          const movements = event.stockMovements.flatMap((movement) => {
            const variantId = movementVariantId(movement);
            const locationId = movement.stockLocationId ?? movement.stockLocation?.id;
            return movement.type === ADJUSTMENT &&
              variantId != null &&
              locationId != null &&
              !transaction.createdIds.has(`ProductVariant:${String(variantId)}`)
              ? [{ movement, variantId: String(variantId), locationId: String(locationId) }]
              : [];
          });
          if (movements.length === 0) {
            return [];
          }
          // One query per kind for the whole event, not four per movement: a bulk stock update of hundreds of
          // variants runs inside the host's transaction.
          const manager = this.pipeline.managerOf(tctx);
          const variantIds = [...new Set(movements.map((m) => m.variantId))];
          const locationIds = [...new Set(movements.map((m) => m.locationId))];
          const priced = await variantsWithPrices(manager, variantIds);
          const levels = await stockLevels(manager, variantIds, locationIds);
          const locations = await locationNames(manager, locationIds);
          const variants = await this.definitions.productVariant.load(tctx, variantIds, manager, BASE_SCOPE);
          const drafts: EntryDraft[] = [];
          for (const { movement, variantId, locationId } of movements) {
            // A variant being created has no price yet: this is its initial stock.
            if (!priced.has(variantId)) {
              continue;
            }
            const variant = variants.get(variantId);
            const to = levels.get(`${variantId}:${locationId}`) ?? movement.quantity;
            const from = to - movement.quantity;
            const locationName = locations.get(locationId) ?? locationId;
            drafts.push({
              entityType: 'ProductVariant',
              entityId: variantId,
              entityLabel: variant?.label ?? variantId,
              action: CHANGE_HISTORY_ACTIONS.stock_adjusted,
              summary: `stock ${locationName}: ${from} → ${to}`,
              parentType: variant?.parentId ? 'Product' : null,
              parentId: variant?.parentId ?? null,
              changes: {
                stock: {
                  kind: 'stock',
                  location: locationName,
                  locationId,
                  from,
                  to,
                  delta: movement.quantity,
                },
              },
            });
          }
          return drafts;
        },
        { event },
      );
    } catch (e) {
      logFailure(CHANGE_HISTORY_ACTIONS.stock_adjusted, e);
    }
  }
}

/** The ids among `variantIds` that have at least one price. */
async function variantsWithPrices(manager: EntityManager, variantIds: string[]): Promise<Set<string>> {
  const priced = new Set<string>();
  for (const chunk of chunks(variantIds)) {
    const rows = await manager
      .createQueryBuilder(ProductVariantPrice, 'price')
      .select('price.variantId', 'variantId')
      .where('price.variantId IN (:...ids)', { ids: chunk })
      .groupBy('price.variantId')
      .getRawMany<{ variantId: ID }>();
    rows.forEach((row) => priced.add(String(row.variantId)));
  }
  return priced;
}

/** Stock on hand by `variantId:locationId`. */
async function stockLevels(
  manager: EntityManager,
  variantIds: string[],
  locationIds: string[],
): Promise<Map<string, number>> {
  const levels = new Map<string, number>();
  for (const chunk of chunks(variantIds)) {
    const rows = await manager
      .createQueryBuilder(StockLevel, 'level')
      .select('level.productVariantId', 'variantId')
      .addSelect('level.stockLocationId', 'locationId')
      .addSelect('level.stockOnHand', 'stockOnHand')
      .where('level.productVariantId IN (:...variantIds)', { variantIds: chunk })
      .andWhere('level.stockLocationId IN (:...locationIds)', { locationIds })
      .getRawMany<{ variantId: ID; locationId: ID; stockOnHand: number | string }>();
    for (const row of rows) {
      levels.set(`${String(row.variantId)}:${String(row.locationId)}`, Number(row.stockOnHand));
    }
  }
  return levels;
}

async function locationNames(manager: EntityManager, locationIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const chunk of chunks(locationIds)) {
    const rows = await manager.find(StockLocation, { where: { id: In(chunk) }, select: { id: true, name: true } });
    rows.forEach((row) => names.set(String(row.id), row.name));
  }
  return names;
}

function movementVariantId(movement: StockMovement): ID | undefined {
  return (movement as StockMovement & { productVariantId?: ID }).productVariantId ?? movement.productVariant?.id;
}
