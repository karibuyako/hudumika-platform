import { create } from 'zustand';

import { api, ApiError } from '@/api/client';
import type {
  BrandDisplayCampaign,
  BrandDisplayCampaignInput,
  Promotion,
  PromotionInput,
  PromotionPerformance,
  SelfServicePromotion,
} from '@/api/types';

export interface PromotionActionResult {
  ok: boolean;
  promotion?: Promotion;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

function errResult(e: unknown, fallback: string): { ok: false; code?: string; message: string; details?: Record<string, unknown> } {
  if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message, details: e.details };
  return { ok: false, message: fallback };
}

interface PromotionState {
  promotions: Promotion[];
  loading: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  create: (input: PromotionInput) => Promise<PromotionActionResult>;
  update: (id: string, patch: PromotionInput) => Promise<PromotionActionResult>;
  pause: (id: string, paused: boolean) => Promise<PromotionActionResult>;
  performance: (id: string) => Promise<PromotionPerformance | null>;

  brandDisplay: BrandDisplayCampaign | null;
  brandLoading: boolean;
  brandError: string | null;
  hydrateBrandDisplay: () => Promise<void>;
  saveBrandDisplay: (input: BrandDisplayCampaignInput) => Promise<PromotionActionResult>;

  selfService: SelfServicePromotion | null;
  ssLoading: boolean;
  ssError: string | null;
  hydrateSelfService: () => Promise<void>;
  toggleSelfService: (active: boolean, opts?: { package?: SelfServicePromotion['package']; designUrl?: string; homepageExposure?: boolean }) => Promise<PromotionActionResult>;
}

function upsertPromotion(list: Promotion[], p: Promotion): Promotion[] {
  const exists = list.some((x) => x.id === p.id);
  return exists ? list.map((x) => (x.id === p.id ? p : x)) : [p, ...list];
}

export const usePromotionStore = create<PromotionState>()((set) => ({
  promotions: [],
  loading: false,
  error: null,

  hydrate: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<Promotion[]>('/promotions', { retries: 1 });
      set({ promotions: res, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load promotions' });
    }
  },

  create: async (input) => {
    try {
      const promotion = await api.post<Promotion>('/promotions', input, { idempotencyKey: `promo:create:${Date.now()}` });
      set((s) => ({ promotions: upsertPromotion(s.promotions, promotion) }));
      return { ok: true, promotion };
    } catch (e) {
      return errResult(e, 'Failed to create promotion');
    }
  },

  update: async (id, patch) => {
    try {
      const promotion = await api.patch<Promotion>(`/promotions/${id}`, patch);
      set((s) => ({ promotions: upsertPromotion(s.promotions, promotion) }));
      return { ok: true, promotion };
    } catch (e) {
      return errResult(e, 'Failed to update promotion');
    }
  },

  pause: async (id, paused) => {
    try {
      const promotion = await api.post<Promotion>(`/promotions/${id}/pause`, { paused }, { idempotencyKey: `promo:pause:${id}:${Date.now()}` });
      set((s) => ({ promotions: upsertPromotion(s.promotions, promotion) }));
      return { ok: true, promotion };
    } catch (e) {
      return errResult(e, 'Failed to update promotion status');
    }
  },

  performance: async (id) => {
    try {
      return await api.get<PromotionPerformance>(`/promotions/${id}/performance`, { retries: 1 });
    } catch {
      return null;
    }
  },

  brandDisplay: null,
  brandLoading: false,
  brandError: null,

  hydrateBrandDisplay: async () => {
    set({ brandLoading: true, brandError: null });
    try {
      const campaign = await api.get<BrandDisplayCampaign>('/marketing/brand-display', { retries: 1 });
      set({ brandDisplay: campaign, brandLoading: false });
    } catch (e) {
      set({
        brandDisplay: null,
        brandLoading: false,
        brandError: e instanceof ApiError ? e.message : 'Failed to load brand display',
      });
    }
  },

  saveBrandDisplay: async (input) => {
    try {
      const campaign = await api.post<BrandDisplayCampaign>('/marketing/brand-display', input, { idempotencyKey: `brand:${Date.now()}` });
      set({ brandDisplay: campaign });
      return { ok: true };
    } catch (e) {
      return errResult(e, 'Failed to save brand display campaign');
    }
  },

  selfService: null,
  ssLoading: false,
  ssError: null,

  hydrateSelfService: async () => {
    set({ ssLoading: true, ssError: null });
    try {
      const row = await api.get<SelfServicePromotion>('/marketing/self-service', { retries: 1 });
      set({ selfService: row, ssLoading: false });
    } catch (e) {
      set({
        selfService: null,
        ssLoading: false,
        ssError: e instanceof ApiError ? e.message : 'Failed to load self-service promotion',
      });
    }
  },

  toggleSelfService: async (active, opts) => {
    try {
      const row = await api.post<SelfServicePromotion>('/marketing/self-service', { active, ...opts }, { idempotencyKey: `ss:${Date.now()}` });
      set({ selfService: row });
      return { ok: true };
    } catch (e) {
      return errResult(e, 'Failed to update self-service promotion');
    }
  },
}));
