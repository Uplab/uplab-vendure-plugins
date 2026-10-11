import { RequestContext } from '@vendure/core';
import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { readChangeHistory } from '../constants';

/** `Permission.SuperAdmin` (the enum lives in `@vendure/common`, which is not a peer of this package). */
const SUPER_ADMIN = 'SuperAdmin';

/**
 * The channels whose entries `ctx` may read: every channel in which the active user holds `ReadChangeHistory`.
 * `undefined` means all of them, entries without a channel included: a SuperAdmin, or code running without a
 * user (a job, a scheduled task, the host's own call with a system context).
 */
export function readableChannelIds(ctx: RequestContext): string[] | undefined {
  const user = ctx.session?.user;
  if (!user) {
    return undefined;
  }
  const channels = user.channelPermissions ?? [];
  const holds = (permissions: readonly string[], permission: string) => permissions.includes(permission);
  if (channels.some((channel) => holds(channel.permissions, SUPER_ADMIN))) {
    return undefined;
  }
  return channels
    .filter((channel) => holds(channel.permissions, readChangeHistory.Permission))
    .map((channel) => String(channel.id));
}

/** Narrows `query` to the entries (`alias`) of `channels`; nothing at all for an empty list. */
export function inChannels<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  alias: string,
  channels: string[] | undefined,
): SelectQueryBuilder<T> {
  if (!channels) {
    return query;
  }
  if (channels.length === 0) {
    return query.andWhere('1 = 0');
  }
  return query.andWhere(`${alias}.channelId IN (:...chReadableChannels)`, { chReadableChannels: channels });
}

/** A cache key per channel scope. */
export function scopeKey(channels: string[] | undefined): string {
  return channels ? [...channels].sort().join(',') : '*';
}
