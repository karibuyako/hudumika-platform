import { create } from 'zustand';

import { api, ApiError, getToken } from '@/api/client';
import type { ApiErrorBody, ContractReceiptTemplate, KitchenCamera, Qualification, QualificationUpload, SelfPickupConfig, StoreQrCode, StoreQrCodeKindInput, StoreServer } from '@/api/types';
import type {
  DecorationSettings,
  NotificationSettings,
  OrderSettings,
  PrinterSettings,
  PromotionPlan,
  StoreSettings,
} from '@/types';

/** PUT — api has no put() and client.ts is frozen; mirrors the local
 *  fetch helper used in store/loyalty.ts. */
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

interface StoreState {
  store: StoreSettings;
  notifications: NotificationSettings;
  printer: PrinterSettings;
  orderSettings: OrderSettings;
  decoration: DecorationSettings;
  promotion: PromotionPlan;
  kitchenCamera: KitchenCamera | null;
  qualifications: Qualification[];
  selfPickup: SelfPickupConfig | null;
  qrCodes: StoreQrCode[];
  hydrate: (server: StoreServer) => void;
  updateStore: (patch: Partial<StoreSettings>) => void;
  toggleOpen: () => void;
  updateNotifications: (patch: Partial<NotificationSettings>) => void;
  updatePrinter: (patch: Partial<PrinterSettings>) => void;
  updateOrderSettings: (patch: Partial<OrderSettings>) => void;
  updateDecoration: (patch: Partial<DecorationSettings>) => void;
  updatePromotion: (patch: Partial<PromotionPlan>) => void;
  hydrateStoreSettings: (storeId?: string) => Promise<void>;
  updateKitchenCamera: (patch: Partial<KitchenCamera>, storeId?: string) => Promise<boolean>;
  updateSelfPickup: (config: SelfPickupConfig, storeId?: string) => Promise<boolean>;
  addQualification: (input: QualificationUpload, storeId?: string) => Promise<boolean>;
  loadQrCodes: (storeId?: string) => Promise<void>;
  createQrCode: (kind: StoreQrCodeKindInput, storeId?: string) => Promise<StoreQrCode | null>;
  deleteQrCode: (id: string, storeId?: string) => Promise<boolean>;
  updateReceiptTemplate: (id: string, body: Partial<ContractReceiptTemplate>) => Promise<boolean>;
  activateReceiptTemplate: (id: string) => Promise<boolean>;
}

const mapServer = (s: StoreServer): StoreSettings => ({
  name: s.name,
  category: s.category,
  phone: s.phone,
  address: s.address,
  description: s.description,
  bannerColor: s.bannerColor,
  featuredProductIds: s.featuredProductIds,
  open: s.open,
  hours: s.hours,
  deliveryRadiusKm: s.deliveryRadiusKm,
  deliveryFee: s.deliveryFee,
  minOrder: s.minOrder,
  rating: s.rating,
  rank: s.rank,
});

export const useStoreStore = create<StoreState>()((set, get) => ({
  store: {
    name: '',
    category: '',
    phone: '',
    address: '',
    description: '',
    bannerColor: '#FFB300',
    featuredProductIds: [],
    open: false,
    hours: { open: '16:30', close: '02:00', closedDays: [] },
    deliveryRadiusKm: 4,
    deliveryFee: 3,
    minOrder: 30,
  },
  notifications: { newOrder: true, orderProgress: true, review: true, campaign: false, system: true },
  printer: { enabled: false, copies: 1, paperSize: '80mm' },
  orderSettings: { autoAccept: false, autoAcceptDelaySec: 30, preOrderEnabled: true, voiceAnnounce: true, ringtone: 'beep' },
  decoration: {
    posterColor: '#FFB300',
    posterText: '',
    sign: '',
    brandStory: '',
    tagline: '',
  },
  promotion: { enabled: false, dailyBudget: 60, focus: 'ranking' },
  kitchenCamera: null,
  qualifications: [],
  selfPickup: null,
  qrCodes: [],

  hydrate: (server) =>
    set({
      store: mapServer(server),
      orderSettings: server.orderSettings,
      decoration: server.decoration,
      promotion: server.promotion,
    }),

  updateStore: (patch) => {
    set((s) => ({ store: { ...s.store, ...patch } }));
    api.patch('/merchants/me', patch, { idempotencyKey: `store:${Date.now()}` }).catch(() => undefined);
  },

  toggleOpen: () => {
    const open = !get().store.open;
    set((s) => ({ store: { ...s.store, open } }));
    api.patch('/merchants/me', { open }, { idempotencyKey: `storeopen:${Date.now()}` }).catch(() => undefined);
  },

  updateNotifications: (patch) => set((s) => ({ notifications: { ...s.notifications, ...patch } })),

  updatePrinter: (patch) => set((s) => ({ printer: { ...s.printer, ...patch } })),

  updateOrderSettings: (patch) => {
    set((s) => ({ orderSettings: { ...s.orderSettings, ...patch } }));
    api.patch('/merchants/me', { orderSettings: { ...get().orderSettings, ...patch } }, { idempotencyKey: `os:${Date.now()}` }).catch(() => undefined);
  },

  updateDecoration: (patch) => {
    set((s) => ({ decoration: { ...s.decoration, ...patch } }));
    api.patch('/merchants/me', { decoration: { ...get().decoration, ...patch } }, { idempotencyKey: `dec:${Date.now()}` }).catch(() => undefined);
  },

  updatePromotion: (patch) => {
    set((s) => ({ promotion: { ...s.promotion, ...patch } }));
    api.patch('/merchants/me', { promotion: { ...get().promotion, ...patch } }, { idempotencyKey: `promo:${Date.now()}` }).catch(() => undefined);
  },

  /* ---- P6b store settings (contract /store/kitchen-camera,
   * /store/qualifications, /store/self-pickup, /store/qr-codes,
   * /store/receipt-templates) ---- */

  hydrateStoreSettings: async (storeId) => {
    const scope = storeId ? `?storeId=${storeId}` : '';
    const [camera, pickup, quals, qrs] = await Promise.all([
      api.get<KitchenCamera>(`/store/kitchen-camera${scope}`, { retries: 1 }).catch(() => null),
      api.get<SelfPickupConfig>(`/store/self-pickup${scope}`, { retries: 1 }).catch(() => null),
      api.get<Qualification[]>(`/store/qualifications${scope}`, { retries: 1 }).catch(() => [] as Qualification[]),
      api.get<StoreQrCode[]>(`/store/qr-codes${scope}`, { retries: 1 }).catch(() => [] as StoreQrCode[]),
    ]);
    set({ kitchenCamera: camera, selfPickup: pickup, qualifications: quals, qrCodes: qrs });
  },

  updateKitchenCamera: async (patch, storeId) => {
    try {
      const res = await api.patch<KitchenCamera>(`/store/kitchen-camera${storeId ? `?storeId=${storeId}` : ''}`, patch);
      set({ kitchenCamera: res });
      return true;
    } catch {
      return false;
    }
  },

  updateSelfPickup: async (config, storeId) => {
    try {
      const res = await put<SelfPickupConfig>(`/store/self-pickup${storeId ? `?storeId=${storeId}` : ''}`, config);
      set({ selfPickup: res });
      return true;
    } catch {
      return false;
    }
  },

  addQualification: async (input, storeId) => {
    try {
      const res = await api.post<Qualification>(`/store/qualifications${storeId ? `?storeId=${storeId}` : ''}`, input);
      set((s) => ({ qualifications: [res, ...s.qualifications] }));
      return true;
    } catch {
      return false;
    }
  },

  loadQrCodes: async (storeId) => {
    try {
      const res = await api.get<StoreQrCode[]>(`/store/qr-codes${storeId ? `?storeId=${storeId}` : ''}`, { retries: 1 });
      set({ qrCodes: res });
    } catch {
      set({ qrCodes: [] });
    }
  },

  createQrCode: async (kind, storeId) => {
    try {
      const res = await api.post<StoreQrCode>(`/store/qr-codes${storeId ? `?storeId=${storeId}` : ''}`, { kind });
      set((s) => ({ qrCodes: [res, ...s.qrCodes] }));
      return res;
    } catch {
      return null;
    }
  },

  deleteQrCode: async (id, storeId) => {
    try {
      await api.delete(`/store/qr-codes/${id}${storeId ? `?storeId=${storeId}` : ''}`);
      set((s) => ({ qrCodes: s.qrCodes.filter((q) => q.id !== id) }));
      return true;
    } catch {
      return false;
    }
  },

  updateReceiptTemplate: async (id, body) => {
    try {
      await put(`/store/receipt-templates/${id}`, body);
      return true;
    } catch {
      return false;
    }
  },

  activateReceiptTemplate: async (id) => {
    try {
      await api.post(`/store/receipt-templates/${id}/activate`);
      return true;
    } catch {
      return false;
    }
  },
}));
