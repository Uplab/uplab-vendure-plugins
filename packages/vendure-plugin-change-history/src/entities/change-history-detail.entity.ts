import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * @description
 * One row of an external run (`recordRun`): a value the host changed outside Vendure's events, e.g. the
 * stock of one variant at one location. Belongs to a `Run` entry; no foreign key — both sides are deleted
 * together by compaction.
 */
@Entity()
@Index(['entryId'])
@Index(['entityType', 'entityId', 'createdAt', 'entryId'])
@Index(['parentType', 'parentId', 'createdAt', 'entryId'])
export class ChangeHistoryDetail extends VendureEntity {
  constructor(input?: DeepPartial<ChangeHistoryDetail>) {
    super(input);
  }

  @EntityId()
  entryId: ID;

  @Column({ type: 'varchar', length: 32 })
  entityType: string;

  @Column({ type: 'varchar', length: 36 })
  entityId: string;

  /** Resolved by the package for `ProductVariant` (→ Product) and `FacetValue` (→ Facet) when omitted. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  parentType: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  parentId: string | null;

  /** Dashboard detail-renderer key. */
  @Column({ type: 'varchar', length: 32 })
  kind: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  scope: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  scopeLabel: string | null;

  @Column({ type: 'simple-json', nullable: true })
  fromValue: unknown;

  @Column({ type: 'simple-json', nullable: true })
  toValue: unknown;
}
