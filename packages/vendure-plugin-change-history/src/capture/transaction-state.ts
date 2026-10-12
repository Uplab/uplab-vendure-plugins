import { ID } from '@vendure/core';
import type { ChannelEventRecord } from './channel-capture';
import type { EntryDraft } from './entry-writer.service';
import { LoadedState } from '../entity-definitions/entity-definition';
import { ChangeHistoryFieldChanges } from '../types';
import { Lru } from './lru';

/** Caps of the per-transaction maps: a long bulk operation must not grow them without bound. */
export const LAST_SEEN_CAPACITY = 500;
const ENTRIES_CAPACITY = 10_000;

/** A `created` entry this transaction wrote, as stored: what a later update of the entity is folded into. */
export interface CreatedEntry {
  id: ID;
  changes: ChangeHistoryFieldChanges | null;
  meta: Record<string, unknown>;
}

/**
 * What one database transaction has recorded so far: the derived rule (`entriesByEntity`), the entities
 * created in it (a variant's initial stock is not an adjustment), the last state of every entity it saved
 * (`lastSeen`: the "before" of a second save of the same entity in the same transaction), the `created` entries
 * a later update of their entity is folded into (`createdEntries`), and the batches whose head it wrote.
 *
 * The maps are read directly but **changed only through the methods**: each change is journaled at the
 * savepoint depth it was made in, so that a rolled-back savepoint takes its changes with it (no before-state
 * from a save that never happened, no derived link to an entry that was rolled back, no batch head assumed
 * written) while a released one hands them to its parent.
 */
export class TransactionState {
  readonly entriesByEntity = new Lru<string, ID>(ENTRIES_CAPACITY);
  readonly createdIds = new Lru<string, true>(ENTRIES_CAPACITY);
  readonly lastSeen: Lru<string, LoadedState>;
  /**
   * The `created` entry of each entity created in this transaction, as last written: an update of the entity
   * later in the transaction changes this entry instead of writing one of its own (capped like `lastSeen`).
   */
  readonly createdEntries: Lru<string, CreatedEntry>;
  /**
   * Keys whose `lastSeen` was evicted by the cap: the committed row is no before-state for them any more (it
   * would repeat this transaction's earlier changes), so a later save of a group `lastSeen` does not cover is
   * recorded without a diff (`meta.noBefore = "evicted"`).
   */
  readonly evicted = new Set<string>();
  /**
   * Collections found deleted by their membership event, written when core's `CollectionEvent deleted` of the
   * deleted collection follows (the deleted collection first, its descendants derived from it).
   */
  readonly collectionDeletions = new Map<string, EntryDraft>();
  /** Batch ids whose head entry this transaction wrote (or found written). */
  readonly batchHeads = new Set<string>();
  /**
   * Channel assignments heard in this transaction, written together when it commits: core announces a
   * product's variants and assets before the product, so only then is it known which entry caused which.
   */
  readonly channelEvents: ChannelEventRecord[] = [];
  /** The tail of the chain of the package's work on this transaction's connection (see `serialize`). */
  lock: Promise<void> = Promise.resolve();

  /** Undo actions per savepoint depth. */
  private readonly journal = new Map<number, Array<() => void>>();
  /** Work registered to run just before the transaction commits, by key (see `beforeCommit`). */
  private readonly commitHooks = new Map<string, () => Promise<void>>();

  /** `depth`: the transaction's current savepoint depth (1 = the transaction itself). */
  constructor(
    private readonly depth: () => number = () => 1,
    lastSeenCapacity = LAST_SEEN_CAPACITY,
  ) {
    this.lastSeen = new Lru(lastSeenCapacity, (key) => this.evicted.add(key));
    this.createdEntries = new Lru(lastSeenCapacity);
  }

  /** The latest entry written for `key` (`'Type:id'`). */
  remember(key: string, entryId: ID): void {
    this.track(this.entriesByEntity, key);
    this.entriesByEntity.set(key, entryId);
  }

  markCreated(key: string): void {
    this.track(this.createdIds, key);
    this.createdIds.set(key, true);
  }

  /** The `created` entry of `key` as it now stands in the database (written, or folded into). */
  recordCreated(key: string, entry: CreatedEntry): void {
    this.track(this.createdEntries, key);
    this.createdEntries.set(key, entry);
  }

  see(key: string, state: LoadedState): void {
    this.track(this.lastSeen, key);
    this.lastSeen.set(key, state);
  }

  forget(key: string): void {
    this.track(this.lastSeen, key);
    this.lastSeen.delete(key);
  }

  deferDeletion(collectionId: string, draft: EntryDraft): void {
    this.track(this.collectionDeletions, collectionId);
    this.collectionDeletions.set(collectionId, draft);
  }

  /** The deferred collection deletions, removed from the state. */
  takeDeletions(): Map<string, EntryDraft> {
    const taken = new Map(this.collectionDeletions);
    this.collectionDeletions.clear();
    this.journalAt(() => taken.forEach((draft, id) => this.collectionDeletions.set(id, draft)));
    return taken;
  }

  addChannelEvent(record: ChannelEventRecord): void {
    const length = this.channelEvents.length;
    this.channelEvents.push(record);
    this.journalAt(() => {
      this.channelEvents.length = length;
    });
  }

  /** The channel events heard so far, removed from the state. */
  takeChannelEvents(): ChannelEventRecord[] {
    const taken = this.channelEvents.splice(0);
    this.journalAt(() => this.channelEvents.unshift(...taken));
    return taken;
  }

  /**
   * Runs `hook` just before the transaction itself commits (not a savepoint), inside it; once per `key`
   * however often it is registered. A transaction that rolls back runs nothing.
   */
  beforeCommit(key: string, hook: () => Promise<void>): void {
    if (!this.commitHooks.has(key)) {
      this.commitHooks.set(key, hook);
    }
  }

  /** Runs the registered hooks one after another, each once (a hook may register another). */
  async runBeforeCommit(): Promise<void> {
    for (let next = this.commitHooks.entries().next(); !next.done; next = this.commitHooks.entries().next()) {
      const [key, hook] = next.value;
      this.commitHooks.delete(key);
      await hook();
    }
  }

  markHead(batchId: string): void {
    if (!this.batchHeads.has(batchId)) {
      this.batchHeads.add(batchId);
      this.journalAt(() => this.batchHeads.delete(batchId));
    }
  }

  /**
   * A savepoint (or the transaction) ended; `depth` is the depth after it. Released: its changes now belong
   * to the parent. Rolled back: its changes are undone, newest first.
   */
  ended(depth: number, committed: boolean): void {
    const levels = [...this.journal.keys()].filter((level) => level > depth).sort((a, b) => b - a);
    for (const level of levels) {
      const actions = this.journal.get(level)!;
      this.journal.delete(level);
      if (!committed) {
        for (let i = actions.length - 1; i >= 0; i--) {
          actions[i]();
        }
      } else if (depth >= 1) {
        this.journal.set(depth, [...(this.journal.get(depth) ?? []), ...actions]);
      }
    }
  }

  private track<V>(map: Lru<string, V> | Map<string, V>, key: string): void {
    const had = map.has(key);
    const previous = map instanceof Lru ? map.peek(key) : map.get(key);
    this.journalAt(() => (had ? map.set(key, previous as V) : map.delete(key)));
  }

  private journalAt(undo: () => void): void {
    const depth = this.depth();
    const actions = this.journal.get(depth);
    if (actions) {
      actions.push(undo);
    } else {
      this.journal.set(depth, [undo]);
    }
  }
}
