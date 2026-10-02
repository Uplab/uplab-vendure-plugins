import { CurrencyCode, DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

@Entity()
export class CurrencyExchangeRate extends VendureEntity {
  constructor(input?: DeepPartial<CurrencyExchangeRate>) {
    super(input);
  }

  @Column({ type: 'varchar' })
  @Index({ unique: true })
  code: CurrencyCode;

  @Column({ default: false })
  enabled: boolean;

  @Column({ type: 'decimal' })
  rate: number;

  @Column({ default: false })
  useCustomRate: boolean;

  @Column({ type: 'decimal', nullable: true })
  customRate?: number;
}
