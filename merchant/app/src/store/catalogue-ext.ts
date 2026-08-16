import { create } from 'zustand';

import { api, ApiError, getToken } from '@/api/client';
import type {
  ApiErrorBody,
  BarcodeFormat,
  BarcodeFormatCode,
  BarcodeInfo,
  BatchBarcodeEntry,
  BatchBarcodeResult,
  BulkOperation,
  Combo,
  ComboLine,
  Menu,
  MenuSection,
  ProductVideo,
} from '@/api/types';
import { uid } from '@/lib/format';

function idemKey(prefix: string): string {
  return `${prefix}-${uid()}`;
}

/** PUT — api has no put() and client.ts is frozen; mirrors the local fetch
 *  helper used in store/loyalty.ts and store/supply-chain.ts. */
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

export interface ComboInput {
  name: string;
  description?: string;
  items: ComboLine[];
  priceTZS?: number;
  imageUrl?: string | null;
  available?: boolean;
}

export interface MenuInput {
  name: string;
  storeIds: string[];
  sections?: MenuSection[];
  active?: boolean;
}

export interface VideoInput {
  title: string;
  url: string;
  catalogueItemId?: string | null;
  thumbnailUrl?: string | null;
  durationSeconds?: number | null;
}

export interface BulkOperationInput {
  type: BulkOperation['type'];
  storeIds: string[];
  payload?: Record<string, unknown>;
  requiresApproval?: boolean;
}

interface CatalogueExtState {
  formats: BarcodeFormat[];
  barcodesByItem: Record<string, BarcodeInfo[]>;
  combos: Combo[];
  menus: Menu[];
  videos: ProductVideo[];
  bulkOperations: BulkOperation[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  listItemBarcodes: (itemId: string) => Promise<BarcodeInfo[]>;
  generateBarcode: (itemId: string, format: BarcodeFormatCode) => Promise<BarcodeInfo | null>;
  deleteBarcode: (itemId: string, code: string) => Promise<boolean>;
  batchBarcodes: (entries: BatchBarcodeEntry[]) => Promise<BatchBarcodeResult | null>;
  createCombo: (input: ComboInput) => Promise<Combo | null>;
  updateCombo: (id: string, patch: Partial<ComboInput>) => Promise<Combo | null>;
  deleteCombo: (id: string) => Promise<boolean>;
  createMenu: (input: MenuInput) => Promise<Menu | null>;
  replaceMenu: (id: string, input: MenuInput) => Promise<Menu | null>;
  deleteMenu: (id: string) => Promise<boolean>;
  createVideo: (input: VideoInput) => Promise<ProductVideo | null>;
  deleteVideo: (id: string) => Promise<boolean>;
  createBulkOperation: (input: BulkOperationInput) => Promise<BulkOperation | null>;
  fetchBulkOperation: (id: string) => Promise<BulkOperation | null>;
}

export const useCatalogueExtStore = create<CatalogueExtState>()((set, get) => ({
  formats: [],
  barcodesByItem: {},
  combos: [],
  menus: [],
  videos: [],
  bulkOperations: [],
  loaded: false,
  loading: false,
  error: null,

  hydrate: async () => {
    if (get().loaded) return;
    set({ loading: true, error: null });
    try {
      const [formats, combos, menus, videos, bulkOperations] = await Promise.all([
        api.get<BarcodeFormat[]>('/barcodes/formats', { retries: 1 }),
        api.get<Combo[]>('/combos', { retries: 1 }),
        api.get<Menu[]>('/menus', { retries: 1 }),
        api.get<ProductVideo[]>('/videos', { retries: 1 }),
        api.get<BulkOperation[]>('/bulk-operations', { retries: 1 }),
      ]);
      set({ formats, combos, menus, videos, bulkOperations, loaded: true, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'hydrate failed' });
    }
  },

  listItemBarcodes: async (itemId) => {
    try {
      const rows = await api.get<BarcodeInfo[]>(`/products/${itemId}/barcodes`, { retries: 1 });
      set((s) => ({ barcodesByItem: { ...s.barcodesByItem, [itemId]: rows } }));
      return rows;
    } catch {
      return get().barcodesByItem[itemId] ?? [];
    }
  },

  generateBarcode: async (itemId, format) => {
    try {
      const barcode = await api.post<BarcodeInfo>(
        `/products/${itemId}/barcode/generate`,
        { format },
        { idempotencyKey: idemKey('bc-gen') },
      );
      const rows = get().barcodesByItem[itemId] ?? [];
      set((s) => ({ barcodesByItem: { ...s.barcodesByItem, [itemId]: [...rows, barcode] } }));
      return barcode;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'generate failed' });
      return null;
    }
  },

  deleteBarcode: async (itemId, code) => {
    try {
      await api.delete(`/products/${itemId}/barcode/${encodeURIComponent(code)}`);
      const rows = get().barcodesByItem[itemId] ?? [];
      set((s) => ({ barcodesByItem: { ...s.barcodesByItem, [itemId]: rows.filter((b) => b.code !== code) } }));
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'delete failed' });
      return false;
    }
  },

  batchBarcodes: async (entries) => {
    try {
      const result = await api.post<BatchBarcodeResult>(
        '/barcodes/batch',
        { entries },
        { idempotencyKey: idemKey('bc-batch') },
      );
      return result;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'batch failed' });
      return null;
    }
  },

  createCombo: async (input) => {
    try {
      const combo = await api.post<Combo>('/combos', input, { idempotencyKey: idemKey('combo') });
      set((s) => ({ combos: [...s.combos, combo] }));
      return combo;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'create failed' });
      return null;
    }
  },

  updateCombo: async (id, patch) => {
    try {
      const combo = await api.patch<Combo>(`/combos/${id}`, patch);
      set((s) => ({ combos: s.combos.map((c) => (c.id === id ? combo : c)) }));
      return combo;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'update failed' });
      return null;
    }
  },

  deleteCombo: async (id) => {
    try {
      await api.delete(`/combos/${id}`);
      set((s) => ({ combos: s.combos.filter((c) => c.id !== id) }));
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'delete failed' });
      return false;
    }
  },

  createMenu: async (input) => {
    try {
      const menu = await api.post<Menu>('/menus', input, { idempotencyKey: idemKey('menu') });
      set((s) => ({ menus: [...s.menus, menu] }));
      return menu;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'create failed' });
      return null;
    }
  },

  replaceMenu: async (id, input) => {
    try {
      const menu = await put<Menu>(`/menus/${id}`, input);
      set((s) => ({ menus: s.menus.map((m) => (m.id === id ? menu : m)) }));
      return menu;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'replace failed' });
      return null;
    }
  },

  deleteMenu: async (id) => {
    try {
      await api.delete(`/menus/${id}`);
      set((s) => ({ menus: s.menus.filter((m) => m.id !== id) }));
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'delete failed' });
      return false;
    }
  },

  createVideo: async (input) => {
    try {
      const video = await api.post<ProductVideo>('/videos', input, { idempotencyKey: idemKey('video') });
      set((s) => ({ videos: [...s.videos, video] }));
      return video;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'create failed' });
      return null;
    }
  },

  deleteVideo: async (id) => {
    try {
      await api.delete(`/videos/${id}`);
      set((s) => ({ videos: s.videos.filter((v) => v.id !== id) }));
      return true;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'delete failed' });
      return false;
    }
  },

  createBulkOperation: async (input) => {
    try {
      const operation = await api.post<BulkOperation>(
        '/bulk-operations',
        input,
        { idempotencyKey: idemKey('bulk') },
      );
      set((s) => ({ bulkOperations: [operation, ...s.bulkOperations] }));
      return operation;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'create failed' });
      return null;
    }
  },

  fetchBulkOperation: async (id) => {
    try {
      const operation = await api.get<BulkOperation>(`/bulk-operations/${id}`, { retries: 1 });
      set((s) => ({ bulkOperations: s.bulkOperations.map((o) => (o.id === id ? operation : o)) }));
      return operation;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'fetch failed' });
      return null;
    }
  },
}));
