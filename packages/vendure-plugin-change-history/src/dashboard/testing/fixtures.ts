import type { ChangeHistoryEntryData } from '../registry';

/** An entry as the API returns it: a person's product update unless `over` says otherwise. */
export function entry(over: Partial<ChangeHistoryEntryData> = {}): ChangeHistoryEntryData {
  return {
    id: '1',
    createdAt: '2026-10-12T08:00:00.000Z',
    entityType: 'Product',
    entityId: '1',
    entityLabel: 'Oversize tee',
    parentType: null,
    parentId: null,
    action: 'updated',
    source: 'admin',
    actorType: 'admin',
    actorId: '1',
    actorLabel: 'Іван Петренко',
    batchId: null,
    derivedFromId: null,
    changes: null,
    meta: {},
    summary: '',
    compactedAt: null,
    isCompacted: false,
    derivedCount: 0,
    batchCounts: null,
    entityDeleted: false,
    parentDeleted: false,
    ...over,
  };
}

/** The entry window's query result: the entry with empty pages of derived entries and batch members. */
export function dialogData(value: ChangeHistoryEntryData | null, members: ChangeHistoryEntryData[] = []) {
  return {
    changeHistoryEntry: value && {
      ...value,
      derivedEntries: { items: [], totalItems: 0 },
      batchMembers: { items: members, totalItems: members.length },
    },
  };
}
