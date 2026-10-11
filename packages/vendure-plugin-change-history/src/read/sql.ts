import { RequestContext, TransactionalConnection } from '@vendure/core';
import type { EntityManager } from 'typeorm';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';

const POSTGRES_FAMILY = ['postgres', 'aurora-postgres', 'cockroachdb'];
const MYSQL_FAMILY = ['mysql', 'mariadb', 'aurora-mysql'];

/**
 * A timestamp column as the database's own text. Postgres keeps microseconds that a JS `Date` would drop:
 * a keyset cursor built from a `Date` skips the other rows of a transaction (they share `now()`).
 */
export function timestampAsText(driver: string, path: string): string {
  if (POSTGRES_FAMILY.includes(driver)) {
    return `CAST(${path} AS text)`;
  }
  if (MYSQL_FAMILY.includes(driver)) {
    return `CAST(${path} AS CHAR)`;
  }
  // SQLite stores timestamps as text already. Parenthesised: a bare `alias.property` would replace the
  // entity's own column in the selection.
  return `(${path})`;
}

/** SQLite orders timestamps as the stored strings; the other drivers by their value. */
export function ordersTimestampsAsText(driver: string): boolean {
  return !POSTGRES_FAMILY.includes(driver) && !MYSQL_FAMILY.includes(driver);
}

/**
 * Runs `fn` with a manager that reads from the primary database: with read replicas configured, a read right
 * after a save could otherwise miss it. Without replication the request's own manager is used.
 */
export async function withPrimaryManager<T>(
  connection: TransactionalConnection,
  ctx: RequestContext,
  fn: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const raw = connection.rawConnection;
  if (!(raw.options as { replication?: unknown }).replication) {
    return fn(connection.getRepository(ctx, ChangeHistoryEntry).manager);
  }
  const runner = raw.createQueryRunner('master');
  try {
    return await fn(runner.manager);
  } finally {
    await runner.release();
  }
}
