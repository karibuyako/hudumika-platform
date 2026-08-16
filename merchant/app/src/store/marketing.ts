import { create } from 'zustand';

import { api, ApiError } from '@/api/client';
import type {
  Coupon,
  CouponCampaign,
  CouponCampaignInput,
  CouponStats,
  DianjinCampaign,
  DianjinCampaignInput,
  FlashSale,
  FlashSaleInput,
  PrecisionCampaign,
  PrecisionCampaignInput,
} from '@/api/types';

export interface MarketingActionResult {
  ok: boolean;
  item?: FlashSale | DianjinCampaign | PrecisionCampaign | Coupon | CouponCampaign;
  code?: string;
  message?: string;
}

function errResult(e: unknown, fallback: string): { ok: false; code?: string; message: string } {
  if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message };
  return { ok: false, message: fallback };
}

interface MarketingState {
  flashSales: FlashSale[];
  dianjin: DianjinCampaign[];
  precision: PrecisionCampaign[];
  couponCampaigns: CouponCampaign[];
  couponStats: CouponStats | null;
  loading: boolean;
  error: string | null;
  hydrateFlashSales: () => Promise<void>;
  createFlashSale: (input: FlashSaleInput) => Promise<MarketingActionResult>;
  updateFlashSale: (id: string, patch: Partial<FlashSaleInput>) => Promise<MarketingActionResult>;
  hydrateDianjin: () => Promise<void>;
  createDianjin: (input: DianjinCampaignInput) => Promise<MarketingActionResult>;
  toggleDianjin: (id: string, active: boolean) => Promise<MarketingActionResult>;
  hydratePrecision: () => Promise<void>;
  createPrecision: (input: PrecisionCampaignInput) => Promise<MarketingActionResult>;
  sendPrecision: (id: string) => Promise<MarketingActionResult>;
  hydrateCouponCampaigns: () => Promise<void>;
  createCouponCampaign: (input: CouponCampaignInput) => Promise<MarketingActionResult>;
  couponStatsOf: (couponId: string) => Promise<CouponStats | null>;
  verifyCoupon: (code: string) => Promise<MarketingActionResult>;
}

function upsertFlash(list: FlashSale[], f: FlashSale): FlashSale[] {
  const exists = list.some((x) => x.id === f.id);
  return exists ? list.map((x) => (x.id === f.id ? f : x)) : [f, ...list];
}

function upsertDianjin(list: DianjinCampaign[], c: DianjinCampaign): DianjinCampaign[] {
  const exists = list.some((x) => x.id === c.id);
  return exists ? list.map((x) => (x.id === c.id ? c : x)) : [c, ...list];
}

function upsertPrecision(list: PrecisionCampaign[], c: PrecisionCampaign): PrecisionCampaign[] {
  const exists = list.some((x) => x.id === c.id);
  return exists ? list.map((x) => (x.id === c.id ? c : x)) : [c, ...list];
}

function upsertCouponCampaign(list: CouponCampaign[], c: CouponCampaign): CouponCampaign[] {
  const exists = list.some((x) => x.id === c.id);
  return exists ? list.map((x) => (x.id === c.id ? c : x)) : [c, ...list];
}

export const useMarketingStore = create<MarketingState>()((set) => ({
  flashSales: [],
  dianjin: [],
  precision: [],
  couponCampaigns: [],
  couponStats: null,
  loading: false,
  error: null,

  hydrateFlashSales: async () => {
    set({ loading: true, error: null });
    try {
      const rows = await api.get<FlashSale[]>('/marketing/flash-sales', { retries: 1 });
      set({ flashSales: rows, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load flash sales' });
    }
  },

  createFlashSale: async (input) => {
    try {
      const flashSale = await api.post<FlashSale>('/marketing/flash-sales', input, { idempotencyKey: `fs:create:${Date.now()}` });
      set((s) => ({ flashSales: upsertFlash(s.flashSales, flashSale) }));
      return { ok: true, item: flashSale };
    } catch (e) {
      return errResult(e, 'Failed to create flash sale');
    }
  },

  updateFlashSale: async (id, patch) => {
    try {
      const flashSale = await api.patch<FlashSale>(`/marketing/flash-sales/${id}`, patch);
      set((s) => ({ flashSales: upsertFlash(s.flashSales, flashSale) }));
      return { ok: true, item: flashSale };
    } catch (e) {
      return errResult(e, 'Failed to update flash sale');
    }
  },

  hydrateDianjin: async () => {
    set({ loading: true, error: null });
    try {
      const rows = await api.get<DianjinCampaign[]>('/marketing/dianjin', { retries: 1 });
      set({ dianjin: rows, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load DianJin campaigns' });
    }
  },

  createDianjin: async (input) => {
    try {
      const campaign = await api.post<DianjinCampaign>('/marketing/dianjin', input, { idempotencyKey: `dj:create:${Date.now()}` });
      set((s) => ({ dianjin: upsertDianjin(s.dianjin, campaign) }));
      return { ok: true, item: campaign };
    } catch (e) {
      return errResult(e, 'Failed to create DianJin campaign');
    }
  },

  toggleDianjin: async (id, active) => {
    try {
      const campaign = await api.patch<DianjinCampaign>(`/marketing/dianjin/${id}/toggle`, { active });
      set((s) => ({ dianjin: upsertDianjin(s.dianjin, campaign) }));
      return { ok: true, item: campaign };
    } catch (e) {
      return errResult(e, 'Failed to toggle DianJin campaign');
    }
  },

  hydratePrecision: async () => {
    set({ loading: true, error: null });
    try {
      const rows = await api.get<PrecisionCampaign[]>('/marketing/precision', { retries: 1 });
      set({ precision: rows, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load precision campaigns' });
    }
  },

  createPrecision: async (input) => {
    try {
      const campaign = await api.post<PrecisionCampaign>('/marketing/precision', input, { idempotencyKey: `pc:create:${Date.now()}` });
      set((s) => ({ precision: upsertPrecision(s.precision, campaign) }));
      return { ok: true, item: campaign };
    } catch (e) {
      return errResult(e, 'Failed to create precision campaign');
    }
  },

  sendPrecision: async (id) => {
    try {
      const campaign = await api.post<PrecisionCampaign>(`/marketing/precision/${id}/send`, {}, { idempotencyKey: `pc:send:${id}:${Date.now()}` });
      set((s) => ({ precision: upsertPrecision(s.precision, campaign) }));
      return { ok: true, item: campaign };
    } catch (e) {
      return errResult(e, 'Failed to send precision campaign');
    }
  },

  couponStatsOf: async (couponId) => {
    try {
      const stats = await api.get<CouponStats>(`/marketing/coupons/${couponId}/stats`, { retries: 1 });
      set({ couponStats: stats });
      return stats;
    } catch {
      return null;
    }
  },

  hydrateCouponCampaigns: async () => {
    try {
      const res = await api.get<{ coupons: CouponCampaign[] }>('/marketing/coupons', { retries: 1 });
      set({ couponCampaigns: res.coupons });
    } catch {
      /* keep stale */
    }
  },

  createCouponCampaign: async (input) => {
    try {
      const res = await api.post<{ couponCampaign: CouponCampaign }>('/coupons', input, { idempotencyKey: `cc:${Date.now()}` });
      set((s) => ({ couponCampaigns: upsertCouponCampaign(s.couponCampaigns, res.couponCampaign) }));
      return { ok: true, item: res.couponCampaign };
    } catch (e) {
      return errResult(e, 'Failed to create coupon campaign');
    }
  },

  verifyCoupon: async (code) => {
    try {
      const coupon = await api.post<Coupon>('/marketing/coupons/verify', { code }, { idempotencyKey: `coupon:verify:${code}:${Date.now()}` });
      return { ok: true, item: coupon };
    } catch (e) {
      return errResult(e, 'Could not verify coupon');
    }
  },
}));
