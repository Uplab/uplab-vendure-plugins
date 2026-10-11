import { InjectableStrategy, RequestContext, TransactionalConnection } from '@vendure/core';
import type { EntityManager } from 'typeorm';

/**
 * @description
 * Why a before-state could not be read: the driver has no second connection (`unsupported`), the pool
 * had no free connection in time (`pool`), the caller ran outside a transaction (`no_transaction`), or
 * the read failed (`error`). The entry is then written without a diff and carries the reason in
 * `meta.noBefore`.
 */
export type NoBeforeState = { noBefore: 'unsupported' | 'pool' | 'no_transaction' | 'error' };

/**
 * @description
 * Strategy that reads the **committed** state of rows while the caller's transaction is still open — the
 * "before" side of a diff. The package picks one by database driver (`beforeState: 'auto'`) or the host
 * passes an instance.
 *
 * The package calls `init()` on bootstrap and `destroy()` on shutdown.
 */
export interface BeforeStateStrategy extends InjectableStrategy {
  readonly name: string;
  /** Whether this strategy can work on the given connection's driver. */
  supports(connection: TransactionalConnection): boolean;
  /**
   * Run `fn` with an EntityManager that sees only COMMITTED data while the caller's transaction is
   * open. Resolve `{ noBefore }` instead of throwing when no such reader is available.
   */
  withCommittedReader<T>(ctx: RequestContext, fn: (manager: EntityManager) => Promise<T>): Promise<T | NoBeforeState>;
}
