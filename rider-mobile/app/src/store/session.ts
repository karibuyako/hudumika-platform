import type { RiderPrivate } from '@hudumika/contract';
import { create } from 'zustand';

import { ApiError } from '@/api/client';
import { clearTokens, getTokenPair, setTokenPair } from '@/api/tokenStore';
import { getAuthRepository } from '@/repos';
import type { OtpRequestResult } from '@/repos';

export type SessionStatus = 'boot' | 'anon' | 'onboarding' | 'authed';

interface SessionState {
  status: SessionStatus;
  token: string | null;
  rider: RiderPrivate | null;
  restore: () => Promise<void>;
  requestOtp: (destination: string) => Promise<OtpRequestResult>;
  verifyOtp: (requestId: string, code: string) => Promise<void>;
  completeOnboarding: (rider: RiderPrivate) => void;
  applyRider: (rider: RiderPrivate) => void;
  logout: () => Promise<void>;
}

function statusFor(rider: RiderPrivate | null): SessionStatus {
  if (!rider) return 'onboarding';
  return rider.verification === 'approved' ? 'authed' : 'onboarding';
}

export const useSessionStore = create<SessionState>()((set) => ({
  status: 'boot',
  token: null,
  rider: null,

  restore: async () => {
    // Cold start: tokens live in SecureStore — no tokens, no session.
    const pair = await getTokenPair();
    if (!pair) {
      set({ status: 'anon', token: null, rider: null });
      return;
    }
    try {
      const { rider } = await getAuthRepository().me();
      set({ token: pair.accessToken, rider, status: statusFor(rider) });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // Refresh failed inside the client — the session is gone.
        await clearTokens();
        set({ status: 'anon', token: null, rider: null });
        return;
      }
      // Mock/backend unreachable — stay boot; the root layout retries.
      set({ status: 'boot' });
    }
  },

  requestOtp: async (destination) => {
    return getAuthRepository().requestOtp(destination, 'login');
  },

  verifyOtp: async (requestId, code) => {
    const res = await getAuthRepository().verifyOtp(requestId, code, 'login');
    await setTokenPair({ accessToken: res.accessToken, refreshToken: res.refreshToken ?? `mock_rt_${res.accessToken}` });
    const rider = res.rider ?? null;
    set({ token: res.accessToken, rider, status: statusFor(rider) });
  },

  completeOnboarding: (rider) => set({ rider, status: 'authed' }),

  applyRider: (rider) => set({ rider }),

  logout: async () => {
    try {
      await getAuthRepository().logout();
    } catch {
      /* revoke best-effort */
    }
    // Wipe regardless of the server response; stop location sharing (native-only).
    await clearTokens();
    try {
      await (await import('@/lib/location')).stopBackgroundTracking();
    } catch {
      /* not native */
    }
    set({ status: 'anon', token: null, rider: null });
  },
}));
