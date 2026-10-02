import { bootstrapWorker, type VendureConfig, type VendureWorker } from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillUnifiedSlugs, formatSlugBackfillReport } from './backfill-unified-slugs';
import { UnifiedSlugPlugin } from './unified-slug.plugin';

vi.mock('@vendure/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vendure/core')>()),
  bootstrapWorker: vi.fn(),
}));

describe('backfillUnifiedSlugs', () => {
  const app = {
    get: vi.fn(() => {
      throw new Error('boom');
    }),
    close: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.mocked(bootstrapWorker).mockResolvedValue({ app } as unknown as VendureWorker);
  });

  it('refuses a config without the plugin, before booting anything', async () => {
    await expect(backfillUnifiedSlugs({ plugins: [] } as unknown as VendureConfig, { dryRun: true })).rejects.toThrow(
      /UnifiedSlugPlugin is not in the config/,
    );
    expect(bootstrapWorker).not.toHaveBeenCalled();
  });

  it('boots a worker from the host config and closes it even when the run fails', async () => {
    const config = { plugins: [UnifiedSlugPlugin] } as unknown as VendureConfig;

    await expect(backfillUnifiedSlugs(config, { dryRun: true })).rejects.toThrow('boom');
    expect(bootstrapWorker).toHaveBeenCalledWith(config);
    expect(app.close).toHaveBeenCalledOnce();
  });
});

describe('formatSlugBackfillReport', () => {
  it('prints the counts, then one line per entity with its previous slugs', () => {
    const lines = formatSlugBackfillReport({
      dryRun: true,
      scanned: 3,
      filled: 0,
      rewritten: 1,
      generated: 0,
      conflicts: 1,
      noSlug: 0,
      entries: [
        {
          entityName: 'Product',
          entityId: 1,
          outcome: 'REWRITTEN',
          slug: 'coat',
          previousSlugs: [
            { languageCode: 'en', slug: 'coat' },
            { languageCode: 'uk', slug: 'palto' },
          ],
          conflictsWith: [],
          rowIds: [2],
        },
        {
          entityName: 'Collection',
          entityId: 4,
          outcome: 'CONFLICT',
          slug: 'hats',
          previousSlugs: [
            { languageCode: 'en', slug: 'hats' },
            { languageCode: 'uk', slug: '' },
          ],
          conflictsWith: ['5'],
          rowIds: [],
        },
      ],
    });

    expect(lines).toEqual([
      'Unified slug backfill (dry run, nothing written): 3 scanned, 0 filled, 1 rewritten, 0 generated, 1 conflicts, 0 without slug',
      '  Product 1: REWRITTEN coat (was en=coat uk=palto)',
      '  Collection 4: CONFLICT hats (was en=hats uk=∅) taken by Collection 5',
    ]);
  });
});
