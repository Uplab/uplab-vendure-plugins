interface PendingBatch<T, R> {
  items: Map<string, T>;
  result: Promise<Map<string, R>>;
}

/**
 * Collects the keys GraphQL asks for while it resolves one list (a field resolver runs once per item) and
 * loads them with one call per scope — the request — instead of one query per item. The batch is sent on
 * the next macrotask, after every item's resolver has queued its key.
 */
export class Batcher<S extends object, T, R> {
  private readonly pending = new WeakMap<S, PendingBatch<T, R>>();

  constructor(
    private readonly keyOf: (item: T) => string,
    private readonly load: (scope: S, items: T[]) => Promise<Map<string, R>>,
  ) {}

  get(scope: S, item: T): Promise<R | undefined> {
    let batch = this.pending.get(scope);
    if (!batch) {
      const items = new Map<string, T>();
      const result = new Promise<Map<string, R>>((resolve, reject) => {
        setImmediate(() => {
          this.pending.delete(scope);
          this.load(scope, [...items.values()]).then(resolve, reject);
        });
      });
      batch = { items, result };
      this.pending.set(scope, batch);
    }
    const key = this.keyOf(item);
    batch.items.set(key, item);
    return batch.result.then((loaded) => loaded.get(key));
  }
}
