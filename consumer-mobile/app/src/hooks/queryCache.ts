/* QueryCache — the sanctioned server-state cache layer (ARCHITECTURE.md
 * "React Query: all server state" decision; see README §Server state).
 *
 * Dependency-free core: a module-level Map keyed by the serialized query
 * key (the queryKeys builders in src/hooks/query.ts), with subscribe/notify
 * so React hooks (useQueryData) and non-React code (event handlers, realtime
 * listeners) share one cache. Screens adopt it incrementally; existing
 * screens keep their useState + load() pattern until migrated.
 *
 * A future @tanstack/react-query migration swaps this core for a QueryClient
 * — the keys and invalidation semantics are already theirs (keys mirror
 * contract resources, invalidate by exact key or prefix).
 *
 * This module is pure (no React): tests exercise it directly. */
export type CacheKey = readonly unknown[];
export type QueryLoader<T> = () => Promise<T>;

export interface QueryCacheEntry<T> {
  data: T;
  at: number;
}

export type CacheListener = () => void;

/** Serialize a query key array to a Map key. JSON keeps object params
 * (['orders','me',{status}]) stable, and the first element is delimited by
 * its closing quote, so the open-prefix match in invalidateQuery can never
 * collide across keys (['orders'] can never prefix-match ['ordersx']). */
export function serializeCacheKey(key: CacheKey | string): string {
  return typeof key === 'string' ? key : JSON.stringify(key);
}

const cache = new Map<string, QueryCacheEntry<unknown>>();
const listeners = new Set<CacheListener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to cache changes (entries added/invalidated). Returns an
 * unsubscribe function. */
export function subscribeCache(listener: CacheListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Cached entry for an exact key (undefined when absent or invalidated). */
export function getCacheEntry<T>(key: CacheKey | string): QueryCacheEntry<T> | undefined {
  return cache.get(serializeCacheKey(key)) as QueryCacheEntry<T> | undefined;
}

/** Cached data for an exact key (undefined when absent or invalidated). */
export function peekQuery<T>(key: CacheKey | string): T | undefined {
  return getCacheEntry<T>(key)?.data;
}

/** Register a loader for a key. Returns the cached data when the key is
 * already cached (no reload — the caller renders it as-is); otherwise runs
 * the loader, stores the result and notifies subscribers. Server failures
 * are never cached (the caller owns the error/retry state). */
export async function registerQuery<T>(key: CacheKey | string, loader: QueryLoader<T>): Promise<{ data: T; fromCache: boolean }> {
  const cacheKey = serializeCacheKey(key);
  const hit = cache.get(cacheKey);
  if (hit) return { data: hit.data as T, fromCache: true };
  const data = await loader();
  cache.set(cacheKey, { data, at: Date.now() });
  notify();
  return { data, fromCache: false };
}

/** Drop an exact key, or every entry under a key prefix
 * (invalidateQuery(['orders']) clears ['orders','me'] and
 * ['orders',id,'track'] — the queryKeys structure). String keys are
 * exact-match only. Notifies subscribers when anything was dropped. */
export function invalidateQuery(key: CacheKey | string): void {
  const prefix = serializeCacheKey(key);
  // Array keys serialize to ["a","b"], so a nested key NEVER string-prefixes
  // its parent (["orders","me"] has ',' where ["orders"] has ']'). Match the
  // open form (everything before the closing ']') instead: every child key
  // starts with it, while sibling keys (["ordersx"]) cannot (first element
  // ends in the same closing quote).
  const openPrefix = typeof key === 'string' || !prefix.endsWith(']') ? null : prefix.slice(0, -1);
  let changed = false;
  for (const k of [...cache.keys()]) {
    if (k === prefix || (openPrefix !== null && k.startsWith(openPrefix))) {
      cache.delete(k);
      changed = true;
    }
  }
  if (changed) notify();
}

/** Drop every cached entry (logout, session switch). */
export function clearQueryCache(): void {
  if (cache.size === 0) return;
  cache.clear();
  notify();
}
