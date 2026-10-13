import { BeforeStateStrategy } from './before-state-strategy';
import { COMMITTED_ROW_DRIVERS, CommittedRowBeforeStateStrategy } from './committed-row.strategy';
import { NoBeforeStateStrategy } from './no-before-state.strategy';

export interface SelectedBeforeStateStrategy {
  strategy: BeforeStateStrategy;
  /** Set when `auto` fell back to no before-state: the reason to log at boot. */
  warning?: string;
}

/**
 * `auto`: the committed-row strategy on the drivers that support a second, committed-only reader; the
 * null strategy (with a boot warning) on SQLite and on every driver not known to support it.
 */
export function selectBeforeStateStrategy(
  option: 'auto' | BeforeStateStrategy,
  driverType: string,
): SelectedBeforeStateStrategy {
  if (option !== 'auto') {
    return { strategy: option };
  }
  if (COMMITTED_ROW_DRIVERS.includes(driverType)) {
    return { strategy: new CommittedRowBeforeStateStrategy() };
  }
  return {
    strategy: new NoBeforeStateStrategy(),
    warning: `Before-state unavailable on "${driverType}": updates are recorded without diffs (meta.noBefore = "unsupported")`,
  };
}
