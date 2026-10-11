import { Inject, Injectable } from '@nestjs/common';
import {
  AssetChannelEvent,
  AssetEvent,
  CollectionEvent,
  CollectionModificationEvent,
  EventBus,
  FacetEvent,
  FacetValueEvent,
  ProductChannelEvent,
  ProductEvent,
  ProductOptionGroupChangeEvent,
  ProductVariantChannelEvent,
  ProductVariantEvent,
  PromotionEvent,
  StockMovementEvent,
} from '@vendure/core';
import { CHANGE_HISTORY_ACTIONS, CHANGE_HISTORY_HANDLER_IDS, CHANGE_HISTORY_PLUGIN_OPTIONS } from '../constants';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
import { ResolvedChangeHistoryPluginOptions } from '../types';
import { CapturePipeline } from './capture-pipeline';
import { ChannelCapture } from './channel-capture';
import { CollectionCapture } from './collection-capture';
import { FacetCapture } from './facet-capture';
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
    private readonly collections: CollectionCapture,
    private readonly facets: FacetCapture,
    private readonly channels: ChannelCapture,
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
    this.eventBus.registerBlockingEventHandler({
      event: CollectionEvent,
      id: CHANGE_HISTORY_HANDLER_IDS.Collection,
      before: order.Collection?.before,
      after: order.Collection?.after,
      handler: (event: CollectionEvent) => this.collections.onCollectionEvent(event),
    });
    this.eventBus.registerBlockingEventHandler({
      event: CollectionModificationEvent,
      id: CHANGE_HISTORY_HANDLER_IDS.CollectionMembership,
      handler: (event: CollectionModificationEvent) => this.collections.onModification(event),
    });
    this.eventBus.registerBlockingEventHandler({
      event: FacetEvent,
      id: CHANGE_HISTORY_HANDLER_IDS.Facet,
      before: order.Facet?.before,
      after: order.Facet?.after,
      handler: (event: FacetEvent) => this.facets.onFacetEvent(event),
    });
    this.eventBus.registerBlockingEventHandler({
      event: FacetValueEvent,
      id: CHANGE_HISTORY_HANDLER_IDS.FacetValue,
      before: order.FacetValue?.before,
      after: order.FacetValue?.after,
      handler: (event: FacetValueEvent) => this.facets.onFacetValueEvent(event),
    });
    this.eventBus.registerBlockingEventHandler({
      event: AssetEvent,
      id: CHANGE_HISTORY_HANDLER_IDS.Asset,
      before: order.Asset?.before,
      after: order.Asset?.after,
      handler: (event: AssetEvent) =>
        this.pipeline.run(event.ctx, this.definitions.asset, [event.entity.id], {
          mode: event.type,
          action: event.type,
          input: event.input,
          event,
          // Hard-deleted before the event: without a before-state only the event's entity remains.
          entities: new Map([[String(event.entity.id), event.entity]]),
        }),
    });
    this.eventBus.registerBlockingEventHandler({
      event: PromotionEvent,
      id: CHANGE_HISTORY_HANDLER_IDS.Promotion,
      before: order.Promotion?.before,
      after: order.Promotion?.after,
      handler: (event: PromotionEvent) =>
        this.pipeline.run(event.ctx, this.definitions.promotion, [event.entity.id], {
          mode: event.type,
          action: event.type,
          input: event.input,
          event,
        }),
    });
    this.eventBus.registerBlockingEventHandler({
      event: [ProductChannelEvent, ProductVariantChannelEvent, AssetChannelEvent],
      id: CHANGE_HISTORY_HANDLER_IDS.Channel,
      handler: (event: ProductChannelEvent | ProductVariantChannelEvent | AssetChannelEvent) =>
        this.channels.record(event),
    });
  }
}
