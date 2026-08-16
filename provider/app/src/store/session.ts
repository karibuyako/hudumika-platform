import type { ProviderPrivate, VerificationState } from '@hudumika/contract';
import { create } from 'zustand';

import { ApiError, setRefreshToken, setToken } from '@/api/client';
import { registerPushToken } from '@/lib/push';
import { getAuthRepository } from '@/repos';
import type { OtpRequestResult } from '@/repos';

export type SessionStatus = 'boot' | 'anon' | 'onboarding' | 'authed';

interface SessionState {
  status: SessionStatus;
  token: string | null;
  provider: ProviderPrivate | null;
  /** Signed-in phone — used for role-switch OTP re-verification. */
  userPhone: string;
  capabilities: string[];
  restore: () => Promise<void>;
  requestOtp: (destination: string, purpose?: 'login' | 'register' | 'verify_role') => Promise<OtpRequestResult>;
  verifyOtp: (requestId: string, code: string, purpose?: 'login' | 'register' | 'verify_role') => Promise<void>;
  applyProvider: (provider: ProviderPrivate) => void;
  setCapabilities: (capabilities: string[]) => void;
  refreshCapabilities: () => Promise<void>;
  logout: () => Promise<void>;
}

/** A provider session unlocks tabs only when verification is approved. */
export function statusFor(provider: ProviderPrivate | null): SessionStatus {
  if (!provider) return 'onboarding';
  return provider.verification === 'approved' ? 'authed' : 'onboarding';
}

export function verificationState(provider: ProviderPrivate | null): VerificationState {
  return provider?.verification ?? 'pending';
}

export const useSessionStore = create<SessionState>()((set) => ({
  status: 'boot',
  token: null,
  provider: null,
  userPhone: '',
  capabilities: [],

  restore: async () => {
    try {
      const { user, provider } = await getAuthRepository().me();
      set({ provider, userPhone: user.phone ?? '', status: statusFor(provider) });
      try {
        const caps = await getAuthRepository().capabilities();
        if (caps) set({ capabilities: caps.capabilities });
      } catch {
        /* capabilities are best-effort during restore */
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setToken(null);
        setRefreshToken(null);
        set({ status: 'anon', token: null, provider: null, capabilities: [] });
        return;
      }
      // Mock/backend unreachable — stay boot; the root layout retries.
      set({ status: 'boot' });
    }
  },

  requestOtp: async (destination, purpose = 'login') => {
    return getAuthRepository().requestOtp(destination, purpose);
  },

  verifyOtp: async (requestId, code, purpose = 'login') => {
    const res = await getAuthRepository().verifyOtp(requestId, code, purpose);
    setToken(res.accessToken);
    setRefreshToken(res.refreshToken ?? null);
    const provider = res.provider ?? null;
    set({ token: res.accessToken, provider, userPhone: res.user.phone ?? '', status: statusFor(provider) });
    // M5 push registration at login — fire-and-forget; degrades gracefully.
    void registerPushToken();
    try {
      const caps = await getAuthRepository().capabilities();
      if (caps) set({ capabilities: caps.capabilities });
    } catch {
      /* capabilities refresh best-effort */
    }
  },

  applyProvider: (provider) => set({ provider, status: statusFor(provider) }),

  setCapabilities: (capabilities) => set({ capabilities }),

  refreshCapabilities: async () => {
    try {
      const caps = await getAuthRepository().capabilities();
      set({ capabilities: caps.capabilities });
    } catch {
      /* non-fatal */
    }
  },

  logout: async () => {
    try {
      await getAuthRepository().logout();
    } catch {
      /* revoke best-effort */
    }
    setToken(null);
    setRefreshToken(null);
    set({ status: 'anon', token: null, provider: null, capabilities: [] });
  },
}));
