import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * @description
 * The last known product ids of each collection. Vendure announces a change of a collection's contents
 * only after it has committed it and without the delta, so the package keeps this snapshot to compute
 * which products were added and removed. Seeded by the package itself; never read by the API.
 */
@Entity()
export class ChangeHistoryCollectionMembers {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  collectionId: string;

  /** Sorted product ids, as strings. */
  @Column({ type: 'simple-json' })
  productIds: string[];

  @UpdateDateColumn()
  updatedAt: Date;
}
