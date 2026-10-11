import { Inject, Injectable } from '@nestjs/common';
import {
  Asset,
  AssetChannelEvent,
  Channel,
  ID,
  ProductChannelEvent,
  ProductVariantChannelEvent,
  RequestContext,
} from '@vendure/core';
import { CHANGE_HISTORY_ACTIONS, CHANGE_HISTORY_PLUGIN_OPTIONS } from '../constants';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
import { BASE_GROUP, ChangeHistoryEntityDefinition } from '../entity-definitions/entity-definition';
import { ResolvedChangeHistoryPluginOptions } from '../types';
import { CapturePipeline } from './capture-pipeline';
import { ChangeHistoryWriter, logFailure } from './entry-writer.service';

type ChannelEvent = ProductChannelEvent | ProductVariantChannelEvent | AssetChannelEvent;

const BASE_SCOPE: ReadonlySet<string> = new Set([BASE_GROUP]);

/**
 * A product, variant or asset assigned to or removed from a channel: an action entry (`channel_assigned` /
 * `channel_removed`) with the channel's id and code in `meta`, no diff. Removing an asset from its last channel
 * is the first step of deleting it: that removal is left to the asset's `deleted` entry.
 */
@Injectable()
export class ChannelCapture {
  constructor(
    @Inject(CHANGE_HISTORY_PLUGIN_OPTIONS) private readonly options: ResolvedChangeHistoryPluginOptions,
    private readonly definitions: ChangeHistoryDefinitions,
    private readonly pipeline: CapturePipeline,
    private readonly writer: ChangeHistoryWriter,
  ) {}

  async record(event: ChannelEvent): Promise<void> {
    if (!this.options.enabled) {
      return;
    }
    const [definition, entityId] =
      event instanceof ProductChannelEvent
        ? [this.definitions.product, event.product.id]
        : event instanceof ProductVariantChannelEvent
          ? [this.definitions.productVariant, event.productVariant.id]
          : [this.definitions.asset, event.asset.id];
    const action =
      event.type === 'assigned' ? CHANGE_HISTORY_ACTIONS.channel_assigned : CHANGE_HISTORY_ACTIONS.channel_removed;
    try {
      await this.writer.write(
        event.ctx,
        `${action} ${definition.entityType}`,
        async (tctx) => {
          const manager = this.pipeline.managerOf(tctx);
          const id = String(entityId);
          if (event instanceof AssetChannelEvent && event.type === 'removed' && !(await this.inAnyChannel(tctx, id))) {
            return [];
          }
          const state = (await definition.load(tctx, [id], manager, BASE_SCOPE)).get(id);
          const channel = await manager.getRepository(Channel).findOne({
            where: { id: event.channelId },
            select: { id: true, code: true },
            loadEagerRelations: false,
          });
          const code = channel?.code ?? String(event.channelId);
          return [
            {
              entityType: definition.entityType,
              entityId: id,
              entityLabel: state?.label ?? id,
              action,
              summary: `${event.type === 'assigned' ? 'assigned to' : 'removed from'} channel ${code}`,
              parentType: parentTypeOf(definition, state?.parentId),
              parentId: state?.parentId ?? null,
              meta: { channelId: String(event.channelId), channelCode: code },
            },
          ];
        },
        { event },
      );
    } catch (e) {
      logFailure(action, e);
    }
  }

  private async inAnyChannel(ctx: RequestContext, assetId: ID): Promise<boolean> {
    const count = await this.pipeline
      .managerOf(ctx)
      .createQueryBuilder(Asset, 'asset')
      .innerJoin('asset.channels', 'channel')
      .where('asset.id = :assetId', { assetId })
      .getCount();
    return count > 0;
  }
}

function parentTypeOf(definition: ChangeHistoryEntityDefinition, parentId: string | undefined): string | null {
  return definition.parentType && parentId ? definition.parentType : null;
}
