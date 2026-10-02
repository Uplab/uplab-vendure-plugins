/** Rates span many magnitudes (JPY in USD is 0.0063…), so a fixed number of decimals would hide them. */
const listFormat: Intl.NumberFormatOptions = { maximumSignificantDigits: 6 };
/** Every decimal a rate is stored with. */
const fullFormat: Intl.NumberFormatOptions = { maximumFractionDigits: 8 };

export function formatRate(locale: string, value: number, precision: 'list' | 'full' = 'list'): string {
  return new Intl.NumberFormat(locale, precision === 'full' ? fullFormat : listFormat).format(value);
}
