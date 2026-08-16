import { create } from 'zustand';

import { useSessionStore } from '@/store/session';

/** Compatibility wrapper over the session store for existing screens. */
export const useAuthStore = create<{
  authed: boolean;
  merchantName: string;
  phone: string;
  login: (phone: string, code: string) => Promise<boolean>;
  logout: () => Promise<void>;
}>()(() => ({
  authed: useSessionStore.getState().status === 'authed',
  merchantName: useSessionStore.getState().me?.merchant.name ?? '',
  phone: useSessionStore.getState().me?.merchant.phone ?? '',
  login: async (phone, code) => {
    try {
      const { requestId } = await useSessionStore.getState().requestOtp(phone, 'login');
      await useSessionStore.getState().verifyOtp(requestId, code, 'login');
      return true;
    } catch {
      return false;
    }
  },
  logout: () => useSessionStore.getState().logout(),
}));

useSessionStore.subscribe((s) => {
  const a = useAuthStore.getState();
  const next = {
    authed: s.status === 'authed',
    merchantName: s.me?.merchant.name ?? '',
    phone: s.me?.merchant.phone ?? '',
  };
  if (a.authed !== next.authed || a.merchantName !== next.merchantName || a.phone !== next.phone) {
    useAuthStore.setState(next);
  }
});
