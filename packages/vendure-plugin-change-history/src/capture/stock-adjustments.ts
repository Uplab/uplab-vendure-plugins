import { Inject, Injectable } from '@nestjs/common';
import { ID, ProductVariantPrice, StockLevel, StockLocation, StockMovement, StockMovementEvent } from '@vendure/core';
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
          const manager = this.pipeline.managerOf(tctx);
          const drafts: EntryDraft[] = [];
          for (const movement of event.stockMovements) {
            const variantId = movementVariantId(movement);
            const locationId = movement.stockLocationId ?? movement.stockLocation?.id;
            if (
              movement.type !== ADJUSTMENT ||
              variantId == null ||
              locationId == null ||
              transaction.createdIds.has(`ProductVariant:${String(variantId)}`) ||
              // A variant being created has no price yet: this is its initial stock.
              (await manager.count(ProductVariantPrice, { where: { variant: { id: variantId } } })) === 0
            ) {
              continue;
            }
            const [level, location, variant] = [
              await manager.findOne(StockLevel, {
                where: { productVariantId: variantId, stockLocationId: locationId },
              }),
              await manager.findOne(StockLocation, { where: { id: locationId } }),
              (await this.definitions.productVariant.load(tctx, [variantId], manager, BASE_SCOPE)).get(
                String(variantId),
              ),
            ];
            const to = level?.stockOnHand ?? movement.quantity;
            const from = to - movement.quantity;
            const locationName = location?.name ?? String(locationId);
            drafts.push({
              entityType: 'ProductVariant',
              entityId: String(variantId),
              entityLabel: variant?.label ?? String(variantId),
              action: CHANGE_HISTORY_ACTIONS.stock_adjusted,
              summary: `stock ${locationName}: ${from} → ${to}`,
              parentType: variant?.parentId ? 'Product' : null,
              parentId: variant?.parentId ?? null,
              changes: {
                stock: {
                  kind: 'stock',
                  location: locationName,
                  locationId: String(locationId),
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

function movementVariantId(movement: StockMovement): ID | undefined {
  return (movement as StockMovement & { productVariantId?: ID }).productVariantId ?? movement.productVariant?.id;
}
