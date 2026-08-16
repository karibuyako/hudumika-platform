import { create } from 'zustand';

import { api } from '@/api/client';
import type {
  IntegrationInfo,
  UpdateWebhookSubscriptionBody,
  WebhookDelivery,
  WebhookSubscription,
} from '@/api/types';

interface WebhooksState {
  webhooks: WebhookSubscription[];
  deliveries: WebhookDelivery[];
  integrations: IntegrationInfo[];
  loaded: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  create: (input: UpdateWebhookSubscriptionBody) => Promise<{ ok: boolean; code?: string; message?: string }>;
  update: (id: string, input: UpdateWebhookSubscriptionBody) => Promise<{ ok: boolean; code?: string; message?: string }>;
  remove: (id: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  loadDeliveries: (webhookId?: string) => Promise<void>;
  disconnect: (id: string, reason: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  /** Re-enable a failing subscription (PATCH status → active) — IW L48. */
  reEnable: (id: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  /** POST /webhooks/{id}/test — enqueue + attempt one delivery now. */
  test: (id: string) => Promise<{ ok: boolean; code?: string; message?: string; delivery?: WebhookDelivery }>;
}

export const useWebhooksStore = create<WebhooksState>()((set, get) => ({
  webhooks: [],
  deliveries: [],
  integrations: [],
  loaded: false,
  error: null,

  hydrate: async () => {
    try {
      const [webhooks, deliveries, integrations] = await Promise.all([
        api.get<WebhookSubscription[]>('/webhooks', { retries: 1 }),
        api.get<WebhookDelivery[]>('/webhooks/deliveries', { retries: 1 }),
        api.get<IntegrationInfo[]>('/integrations', { retries: 1 }),
      ]);
      set({ webhooks, deliveries, integrations, loaded: true, error: null });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      set({ error: err.message ?? null, loaded: true });
    }
  },

  create: async (input) => {
    try {
      await api.post<WebhookSubscription>('/webhooks', input, { idempotencyKey: `wh:${Date.now()}` });
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  update: async (id, input) => {
    try {
      await api.patch<WebhookSubscription>(`/webhooks/${id}`, input, { idempotencyKey: `wh:${id}:${Date.now()}` });
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  remove: async (id) => {
    try {
      await api.delete<never>(`/webhooks/${id}`);
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  loadDeliveries: async (webhookId) => {
    try {
      const query = webhookId ? `?webhookId=${encodeURIComponent(webhookId)}` : '';
      const deliveries = await api.get<WebhookDelivery[]>(`/webhooks/deliveries${query}`, { retries: 1 });
      set({ deliveries, error: null });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      set({ error: err.message ?? null });
    }
  },

  disconnect: async (id, reason) => {
    try {
      await api.post<never>(`/integrations/${id}/disconnect`, { reason }, { idempotencyKey: `int:${id}:${Date.now()}` });
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  reEnable: async (id) => {
    try {
      await api.patch<WebhookSubscription>(`/webhooks/${id}`, { status: 'active' }, { idempotencyKey: `wh-re:${id}:${Date.now()}` });
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  test: async (id) => {
    try {
      const delivery = await api.post<WebhookDelivery>(`/webhooks/${id}/test`, {}, { idempotencyKey: `wh-test:${id}:${Date.now()}` });
      await get().hydrate();
      return { ok: true, delivery };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },
}));
