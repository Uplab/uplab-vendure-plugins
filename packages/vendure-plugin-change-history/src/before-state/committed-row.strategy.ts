import { Injector, RequestContext, TransactionalConnection } from '@vendure/core';
import type { EntityManager, QueryRunner } from 'typeorm';
import { DEFAULTS } from '../constants';
import { BeforeStateStrategy, NoBeforeState } from './before-state-strategy';

/**
 * Drivers whose default isolation (READ COMMITTED on Postgres, consistent non-locking reads on InnoDB)
 * lets a second connection see the last committed row while the caller's transaction is open. An
 * allow-list on purpose: on any other driver the read could run on the caller's own handle and return
 * the uncommitted "after" state — an empty diff, silently.
 */
export const COMMITTED_ROW_DRIVERS: readonly string[] = [
  'postgres',
  'aurora-postgres',
  'mysql',
  'aurora-mysql',
  'mariadb',
];

/**
 * @description
 * Reads the before-state on a **separate master connection**: inside the caller's open transaction that
 * connection still sees the last committed version of every row. The default on Postgres, MySQL and
 * MariaDB.
 *
 * Taking the second connection is fail-fast: when the pool has no free connection within
 * `acquireTimeoutMs` (default 500), the entry is written without a diff (`meta.noBefore = 'pool'`)
 * instead of holding the caller's row locks while waiting.
 */
export class CommittedRowBeforeStateStrategy implements BeforeStateStrategy {
  readonly name = 'committed-row';
  private connection: TransactionalConnection;
  private readonly acquireTimeoutMs: number;

  constructor(options: { acquireTimeoutMs?: number } = {}) {
    const timeout = options.acquireTimeoutMs ?? DEFAULTS.acquireTimeoutMs;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new Error(`CommittedRowBeforeStateStrategy: "acquireTimeoutMs" must be a positive integer, got ${timeout}`);
    }
    this.acquireTimeoutMs = timeout;
  }

  init(injector: Injector): void {
    this.connection = injector.get(TransactionalConnection);
  }

  supports(connection: TransactionalConnection): boolean {
    return COMMITTED_ROW_DRIVERS.includes(connection.rawConnection.options.type);
  }

  async withCommittedReader<T>(
    _ctx: RequestContext,
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T | NoBeforeState> {
    let queryRunner: QueryRunner;
    try {
      // The master, never a replica: a lagging replica would return an older before-state. Read at call
      // time, because test harnesses re-create the DataSource.
      queryRunner = this.connection.rawConnection.createQueryRunner('master');
    } catch {
      return { noBefore: 'error' };
    }
    const connecting = Promise.resolve().then(() => queryRunner.connect());
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      connecting.then(
        () => 'connected' as const,
        () => 'failed' as const,
      ),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.acquireTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome !== 'connected') {
      // A connection that arrives after the timeout goes straight back to the pool.
      void connecting.then(
        () => release(queryRunner),
        () => release(queryRunner),
      );
      return { noBefore: outcome === 'timeout' ? 'pool' : 'error' };
    }
    try {
      return await fn(queryRunner.manager);
    } finally {
      await release(queryRunner);
    }
  }
}

async function release(queryRunner: QueryRunner): Promise<void> {
  try {
    await queryRunner.release();
  } catch {
    // Already released or never connected — nothing to give back.
  }
}
