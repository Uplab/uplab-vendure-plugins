import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@vendure/core';
import { CHANGE_HISTORY_PLUGIN_OPTIONS } from '../constants';
import { ChangeHistoryCoreEntityType, ResolvedChangeHistoryPluginOptions } from '../types';
import { productDefinition, productVariantDefinition } from './catalog-definitions';
import { ChangeHistoryEntityDefinition } from './entity-definition';

/** The capture definitions of the core entities, built once from the options and `config.customFields`. */
@Injectable()
export class ChangeHistoryDefinitions {
  readonly product: ChangeHistoryEntityDefinition;
  readonly productVariant: ChangeHistoryEntityDefinition;

  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) options: ResolvedChangeHistoryPluginOptions,
    configService: ConfigService,
  ) {
    const { customFields } = configService;
    this.product = productDefinition(options, customFields);
    this.productVariant = productVariantDefinition(options, customFields);
  }

  /** The definition of a type, or `undefined` for a type the package does not capture yet. */
  forType(entityType: ChangeHistoryCoreEntityType): ChangeHistoryEntityDefinition | undefined {
    switch (entityType) {
      case 'Product':
        return this.product;
      case 'ProductVariant':
        return this.productVariant;
      default:
        return undefined;
    }
  }
}
