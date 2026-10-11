import type { TestDbInitializer } from '@vendure/testing';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Runs the suite in the database named by the connection options, resetting its schema first.
 *
 * `@vendure/testing`'s `PostgresInitializer` instead drops and re-creates a database named after the test
 * file through the server's maintenance database — fine on a throw-away CI service, not on a developer's
 * shared Postgres. This one only ever touches the database it is given (`dropSchema` on the populate
 * run, then the populated schema is kept for the suite).
 */
export class DedicatedPostgresInitializer implements TestDbInitializer<PostgresConnectionOptions> {
  private options?: Mutable<PostgresConnectionOptions>;

  async init(_testFileName: string, connectionOptions: PostgresConnectionOptions): Promise<PostgresConnectionOptions> {
    this.options = connectionOptions as Mutable<PostgresConnectionOptions>;
    this.options.synchronize = true;
    this.options.dropSchema = true;
    return connectionOptions;
  }

  async populate(populateFn: () => Promise<void>): Promise<void> {
    await populateFn();
    if (this.options) {
      this.options.dropSchema = false;
    }
  }

  destroy(): void {
    // Nothing to close: the initializer opens no connection of its own.
  }
}
