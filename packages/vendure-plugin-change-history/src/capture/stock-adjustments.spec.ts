import { ID, Logger, ProductVariantPrice, RequestContext, StockLocation, StockMovementEvent } from '@vendure/core';
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

/** A query builder over `rows`, recording the `IN` lists it was given. */
function rawQuery(rows: () => unknown[], params: Array<Record<string, unknown>>) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'addSelect', 'groupBy']) {
    builder[method] = () => builder;
  }
  builder.where = builder.andWhere = (_sql: string, values: Record<string, unknown>) => {
    params.push(values);
    return builder;
  };
  builder.getRawMany = async () => rows();
  return builder;
}

function setup(
  options: {
    enabled?: boolean;
    /** Stock on hand by `variantId:locationId`. */
    levels?: Record<string, number>;
    locations?: Record<string, string>;
    variants?: Record<string, Partial<LoadedState>>;
    /** The variants with a price; default every one asked for. */
    priced?: string[];
    failWrite?: boolean;
  } = {},
) {
  const transaction = new TransactionState();
  const params: Array<Record<string, unknown>> = [];
  const asked = (key: string) => params.flatMap((values) => (values[key] as string[] | undefined) ?? []);
  const manager = {
    createQueryBuilder: vi.fn((entity: unknown) =>
      entity === ProductVariantPrice
        ? rawQuery(
            () => (options.priced ?? asked('ids')).map((variantId) => ({ variantId: Number(variantId) })),
            params,
          )
        : rawQuery(
            () =>
              Object.entries(options.levels ?? {}).map(([key, stockOnHand]) => {
                const [variantId, locationId] = key.split(':');
                return {
                  variantId: Number(variantId),
                  locationId: Number(locationId),
                  stockOnHand: String(stockOnHand),
                };
              }),
            params,
          ),
    ),
    find: vi.fn(async (entity: unknown) =>
      entity === StockLocation
        ? Object.entries(options.locations ?? {}).map(([id, name]) => ({ id: Number(id), name }))
        : [],
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
  return { capture, write, drafts, transaction, manager, load };
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
      levels: { '21:1': 12 },
      locations: { '1': 'Kyiv' },
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
    expect(created.manager.createQueryBuilder).not.toHaveBeenCalled();

    const unpriced = setup({ priced: ['22'] });
    await unpriced.capture.record(
      adjustment(
        { type: 'ADJUSTMENT', productVariantId: 21, stockLocationId: 1, quantity: 5 },
        { type: 'ADJUSTMENT', productVariantId: 22, stockLocationId: 1, quantity: 3 },
      ),
    );
    expect(unpriced.drafts.map((draft) => draft.entityId)).toEqual(['22']);
  });

  it('loads prices, stock levels, locations and variants once for a bulk adjustment', async () => {
    const movements = Array.from({ length: 300 }, (_, index) => ({
      type: 'ADJUSTMENT',
      productVariantId: 100 + index,
      stockLocationId: 1 + (index % 2),
      quantity: 1,
    }));
    const { capture, drafts, manager, load } = setup({
      levels: { '100:1': 9, '101:2': 4 },
      locations: { '1': 'Kyiv', '2': 'Lviv' },
    });
    await capture.record(adjustment(...movements));
    expect(drafts).toHaveLength(300);
    expect(drafts.slice(0, 2).map((draft) => draft.summary)).toEqual(['stock Kyiv: 8 → 9', 'stock Lviv: 3 → 4']);
    // One price query, one stock-level query, one location read, one variant load — not four per movement.
    expect(manager.createQueryBuilder).toHaveBeenCalledTimes(2);
    expect(manager.find).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][1]).toHaveLength(300);
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
