import { ID, Logger, RequestContext, StockLevel, StockLocation, StockMovementEvent } from '@vendure/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANGE_HISTORY_ACTIONS } from '../constants';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
import { LoadedState } from '../entity-definitions/entity-definition';
import { resolveOptions } from '../options';
import { ChangeHistoryContextService } from '../services/change-history-context.service';
import { CapturePipeline } from './capture-pipeline';
import { ChangeHistoryWriter, EntryDraft } from './entry-writer.service';
import { StockAdjustmentCapture } from './stock-adjustments';
import { TransactionState } from './transaction-state';

const ctx = { languageCode: 'en' } as unknown as RequestContext;

function setup(
  options: {
    enabled?: boolean;
    level?: { stockOnHand: number } | null;
    location?: { name: string } | null;
    variants?: Record<string, Partial<LoadedState>>;
    prices?: number;
    failWrite?: boolean;
  } = {},
) {
  const transaction = new TransactionState();
  const manager = {
    count: vi.fn(async () => options.prices ?? 1),
    findOne: vi.fn(async (entity: unknown) =>
      entity === StockLevel ? (options.level ?? null) : entity === StockLocation ? (options.location ?? null) : null,
    ),
  };
  const load = vi.fn(
    async (_ctx: RequestContext, ids: ID[]) =>
      new Map(
        ids
          .map(String)
          .filter((id) => options.variants?.[id])
          .map((id) => [id, options.variants![id] as LoadedState]),
      ),
  );
  const drafts: EntryDraft[] = [];
  const write = vi.fn(
    async (_ctx: RequestContext, _operation: string, produce: (tctx: RequestContext) => Promise<EntryDraft[]>) => {
      if (options.failWrite) {
        throw new Error('insert failed');
      }
      drafts.push(...(await produce(ctx)));
      return [];
    },
  );
  const capture = new StockAdjustmentCapture(
    resolveOptions({ retention: { archive: 'none' }, enabled: options.enabled }),
    { transactionStateOf: () => transaction } as unknown as ChangeHistoryContextService,
    { productVariant: { load } } as unknown as ChangeHistoryDefinitions,
    { managerOf: () => manager } as unknown as CapturePipeline,
    { write } as unknown as ChangeHistoryWriter,
  );
  return { capture, write, drafts, transaction, manager };
}

const adjustment = (...stockMovements: Array<Record<string, unknown>>) =>
  ({ ctx, type: 'ADJUSTMENT', stockMovements }) as unknown as StockMovementEvent;

describe('StockAdjustmentCapture', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records nothing with the kill switch off, nor for movements other than adjustments', async () => {
    const off = setup({ enabled: false });
    await off.capture.record(adjustment({ type: 'ADJUSTMENT', productVariantId: 21, stockLocationId: 1, quantity: 5 }));
    expect(off.write).not.toHaveBeenCalled();

    const sale = setup();
    await sale.capture.record({ ctx, type: 'SALE', stockMovements: [] } as unknown as StockMovementEvent);
    expect(sale.write).not.toHaveBeenCalled();
  });

  it('records the location and stock on hand of each adjustment, under the product', async () => {
    const { capture, write, drafts } = setup({
      level: { stockOnHand: 12 },
      location: { name: 'Kyiv' },
      variants: { '21': { label: 'Shirt S (SH-1)', parentId: '3' } },
    });
    await capture.record(adjustment({ type: 'ADJUSTMENT', productVariantId: 21, stockLocationId: 1, quantity: 5 }));
    expect(write.mock.calls[0][1]).toBe(CHANGE_HISTORY_ACTIONS.stock_adjusted);
    expect(drafts).toEqual([
      {
        entityType: 'ProductVariant',
        entityId: '21',
        entityLabel: 'Shirt S (SH-1)',
        action: CHANGE_HISTORY_ACTIONS.stock_adjusted,
        summary: 'stock Kyiv: 7 → 12',
        parentType: 'Product',
        parentId: '3',
        changes: { stock: { kind: 'stock', location: 'Kyiv', locationId: '1', from: 7, to: 12, delta: 5 } },
      },
    ]);
  });

  it('falls back to the related ids, the quantity and the location id when rows are missing', async () => {
    const { capture, drafts } = setup();
    await capture.record(
      adjustment(
        { type: 'ADJUSTMENT', productVariant: { id: 22 }, stockLocation: { id: 4 }, quantity: -2 },
        { type: 'ADJUSTMENT', productVariantId: 23, quantity: 1 },
        { type: 'SALE', productVariantId: 24, stockLocationId: 1, quantity: 1 },
        { type: 'ADJUSTMENT', stockLocationId: 1, quantity: 1 },
      ),
    );
    expect(drafts).toEqual([
      expect.objectContaining({
        entityId: '22',
        entityLabel: '22',
        summary: 'stock 4: 0 → -2',
        parentType: null,
        parentId: null,
        changes: { stock: { kind: 'stock', location: '4', locationId: '4', from: 0, to: -2, delta: -2 } },
      }),
    ]);
  });

  it("skips a variant's initial stock: created in this transaction, or without prices yet", async () => {
    const created = setup();
    created.transaction.createdIds.set('ProductVariant:21', true);
    await created.capture.record(
      adjustment({ type: 'ADJUSTMENT', productVariantId: 21, stockLocationId: 1, quantity: 5 }),
    );
    expect(created.drafts).toEqual([]);
    expect(created.manager.count).not.toHaveBeenCalled();

    const unpriced = setup({ prices: 0 });
    await unpriced.capture.record(
      adjustment({ type: 'ADJUSTMENT', productVariantId: 21, stockLocationId: 1, quantity: 5 }),
    );
    expect(unpriced.drafts).toEqual([]);
    expect(unpriced.manager.findOne).not.toHaveBeenCalled();
  });

  it('logs a failed write instead of failing the adjustment', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { capture } = setup({ failWrite: true });
    await expect(
      capture.record(adjustment({ type: 'ADJUSTMENT', productVariantId: 21, stockLocationId: 1, quantity: 5 })),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`write failed in ${CHANGE_HISTORY_ACTIONS.stock_adjusted}: insert failed`),
      expect.anything(),
      expect.anything(),
    );
  });
});
