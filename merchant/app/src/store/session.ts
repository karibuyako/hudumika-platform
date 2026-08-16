import { create } from 'zustand';

import { api, getRefreshToken, setRefreshToken, setToken, ApiError } from '@/api/client';
import type { OtpRequestBody, OtpRequestResponse, OtpVerifyRequestBody, SessionMe } from '@/api/types';

/* Refresh-token lifecycle (SECURITY.md §10–13).
 * client.ts owns the runtime storage (sessionStorage on web, in-memory cache)
 * and the 401 → refresh → retry-once flow. This store adds the two missing
 * pieces:
 *   - native durability: expo-secure-store via the TokenPersister pattern
 *     (client.ts has no native persister hook for the refresh token), and
 *   - an explicit `refresh()` hook + state sync for the UI/login flow.
 * A failed refresh clears stored credentials and routes to login.
 */

export interface TokenPersister {
  get: () => Promise<string | null>;
  set: (token: string | null) => Promise<void>;
}

let refreshPersister: TokenPersister | null = null;

export function setRefreshTokenPersister(p: TokenPersister | null) {
  refreshPersister = p;
}

/** Copy the keychain refresh token into the client cache at boot when the
 * runtime storage is empty (native restarts after tab/app close). */
async function rehydrateRefreshToken(): Promise<void> {
  if (!refreshPersister || getRefreshToken()) return;
  try {
    const stored = await refreshPersister.get();
    if (stored) setRefreshToken(stored);
  } catch {
    /* SecureStore unavailable — the client cache still serves this session */
  }
}

/** Persist through the client storage (web: sessionStorage) AND the native
 * keychain persister when registered. */
async function storeRefreshToken(token: string | null): Promise<void> {
  setRefreshToken(token);
  if (refreshPersister) {
    void refreshPersister.set(token).catch(() => {
      /* storage unavailable — the client cache still serves this session */
    });
  }
}

interface SessionState {
  status: 'boot' | 'anon' | 'authed';
  token: string | null;
  me: SessionMe | null;
  perms: string[];
  restore: () => Promise<void>;
  requestOtp: (destination: string, purpose?: 'login' | 'register') => Promise<OtpRequestResponse>;
  verifyOtp: (requestId: string, code: string, purpose?: 'login' | 'register') => Promise<SessionMe>;
  refreshMe: () => Promise<void>;
  /** One refresh attempt with the persisted refresh token; true on success.
   * On failure clears stored credentials (SECURITY.md §13). */
  refresh: () => Promise<boolean>;
  logout: () => Promise<void>;
}

function hasPerm(perms: string[], perm: string): boolean {
  return perms.includes('*') || perms.includes(perm);
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  status: 'boot',
  token: null,
  me: null,
  perms: [],

  restore: async () => {
    await rehydrateRefreshToken();
    try {
      const { me } = await api.get<{ me: SessionMe }>('/merchants/me', { retries: 1 });
      set({ status: 'authed', me, perms: me.permissions });
      return;
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status !== 401) {
        // Server unreachable (e.g. mock not started) — stay boot, app shows retry.
        set({ status: 'boot' });
        return;
      }
    }
    // Access token dead — one refresh, then fall back to login.
    if (await get().refresh()) {
      try {
        const { me } = await api.get<{ me: SessionMe }>('/merchants/me', { retries: 0 });
        set({ status: 'authed', me, perms: me.permissions });
        return;
      } catch {
        /* refresh gave tokens but me failed — treat as anon */
      }
    }
    setToken(null);
    set({ status: 'anon', me: null, token: null, perms: [] });
  },

  requestOtp: async (destination, purpose = 'login') => {
    const res = await api.post<OtpRequestResponse>(
      '/auth/request-otp',
      { channel: 'phone', destination, purpose } satisfies OtpRequestBody,
    );
    return res;
  },

  verifyOtp: async (requestId, code, purpose = 'login') => {
    const res = await api.post<{
      accessToken: string;
      refreshToken?: string;
      me: SessionMe;
      onboarding?: { status: string };
    }>('/auth/verify-otp', { requestId, code, purpose } satisfies OtpVerifyRequestBody);
    setToken(res.accessToken);
    if (res.refreshToken) {
      await storeRefreshToken(res.refreshToken);
    }
    set({ token: res.accessToken, status: 'authed', me: res.me, perms: res.me.permissions });
    return res.me;
  },

  refreshMe: async () => {
    if (get().status !== 'authed') return;
    const { me } = await api.get<{ me: SessionMe }>('/merchants/me');
    set({ me, perms: me.permissions });
  },

  refresh: async () => {
    await rehydrateRefreshToken();
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await api.post<{ accessToken: string; refreshToken: string; me: SessionMe }>(
        '/auth/refresh',
        { refreshToken },
        { retries: 0 },
      );
      setToken(res.accessToken);
      if (res.refreshToken) {
        await storeRefreshToken(res.refreshToken);
      }
      set({ token: res.accessToken, status: 'authed', me: res.me, perms: res.me.permissions });
      return true;
    } catch {
      await storeRefreshToken(null);
      setToken(null);
      set({ status: 'anon', me: null, token: null, perms: [] });
      return false;
    }
  },

  logout: async () => {
    try {
      await api.post('/auth/logout', {}, { retries: 0 });
    } catch {
      /* revoke best-effort */
    }
    await storeRefreshToken(null);
    setToken(null);
    set({ status: 'anon', me: null, token: null, perms: [] });
  },
}));

/** Convenience hook (client.ts 401 wiring imports this). */
export const useSession = () => useSessionStore;

export { hasPerm };
