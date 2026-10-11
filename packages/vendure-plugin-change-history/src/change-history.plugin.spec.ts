import {
  getConfigurationFunction,
  Injector,
  ListQueryBuilder,
  Logger,
  RequestContext,
  RuntimeVendureConfig,
  TransactionalConnection,
} from '@vendure/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoBeforeStateStrategy } from './before-state/no-before-state.strategy';
import { ChangeHistoryPlugin } from './change-history.plugin';
import { readChangeHistory } from './constants';
import { resolveOptions } from './options';
import { ChangeHistoryArchiveStorage } from './retention/archive-storage';
import { ChangeHistoryContextService } from './services/change-history-context.service';
import { ChangeHistoryStrategies } from './services/change-history-strategies.service';
import { ChangeHistoryService } from './services/change-history.service';
import { BeforeStateStrategy } from './before-state/before-state-strategy';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChangeHistoryPlugin', () => {
  async function configure() {
    const config = { authOptions: { customPermissions: [] } } as unknown as RuntimeVendureConfig;
    return (await getConfigurationFunction(ChangeHistoryPlugin)?.(config)) ?? config;
  }

  it('adds the ReadChangeHistory permission', async () => {
    ChangeHistoryPlugin.init({ retention: { archive: 'none' } });
    expect((await configure()).authOptions.customPermissions).toEqual([readChangeHistory]);
    expect(readChangeHistory.Permission).toBe('ReadChangeHistory');
  });

  it('fails fast when registered without init()', async () => {
    const options = ChangeHistoryPlugin.options;
    ChangeHistoryPlugin.options = undefined as never;
    try {
      await expect(configure()).rejects.toThrow(/ChangeHistoryPlugin.init/);
    } finally {
      ChangeHistoryPlugin.options = options;
    }
  });

  it('fails fast on bad options', () => {
    expect(() => ChangeHistoryPlugin.init({} as never)).toThrow(/"retention.archive" is required/);
  });
});

describe('ChangeHistoryStrategies', () => {
  const connection = { rawConnection: { options: { type: 'postgres' } } } as unknown as TransactionalConnection;
  const injector = {} as Injector;

  it('initialises and destroys the before-state strategy and the archive storage', async () => {
    const beforeState: BeforeStateStrategy = Object.assign(new NoBeforeStateStrategy(), {
      supports: () => false,
      init: vi.fn(),
      destroy: vi.fn(),
    });
    const archive: ChangeHistoryArchiveStorage = { put: vi.fn(), exists: vi.fn(), init: vi.fn(), destroy: vi.fn() };
    const warn = vi.spyOn(Logger, 'warn');
    const strategies = new ChangeHistoryStrategies(resolveOptions({ beforeState, retention: { archive } }), connection);

    expect(() => strategies.beforeState).toThrow(/selected on application bootstrap/);
    await strategies.init(injector);
    await strategies.destroy();

    expect(strategies.beforeState).toBe(beforeState);
    expect(beforeState.init).toHaveBeenCalledWith(injector);
    expect(archive.init).toHaveBeenCalledWith(injector);
    expect(beforeState.destroy).toHaveBeenCalled();
    expect(archive.destroy).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"none" does not support "postgres"'), 'ChangeHistory');
  });

  it('logs the explicit archive opt-out', async () => {
    const info = vi.spyOn(Logger, 'info');
    const sqlite = { rawConnection: { options: { type: 'sqljs' } } } as unknown as TransactionalConnection;
    const strategies = new ChangeHistoryStrategies(resolveOptions({ retention: { archive: 'none' } }), sqlite);
    await strategies.init(injector);
    await strategies.destroy();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('retention.archive is "none"'), 'ChangeHistory');
  });
});

describe('ChangeHistoryService with the kill switch off', () => {
  it('writes nothing and still runs a batch callback', async () => {
    const withTransaction = vi.fn();
    const service = new ChangeHistoryService(
      resolveOptions({ enabled: false, retention: { archive: 'none' } }),
      { withTransaction } as unknown as TransactionalConnection,
      {} as ListQueryBuilder,
      new ChangeHistoryContextService(
        resolveOptions({ retention: { archive: 'none' } }),
        {} as never,
        {} as never,
        {} as never,
      ),
      {} as never,
      {} as never,
      {} as never,
    );
    const ctx = {} as RequestContext;

    await service.recordAction(ctx, { entityType: 'Product', entityId: 1, entityLabel: 'P', action: 'archived' });
    await service.recordRun(ctx, { source: 's', label: 'S', counts: { updated: 1 }, details: [] });
    await service.capture(ctx, 'Product', [1], { action: 'archived' });
    expect(await service.runBatch(ctx, { kind: 'bulk_edit' }, async () => 'ran')).toBe('ran');

    expect(withTransaction).not.toHaveBeenCalled();
  });
});
