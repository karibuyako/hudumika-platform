import { create } from 'zustand';

import { api } from '@/api/client';
import type { ChainDashboard, ChainReportBody, ChainStorePerformance, ReportExport } from '@/api/types';
import { uid } from '@/lib/format';

interface ChainState {
  dashboard: ChainDashboard | null;
  stores: ChainStorePerformance[];
  loading: boolean;
  error: string | null;
  /** Cross-store analytics (GET /chain/analytics?from&to) — EF L18-22. */
  analytics: ChainStorePerformance[];
  analyticsLoading: boolean;
  analyticsError: string | null;
  hydrate: () => Promise<void>;
  exportReport: (body: ChainReportBody) => Promise<ReportExport | null>;
  fetchAnalytics: (from: string, to: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
}

export const useChainStore = create<ChainState>()((set) => ({
  dashboard: null,
  stores: [],
  loading: false,
  error: null,
  analytics: [],
  analyticsLoading: false,
  analyticsError: null,

  hydrate: async () => {
    set({ loading: true, error: null });
    try {
      const dashboard = await api.get<ChainDashboard>('/chain/dashboard', { retries: 1 });
      set({ dashboard, stores: dashboard.stores, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'hydrate failed' });
    }
  },

  exportReport: async (body) => {
    try {
      const result = await api.post<ReportExport>('/chain/reports', body, {
        idempotencyKey: `chain-report-${uid()}`,
      });
      return result;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'export failed' });
      return null;
    }
  },

  fetchAnalytics: async (from, to) => {
    set({ analyticsLoading: true, analyticsError: null });
    try {
      const rows = await api.get<ChainStorePerformance[]>(`/chain/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { retries: 1 });
      set({ analytics: rows, analyticsLoading: false });
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      set({ analyticsLoading: false, analyticsError: err.message ?? 'analytics failed' });
      return { ok: false, code: err.code, message: err.message };
    }
  },
}));
