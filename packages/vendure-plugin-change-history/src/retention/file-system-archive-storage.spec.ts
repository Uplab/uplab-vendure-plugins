import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSystemArchiveStorage } from './file-system-archive-storage';

describe('FileSystemArchiveStorage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'change-history-archive-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes an object under its key, creating the folders, and finds it again', async () => {
    const storage = new FileSystemArchiveStorage({ dir });
    const key = 'change-history-archive/2026/10/change-history_1.jsonl.gz';

    expect(await storage.exists(key)).toBe(false);
    await storage.put(key, Buffer.from('payload'));

    expect(await storage.exists(key)).toBe(true);
    expect(await readFile(path.join(dir, key), 'utf8')).toBe('payload');
  });

  it('refuses a key outside its directory', async () => {
    const storage = new FileSystemArchiveStorage({ dir });
    await expect(storage.put('../escape.jsonl.gz', Buffer.from('x'))).rejects.toThrow(/outside/);
    await expect(storage.put('', Buffer.from('x'))).rejects.toThrow(/outside/);
    expect(await storage.exists('../escape.jsonl.gz')).toBe(false);
  });

  it('needs a directory', () => {
    expect(() => new FileSystemArchiveStorage({ dir: '' })).toThrow(/"dir" is required/);
  });
});
