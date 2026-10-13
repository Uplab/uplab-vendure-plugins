import { once } from 'node:events';
import { createGzip, gunzipSync } from 'node:zlib';

/** The logical table names used in archive lines (independent of a host's `entityPrefix`). */
export const ARCHIVE_TABLES = {
  entry: 'change_history_entry',
  detail: 'change_history_detail',
} as const;

type ArchiveTable = (typeof ARCHIVE_TABLES)[keyof typeof ARCHIVE_TABLES];

/**
 * @description
 * One line of a change-history archive object (gzipped JSON Lines). `row` holds the database columns as
 * stored: timestamps as the database's own text (Postgres keeps microseconds), JSON columns parsed.
 */
export interface ChangeHistoryArchiveLine {
  table: ArchiveTable;
  row: Record<string, unknown>;
}

export const ARCHIVE_CONTENT_TYPE = 'application/gzip';

/**
 * Gzipped JSON Lines, one line per row. Each line goes through the gzip stream on its own: only the compressed
 * object is ever held in full, never the text of the whole batch.
 */
export async function encodeArchive(lines: Iterable<ChangeHistoryArchiveLine>): Promise<Buffer> {
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = once(gzip, 'end');
  for (const line of lines) {
    if (!gzip.write(`${JSON.stringify(line)}\n`, 'utf8')) {
      await once(gzip, 'drain');
    }
  }
  gzip.end();
  await finished;
  return Buffer.concat(chunks);
}

/**
 * @description
 * Reads an archive object written by compaction (gzipped JSON Lines) back into lines, e.g. to restore it
 * with `ChangeHistoryRetentionService.restore()`.
 */
export function decodeChangeHistoryArchive(body: Buffer): ChangeHistoryArchiveLine[] {
  const text = gunzipSync(body).toString('utf8');
  const lines: ChangeHistoryArchiveLine[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') {
      continue;
    }
    const line = JSON.parse(raw) as ChangeHistoryArchiveLine;
    if (
      (line?.table !== ARCHIVE_TABLES.entry && line?.table !== ARCHIVE_TABLES.detail) ||
      typeof line.row !== 'object' ||
      line.row === null
    ) {
      throw new Error(`change-history archive: line ${index + 1} is not a { table, row } line`);
    }
    lines.push(line);
  }
  return lines;
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

/**
 * `<prefix>/<yyyy>/<mm>/change-history_<stamp>_<maxId>_<uuid>.jsonl.gz`, dated by the oldest row of the
 * object (a raw database timestamp or a `Date`).
 */
export function archiveKey(prefix: string, oldest: string | Date, maxId: unknown, uuid: string): string {
  let parts = typeof oldest === 'string' ? TIMESTAMP.exec(oldest)?.slice(1) : undefined;
  if (!parts) {
    const date = oldest instanceof Date ? oldest : new Date(oldest);
    const iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
    parts = TIMESTAMP.exec(iso)!.slice(1);
  }
  const [year, month, day, hour, minute, second] = parts;
  const id = String(maxId).replace(/[^A-Za-z0-9-]/g, '');
  return `${prefix}/${year}/${month}/change-history_${year}${month}${day}T${hour}${minute}${second}_${id}_${uuid}.jsonl.gz`;
}
