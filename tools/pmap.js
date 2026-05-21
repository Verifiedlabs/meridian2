/**
 * pmap — Promise-based map with concurrency limit.
 *
 * Audit 5/21 Phase 0: replace `await Promise.all(items.map(fn))` patterns
 * that fan out 50+ concurrent fetches to the same upstream API. Without a
 * limit those bursts get rate-limited and the entire batch fails.
 *
 * Behavior:
 *  - Resolves to an array of results in input order.
 *  - If any worker throws, the rejection propagates (Promise.all semantics).
 *    Use `.catch(() => null)` per item if you want allSettled semantics.
 *
 * @param {Iterable<T>} items
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {number} [concurrency=5]  max simultaneous in-flight workers
 * @returns {Promise<R[]>}
 */
export async function pmap(items, fn, concurrency = 5) {
  const list = Array.isArray(items) ? items : Array.from(items);
  if (list.length === 0) return [];
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array(list.length);
  let cursor = 0;

  const workers = new Array(Math.min(limit, list.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;
      results[i] = await fn(list[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
