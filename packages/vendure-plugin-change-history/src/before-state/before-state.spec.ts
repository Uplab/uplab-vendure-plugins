import { Injector, RequestContext, TransactionalConnection } from '@vendure/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommittedRowBeforeStateStrategy } from './committed-row.strategy';
import { NoBeforeStateStrategy } from './no-before-state.strategy';
import { selectBeforeStateStrategy } from './select-strategy';

const ctx = {} as RequestContext;

function connectionWith(queryRunner: Record<string, unknown> | (() => never), type = 'postgres') {
  const createQueryRunner = vi.fn(typeof queryRunner === 'function' ? queryRunner : () => queryRunner);
  const connection = { rawConnection: { options: { type }, createQueryRunner } } as unknown as TransactionalConnection;
  return { connection, createQueryRunner };
}

function strategyOn(connection: TransactionalConnection, acquireTimeoutMs?: number) {
  const strategy = new CommittedRowBeforeStateStrategy({ acquireTimeoutMs });
  strategy.init({ get: () => connection } as unknown as Injector);
  return strategy;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('selectBeforeStateStrategy', () => {
  it.each(['postgres', 'aurora-postgres', 'mysql', 'aurora-mysql', 'mariadb'])('reads committed rows on %s', (type) => {
    const selected = selectBeforeStateStrategy('auto', type);
    expect(selected.strategy).toBeInstanceOf(CommittedRowBeforeStateStrategy);
    expect(selected.warning).toBeUndefined();
  });

  it.each(['sqljs', 'better-sqlite3', 'sqlite', 'mssql', 'oracle'])(
    'reads no before-state on %s, with a warning',
    (type) => {
      const selected = selectBeforeStateStrategy('auto', type);
      expect(selected.strategy).toBeInstanceOf(NoBeforeStateStrategy);
      expect(selected.warning).toContain(`"${type}"`);
    },
  );

  it('uses an instance as given', () => {
    const strategy = new NoBeforeStateStrategy();
    expect(selectBeforeStateStrategy(strategy, 'postgres')).toEqual({ strategy });
  });
});

describe('NoBeforeStateStrategy', () => {
  it('supports any driver and never reads', async () => {
    const strategy = new NoBeforeStateStrategy();
    const fn = vi.fn();
    expect(strategy.supports()).toBe(true);
    expect(await strategy.withCommittedReader(ctx, fn)).toEqual({ noBefore: 'unsupported' });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('CommittedRowBeforeStateStrategy', () => {
  it('rejects a non-positive acquire timeout', () => {
    expect(() => new CommittedRowBeforeStateStrategy({ acquireTimeoutMs: 0 })).toThrow(/positive integer/);
  });

  it('supports only the drivers with a committed-only second reader', () => {
    expect(strategyOn(connectionWith({}).connection).supports(connectionWith({}).connection)).toBe(true);
    const sqlite = connectionWith({}, 'sqljs').connection;
    expect(strategyOn(sqlite).supports(sqlite)).toBe(false);
  });

  it('reads on a master query runner and releases it', async () => {
    const manager = {};
    const queryRunner = { connect: vi.fn().mockResolvedValue(undefined), release: vi.fn(), manager };
    const { connection, createQueryRunner } = connectionWith(queryRunner);

    const result = await strategyOn(connection).withCommittedReader(ctx, async (m) =>
      m === manager ? 'read' : 'other',
    );

    expect(result).toBe('read');
    expect(createQueryRunner).toHaveBeenCalledWith('master');
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('releases the query runner when the read throws', async () => {
    const queryRunner = { connect: vi.fn().mockResolvedValue(undefined), release: vi.fn(), manager: {} };
    const strategy = strategyOn(connectionWith(queryRunner).connection);

    await expect(strategy.withCommittedReader(ctx, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('gives up after the acquire timeout and releases the late connection', async () => {
    vi.useFakeTimers();
    let connected!: () => void;
    const queryRunner = {
      connect: vi.fn(() => new Promise<void>((resolve) => (connected = resolve))),
      release: vi.fn().mockRejectedValue(new Error('already released')),
      manager: {},
    };
    const fn = vi.fn();
    const pending = strategyOn(connectionWith(queryRunner).connection, 5).withCommittedReader(ctx, fn);

    await vi.advanceTimersByTimeAsync(5);
    expect(await pending).toEqual({ noBefore: 'pool' });
    expect(queryRunner.release).not.toHaveBeenCalled();

    connected();
    await vi.runAllTimersAsync();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports an error when no connection can be taken', async () => {
    const failing = { connect: vi.fn().mockRejectedValue(new Error('refused')), release: vi.fn(), manager: {} };
    expect(await strategyOn(connectionWith(failing).connection).withCommittedReader(ctx, vi.fn())).toEqual({
      noBefore: 'error',
    });

    const throwing = connectionWith(() => {
      throw new Error('no data source');
    }).connection;
    expect(await strategyOn(throwing).withCommittedReader(ctx, vi.fn())).toEqual({ noBefore: 'error' });
  });
});
