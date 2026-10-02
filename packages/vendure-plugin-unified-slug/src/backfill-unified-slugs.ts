import type { INestApplicationContext } from '@nestjs/common';
import { bootstrapWorker, RequestContextService, TransactionalConnection, type VendureConfig } from '@vendure/core';
import { UNIFIED_SLUG_ENTITY_NAMES } from './constants';
import { type SlugBackfillReport, SlugBackfillService } from './slug-backfill.service';
import type { UnifiedSlugEntityName } from './types';
import { UnifiedSlugPlugin } from './unified-slug.plugin';

/**
 * @description
 * Options for {@link backfillUnifiedSlugs} and {@link runSlugBackfill}.
 */
export interface BackfillUnifiedSlugsOptions {
  /** Report what would change and write nothing. */
  dryRun: boolean;
  /** Only this kind of entity. Default: products and collections. */
  entityName?: UnifiedSlugEntityName;
  /** The channel whose default language picks the canonical slug. Default: the default channel. */
  channelToken?: string;
  /** Receives the printed report, line by line. Default: `console.log`. */
  logger?: (line: string) => void;
}

/**
 * @description
 * Brings products and collections saved before the plugin onto one slug per entity, by the rule the
 * plugin applies on every write. Boots Vendure headless with `bootstrapWorker(config)`, runs
 * {@link runSlugBackfill}, prints the report and closes the app. Meant for a one-off host script.
 *
 * @example
 * ```ts
 * import { backfillUnifiedSlugs } from '@uplab/vendure-plugin-unified-slug';
 * import { config } from '../src/vendure-config';
 *
 * backfillUnifiedSlugs(config, { dryRun: process.argv.includes('--dry-run') });
 * ```
 */
export async function backfillUnifiedSlugs(
  config: VendureConfig,
  options: BackfillUnifiedSlugsOptions,
): Promise<SlugBackfillReport> {
  if (!config.plugins?.includes(UnifiedSlugPlugin)) {
    throw new Error('backfillUnifiedSlugs: UnifiedSlugPlugin is not in the config’s plugins');
  }
  const { app } = await bootstrapWorker(config);
  try {
    return await runSlugBackfill(app, options);
  } finally {
    await app.close();
  }
}

/**
 * @description
 * The backfill inside an app that is already running (what {@link backfillUnifiedSlugs} calls after
 * booting): one transaction, all or nothing. A dry run writes nothing.
 */
export async function runSlugBackfill(
  app: Pick<INestApplicationContext, 'get'>,
  options: BackfillUnifiedSlugsOptions,
): Promise<SlugBackfillReport> {
  const connection = app.get(TransactionalConnection);
  // No user: a script is not a request, and nothing on this path checks permissions.
  const ctx = await app.get(RequestContextService).create({ apiType: 'admin', channelOrToken: options.channelToken });
  const report = await connection.withTransaction(ctx, (txCtx) =>
    app.get(SlugBackfillService).backfill(txCtx, {
      entityNames: options.entityName ? [options.entityName] : UNIFIED_SLUG_ENTITY_NAMES,
      dryRun: options.dryRun,
    }),
  );
  formatSlugBackfillReport(report).forEach(options.logger ?? ((line) => console.log(line)));
  return report;
}

/** A header with the counts, then one line per listed entity. */
export function formatSlugBackfillReport(report: SlugBackfillReport): string[] {
  const header =
    `Unified slug backfill${report.dryRun ? ' (dry run, nothing written)' : ''}: ${report.scanned} scanned, ` +
    `${report.filled} filled, ${report.rewritten} rewritten, ${report.generated} generated, ` +
    `${report.conflicts} conflicts, ${report.noSlug} without slug`;
  return [
    header,
    ...report.entries.map((entry) => {
      const previous = entry.previousSlugs.map((p) => `${p.languageCode}=${p.slug || '∅'}`).join(' ');
      const conflict = entry.conflictsWith.length
        ? ` taken by ${entry.entityName} ${entry.conflictsWith.join(', ')}`
        : '';
      return `  ${entry.entityName} ${entry.entityId}: ${entry.outcome} ${entry.slug ?? ''} (was ${previous})${conflict}`;
    }),
  ];
}
