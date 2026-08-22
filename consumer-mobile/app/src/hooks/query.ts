/* Query keys mirror contract resources (INSTRUCTIONS §5 tab map):
 * ['orders','me',{status}], ['merchants',id], ['orders',id,'track'],
 * ['catalogues',merchantId]. Screens invalidate/refetch on 409/CONFLICT —
 * server state wins. (Rider has no react-query; these builders keep the
 * resource-key convention without a new dependency.) */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  clearQueryCache,
  getCacheEntry,
  invalidateQuery,
  peekQuery,
  registerQuery,
  serializeCacheKey,
  subscribeCache,
} from './queryCache';
import type { CacheKey, QueryCacheEntry, QueryLoader } from './queryCache';

export { clearQueryCache, getCacheEntry, invalidateQuery, peekQuery, registerQuery, serializeCacheKey, subscribeCache };
export type { CacheKey, QueryCacheEntry, QueryLoader };

export const queryKeys = {
  home: { all: ['home'] as const, feed: ['home', 'feed'] as const, cities: ['cities'] as const, recommendations: (cityId?: string) => ['home', 'recommendations', cityId ?? ''] as const },
  search: { results: (q: string) => ['search', q] as const, suggest: (q: string) => ['search', 'suggest', q] as const },
  merchants: {
    list: (params?: { cityId?: string; category?: string }) => ['merchants', params ?? {}] as const,
    detail: (merchantId: string) => ['merchants', merchantId] as const,
    catalogue: (merchantId: string) => ['catalogues', merchantId] as const,
    promotions: (merchantId: string) => ['merchants', merchantId, 'promotions'] as const,
  },
  orders: {
    me: (params?: { status?: string }) => ['orders', 'me', params ?? {}] as const,
    detail: (orderId: string) => ['orders', orderId] as const,
    track: (orderId: string) => ['orders', orderId, 'track'] as const,
    route: (orderId: string) => ['orders', orderId, 'route'] as const,
    waybill: (orderId: string) => ['orders', orderId, 'waybill'] as const,
    phases: (orderId: string) => ['orders', orderId, 'tracking-phases'] as const,
  },
  bookings: { me: (params?: { status?: string }) => ['bookings', 'me', params ?? {}] as const, detail: (id: string) => ['bookings', id] as const },
  wallet: { me: ['wallet', 'me'] as const, transactions: ['wallet', 'me', 'transactions'] as const },
  coupons: { me: (status?: string) => ['coupons', 'me', status ?? ''] as const },
  conversations: {
    list: (status?: string) => ['conversations', status ?? ''] as const,
    thread: (id: string) => ['conversations', id] as const,
    messages: (id: string) => ['conversations', id, 'messages'] as const,
    unread: ['conversations', 'unread-count'] as const,
  },
  notifications: { me: ['notifications', 'me'] as const, preferences: ['notifications', 'me', 'preferences'] as const },
  support: { me: ['support', 'tickets', 'me'] as const, detail: (id: string) => ['support', 'tickets', id] as const },
  reviews: { mine: ['reviews', 'me'] as const },
  favorites: { all: ['favorites'] as const },
  membership: { me: ['memberships', 'me'] as const },
} as const;

export interface UseQueryDataResult<T> {
  data: T | null;
  loading: boolean;
  /** Invalidate the key and reload from the repo. */
  refetch: () => Promise<void>;
}

/**
 * Hook over the QueryCache core (README §Server state). Renders cached data
 * for the key when present (no reload); otherwise loads through the loader
 * once. Refetches on invalidateQuery elsewhere (notify-driven) and exposes
 * refetch() for pull-to-refresh/retry. Screens adopt incrementally — the
 * existing useState + load() pattern stays valid.
 */
export function useQueryData<T>(key: CacheKey, loader: QueryLoader<T>): UseQueryDataResult<T> {
  const [loading, setLoading] = useState(false);
  const data = useSyncExternalStore(
    subscribeCache,
    () => getCacheEntry<T>(key)?.data ?? null,
    () => null,
  );

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      invalidateQuery(key);
      await registerQuery(key, loader);
    } finally {
      setLoading(false);
    }
  }, [key, loader]);

  // Load only when nothing is cached — a cached entry renders without a
  // reload (the cache is the source of truth until invalidated).
  useEffect(() => {
    if (getCacheEntry(key)) return;
    void refetch();
  }, [key, refetch]);

  return { data, loading, refetch };
}
