import { OnModuleInit } from '@nestjs/common';
import {
  EventBus,
  ID,
  PluginCommonModule,
  Product,
  ProductEvent,
  ProductVariant,
  ProductVariantEvent,
  ProductVariantService,
  TransactionalConnection,
  VendurePlugin,
} from '@vendure/core';
import { IsNull } from 'typeorm';
import { CHANGE_HISTORY_HANDLER_IDS } from '../../src';

export const FAN_OUT_HANDLER_ID = 'test-fanout';
export const VARIANT_FAN_OUT_HANDLER_ID = 'test-variant-fanout';
/** `updateProduct` with this name fails in a handler that runs after the history handler. */
export const ROLLBACK_NAME = 'Rollback me';

type PriceInput = { customFields?: { price?: number | null } };

/**
 * A host plugin like a "product price" plugin: a price set on the product is copied to every variant from a
 * blocking ProductEvent handler (nested variant saves), and a new variant gets the product's price from a
 * blocking ProductVariantEvent handler. Registered in `onModuleInit`, i.e. before the change history's
 * handlers — the history must still run first (`handlerOrder`).
 */
@VendurePlugin({ imports: [PluginCommonModule], compatibility: '^3.7.0' })
export class FanOutTestPlugin implements OnModuleInit {
  constructor(
    private readonly eventBus: EventBus,
    private readonly connection: TransactionalConnection,
    private readonly variants: ProductVariantService,
  ) {}

  onModuleInit(): void {
    this.eventBus.registerBlockingEventHandler({
      event: ProductEvent,
      id: FAN_OUT_HANDLER_ID,
      handler: async (event) => {
        const price = (event.input as PriceInput | undefined)?.customFields?.price;
        if (event.type !== 'updated' || price == null) {
          return;
        }
        const variants = await this.connection
          .getRepository(event.ctx, ProductVariant)
          .find({ where: { productId: event.entity.id, deletedAt: IsNull() } });
        if (variants.length > 0) {
          await this.variants.update(
            event.ctx,
            variants.map((variant) => ({ id: variant.id, price })),
          );
        }
      },
    });
    this.eventBus.registerBlockingEventHandler({
      event: ProductVariantEvent,
      id: VARIANT_FAN_OUT_HANDLER_ID,
      handler: async (event) => {
        if (event.type !== 'created') {
          return;
        }
        const updates: Array<{ id: ID; price: number }> = [];
        for (const variant of event.entity) {
          const product = await this.connection
            .getRepository(event.ctx, Product)
            .findOne({ where: { id: variant.productId } });
          const price = (product?.customFields as { price?: number | null } | undefined)?.price;
          if (price != null) {
            updates.push({ id: variant.id, price });
          }
        }
        if (updates.length > 0) {
          await this.variants.update(event.ctx, updates);
        }
      },
    });
    this.eventBus.registerBlockingEventHandler({
      event: ProductEvent,
      id: 'test-rollback',
      after: CHANGE_HISTORY_HANDLER_IDS.Product,
      handler: (event) => {
        const translations = (event.input as { translations?: Array<{ name?: string }> } | undefined)?.translations;
        if (translations?.some((t) => t.name === ROLLBACK_NAME)) {
          throw new Error('host handler failed after the history handler');
        }
      },
    });
  }
}
