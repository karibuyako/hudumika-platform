import { create } from 'zustand';

import { api, ApiError, getToken } from '@/api/client';
import type { ApiErrorBody, CustomerMembership, LoyaltyMember, LoyaltyMemberListItem, LoyaltyTransaction, MembershipTier, TopUpPaymentMethod, TopUpResult } from '@/api/types';

/** PUT — api has no put() and client.ts is frozen; mirrors the local
 *  fetch helpers used for DELETE in products/templates.tsx. */
async function put(path: string, body: unknown): Promise<unknown> {
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
  return data;
}

interface LoyaltyState {
  members: LoyaltyMemberListItem[];
  member: LoyaltyMember | null;
  tiers: MembershipTier[];
  loyaltyTransactions: LoyaltyTransaction[];
  myMembership: CustomerMembership | null;
  loading: boolean;
  error: string | null;
  hydrateMembers: (search?: string) => Promise<void>;
  hydrateMember: (id: string) => Promise<void>;
  registerMember: (input: { name: string; phone: string; birthday?: string }) => Promise<LoyaltyMember | null>;
  updateMember: (id: string, patch: { name?: string; phone?: string; birthday?: string | null }) => Promise<LoyaltyMember | null>;
  topUp: (id: string, amountTZS: number, paymentMethod?: TopUpPaymentMethod) => Promise<TopUpResult | null>;
  redeem: (id: string, amountTZS: number) => Promise<{ member: LoyaltyMember | null; code?: string; message?: string }>;
  hydrateTiers: () => Promise<void>;
  updateTiers: (tiers: Omit<MembershipTier, 'id' | 'merchantId'>[]) => Promise<void>;
  hydrateLoyaltyTransactions: () => Promise<void>;
  hydrateMyMembership: () => Promise<void>;
}

export const useLoyaltyStore = create<LoyaltyState>()((set) => ({
  members: [],
  member: null,
  tiers: [],
  loyaltyTransactions: [],
  myMembership: null,
  loading: false,
  error: null,

  hydrateMembers: async (search) => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<{ members: LoyaltyMemberListItem[] }>(
        search ? `/members?search=${encodeURIComponent(search)}` : '/members',
        { retries: 1 },
      );
      set({ members: res.members, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load members' });
    }
  },

  hydrateMember: async (id) => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<{ member: LoyaltyMember }>(`/members/${id}`, { retries: 1 });
      set({ member: res.member, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load member' });
    }
  },

  registerMember: async (input) => {
    try {
      const res = await api.post<{ member: LoyaltyMember }>('/members', input, { idempotencyKey: `loy:${Date.now()}` });
      set((s) => ({
        members: [{ id: res.member.id, name: res.member.name, maskedPhone: res.member.maskedPhone, balanceTZS: 0, tierId: res.member.tierId, tierName: res.member.tier?.name ?? null, totalSpendTZS: 0, joinedAt: res.member.joinedAt }, ...s.members],
      }));
      return res.member;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Failed to register member' });
      return null;
    }
  },

  updateMember: async (id, patch) => {
    try {
      const res = await api.patch<{ member: LoyaltyMember }>(`/members/${id}`, patch);
      set((s) => ({
        member: res.member,
        members: s.members.map((m) => (m.id === id ? { id: m.id, name: res.member.name, maskedPhone: res.member.maskedPhone, balanceTZS: res.member.balanceTZS, tierId: res.member.tierId, tierName: res.member.tier?.name ?? null, totalSpendTZS: res.member.totalSpendTZS, joinedAt: res.member.joinedAt } : m)),
      }));
      return res.member;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Failed to update member' });
      return null;
    }
  },

  topUp: async (id, amountTZS, paymentMethod) => {
    try {
      const res = await api.post<{ topUp: TopUpResult }>(`/members/${id}/top-up`, { amountTZS, paymentMethod }, { idempotencyKey: `loyalty:topup:${id}:${Date.now()}` });
      const { member } = res.topUp;
      set((s) => ({
        member: member,
        members: s.members.map((m) => (m.id === id ? { id: m.id, name: member.name, maskedPhone: member.maskedPhone, balanceTZS: member.balanceTZS, tierId: member.tierId, tierName: member.tier?.name ?? null, totalSpendTZS: member.totalSpendTZS, joinedAt: member.joinedAt } : m)),
      }));
      return res.topUp;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Failed to credit balance' });
      return null;
    }
  },

  redeem: async (id, amountTZS) => {
    try {
      const res = await api.post<{ member: LoyaltyMember; amountTZS: number; balanceTZS: number }>(`/members/${id}/redeem`, { amountTZS }, { idempotencyKey: `loyalty:redeem:${id}:${Date.now()}` });
      const { member } = res;
      set((s) => ({
        member,
        members: s.members.map((m) => (m.id === id ? { id: m.id, name: member.name, maskedPhone: member.maskedPhone, balanceTZS: member.balanceTZS, tierId: member.tierId, tierName: member.tier?.name ?? null, totalSpendTZS: member.totalSpendTZS, joinedAt: member.joinedAt } : m)),
      }));
      return { member };
    } catch (e) {
      if (e instanceof ApiError) {
        set({ error: e.message });
        return { member: null, code: e.code, message: e.message };
      }
      set({ error: 'Failed to redeem balance' });
      return { member: null, message: 'Failed to redeem balance' };
    }
  },

  hydrateTiers: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<{ tiers: MembershipTier[] }>('/membership-tiers', { retries: 1 });
      set({ tiers: res.tiers, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load tiers' });
    }
  },

  updateTiers: async (tiers) => {
    try {
      const res = (await put('/membership-tiers', { tiers })) as { tiers: MembershipTier[] };
      set({ tiers: res.tiers });
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Failed to save tiers' });
    }
  },

  hydrateLoyaltyTransactions: async () => {
    try {
      const res = await api.get<LoyaltyTransaction[]>('/loyalty-transactions', { retries: 1 });
      set({ loyaltyTransactions: res });
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Failed to load loyalty transactions' });
    }
  },

  hydrateMyMembership: async () => {
    try {
      const res = await api.get<CustomerMembership>('/memberships/me', { retries: 1 });
      set({ myMembership: res });
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Failed to load membership' });
    }
  },
}));