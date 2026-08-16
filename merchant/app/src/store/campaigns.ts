import { create } from 'zustand';

import { api } from '@/api/client';
import type { CampaignDto, PlatformCampaignDto } from '@/api/types';
import type { Campaign, CampaignType, PlatformCampaign } from '@/types';

interface CampaignState {
  campaigns: Campaign[];
  platformCampaigns: PlatformCampaign[];
  hydrate: () => Promise<void>;
  upsert: (campaign: Campaign) => void;
  createCampaign: (input: {
    type: CampaignType;
    title: string;
    budget: number;
    start: number;
    end: number;
    discountRate?: number;
    couponAmount?: number;
    threshold?: number;
    target: string;
    productIds: string[];
    groupBuyTargets?: { buyers: number; discountRate: number }[];
    haggleEnabled?: boolean;
    cpc?: number;
  }) => Promise<void>;
  stopCampaign: (id: string) => Promise<void>;
  signupPlatform: (id: string) => Promise<void>;
}

export const useCampaignStore = create<CampaignState>()((set) => ({
  campaigns: [],
  platformCampaigns: [],

  hydrate: async () => {
    try {
      const [mine, platform] = await Promise.all([
        api.get<{ campaigns: CampaignDto[] }>('/coupon-campaigns', { retries: 1 }),
        api.get<{ campaigns: PlatformCampaignDto[] }>('/marketing/platform-events', { retries: 1 }),
      ]);
      set({ campaigns: mine.campaigns, platformCampaigns: platform.campaigns });
    } catch {
      /* keep stale */
    }
  },

  upsert: (campaign) =>
    set((s) => {
      const exists = s.campaigns.some((c) => c.id === campaign.id);
      return { campaigns: exists ? s.campaigns.map((c) => (c.id === campaign.id ? campaign : c)) : [campaign, ...s.campaigns] };
    }),

  createCampaign: async (input) => {
    try {
      const res = await api.post<{ campaign: Campaign }>('/coupon-campaigns', input, { idempotencyKey: `cp:${Date.now()}` });
      set((s) => ({ campaigns: [res.campaign, ...s.campaigns] }));
    } catch {
      /* surface via toast elsewhere */
    }
  },

  stopCampaign: async (id) => {
    try {
      const res = await api.post<{ campaign: Campaign }>(`/campaigns/${id}/stop`, {}, { idempotencyKey: `stop:${id}:${Date.now()}` });
      set((s) => ({ campaigns: s.campaigns.map((c) => (c.id === id ? res.campaign : c)) }));
    } catch {
      /* keep stale */
    }
  },

  signupPlatform: async (id) => {
    try {
      const res = await api.post<{ campaign: PlatformCampaign }>(`/marketing/platform-events/${id}/enroll`, {}, { idempotencyKey: `ps:${id}:${Date.now()}` });
      set((s) => ({ platformCampaigns: s.platformCampaigns.map((p) => (p.id === id ? res.campaign : p)) }));
    } catch {
      /* keep stale */
    }
  },
}));
