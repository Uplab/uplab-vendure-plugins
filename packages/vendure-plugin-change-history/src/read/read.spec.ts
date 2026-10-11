import { RequestContext, TransactionalConnection } from '@vendure/core';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { Batcher } from './batcher';
import { inChannels, readableChannelIds, scopeKey } from './channel-scope';
import { compareKeys, decodeCursor, encodeCursor } from './cursor';
import { ordersTimestampsAsText, timestampAsText, withPrimaryManager } from './sql';

describe('timeline cursor', () => {
  it('round-trips the raw timestamp and the id', () => {
    const key = { createdAt: '2026-10-11 06:22:01.123456', id: '42' };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it.each(['nonsense', Buffer.from('[1,2]').toString('base64url'), Buffer.from('["a"]').toString('base64url')])(
    'rejects a malformed cursor %s',
    (cursor) => {
      expect(() => decodeCursor(cursor)).toThrow(/Invalid change history cursor/);
    },
  );

  it('orders Postgres timestamps by value, whatever trailing zeros they print', () => {
    const at = (createdAt: string, id = '1') => ({ createdAt, id });
    expect(compareKeys(at('2026-10-11 06:22:01.5'), at('2026-10-11 06:22:01.123456'), false)).toBeGreaterThan(0);
    expect(compareKeys(at('2026-10-11 06:22:01'), at('2026-10-11 06:22:01.000001'), false)).toBeLessThan(0);
    expect(compareKeys(at('2026-10-11 06:22:01.50', '9'), at('2026-10-11 06:22:01.5', '10'), false)).toBeLessThan(0);
    expect(compareKeys(at('2026-10-11T06:22:01.5', 'b'), at('2026-10-11 06:22:01.5', 'a'), false)).toBeGreaterThan(0);
    expect(compareKeys(at('x', '7'), at('x', '7'), false)).toBe(0);
  });

  it('orders SQLite timestamps as the stored strings', () => {
    expect(
      compareKeys(
        { createdAt: '2026-10-11 06:22:01', id: '2' },
        { createdAt: '2026-10-11 06:22:01.000', id: '1' },
        true,
      ),
    ).toBeLessThan(0);
  });
});

describe('timestamp SQL', () => {
  it('reads a timestamp as the stored text per driver', () => {
    expect(timestampAsText('postgres', 'e.createdAt')).toBe('CAST(e.createdAt AS text)');
    expect(timestampAsText('mariadb', 'e.createdAt')).toBe('CAST(e.createdAt AS CHAR)');
    expect(timestampAsText('sqljs', 'e.createdAt')).toBe('(e.createdAt)');
    expect(ordersTimestampsAsText('sqljs')).toBe(true);
    expect(ordersTimestampsAsText('aurora-postgres')).toBe(false);
  });

  it('reads from the primary when replicas are configured, and releases the runner', async () => {
    const manager = { name: 'primary' };
    const runner = { manager, release: vi.fn(async () => undefined) };
    const createQueryRunner = vi.fn(() => runner);
    const connection = {
      rawConnection: { options: { replication: { master: {}, slaves: [] } }, createQueryRunner },
    } as unknown as TransactionalConnection;

    await expect(withPrimaryManager(connection, {} as RequestContext, async (m) => m)).resolves.toBe(manager);
    expect(createQueryRunner).toHaveBeenCalledWith('master');
    expect(runner.release).toHaveBeenCalledTimes(1);

    await expect(
      withPrimaryManager(connection, {} as RequestContext, async () => {
        throw new Error('read failed');
      }),
    ).rejects.toThrow('read failed');
    expect(runner.release).toHaveBeenCalledTimes(2);
  });

  it("uses the request's manager without replication", async () => {
    const manager = { name: 'request' };
    const connection = {
      rawConnection: { options: {} },
      getRepository: () => ({ manager }),
    } as unknown as TransactionalConnection;
    await expect(withPrimaryManager(connection, {} as RequestContext, async (m) => m)).resolves.toBe(manager);
  });
});

describe('Batcher', () => {
  it('loads the keys queued in one tick with one call per scope', async () => {
    const load = vi.fn(async (_scope: object, items: number[]) => new Map(items.map((n) => [String(n), n * 10])));
    const batcher = new Batcher<object, number, number>((n) => String(n), load);
    const one = {};
    const two = {};

    const results = await Promise.all([
      batcher.get(one, 1),
      batcher.get(one, 2),
      batcher.get(one, 2),
      batcher.get(two, 3),
    ]);

    expect(results).toEqual([10, 20, 20, 30]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledWith(one, [1, 2]);
    expect(await batcher.get(one, 4)).toBe(40);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('rejects every waiting key when the load fails', async () => {
    const batcher = new Batcher<object, number, number>(String, async () => {
      throw new Error('db down');
    });
    const scope = {};
    await expect(Promise.all([batcher.get(scope, 1), batcher.get(scope, 2)])).rejects.toThrow('db down');
  });
});

describe('channel scope', () => {
  const ctxWith = (channelPermissions?: Array<{ id: number; permissions: string[] }>) =>
    ({ session: channelPermissions ? { user: { channelPermissions } } : undefined }) as unknown as RequestContext;
  const query = () => {
    const andWhere = vi.fn();
    return { andWhere, builder: { andWhere } as unknown as SelectQueryBuilder<ObjectLiteral> };
  };

  it('reads every channel without a user and for a SuperAdmin', () => {
    expect(readableChannelIds(ctxWith())).toBeUndefined();
    expect(readableChannelIds(ctxWith([{ id: 2, permissions: ['SuperAdmin'] }]))).toBeUndefined();
  });

  it('reads the channels in which the user holds ReadChangeHistory', () => {
    const ctx = ctxWith([
      { id: 1, permissions: ['ReadCatalog'] },
      { id: 2, permissions: ['ReadChangeHistory'] },
      { id: 3, permissions: ['ReadChangeHistory', 'ReadCatalog'] },
    ]);
    expect(readableChannelIds(ctx)).toEqual(['2', '3']);
    expect(scopeKey(['3', '2'])).toBe('2,3');
    expect(scopeKey(undefined)).toBe('*');
  });

  it('narrows a query to the channels, to nothing for none, and leaves it alone for all', () => {
    const some = query();
    inChannels(some.builder, 'entry', ['2']);
    expect(some.andWhere).toHaveBeenCalledWith('entry.channelId IN (:...chReadableChannels)', {
      chReadableChannels: ['2'],
    });
    const none = query();
    inChannels(none.builder, 'entry', []);
    expect(none.andWhere).toHaveBeenCalledWith('1 = 0');
    const all = query();
    inChannels(all.builder, 'entry', undefined);
    expect(all.andWhere).not.toHaveBeenCalled();
  });
});
