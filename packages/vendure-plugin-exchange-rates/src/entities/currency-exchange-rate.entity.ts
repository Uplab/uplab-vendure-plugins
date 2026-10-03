import { CurrencyCode, DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ValueTransformer } from 'typeorm';

/** Decimal columns come back as strings from Postgres and MySQL; `null` stays `null`. */
const decimalToNumber: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | number | null) => (value == null ? value : Number(value)),
};

@Entity()
export class CurrencyExchangeRate extends VendureEntity {
  constructor(input?: DeepPartial<CurrencyExchangeRate>) {
    super(input);
  }

  @Column({ type: 'varchar' })
  @Index({ unique: true })
  code: CurrencyCode;

  /**
   * The currency `rate` and `customRate` are expressed in. Nullable only so that a host's generated
   * migration can add the column to a filled table; the plugin fills it before any rate is read.
   */
  @Column({ type: 'varchar', nullable: true })
  baseCurrency: CurrencyCode;

  @Column({ default: false })
  enabled: boolean;

  /** Units of `baseCurrency` per one unit of `code`, as fetched from the source. */
  @Column({ type: 'decimal', precision: 19, scale: 8, transformer: decimalToNumber })
  rate: number;

  @Column({ default: false })
  useCustomRate: boolean;

  @Column({ type: 'decimal', precision: 19, scale: 8, nullable: true, transformer: decimalToNumber })
  customRate?: number | null;
}
