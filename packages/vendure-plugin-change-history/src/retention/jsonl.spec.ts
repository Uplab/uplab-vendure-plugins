import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { archiveKey, decodeChangeHistoryArchive, encodeArchive } from './jsonl';

describe('archive lines', () => {
  it('round-trips gzipped JSON lines', async () => {
    const lines = [
      { table: 'change_history_entry' as const, row: { id: 1, createdAt: '2026-03-15 04:15:00.123456', meta: {} } },
      { table: 'change_history_detail' as const, row: { id: 7, entryId: 1, fromValue: 5, toValue: 7 } },
    ];
    expect(decodeChangeHistoryArchive(await encodeArchive(lines))).toEqual(lines);
  });

  it('streams many lines through gzip, waiting for it to drain', async () => {
    const lines = Array.from({ length: 20_000 }, (_, id) => ({
      table: 'change_history_detail' as const,
      row: { id, entryId: 1, fromValue: `${id}-${'x'.repeat(id % 97)}`, toValue: id * 7 },
    }));
    function* generated() {
      yield* lines;
    }
    expect(decodeChangeHistoryArchive(await encodeArchive(generated()))).toEqual(lines);
  });

  it('skips blank lines and refuses anything that is not a { table, row } line', () => {
    const body = (text: string) => gzipSync(Buffer.from(text));
    expect(decodeChangeHistoryArchive(body('\n{"table":"change_history_entry","row":{"id":1}}\n\n'))).toHaveLength(1);
    expect(() => decodeChangeHistoryArchive(body('{"table":"order","row":{}}'))).toThrow(/line 1/);
    expect(() => decodeChangeHistoryArchive(body('{"table":"change_history_entry","row":null}'))).toThrow(/line 1/);
  });

  it('builds keys from the oldest row, its month and the highest id', () => {
    expect(archiveKey('arch', '2026-03-15 04:15:00.123456', 42, 'u-1')).toBe(
      'arch/2026/03/change-history_20260315T041500_42_u-1.jsonl.gz',
    );
    expect(archiveKey('arch', new Date('2026-01-02T03:04:05Z'), 'a1b2-c3', 'u')).toBe(
      'arch/2026/01/change-history_20260102T030405_a1b2-c3_u.jsonl.gz',
    );
    expect(archiveKey('arch', 'Mon Mar 02 2026 10:00:00 GMT+0000', '../7', 'u')).toMatch(
      /^arch\/2026\/03\/change-history_20260302T\d{6}_7_u\.jsonl\.gz$/,
    );
    expect(archiveKey('arch', 'garbage', 1, 'u')).toMatch(
      /^arch\/\d{4}\/\d{2}\/change-history_\d{8}T\d{6}_1_u\.jsonl\.gz$/,
    );
  });
});
