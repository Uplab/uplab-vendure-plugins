import { Inject, Injectable } from '@nestjs/common';
import {
  EventBus,
  ProductEvent,
  ProductOptionGroupChangeEvent,
  ProductVariantEvent,
  StockMovementEvent,
} from '@vendure/core';
import { CHANGE_HISTORY_ACTIONS, CHANGE_HISTORY_HANDLER_IDS, CHANGE_HISTORY_PLUGIN_OPTIONS } from '../constants';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
import { ResolvedChangeHistoryPluginOptions } from '../types';
import { CapturePipeline } from './capture-pipeline';
import { StockAdjustmentCapture } from './stock-adjustments';

/**
 * Observer: the package's blocking event handlers. Blocking handlers run inside the publishing
 * transaction, before it commits — the only place where the request context and a committed "before"
 * coincide. Registered on the server and on the worker (both bootstrap the plugin). Each handler is
 * wrapped so that it can never fail the host's operation.
 */
@Injectable()
export class ChangeHistoryEventHandlers {
  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly eventBus: EventBus,
    private readonly definitions: ChangeHistoryDefinitions,
    private readonly pipeline: CapturePipeline,
    private readonly stock: StockAdjustmentCapture,
  ) {}

  register(): void {
    const order = this.options.handlerOrder;
    this.eventBus.registerBlockingEventHandler({
      event: ProductEvent,
      id: CHANGE_HISTORY_HANDLER_IDS.Product,
      before: order.Product?.before,
      after: order.Product?.after,
      handler: (event: ProductEvent) =>
        this.pipeline.run(event.ctx, this.definitions.product, [event.entity.id], {
          mode: event.type,
          action: event.type,
          input: event.input,
          event,
        }),
    });
    this.eventBus.registerBlockingEventHandler({
      event: ProductVariantEvent,
      id: CHANGE_HISTORY_HANDLER_IDS.ProductVariant,
      before: order.ProductVariant?.before,
      after: order.ProductVariant?.after,
      handler: (event: ProductVariantEvent) =>
        this.pipeline.run(
          event.ctx,
          this.definitions.productVariant,
          event.entity.map((variant) => variant.id),
          { mode: event.type, action: event.type, input: event.input, event },
        ),
    });
    this.eventBus.registerBlockingEventHandler({
      event: ProductOptionGroupChangeEvent,
      id: CHANGE_HISTORY_HANDLER_IDS.ProductOptionGroup,
      handler: (event: ProductOptionGroupChangeEvent) =>
        this.pipeline.run(event.ctx, this.definitions.product, [event.product.id], {
          mode: 'updated',
          action:
            event.type === 'assigned'
              ? CHANGE_HISTORY_ACTIONS.option_group_added
              : CHANGE_HISTORY_ACTIONS.option_group_removed,
          input: { optionGroupIds: [event.optionGroupId] },
          event,
        }),
    });
    this.eventBus.registerBlockingEventHandler({
      event: StockMovementEvent,
      id: CHANGE_HISTORY_HANDLER_IDS.StockMovement,
      handler: (event: StockMovementEvent) => this.stock.record(event),
    });
  }
}
