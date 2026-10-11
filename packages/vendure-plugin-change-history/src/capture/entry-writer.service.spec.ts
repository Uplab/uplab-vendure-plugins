import { Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeHistoryEntry } from '../entities/change-history-entry.entity';
import { ChangeHistoryContextService, ChangeHistoryState } from '../services/change-history-context.service';
import { ResolvedActor } from '../types';
import { ChangeHistoryWriter, EntryDraft, logFailure } from './entry-writer.service';
import { TransactionState } from './transaction-state';

const ACTOR: ResolvedActor = { actorType: 'admin', actorId: 7, actorLabel: 'Olena Koval', source: 'admin' };

/** The writer on a fake connection (`withTransaction` runs the work at once) and a fake context. */
function setup(actor: ResolvedActor = ACTOR) {
  const saved: ChangeHistoryEntry[] = [];
  let nextId = 1;
  const save = vi.fn(async (entries: ChangeHistoryEntry | ChangeHistoryEntry[]) => {
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      entry.id = nextId++;
      saved.push(entry);
    }
    return entries;
  });
  const withTransaction = vi.fn((ctx: RequestContext, work: (tctx: RequestContext) => Promise<unknown>) => work(ctx));
  const connection = {
    getRepository: () => ({ save, count: vi.fn(async () => 0) }),
    withTransaction,
  } as unknown as TransactionalConnection;
  const state: ChangeHistoryState = { correlationId: 'corr-1' };
  const transaction = new TransactionState();
  const context = {
    stateOf: () => state,
    transactionStateOf: () => transaction,
    serialize: (_ctx: RequestContext, fn: () => Promise<unknown>) => fn(),
    resolveActor: async () => actor,
  } as unknown as ChangeHistoryContextService;
  const writer = new ChangeHistoryWriter(connection, context);
  const ctx = { channel: { id: 2 } } as unknown as RequestContext;
  return { writer, ctx, saved, transaction, withTransaction };
}

const draft = (overrides: Partial<EntryDraft> = {}): EntryDraft => ({
  entityType: 'Product',
  entityId: '5',
  entityLabel: 'Shirt',
  action: 'updated',
  summary: '1 field: name',
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChangeHistoryWriter', () => {
  it('clips an over-long label, summary and actor label to their columns', async () => {
    const { writer, ctx, saved } = setup({ ...ACTOR, actorLabel: 'A'.repeat(300) });
    await writer.write(ctx, 'test', async () => [draft({ entityLabel: 'L'.repeat(300), summary: 'S'.repeat(600) })]);

    expect(saved).toHaveLength(1);
    expect(saved[0].entityLabel).toBe('L'.repeat(255));
    expect(saved[0].summary).toBe('S'.repeat(512));
    expect(saved[0].actorLabel).toBe('A'.repeat(255));
    expect(saved[0]).toMatchObject({ channelId: '2', meta: { correlationId: 'corr-1' } });
  });

  it('links an entity created in this transaction to its own earlier entry, and to nothing once that is gone', async () => {
    const { writer, ctx, saved, transaction } = setup();
    transaction.markCreated('Product:5');
    transaction.remember('Product:5', 41);
    transaction.markCreated('Product:6');

    await writer.write(ctx, 'test', async () => [draft(), draft({ entityId: '6' })]);

    expect(saved.map((entry) => [entry.entityId, entry.derivedFromId])).toEqual([
      ['5', 41],
      ['6', null],
    ]);
  });

  it('keeps notifying the other listeners when one throws, and logs it', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { writer, ctx } = setup();
    const after = vi.fn();
    writer.onSaved(() => {
      throw new Error('cache down');
    });
    writer.onSaved(after);

    const entries = await writer.write(ctx, 'test', async () => [draft()]);

    expect(entries).toHaveLength(1);
    expect(after).toHaveBeenCalledWith(entries);
    expect(error).toHaveBeenCalledWith(
      '[ChangeHistory] write failed in saved entries listener: cache down',
      'ChangeHistory',
      expect.any(String),
    );
  });

  it('runs inSavepoint work in a transaction and resolves its result', async () => {
    const { writer, ctx, withTransaction } = setup();
    await expect(writer.inSavepoint(ctx, 'reseed', async () => 3)).resolves.toBe(3);
    expect(withTransaction).toHaveBeenCalledWith(ctx, expect.any(Function));
  });

  it('resolves undefined when inSavepoint work fails, and logs it', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { writer, ctx } = setup();
    await expect(
      writer.inSavepoint(ctx, 'reseed', async () => {
        throw new Error('deadlock');
      }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      '[ChangeHistory] write failed in reseed: deadlock',
      'ChangeHistory',
      expect.any(String),
    );
  });

  it('logs a thrown value that is not an Error by its text', () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    logFailure('recordAction', 'connection reset');
    expect(error).toHaveBeenCalledWith(
      '[ChangeHistory] write failed in recordAction: connection reset',
      'ChangeHistory',
      expect.any(String),
    );
  });
});
