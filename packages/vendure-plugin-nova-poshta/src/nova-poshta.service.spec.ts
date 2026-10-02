import { Country, type RequestContext, type TransactionalConnection } from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
import type { NovaPoshtaClient } from './nova-poshta.client';
import { normalizeSearchTerm, NovaPoshtaService } from './nova-poshta.service';

const ctx = {} as RequestContext;
const POLAND_REF = 'pl-ref';

const warehousesByCategory: Record<string, { WarehouseRef: string; FullDescription: string }[]> = {
  PostBranch: [{ WarehouseRef: 'branch-1', FullDescription: 'WARSZAWA 10' }],
  CargoBranch: [{ WarehouseRef: 'cargo-1', FullDescription: 'WARSZAWA 7' }],
  PUDO: [{ WarehouseRef: 'pudo-1', FullDescription: 'Pick Up Drop off Point' }],
  Poshtomat: [
    { WarehouseRef: 'locker-1', FullDescription: 'WAW01M' },
    { WarehouseRef: 'locker-2', FullDescription: 'APM' },
  ],
};

/** Answers `International.getWarehouses` the way the live API does: one category per request. */
function fakeClient() {
  return {
    request: vi.fn((_ctx: RequestContext, _model: string, _method: string, props: Record<string, any>) => {
      const { WarehouseCategory, Limit } = props;
      const matching = WarehouseCategory
        ? (warehousesByCategory[WarehouseCategory] ?? [])
        : Object.values(warehousesByCategory).flat();
      return Promise.resolve(Limit ? matching.slice(0, Limit) : matching);
    }),
  };
}

function makeService(country: { novaPoshtaWarehouseCategories?: string[] | null } | null) {
  const client = fakeClient();
  const findOne = vi
    .fn()
    .mockResolvedValue(country && { customFields: { novaPoshtaCountryRef: POLAND_REF, ...country } });
  const connection = { getRepository: () => ({ findOne }) } as unknown as TransactionalConnection;
  return { service: new NovaPoshtaService(connection, client as unknown as NovaPoshtaClient), client, findOne };
}

const refs = (warehouses: { WarehouseRef: string }[]) => warehouses.map((w) => w.WarehouseRef).sort();

describe('NovaPoshtaService.getInternationalWarehouses', () => {
  const input = { city: 'Warszawa', country: POLAND_REF };

  it('returns only warehouses of the categories selected for the country', async () => {
    const { service, findOne } = makeService({ novaPoshtaWarehouseCategories: ['PostBranch', 'PUDO'] });

    const result = await service.getInternationalWarehouses(ctx, input);

    expect(refs(result)).toEqual(['branch-1', 'pudo-1']);
    expect(findOne).toHaveBeenCalledWith({ where: { customFields: { novaPoshtaCountryRef: POLAND_REF } } });
  });

  it.each([[[]], [null], [undefined]])(
    'returns every warehouse when the country has no categories selected (%j)',
    async (categories) => {
      const { service, client } = makeService({ novaPoshtaWarehouseCategories: categories });

      const result = await service.getInternationalWarehouses(ctx, input);

      expect(refs(result)).toEqual(['branch-1', 'cargo-1', 'locker-1', 'locker-2', 'pudo-1']);
      expect(client.request).toHaveBeenCalledOnce();
    },
  );

  it('returns every warehouse when no country matches the Nova Poshta ref', async () => {
    const { service } = makeService(null);

    expect(await service.getInternationalWarehouses(ctx, input)).toHaveLength(5);
  });

  it('ignores stored values that are not Nova Poshta categories', async () => {
    const { service } = makeService({ novaPoshtaWarehouseCategories: ['Poshtomat', 'Lockers'] });

    expect(refs(await service.getInternationalWarehouses(ctx, input))).toEqual(['locker-1', 'locker-2']);
  });

  it('caps the merged list at the requested limit', async () => {
    const { service } = makeService({ novaPoshtaWarehouseCategories: ['PostBranch', 'Poshtomat'] });

    const result = await service.getInternationalWarehouses(ctx, { ...input, limit: 2 });

    expect(refs(result)).toEqual(['branch-1', 'locker-1']);
  });
});

describe('NovaPoshtaService.syncCountries', () => {
  function makeSyncService(countries: { code: string; ref?: string | null }[]) {
    const entities = countries.map(
      ({ code, ref }) => Object.assign(new Country(), { code, customFields: { novaPoshtaCountryRef: ref } }) as Country,
    );
    const save = vi.fn();
    const connection = {
      getRepository: () => ({ find: vi.fn().mockResolvedValue(entities), save }),
    } as unknown as TransactionalConnection;
    const client = {
      request: vi.fn().mockResolvedValue([
        { Code: 'PL', Ref: 'pl-ref', Description: 'Польща' },
        { Code: 'DE', Ref: 'de-ref', Description: 'Німеччина' },
      ]),
    };
    return { service: new NovaPoshtaService(connection, client as unknown as NovaPoshtaClient), save, entities };
  }

  it('writes the ref of every country Nova Poshta knows by ISO code, case-insensitively', async () => {
    const { service, save, entities } = makeSyncService([{ code: 'pl' }, { code: 'DE', ref: 'old' }, { code: 'UA' }]);

    expect(await service.syncCountries(ctx)).toEqual({ matched: 2, updated: 2 });
    expect(save).toHaveBeenCalledWith([entities[0], entities[1]]);
    expect(entities.map((c) => c.customFields.novaPoshtaCountryRef)).toEqual(['pl-ref', 'de-ref', undefined]);
  });

  it('saves nothing when every ref is current', async () => {
    const { service, save } = makeSyncService([{ code: 'PL', ref: 'pl-ref' }]);

    expect(await service.syncCountries(ctx)).toEqual({ matched: 1, updated: 0 });
    expect(save).not.toHaveBeenCalled();
  });
});

describe('normalizeSearchTerm', () => {
  it('turns typographic apostrophes into the one Nova Poshta matches', () => {
    expect(normalizeSearchTerm('Кам’янське')).toBe("Кам'янське");
    expect(normalizeSearchTerm('Мо‘ш`ʼ′')).toBe("Мо'ш'''");
    expect(normalizeSearchTerm(null)).toBeUndefined();
  });
});
