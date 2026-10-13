import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@vendure/core';
import { CHANGE_HISTORY_PLUGIN_OPTIONS } from '../constants';
import { ChangeHistoryCoreEntityType, ResolvedChangeHistoryPluginOptions } from '../types';
import {
  assetDefinition,
  collectionDefinition,
  facetDefinition,
  facetValueDefinition,
  productDefinition,
  productVariantDefinition,
  promotionDefinition,
} from './catalog-definitions';
import { ChangeHistoryEntityDefinition } from './entity-definition';

/** The capture definitions of the core entities, built once from the options and `config.customFields`. */
@Injectable()
export class ChangeHistoryDefinitions {
  readonly product: ChangeHistoryEntityDefinition;
  readonly productVariant: ChangeHistoryEntityDefinition;
  readonly collection: ChangeHistoryEntityDefinition;
  readonly facet: ChangeHistoryEntityDefinition;
  readonly facetValue: ChangeHistoryEntityDefinition;
  readonly promotion: ChangeHistoryEntityDefinition;
  readonly asset: ChangeHistoryEntityDefinition;
  private readonly byType: Map<string, ChangeHistoryEntityDefinition>;

  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) options: ResolvedChangeHistoryPluginOptions,
    configService: ConfigService,
  ) {
    const { customFields } = configService;
    this.product = productDefinition(options, customFields);
    this.productVariant = productVariantDefinition(options, customFields);
    this.collection = collectionDefinition(options, customFields);
    this.facet = facetDefinition(options, customFields);
    this.facetValue = facetValueDefinition(options, customFields);
    this.promotion = promotionDefinition(options, customFields);
    this.asset = assetDefinition(options, customFields);
    this.byType = new Map<string, ChangeHistoryEntityDefinition>(
      Object.entries({
        Product: this.product,
        ProductVariant: this.productVariant,
        Collection: this.collection,
        Facet: this.facet,
        FacetValue: this.facetValue,
        Promotion: this.promotion,
        Asset: this.asset,
      }),
    );
  }

  /** The definition of a core type, or `undefined` for a type the package does not know. */
  forType(entityType: ChangeHistoryCoreEntityType): ChangeHistoryEntityDefinition | undefined {
    return this.byType.get(entityType);
  }
}
