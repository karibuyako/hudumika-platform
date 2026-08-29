import type { User } from '@hudumika/contract';
import { create } from 'zustand';

import { ApiError, hydrateToken, setToken } from '@/api/client';
import { getAuthRepository } from '@/repos';
import type { OtpChannel, OtpPurpose, OtpRequestResult } from '@/repos';
import { getLocale, setLocale } from '@/i18n';
import { registerPushForUser, unregisterTokenForUser } from '@/lib/push';
import { getStoredSession, setStoredSession } from '@/lib/secureStorage';

export type SessionStatus = 'boot' | 'anon' | 'onboarding' | 'authed';

interface SessionState {
  status: SessionStatus;
  token: string | null;
  user: User | null;
  restore: () => Promise<void>;
  requestOtp: (destination: string, purpose?: OtpPurpose, channel?: OtpChannel) => Promise<OtpRequestResult>;
  verifyOtp: (requestId: string, code: string, purpose?: 'login' | 'verify_role') => Promise<void>;
  completeOnboarding: (user: User) => void;
  applyUser: (user: User) => void;
  logout: () => Promise<void>;
}

function statusFor(user: User | null): SessionStatus {
  if (!user) return 'onboarding';
  return user.activeRole === 'customer' ? 'authed' : 'onboarding';
}

/** Cold-start restore needs a persisted city to land in the tabs. */
function restoredStatusFor(user: User | null): SessionStatus {
  if (statusFor(user) !== 'authed') return statusFor(user);
  try {
    const raw = localStorage.getItem('consumer.city');
    return raw ? 'authed' : 'onboarding';
  } catch {
    return 'onboarding';
  }
}

function applyLocale(user: User | null) {
  if (user?.locale && (user.locale === 'en' || user.locale === 'sw' || user.locale === 'ar')) {
    setLocale(user.locale);
  }
}

/** Push registration lifecycle (NOTIFICATIONS.md step 2): register on
 * session success, unregister on logout. Fire-and-forget — native only
 * (push.ts no-ops on web/node), never blocks the session transition, and a
 * registration failure only logs a typed PushError. */
function registerPushForSession(): void {
  void registerPushForUser().then((r) => {
    if (r.error) {
      console.warn(`[push] registration failed (${r.error.code}): ${r.error.message}`);
    }
  });
}

function unregisterPushForSession(): void {
  void unregisterTokenForUser();
}

export const useSessionStore = create<SessionState>()((set) => ({
  status: 'boot',
  token: null,
  user: null,

  restore: async () => {
    try {
      await hydrateToken();
      const stored = await getStoredSession();
      if (stored) {
        setToken(stored.accessToken);
        applyLocale({ locale: stored.locale } as User);
      }
      const user = await getAuthRepository().me();
      const status = restoredStatusFor(user);
      set({ token: getStoredToken(), user, status });
      await persistSession(user, stored?.refreshToken ?? '');
      if (status === 'authed') {
        // Re-register the push token on a successful restore (step 3 of
        // NOTIFICATIONS.md — refresh on session resume if changed).
        registerPushForSession();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setToken(null);
        await setStoredSession(null);
        set({ status: 'anon', token: null, user: null });
        return;
      }
      // Backend unreachable — fall back to anon so user sees login instead of infinite splash.
      console.warn('[session] restore failed, falling back to anon', e);
      set({ status: 'anon', token: null, user: null });
    }
  },

  requestOtp: async (destination, purpose = 'login', channel = 'phone') => {
    return getAuthRepository().requestOtp(destination, purpose, channel);
  },

  verifyOtp: async (requestId, code, purpose = 'login') => {
    const res = await getAuthRepository().verifyOtp(requestId, code, purpose);
    if (purpose === 'verify_role') {
      // Role hand-off: verification succeeds server-side, but the customer app
      // only renders customer sessions (SECURITY.md) — the role's own app takes
      // over. The current customer session is left untouched (no token swap,
      // no persistence): sessions never mix.
      return;
    }
    setToken(res.accessToken);
    const user = res.user;
    applyLocale(user);
    // Fresh login always runs the city picker before the tabs.
    set({ token: res.accessToken, user, status: 'onboarding' });
    await persistSession(user, res.refreshToken ?? '');
  },

  completeOnboarding: (user) => {
    applyLocale(user);
    set({ user, status: 'authed' });
    registerPushForSession();
  },

  applyUser: (user) => {
    applyLocale(user);
    set({ user });
  },

  logout: async () => {
    unregisterPushForSession();
    try {
      await getAuthRepository().logout();
    } catch {
      /* revoke best-effort */
    }
    setToken(null);
    await setStoredSession(null);
    set({ status: 'anon', token: null, user: null });
  },
}));

function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem('customer.token') ?? localStorage.getItem('customer.token');
  } catch {
    try {
      return localStorage.getItem('customer.token');
    } catch {
      return null;
    }
  }
}

/** Persist the full pair (access + refresh) so a real refresh can succeed and
 * rotation updates the stored session (client.ts tryRefreshToken). */
async function persistSession(user: User | null, refreshToken: string) {
  const token = getStoredToken();
  if (!token || !user) return;
  await setStoredSession({
    accessToken: token,
    refreshToken,
    userId: user.id,
    phone: user.phone,
    locale: getLocale(),
    savedAt: new Date().toISOString(),
  });
}
