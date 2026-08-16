import { create } from 'zustand';

import { api, ApiError, getToken } from '@/api/client';
import type {
  ApiErrorBody,
  ChainStore,
  LeadCreated,
  MerchantApplication,
  MerchantClaim,
  MerchantCommercialTerms,
  MerchantPublic,
  MerchantVerificationStatus,
  PayoutAccount,
  PayoutAccountWrite,
  StoreSettings,
  StoreSettingsUpdate,
} from '@/api/types';

/** PUT — api has no put() and client.ts is frozen; mirrors the local fetch
 *  helper used in store/loyalty.ts / store/notifications-settings.ts. */
async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${getToken() ?? ''}`,
    },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

interface MerchantsState {
  merchants: MerchantPublic[];
  merchant: MerchantPublic | null;
  settings: StoreSettings | null;
  payoutAccount: PayoutAccount | null;
  verification: MerchantVerificationStatus | null;
  commercial: MerchantCommercialTerms | null;
  loading: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  hydrateMerchant: (id: string) => Promise<void>;
  apply: (application: MerchantApplication) => Promise<LeadCreated | null>;
  claim: (claim: MerchantClaim) => Promise<LeadCreated | null>;
  hydrateSettings: () => Promise<void>;
  saveSettings: (update: StoreSettingsUpdate) => Promise<StoreSettings | null>;
  hydratePayout: () => Promise<void>;
  savePayout: (write: PayoutAccountWrite) => Promise<PayoutAccount | null>;
  hydratePrivate: () => Promise<void>;
  updateStore: (storeId: string, patch: StoreSettingsUpdate) => Promise<ChainStore | null>;
}

export const useMerchantsStore = create<MerchantsState>()((set) => ({
  merchants: [],
  merchant: null,
  settings: null,
  payoutAccount: null,
  verification: null,
  commercial: null,
  loading: false,
  error: null,

  hydrate: async () => {
    set({ loading: true, error: null });
    try {
      const merchants = await api.get<MerchantPublic[]>('/merchants', { retries: 1 });
      set({ merchants, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load merchants' });
    }
  },

  hydrateMerchant: async (id) => {
    set({ loading: true, error: null });
    try {
      const merchant = await api.get<MerchantPublic>(`/merchants/${id}`, { retries: 1 });
      set({ merchant, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load merchant' });
    }
  },

  apply: async (application) => {
    try {
      const lead = await api.post<LeadCreated>('/merchants', application, { idempotencyKey: `mch:apply:${Date.now()}` });
      set({ error: null });
      return lead;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Application failed' });
      return null;
    }
  },

  claim: async (claim) => {
    try {
      const lead = await api.post<LeadCreated>('/merchants/claim', claim, { idempotencyKey: `mch:claim:${claim.merchantId}:${Date.now()}` });
      set({ error: null });
      return lead;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Claim failed' });
      return null;
    }
  },

  hydrateSettings: async () => {
    set({ loading: true, error: null });
    try {
      const settings = await api.get<StoreSettings>('/merchants/me/settings', { retries: 1 });
      set({ settings, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load settings' });
    }
  },

  saveSettings: async (update) => {
    try {
      const settings = await put<StoreSettings>('/merchants/me/settings', update);
      set({ settings, error: null });
      return settings;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Failed to save settings' });
      return null;
    }
  },

  hydratePayout: async () => {
    set({ loading: true, error: null });
    try {
      const payoutAccount = await api.get<PayoutAccount>('/merchants/me/payout-account', { retries: 1 });
      set({ payoutAccount, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load payout account' });
    }
  },

  savePayout: async (write) => {
    try {
      const payoutAccount = await put<PayoutAccount>('/merchants/me/payout-account', write);
      set({ payoutAccount, error: null });
      return payoutAccount;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Failed to save payout account' });
      return null;
    }
  },

  hydratePrivate: async () => {
    set({ loading: true, error: null });
    try {
      const { verification, commercial } = await api.get<{
        verification: MerchantVerificationStatus;
        commercial: MerchantCommercialTerms;
      }>('/merchants/me', { retries: 1 });
      set({ verification, commercial, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load merchant verification' });
    }
  },

  updateStore: async (storeId, patch) => {
    try {
      const store = await api.patch<ChainStore>(`/merchants/me/stores/${storeId}`, patch, { idempotencyKey: `mch:store:${storeId}:${Date.now()}` });
      set({ error: null });
      return store;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Failed to update store' });
      return null;
    }
  },
}));
