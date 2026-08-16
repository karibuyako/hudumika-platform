import { create } from 'zustand';

import { api } from '@/api/client';
import type {
  AnalyticsDashboard,
  ProductPerformance,
  ReviewAnalyticsContract,
  TrafficAnalysis,
} from '@/api/types';

export interface Overview {
  gmv: number;
  todayRevenue: number;
  prevRevenue: number;
  todayOrders: number;
  prevOrders: number;
  aov: number;
  conversion: number;
  repeatRate: number;
  praiseRate: number;
}

export interface TrendPoint {
  label: string;
  revenue: number;
  orders: number;
}

export interface DishStat {
  id: string;
  name: string;
  emoji: string;
  sold: number;
  revenue: number;
}

interface AnalyticsState {
  overview: Overview | null;
  trend: TrendPoint[];
  dishes: DishStat[];
  traffic: TrafficAnalysis | null;
  dashboard: AnalyticsDashboard | null;
  reviewAnalytics: ReviewAnalyticsContract | null;
  loaded: boolean;
  selectedStoreId: string | null;
  setStoreId: (id: string | null) => void;
  hydrate: () => Promise<void>;
  hydrateDashboard: () => Promise<void>;
}

const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function dishFrom(p: ProductPerformance): DishStat {
  return { id: p.catalogueItemId, name: p.name, emoji: '', sold: p.unitsSold, revenue: p.revenueTZS };
}

/* Selected store is persisted per session (MULTI-STORE.md:21 — the switcher
 * must survive tab switches; the mock has no per-device store). */
const SELECTED_KEY = 'merchant.selectedStore';

function readSelectedStore(): string | null {
  try {
    return sessionStorage.getItem(SELECTED_KEY) ?? localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function persistSelectedStore(id: string | null) {
  try {
    if (id) localStorage.setItem(SELECTED_KEY, id);
    else localStorage.removeItem(SELECTED_KEY);
  } catch {
    /* storage unavailable */
  }
}

export const useAnalyticsStore = create<AnalyticsState>()((set, get) => ({
  overview: null,
  trend: [],
  dishes: [],
  traffic: null,
  dashboard: null,
  reviewAnalytics: null,
  loaded: false,
  selectedStoreId: readSelectedStore(),

  setStoreId: (id) => {
    persistSelectedStore(id);
    set({ selectedStoreId: id });
  },

  hydrate: async () => {
    try {
      const { selectedStoreId } = get();
      const storeQ = selectedStoreId ? `&storeId=${encodeURIComponent(selectedStoreId)}` : '';
      const from = isoDate(new Date(Date.now() - 6 * 86400000));
      const to = isoDate(new Date());
      const [overview, trend, dishes, traffic, reviewAnalytics] = await Promise.all([
        /* ?storeId= (legacy dual dispatch in the mock) — the home dashboard
         * still consumes the Overview payload. */
        api.get<Overview>(`/analytics/dashboard?storeId=${selectedStoreId ?? ''}`, { retries: 1 }),
        api.get<{ days: TrendPoint[] }>(`/analytics/hourly-trends?days=7${storeQ}`, { retries: 1 }),
        api.get<{ top: ProductPerformance[] }>(`/analytics/top-dishes?from=${from}&to=${to}&limit=10${storeQ}`, { retries: 1 }),
        api.get<TrafficAnalysis>(`/analytics/traffic?from=${from}&to=${to}${storeQ}`, { retries: 1 }),
        api.get<ReviewAnalyticsContract>(`/analytics/reviews?from=${from}&to=${to}${storeQ}`, { retries: 1 }),
      ]);
      set({
        overview,
        trend: trend.days,
        dishes: dishes.top.map(dishFrom),
        traffic,
        reviewAnalytics,
        loaded: true,
      });
    } catch {
      /* screens fall back to local computation */
    }
  },

  /* Contract AnalyticsDashboard — today tiles + live strip (ANALYTICS.md:7-16).
   * ?live=1&storeId= selects the contract dispatch in the mock, scoped to the
   * chosen store. */
  hydrateDashboard: async () => {
    try {
      const { selectedStoreId } = get();
      const q = selectedStoreId ? `?live=1&storeId=${encodeURIComponent(selectedStoreId)}` : '';
      const dashboard = await api.get<AnalyticsDashboard>(`/analytics/dashboard${q}`, { retries: 1 });
      set({ dashboard });
    } catch {
      /* keep the last payload; the polling screen shows stale-while-revalidating */
    }
  },
}));
