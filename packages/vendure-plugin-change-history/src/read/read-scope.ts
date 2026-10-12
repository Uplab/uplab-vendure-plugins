import { RequestContext } from '@vendure/core';
import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { readChangeHistory } from '../constants';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';

/** `Permission.SuperAdmin` (the enum lives in `@vendure/common`, which is not a peer of this package). */
const SUPER_ADMIN = 'SuperAdmin';

/** Channels in which the reader may read the same entity types: every type except `deniedTypes`. */
interface ReadScopeGroup {
  channelIds: string[];
  /** Sorted. */
  deniedTypes: string[];
}

/**
 * What a reader may see: per channel in which they hold `ReadChangeHistory`, the entity types whose read
 * permission they lack there. `undefined` means everything, entries without a channel included.
 */
export type ReadScope = ReadScopeGroup[] | undefined;

/** The entity types a channel's `permissions` cannot read: those whose required permissions it holds none of. */
function deniedIn(permissions: readonly string[], readPermissions: Readonly<Record<string, readonly string[]>>) {
  return Object.entries(readPermissions)
    .filter(([, required]) => required.length > 0 && !required.some((permission) => permissions.includes(permission)))
    .map(([type]) => type)
    .sort();
}

/**
 * The scope of `ctx`'s user: the channels in which they hold `ReadChangeHistory`, and in each the entity types
 * whose read permission (`readPermissions`, any one of the listed ones) they hold too. `undefined` — everything —
 * for a SuperAdmin and for code running without a user (a job, a scheduled task, the host's own call with a
 * system context).
 */
export function readScopeOf(
  ctx: RequestContext,
  readPermissions: Readonly<Record<string, readonly string[]>>,
): ReadScope {
  const user = ctx.session?.user;
  if (!user) {
    return undefined;
  }
  // Core types `permissions` as its `Permission` enum; custom permissions are plain strings in it too.
  const channels = (user.channelPermissions ?? []).map((channel) => ({
    id: String(channel.id),
    permissions: channel.permissions as readonly string[],
  }));
  if (channels.some((channel) => channel.permissions.includes(SUPER_ADMIN))) {
    return undefined;
  }
  const groups = new Map<string, ReadScopeGroup>();
  for (const channel of channels) {
    if (!channel.permissions.includes(readChangeHistory.Permission)) {
      continue;
    }
    const deniedTypes = deniedIn(channel.permissions, readPermissions);
    const key = deniedTypes.join(',');
    const group = groups.get(key) ?? { channelIds: [], deniedTypes };
    group.channelIds.push(channel.id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Narrows `query` to the rows `scope` may read: `channel` is the column holding the entry's channel, `type`
 * the one holding the entity type checked against the read permissions (a run's detail rows are checked by
 * their own type, in the channel of their run). Nothing at all for an empty scope; `prefix` keeps the
 * parameters of two calls on one query apart.
 */
export function inScope<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  columns: { channel: string; type: string },
  scope: ReadScope,
  prefix = 'chScope',
): SelectQueryBuilder<T> {
  if (!scope) {
    return query;
  }
  if (scope.length === 0) {
    return query.andWhere('1 = 0');
  }
  const params: Record<string, string[]> = {};
  const clauses = scope.map((group, index) => {
    params[`${prefix}C${index}`] = group.channelIds;
    let clause = `${columns.channel} IN (:...${prefix}C${index})`;
    if (group.deniedTypes.length > 0) {
      params[`${prefix}T${index}`] = group.deniedTypes;
      clause += ` AND ${columns.type} NOT IN (:...${prefix}T${index})`;
    }
    return `(${clause})`;
  });
  return query.andWhere(clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`, params);
}

/** The columns of an entry aliased `entry` that the read scope checks. */
export const ENTRY_COLUMNS = { channel: 'entry.channelId', type: 'entry.entityType' };

/**
 * Narrows detail rows (aliased `detail`) to those `scope` may read: their run (joined as `run`) and each row's
 * own entity type, both in the run's channel.
 */
export function inRunScope<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  scope: ReadScope,
): SelectQueryBuilder<T> {
  if (!scope) {
    return query;
  }
  query.innerJoin(ChangeHistoryEntry, 'run', 'run.id = detail.entryId');
  inScope(query, { channel: 'run.channelId', type: 'run.entityType' }, scope, 'chRun');
  return inScope(query, { channel: 'run.channelId', type: 'detail.entityType' }, scope, 'chRow');
}

/** The entity types `scope` may not read in `channelId`; `null` when it may not read that channel at all. */
export function deniedTypesIn(scope: ReadScope, channelId: string | null): string[] | null {
  if (!scope) {
    return [];
  }
  const group = channelId == null ? undefined : scope.find((g) => g.channelIds.includes(String(channelId)));
  return group ? group.deniedTypes : null;
}

/** Whether `scope` may read an entry of `entityType` in `channelId`. */
export function scopeAllows(scope: ReadScope, channelId: string | null, entityType: string): boolean {
  const denied = deniedTypesIn(scope, channelId);
  return denied !== null && !denied.includes(entityType);
}

/** A cache key per scope. */
export function scopeKey(scope: ReadScope): string {
  if (!scope) {
    return '*';
  }
  return scope
    .map((group) => `${[...group.channelIds].sort().join(',')}/${group.deniedTypes.join(',')}`)
    .sort()
    .join('|');
}
