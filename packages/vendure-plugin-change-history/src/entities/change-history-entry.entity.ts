import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';
import { ChangeHistoryFieldChanges } from '../types';

/**
 * @description
 * One recorded change: an entity created / updated / deleted / moved, an action-only entry, the head of
 * a batch (`entityType = 'Batch'`) or an external run (`entityType = 'Run'`).
 *
 * Portable across Postgres, MySQL and SQLite: plain varchar columns, `simple-json`, no foreign keys to
 * core tables (entities and administrators may be deleted; their labels are snapshots), plain composite
 * indexes. The host generates the migration.
 */
@Entity()
@Index(['entityType', 'entityId', 'createdAt', 'id'])
@Index(['parentType', 'parentId', 'createdAt', 'id'])
@Index(['createdAt', 'id'])
@Index(['actorId', 'createdAt'])
@Index(['batchId'])
@Index(['derivedFromId'])
@Index(['actorType', 'createdAt'])
@Index(['compactedAt', 'createdAt', 'id'])
export class ChangeHistoryEntry extends VendureEntity {
  constructor(input?: DeepPartial<ChangeHistoryEntry>) {
    super(input);
  }

  /** `Product`, `ProductVariant`, …, `Batch`, `Run`, or a host type. */
  @Column({ type: 'varchar', length: 32 })
  entityType: string;

  /** A string, so that it works with any id strategy. */
  @Column({ type: 'varchar', length: 36 })
  entityId: string;

  /** Snapshot of the entity's name at the time of the change. */
  @Column({ type: 'varchar', length: 255 })
  entityLabel: string;

  /**
   * What a run was about (`recordRun`'s `subject.label`, e.g. an order code): searchable like `entityLabel`.
   * `null` for every other entry.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  subjectLabel: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  parentType: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  parentId: string | null;

  @Column({ type: 'varchar', length: 32 })
  action: string;

  @Column({ type: 'varchar', length: 32 })
  source: string;

  /** `admin` · `api_key` · `system`. */
  @Column({ type: 'varchar', length: 16 })
  actorType: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  actorId: string | null;

  /** Snapshot of the actor's name. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  actorLabel: string | null;

  /** `<kind>:<uuid>` of the batch this entry belongs to. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  batchId: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  channelId: string | null;

  /** `null` only together with `meta.noBefore`, or on entries that carry no diff. */
  @Column({ type: 'simple-json', nullable: true })
  changes: ChangeHistoryFieldChanges | null;

  /** The entry, written earlier in the same request, that caused this one. */
  @EntityId({ nullable: true })
  derivedFromId: ID | null;

  @Column({ type: 'simple-json' })
  meta: Record<string, unknown>;

  @Column({ type: 'varchar', length: 512 })
  summary: string;

  /** Set by compaction; `null` while the full detail is present. */
  @Column({ type: Date, nullable: true })
  compactedAt: Date | null;
}
