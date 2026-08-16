import { create } from 'zustand';

import { api, ApiError, getToken } from '@/api/client';
import type {
  ApiErrorBody,
  AdjustWarehouseStockBody,
  CancelPurchaseOrderBody,
  CreateSupplierReturnBody,
  InventoryAdjustment,
  InventoryAlert,
  InventoryItem,
  InventorySyncConfig,
  InventorySyncConfigInput,
  PurchaseOrder,
  PurchaseOrderInput,
  ReceivePurchaseOrderBody,
  Supplier,
  SupplierInput,
  SupplierReturn,
  SupplierReturnDetail,
  Warehouse,
  WarehouseInput,
} from '@/api/types';
import { useMessageStore } from '@/store/messages';

interface SectionState<T> {
  rows: T[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY: SectionState<never> = { rows: [], loaded: false, loading: false, error: null };

/** PUT — api has no put() and client.ts is frozen; mirrors the local fetch
 *  helper used in store/loyalty.ts. */
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

interface SupplyChainState {
  inventory: SectionState<InventoryItem>;
  adjustments: InventoryAdjustment[];
  alerts: InventoryAlert[];
  syncConfig: InventorySyncConfig | null;
  suppliers: SectionState<Supplier>;
  purchaseOrders: SectionState<PurchaseOrder>;
  supplierReturns: SupplierReturnDetail[];
  supplierReturnsError: string | null;
  supplierReturnsLoading: boolean;
  warehouses: SectionState<Warehouse>;
  /** PO being viewed in detail (GET /purchase-orders/{id}). */
  purchaseOrderDetail: PurchaseOrder | null;
  /** Warehouse detail (GET /warehouses/{id}) — server-computed totalUnits. */
  warehouseDetail: Warehouse | null;

  hydrateInventory: () => Promise<void>;
  hydrateAdjustments: () => Promise<void>;
  hydrateAlerts: () => Promise<void>;
  hydrateSyncConfig: () => Promise<void>;
  hydrateSuppliers: () => Promise<void>;
  hydratePurchaseOrders: (status?: string) => Promise<void>;
  hydrateWarehouses: () => Promise<void>;
  hydrateSupplierReturns: () => Promise<void>;
  hydrateAll: () => Promise<void>;

  adjustStock: (itemId: string, delta: number, reason: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  updateSyncConfig: (input: InventorySyncConfigInput) => Promise<{ ok: boolean; code?: string; message?: string }>;

  addSupplier: (input: SupplierInput) => Promise<{ ok: boolean; code?: string; message?: string }>;
  updateSupplier: (id: string, input: SupplierInput) => Promise<{ ok: boolean; code?: string; message?: string }>;
  removeSupplier: (id: string) => Promise<{ ok: boolean; code?: string; message?: string }>;

  createPurchaseOrder: (input: PurchaseOrderInput) => Promise<{ ok: boolean; id?: string; code?: string; message?: string }>;
  sendPurchaseOrder: (id: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  receivePurchaseOrder: (id: string, items: ReceivePurchaseOrderBody['items']) => Promise<{ ok: boolean; code?: string; message?: string }>;
  cancelPurchaseOrder: (id: string, body: CancelPurchaseOrderBody) => Promise<{ ok: boolean; code?: string; message?: string }>;
  fetchPurchaseOrder: (id: string) => Promise<PurchaseOrder | null>;

  createSupplierReturn: (input: CreateSupplierReturnBody) => Promise<{ ok: boolean; id?: string; code?: string; message?: string }>;
  processSupplierReturn: (id: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  rejectSupplierReturn: (id: string, reason: string) => Promise<{ ok: boolean; code?: string; message?: string }>;

  addWarehouse: (input: WarehouseInput) => Promise<{ ok: boolean; code?: string; message?: string }>;
  updateWarehouse: (id: string, input: WarehouseInput) => Promise<{ ok: boolean; code?: string; message?: string }>;
  setWarehouseStock: (id: string, body: AdjustWarehouseStockBody) => Promise<{ ok: boolean; code?: string; message?: string }>;
  fulfillFromWarehouse: (id: string, orderId: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  fetchWarehouse: (id: string) => Promise<Warehouse | null>;
}

const fail = (e: unknown): { ok: false; code?: string; message?: string } => {
  const err = e as { code?: string; message?: string };
  return { ok: false, code: err.code, message: err.message };
};

export const useSupplyChainStore = create<SupplyChainState>()((set, get) => {
  const hydrateOne = async <T>(
    key: 'inventory' | 'suppliers' | 'purchaseOrders' | 'warehouses',
    fn: () => Promise<T[]>,
    map?: (row: T) => T,
  ) => {
    set((s) => ({ [key]: { ...s[key], loading: true, error: null } }) as Partial<SupplyChainState>);
    try {
      const rows = await fn();
      set((s) => ({ [key]: { ...s[key], rows: map ? rows.map(map) : rows, loaded: true, loading: false } }) as Partial<SupplyChainState>);
    } catch (e) {
      const err = e as { message?: string };
      set((s) => ({ [key]: { ...s[key], loading: false, error: err.message ?? 'load failed' } }) as Partial<SupplyChainState>);
    }
  };

  return {
    inventory: { ...EMPTY },
    adjustments: [],
    alerts: [],
    syncConfig: null,
    suppliers: { ...EMPTY },
    purchaseOrders: { ...EMPTY },
    supplierReturns: [],
    supplierReturnsError: null,
    supplierReturnsLoading: false,
    warehouses: { ...EMPTY },
    purchaseOrderDetail: null,
    warehouseDetail: null,

    hydrateInventory: () => hydrateOne('inventory', () => api.get<InventoryItem[]>('/inventory/items', { retries: 1 })),
    hydrateAdjustments: async () => {
      try {
        const rows = await api.get<InventoryAdjustment[]>('/inventory/adjustments', { retries: 1 });
        set({ adjustments: rows });
      } catch {
        /* keep stale */
      }
    },
    hydrateAlerts: async () => {
      try {
        const rows = await api.get<InventoryAlert[]>('/inventory/alerts', { retries: 1 });
        set({ alerts: rows });
      } catch {
        /* keep stale */
      }
    },
    hydrateSyncConfig: async () => {
      try {
        const cfg = await api.get<InventorySyncConfig>('/inventory/sync-config', { retries: 1 });
        set({ syncConfig: cfg });
      } catch {
        /* keep stale */
      }
    },
    hydrateSuppliers: () => hydrateOne('suppliers', () => api.get<Supplier[]>('/suppliers', { retries: 1 })),
    hydratePurchaseOrders: (status?: string) =>
      hydrateOne('purchaseOrders', () => api.get<PurchaseOrder[]>(`/purchase-orders${status ? `?status=${status}` : ''}`, { retries: 1 })),
    hydrateWarehouses: () => hydrateOne('warehouses', () => api.get<Warehouse[]>('/warehouses', { retries: 1 })),
    hydrateSupplierReturns: async () => {
      set({ supplierReturnsLoading: true });
      try {
        const rows = await api.get<SupplierReturnDetail[]>('/supplier-returns', { retries: 1 });
        set({ supplierReturns: rows, supplierReturnsError: null, supplierReturnsLoading: false });
      } catch (e) {
        const err = e as { message?: string };
        set({ supplierReturnsError: err.message ?? 'load failed', supplierReturnsLoading: false });
      }
    },

    hydrateAll: async () => {
      const s = get();
      await Promise.all([
        s.hydrateInventory(),
        s.hydrateAdjustments(),
        s.hydrateAlerts(),
        s.hydrateSyncConfig(),
        s.hydrateSuppliers(),
        s.hydratePurchaseOrders(),
        s.hydrateWarehouses(),
        s.hydrateSupplierReturns(),
      ]);
    },

    adjustStock: async (itemId, delta, reason) => {
      try {
        const item = await api.post<InventoryItem>(`/inventory/items/${itemId}/adjust`, { delta, reason }, { idempotencyKey: `inv:${itemId}:${Date.now()}` });
        set((s) => ({ inventory: { ...s.inventory, rows: s.inventory.rows.map((r) => (r.catalogueItemId === itemId ? item : r)) } }));
        await get().hydrateAdjustments();
        await get().hydrateAlerts();
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    updateSyncConfig: async (input) => {
      try {
        const cfg = await put<InventorySyncConfig>('/inventory/sync-config', input);
        set({ syncConfig: cfg });
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    addSupplier: async (input) => {
      try {
        const supplier = await api.post<Supplier>('/suppliers', input, { idempotencyKey: `sup:${Date.now()}` });
        set((s) => ({ suppliers: { ...s.suppliers, rows: [...s.suppliers.rows, supplier] } }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    updateSupplier: async (id, input) => {
      try {
        const supplier = await api.patch<Supplier>(`/suppliers/${id}`, input, { idempotencyKey: `sup:${id}:${Date.now()}` });
        set((s) => ({ suppliers: { ...s.suppliers, rows: s.suppliers.rows.map((r) => (r.id === id ? supplier : r)) } }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    removeSupplier: async (id) => {
      try {
        await api.delete<never>(`/suppliers/${id}`);
        set((s) => ({ suppliers: { ...s.suppliers, rows: s.suppliers.rows.filter((r) => r.id !== id) } }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    createPurchaseOrder: async (input) => {
      try {
        const po = await api.post<PurchaseOrder>('/purchase-orders', input, { idempotencyKey: `po:${Date.now()}` });
        set((s) => ({ purchaseOrders: { ...s.purchaseOrders, rows: [po, ...s.purchaseOrders.rows] } }));
        return { ok: true, id: po.id };
      } catch (e) {
        return fail(e);
      }
    },

    sendPurchaseOrder: async (id) => {
      try {
        const po = await api.post<PurchaseOrder>(`/purchase-orders/${id}/send`, {}, { idempotencyKey: `po-send:${id}:${Date.now()}` });
        set((s) => ({ purchaseOrders: { ...s.purchaseOrders, rows: s.purchaseOrders.rows.map((r) => (r.id === id ? po : r)) }, purchaseOrderDetail: s.purchaseOrderDetail?.id === id ? po : s.purchaseOrderDetail }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    receivePurchaseOrder: async (id, items) => {
      try {
        const po = await api.post<PurchaseOrder>(`/purchase-orders/${id}/receive`, { items }, { idempotencyKey: `po-recv:${id}:${Date.now()}` });
        set((s) => ({ purchaseOrders: { ...s.purchaseOrders, rows: s.purchaseOrders.rows.map((r) => (r.id === id ? po : r)) }, purchaseOrderDetail: s.purchaseOrderDetail?.id === id ? po : s.purchaseOrderDetail }));
        await get().hydrateInventory();
        await get().hydrateAdjustments();
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    cancelPurchaseOrder: async (id, body) => {
      try {
        const po = await api.post<PurchaseOrder>(`/purchase-orders/${id}/cancel`, body, { idempotencyKey: `po-cancel:${id}:${Date.now()}` });
        set((s) => ({ purchaseOrders: { ...s.purchaseOrders, rows: s.purchaseOrders.rows.map((r) => (r.id === id ? po : r)) }, purchaseOrderDetail: s.purchaseOrderDetail?.id === id ? po : s.purchaseOrderDetail }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    fetchPurchaseOrder: async (id) => {
      try {
        const po = await api.get<PurchaseOrder>(`/purchase-orders/${id}`, { retries: 1 });
        set({ purchaseOrderDetail: po });
        return po;
      } catch (e) {
        if (e instanceof ApiError) {
          useMessageStore.getState().pushSystem('Purchase order unavailable', e.message, 'important');
        }
        return null;
      }
    },

    createSupplierReturn: async (input) => {
      try {
        const res = await api.post<SupplierReturn>('/supplier-returns', input, { idempotencyKey: `sr:${Date.now()}` });
        set((s) => ({ supplierReturns: [{ id: res.id, supplierId: input.supplierId, items: input.items, reason: input.reason, status: res.status, createdAt: res.createdAt }, ...s.supplierReturns] }));
        return { ok: true, id: res.id };
      } catch (e) {
        return fail(e);
      }
    },

    processSupplierReturn: async (id) => {
      try {
        const detail = await api.post<SupplierReturnDetail>(`/supplier-returns/${id}/process`, {}, { idempotencyKey: `sr-process:${id}:${Date.now()}` });
        set((s) => ({ supplierReturns: s.supplierReturns.map((r) => (r.id === id ? detail : r)) }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    rejectSupplierReturn: async (id, reason) => {
      try {
        const detail = await api.post<SupplierReturnDetail>(`/supplier-returns/${id}/reject`, { reason }, { idempotencyKey: `sr-reject:${id}:${Date.now()}` });
        set((s) => ({ supplierReturns: s.supplierReturns.map((r) => (r.id === id ? detail : r)) }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    addWarehouse: async (input) => {
      try {
        const warehouse = await api.post<Warehouse>('/warehouses', input, { idempotencyKey: `wh:${Date.now()}` });
        set((s) => ({ warehouses: { ...s.warehouses, rows: [...s.warehouses.rows, warehouse] } }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    updateWarehouse: async (id, input) => {
      try {
        const warehouse = await api.patch<Warehouse>(`/warehouses/${id}`, input, { idempotencyKey: `wh:${id}:${Date.now()}` });
        set((s) => ({ warehouses: { ...s.warehouses, rows: s.warehouses.rows.map((r) => (r.id === id ? warehouse : r)) } }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    setWarehouseStock: async (id, body) => {
      try {
        const warehouse = await put<Warehouse>(`/warehouses/${id}/stock`, body);
        set((s) => ({ warehouses: { ...s.warehouses, rows: s.warehouses.rows.map((r) => (r.id === id ? warehouse : r)) } }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    fulfillFromWarehouse: async (id, orderId) => {
      try {
        await api.post(`/warehouses/${id}/fulfill`, { orderId }, { idempotencyKey: `wh-fulfill:${id}:${orderId}:${Date.now()}` });
        await get().hydrateWarehouses();
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    fetchWarehouse: async (id) => {
      try {
        const warehouse = await api.get<Warehouse>(`/warehouses/${id}`, { retries: 1 });
        set({ warehouseDetail: warehouse });
        return warehouse;
      } catch (e) {
        if (e instanceof ApiError) {
          useMessageStore.getState().pushSystem('Warehouse unavailable', e.message, 'important');
        }
        return null;
      }
    },
  };
});

export type { SectionState };
