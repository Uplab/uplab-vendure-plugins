import { FacetEvent, FacetValue, FacetValueEvent, Logger, Product, RequestContext } from '@vendure/core';
import type { EntityManager } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoBeforeState } from '../before-state/before-state-strategy';
import { ChangeHistoryDefinitions } from '../entity-definitions/definitions.service';
import { resolveOptions } from '../options';
import { ChangeHistoryContextService } from '../services/change-history-context.service';
import { ChangeHistoryStrategies } from '../services/change-history-strategies.service';
import { CapturePipeline } from './capture-pipeline';
import { FacetCapture } from './facet-capture';

const ctx = { languageCode: 'en' } as unknown as RequestContext;

/** What the capture passes to `pipeline.run`, as far as these tests read it. */
type RunOptions = { mode: string; action: string; entities?: Map<string, FacetValue>; metaById?: Map<string, unknown> };

/** A committed reader whose query builders count `products` / `variants` uses per facet value id. */
function countingManager(products: Record<string, number>, variants: Record<string, number>) {
  return {
    createQueryBuilder: (entity: unknown) => {
      const counts = entity === Product ? products : variants;
      const builder = {
        innerJoin: () => builder,
        select: () => builder,
        addSelect: () => builder,
        where: () => builder,
        andWhere: () => builder,
        groupBy: () => builder,
        getRawMany: async () => Object.entries(counts).map(([id, count]) => ({ id, count: String(count) })),
      };
      return builder;
    },
  } as unknown as EntityManager;
}

function setup(
  options: {
    enabled?: boolean;
    inTransaction?: boolean;
    committed?: EntityManager | NoBeforeState | Error;
    failRun?: boolean;
  } = {},
) {
  const facet = { entityType: 'Facet' };
  const facetValue = { entityType: 'FacetValue' };
  const run = vi.fn(async (_ctx: RequestContext, definition: unknown, _ids: unknown[], _options: RunOptions) => {
    if (options.failRun && definition === facetValue) {
      throw new Error('pipeline failed');
    }
  });
  const withCommittedReader = vi.fn(async (_ctx: RequestContext, fn: (manager: EntityManager) => Promise<unknown>) => {
    const committed = options.committed ?? countingManager({}, {});
    if (committed instanceof Error) {
      throw committed;
    }
    return 'noBefore' in committed ? committed : fn(committed);
  });
  const capture = new FacetCapture(
    resolveOptions({ retention: { archive: 'none' }, enabled: options.enabled }),
    {
      transactionOf: () => (options.inTransaction === false ? undefined : {}),
    } as unknown as ChangeHistoryContextService,
    { beforeState: { withCommittedReader } } as unknown as ChangeHistoryStrategies,
    { facet, facetValue } as unknown as ChangeHistoryDefinitions,
    { run } as unknown as CapturePipeline,
  );
  /** The `metaById` of the facet value deletion. */
  const usage = () => run.mock.calls.find(([, definition]) => definition === facetValue)?.[3].metaById;
  return { capture, run, withCommittedReader, facet, facetValue, usage };
}

const facetEvent = (entity: Record<string, unknown>) => ({ ctx, entity, type: 'deleted' }) as unknown as FacetEvent;
const valueEvent = (entity: Record<string, unknown>) =>
  ({ ctx, entity, type: 'deleted' }) as unknown as FacetValueEvent;

describe('FacetCapture', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records a deleted facet without loaded values as the facet alone', async () => {
    const { capture, run, facet } = setup();
    await capture.onFacetEvent(facetEvent({ id: 2, code: 'colour' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toBe(facet);
    expect(run.mock.calls[0][2]).toEqual(['2']);
    expect(run.mock.calls[0][3]).toMatchObject({ mode: 'deleted', action: 'deleted' });
  });

  it("derives each value's deletion from the facet's, with the facet attached and the usage counted", async () => {
    const { capture, run, facetValue, usage } = setup({ committed: countingManager({ '12': 3 }, { '13': 1 }) });
    const entity = { id: 2, code: 'colour', values: [{ id: 12 }, { id: 13 }] };
    await capture.onFacetEvent(facetEvent(entity));

    expect(run).toHaveBeenCalledTimes(2);
    const [, definition, ids, options] = run.mock.calls[1];
    expect(definition).toBe(facetValue);
    expect(ids).toEqual(['12', '13']);
    expect(options.entities?.get('12')).toBeInstanceOf(FacetValue);
    expect(options.entities?.get('12')?.facet).toBe(entity);
    expect(usage()).toEqual(
      new Map([
        ['12', { usedByProducts: 3, usedByVariants: 0 }],
        ['13', { usedByProducts: 0, usedByVariants: 1 }],
      ]),
    );
  });

  it('records nothing for the values when the kill switch is off', async () => {
    const { capture, run, facet } = setup({ enabled: false });
    await capture.onFacetEvent(facetEvent({ id: 2, values: [{ id: 12 }] }));
    await capture.onFacetValueEvent(valueEvent({ id: 13 }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toBe(facet);
  });

  it('logs a failed value deletion instead of failing the save', async () => {
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { capture } = setup({ failRun: true });
    await expect(capture.onFacetValueEvent(valueEvent({ id: 12 }))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('write failed in deleted FacetValue: pipeline failed'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('counts no usage outside a transaction, without a before-state or when the committed read fails', async () => {
    const outside = setup({ inTransaction: false });
    await outside.capture.onFacetValueEvent(valueEvent({ id: 12 }));
    expect(outside.withCommittedReader).not.toHaveBeenCalled();
    expect(outside.usage()).toEqual(new Map());

    const unsupported = setup({ committed: { noBefore: 'unsupported' } });
    await unsupported.capture.onFacetValueEvent(valueEvent({ id: 12 }));
    expect(unsupported.withCommittedReader).toHaveBeenCalledTimes(1);
    expect(unsupported.usage()).toEqual(new Map());

    const failing = setup({ committed: new Error('connection lost') });
    await failing.capture.onFacetValueEvent(valueEvent({ id: 12 }));
    expect(failing.withCommittedReader).toHaveBeenCalledTimes(1);
    expect(failing.usage()).toEqual(new Map());
  });
});
