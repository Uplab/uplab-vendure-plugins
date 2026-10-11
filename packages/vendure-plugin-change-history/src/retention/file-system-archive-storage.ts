import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ChangeHistoryArchiveStorage } from './archive-storage';

/**
 * @description
 * Writes archive objects as files under a local directory, one file per key. Meant for development and
 * tests; production hosts plug in an object store.
 *
 * @example
 * ```ts
 * ChangeHistoryPlugin.init({
 *   retention: { archive: new FileSystemArchiveStorage({ dir: './change-history-archive' }) },
 * });
 * ```
 */
export class FileSystemArchiveStorage implements ChangeHistoryArchiveStorage {
  private readonly dir: string;

  constructor(options: { dir: string }) {
    if (typeof options?.dir !== 'string' || options.dir.trim() === '') {
      throw new Error('FileSystemArchiveStorage: "dir" is required');
    }
    this.dir = path.resolve(options.dir);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  /** Keys are relative paths; one that would leave the directory is refused. */
  private resolve(key: string): string {
    const file = path.resolve(this.dir, key);
    if (key.trim() === '' || !file.startsWith(this.dir + path.sep)) {
      throw new Error(`FileSystemArchiveStorage: key "${key}" is outside ${this.dir}`);
    }
    return file;
  }
}
