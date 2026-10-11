import { InjectableStrategy } from '@vendure/core';

/**
 * @description
 * Where compaction puts the full record of an entry before it strips or deletes anything. Compaction
 * writes an object with `put`, then requires `exists` to return `true` before it touches the database
 * (the upload-first invariant).
 *
 * The package calls `init(injector)` on bootstrap and `destroy()` on shutdown, so an adapter can inject
 * the host's own services (an object-store client, for example).
 *
 * @example
 * ```ts
 * export class MyBucketArchiveStorage implements ChangeHistoryArchiveStorage {
 *   private bucket: BucketService;
 *   init(injector: Injector) { this.bucket = injector.get(BucketService); }
 *   put(key: string, body: Buffer, contentType: string) { return this.bucket.upload(key, body, contentType); }
 *   exists(key: string) { return this.bucket.has(key); }
 * }
 * ```
 */
export interface ChangeHistoryArchiveStorage extends InjectableStrategy {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Verifies an object written by `put` (a HEAD request for an object store). */
  exists(key: string): Promise<boolean>;
}
