import { RequestContext } from '@vendure/core';
import { BeforeStateStrategy, NoBeforeState } from './before-state-strategy';

/**
 * @description
 * Null object: never reads a before-state. Selected automatically on SQLite (sql.js, better-sqlite3),
 * where the only database handle is the caller's own and would see its uncommitted writes. Every change
 * is still recorded, without the "was" values (`meta.noBefore = 'unsupported'`).
 */
export class NoBeforeStateStrategy implements BeforeStateStrategy {
  readonly name = 'none';

  supports(): boolean {
    return true;
  }

  async withCommittedReader<T>(_ctx: RequestContext, _fn: unknown): Promise<T | NoBeforeState> {
    return { noBefore: 'unsupported' };
  }
}
