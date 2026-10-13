import { Logger } from '@vendure/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DETAIL_COLUMN_LENGTHS, fitColumns, warnClipped } from './fit';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fitColumns', () => {
  it('clips over-long strings to their column and names them', () => {
    const clipped = new Set<string>();
    const row = fitColumns(
      { kind: 'k'.repeat(40), scope: 's'.repeat(64), entityId: 7, parentType: null, fromValue: 'x'.repeat(500) },
      DETAIL_COLUMN_LENGTHS,
      clipped,
    );
    expect(row).toEqual({
      kind: 'k'.repeat(32),
      scope: 's'.repeat(64),
      entityId: 7,
      parentType: null,
      fromValue: 'x'.repeat(500),
    });
    expect([...clipped]).toEqual(['kind']);
  });

  it('warns once per write, and only when it clipped something', () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    warnClipped('recordAction', new Set());
    expect(warn).not.toHaveBeenCalled();
    warnClipped('recordAction', new Set(['source', 'action']));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recordAction: clipped action, source'), 'ChangeHistory');
  });
});
