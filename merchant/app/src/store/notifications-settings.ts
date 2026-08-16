import { create } from 'zustand';

import { api, ApiError, getToken } from '@/api/client';
import type { ApiErrorBody, NotificationPreferences, OrderAlertSettings } from '@/api/types';

/** PUT — api has no put() and client.ts is frozen; mirrors the local fetch
 *  helper used in store/loyalty.ts / store/supply-chain.ts. */
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

interface NotificationsSettingsState {
  preferences: NotificationPreferences | null;
  orderSettings: OrderAlertSettings | null;
  loading: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  savePreferences: (preferences: NotificationPreferences) => Promise<void>;
  saveOrderSettings: (settings: OrderAlertSettings) => Promise<void>;
}

export const useNotificationsSettingsStore = create<NotificationsSettingsState>()((set) => ({
  preferences: null,
  orderSettings: null,
  loading: false,
  error: null,

  hydrate: async () => {
    set({ loading: true, error: null });
    try {
      const [preferences, orderSettings] = await Promise.all([
        api.get<NotificationPreferences>('/notifications/me/preferences', { retries: 1 }),
        api.get<OrderAlertSettings>('/notifications/me/order-settings', { retries: 1 }),
      ]);
      set({ preferences, orderSettings, loading: false });
    } catch {
      set({ loading: false, error: 'notif.errLoad' });
    }
  },

  savePreferences: async (preferences) => {
    const saved = await put<NotificationPreferences>('/notifications/me/preferences', preferences);
    set({ preferences: saved });
  },

  saveOrderSettings: async (orderSettings) => {
    const saved = await put<OrderAlertSettings>('/notifications/me/order-settings', orderSettings);
    set({ orderSettings: saved });
  },
}));
