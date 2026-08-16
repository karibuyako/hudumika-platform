import { create } from 'zustand';

import { api } from '@/api/client';
import type { MerchantDevice, MerchantDeviceInput } from '@/api/types';

interface DevicesState {
  devices: MerchantDevice[];
  loaded: boolean;
  hydrate: () => Promise<void>;
  add: (input: MerchantDeviceInput) => Promise<{ ok: boolean; code?: string; message?: string }>;
  update: (id: string, input: MerchantDeviceInput) => Promise<{ ok: boolean; code?: string; message?: string }>;
  remove: (id: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
}

export const useDevicesStore = create<DevicesState>()((set, get) => ({
  devices: [],
  loaded: false,

  hydrate: async () => {
    try {
      const devices = await api.get<MerchantDevice[]>('/devices', { retries: 1 });
      set({ devices, loaded: true });
    } catch {
      /* keep stale */
    }
  },

  add: async (input) => {
    try {
      await api.post<MerchantDevice>('/devices', input, { idempotencyKey: `dev:${Date.now()}` });
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  update: async (id, input) => {
    try {
      await api.patch<MerchantDevice>(`/devices/${id}`, input, { idempotencyKey: `dev:${id}:${Date.now()}` });
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  remove: async (id) => {
    try {
      await api.delete<never>(`/devices/${id}`);
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },
}));
