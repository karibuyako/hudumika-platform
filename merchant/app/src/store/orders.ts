import { create } from 'zustand';

import { api, ApiError } from '@/api/client';
import { useMessageStore } from '@/store/messages';
import type {
  AddItemsOrderBody,
  BatchResultDto,
  CancelOrderResult,
  DamageClaimBody,
  EnterpriseOrderDto,
  FailedDeliveryBody,
  HandoffBody,
  OrderAcceptBody,
  OrderBatchAcceptBody,
  OrderDto,
  OrderRejectBody,
  OrderTimelineEventDto,
  ProofOfDeliveryBody,
  ReceiptRowDto,
  RouteSegmentDto,
  RushOrderDto,
  TrackingEventDto,
  WaybillDto,
} from '@/api/types';
import type { Order, OrderStatus } from '@/types';

const QUEUE_PAGE = 20;

interface OrderState {
  orders: Order[];
  loaded: boolean;
  hydrate: (storeId?: string) => Promise<void>;
  upsert: (order: Order) => void;
  acceptOrder: (id: string) => Promise<void>;
  acceptAllOrders: () => Promise<BatchResultDto | null>;
  rejectOrder: (id: string, reason: string, reasonCode?: string) => Promise<void>;
  startPreparing: (id: string) => Promise<void>;
  markReady: (id: string) => Promise<void>;
  completeOrder: (id: string) => Promise<void>;
  requestRefund: (id: string, reason: string) => Promise<void>;
  decideRefund: (id: string, approve: boolean) => Promise<void>;
  replyRush: (id: string, message?: string) => Promise<void>;
  markSeen: (id: string) => void;
  markAllSeen: () => void;
  /* ---- Server-side queue (GET /orders/me?status=&limit=&cursor=) ---- */
  queueStatus: OrderStatus | 'all';
  queueCursor: number;
  queueHasMore: boolean;
  hydrateQueue: (status: OrderStatus | 'all') => Promise<void>;
  loadMoreQueue: () => Promise<void>;
  advanceOrders: OrderDto[];
  advanceLoaded: boolean;
  advanceTab: 'today' | 'upcoming' | 'past';
  setAdvanceTab: (tab: 'today' | 'upcoming' | 'past') => void;
  hydrateAdvance: (tab: 'today' | 'upcoming' | 'past') => Promise<void>;
  /* ---- P2: orders ops (contract /orders*) ---- */
  searchResults: OrderDto[];
  searchLoaded: boolean;
  searchOrders: (params: { q?: string; status?: string; from?: string; to?: string; customerPhone?: string }) => Promise<void>;
  rushOrders: RushOrderDto[];
  enterpriseOrders: EnterpriseOrderDto[];
  queueMode: 'mine' | 'rush' | 'enterprise';
  setQueueMode: (mode: 'mine' | 'rush' | 'enterprise') => void;
  hydrateRush: (status?: string) => Promise<void>;
  hydrateEnterprise: (status?: string) => Promise<void>;
  hydrateOrderTimeline: (id: string) => Promise<OrderTimelineEventDto[]>;
  trackOrder: (id: string) => Promise<TrackingEventDto | null>;
  fetchWaybill: (id: string) => Promise<WaybillDto | null>;
  fetchRoute: (id: string) => Promise<RouteSegmentDto[]>;
  cancelOrder: (id: string, reason: string) => Promise<CancelOrderResult>;
  holdOrder: (id: string, reason: string) => Promise<void>;
  unholdOrder: (id: string) => Promise<void>;
  rescheduleOrder: (id: string, scheduledAt: number, reason: string) => Promise<void>;
  transferOrder: (id: string, reason: string) => Promise<void>;
  addTip: (id: string, amountTZS: number, note?: string) => Promise<void>;
  addItems: (id: string, items: AddItemsOrderBody['items'], reason: string) => Promise<void>;
  damageOrder: (id: string, body: DamageClaimBody) => Promise<void>;
  failedDelivery: (id: string, body: FailedDeliveryBody) => Promise<void>;
  handoff: (id: string, body: HandoffBody) => Promise<void>;
  proofOfDelivery: (id: string, body: ProofOfDeliveryBody) => Promise<void>;
  advanceHandoff: (id: string) => Promise<void>;
  batchRejectOrder: (ids: string[], reason: string) => Promise<BatchResultDto>;
  fetchReceiptRows: () => Promise<ReceiptRowDto[]>;
  reprintReceipt: (orderId: string) => Promise<void>;
}

const optimistic = (orders: Order[], id: string, patch: Partial<Order>): Order[] =>
  orders.map((o) => (o.id === id ? { ...o, ...patch } : o));

async function runWithConflictRetry(
  get: () => OrderState,
  set: (fn: (s: OrderState) => Partial<OrderState>) => void,
  id: string,
  call: (expectedVersion: number) => Promise<{ order: Order }>,
): Promise<OrderDto | null> {
  let order = get().orders.find((o) => o.id === id);
  if (!order) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await call(order?.version ?? 1);
      set((s) => ({ orders: s.orders.map((o) => (o.id === id ? res.order : o)) }));
      return res.order as OrderDto;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        const fresh = await api.get<{ order: Order }>(`/orders/${id}`, { retries: 0 });
        order = fresh.order;
        set((s) => ({ orders: s.orders.map((o) => (o.id === id ? fresh.order : o)) }));
        continue;
      }
      throw e;
    }
  }
  // OF-03: a second VERSION_CONFLICT is never a silent success — surface it so
  // the detail screen renders the conflict banner and disables the accept CTA.
  const fresh = get().orders.find((o) => o.id === id) ?? (await api.get<{ order: Order }>(`/orders/${id}`, { retries: 0 }).then((r) => r.order));
  throw new ApiError(409, 'VERSION_CONFLICT', 'Order changed again on the server — view the updated order', false, {
    currentVersion: fresh?.version,
  });
}

export const useOrderStore = create<OrderState>()((set, get) => ({
  orders: [],
  loaded: false,
  searchResults: [],
  searchLoaded: false,
  rushOrders: [],
  enterpriseOrders: [],
  queueMode: 'mine',
  queueStatus: 'new',
  queueCursor: 0,
  queueHasMore: false,
  advanceOrders: [],
  advanceLoaded: false,
  advanceTab: 'today',

  hydrate: async (storeId?: string) => {
    try {
      const res = await api.get<{ orders: OrderDto[] }>(storeId ? `/orders?storeId=${storeId}` : '/orders', { retries: 1 });
      set({ orders: res.orders, loaded: true });
    } catch {
      /* keep stale data; loaded stays false so UI shows a retry affordance */
    }
  },

  hydrateQueue: async (status) => {
    const res = await api.get<OrderDto[]>(`/orders/me?status=${status}&limit=${QUEUE_PAGE}&cursor=0`, { retries: 1 });
    set({
      orders: res,
      loaded: true,
      queueStatus: status,
      queueCursor: res.length,
      queueHasMore: res.length >= QUEUE_PAGE,
    });
  },

  loadMoreQueue: async () => {
    const { queueStatus, queueCursor, orders } = get();
    try {
      const res = await api.get<OrderDto[]>(`/orders/me?status=${queueStatus}&limit=${QUEUE_PAGE}&cursor=${queueCursor}`, { retries: 1 });
      const byId = new Map([...orders, ...res].map((o) => [o.id, o]));
      set({
        orders: [...byId.values()],
        queueCursor: queueCursor + res.length,
        queueHasMore: res.length >= QUEUE_PAGE,
      });
    } catch {
      /* keep current page — the retry affordance is the pull-to-refresh */
    }
  },

  setAdvanceTab: (tab) => set({ advanceTab: tab }),

  hydrateAdvance: async (tab) => {
    set({ advanceLoaded: false });
    const d = new Date();
    const day = (offset: number) => {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    };
    const dates = tab === 'today' ? [day(0)] : tab === 'upcoming' ? [1, 2, 3, 4, 5, 6, 7].map(day) : [-1, -2, -3].map(day);
    try {
      const pages = await Promise.all(dates.map((date) => api.get<OrderDto[]>(`/orders/me/advance?date=${date}`, { retries: 1 })));
      const byId = new Map(pages.flat().map((o) => [o.id, o]));
      set({
        advanceOrders: [...byId.values()].sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0)),
        advanceLoaded: true,
      });
    } catch {
      set({ advanceLoaded: true });
      throw new ApiError(0, 'ADVANCE_LOAD_FAILED', 'Could not load scheduled orders');
    }
  },

  upsert: (order) =>
    set((s) => {
      const exists = s.orders.some((o) => o.id === order.id);
      return { orders: exists ? s.orders.map((o) => (o.id === order.id ? order : o)) : [order, ...s.orders] };
    }),

  acceptOrder: async (id) => {
    set((s) => ({ orders: optimistic(s.orders, id, { status: 'merchant_accepted', acceptedAt: Date.now(), seen: true }) }));
    try {
      await runWithConflictRetry(get, set, id, (v) =>
        api.post(`/orders/${id}/accept`, { expectedVersion: v } satisfies OrderAcceptBody, {
          idempotencyKey: `accept:${id}:${Date.now()}`,
        }),
      );
    } catch (e) {
      await get().hydrate();
      if (e instanceof ApiError && e.code === 'OUT_OF_STOCK') {
        useMessageStore.getState().pushSystem('Accept blocked — out of stock', e.message, 'important');
      } else if (e instanceof ApiError && (e.code === 'VERSION_CONFLICT' || e.code === 'ORDER_STATUS_CONFLICT' || e.code === 'ORDER_AUTO_CANCELLED')) {
        // OF-03/OF-04: conflicts are never silent — the detail screen turns this
        // into a conflict banner; the queue surface pushes a system message.
        useMessageStore.getState().pushSystem('Order changed on the server', e.message, 'important');
      } else if (e instanceof ApiError) {
        useMessageStore.getState().pushSystem('Accept failed', e.message, 'important');
      }
      // Surface to the caller (runAction on the detail screen) so the conflict
      // banner renders — never swallow the accept conflict silently.
      throw e;
    }
  },

  acceptAllOrders: async () => {
    const ids = get().orders.filter((o) => o.status === 'new').map((o) => o.id);
    if (!ids.length) return null;
    try {
      const res = await api.post<{ accepted: { id: string; order: Order }[]; failed: { id: string; code?: string }[] } & Partial<BatchResultDto>>(
        '/orders/batch/accept',
        { ids } satisfies OrderBatchAcceptBody,
        { idempotencyKey: `batch-accept:${Date.now()}` },
      );
      // BatchResult honesty: server may return accepted as array (mock) or count (contract shape); normalize to BatchResult.
      const acceptedCount = Array.isArray((res as any).accepted) ? (res as any).accepted.length : ((res as any).accepted as number) ?? 0;
      const failedList: { id: string; code?: string }[] = Array.isArray((res as any).failed) ? (res as any).failed : [];
      const failuresDto = (res as any).failures as { orderId: string; code: string }[] | undefined;
      const failedCount = failuresDto ? failuresDto.length : failedList.length;
      const normalized: BatchResultDto = {
        accepted: acceptedCount,
        failed: failedCount,
        failures: failuresDto ?? failedList.map((f) => ({ orderId: f.id, code: f.code ?? 'error' })),
      };
      if (Array.isArray((res as any).accepted) && (res as any).accepted.length) {
        set((s) => {
          const byId = new Map<string, Order>((res as any).accepted.map((a: { order: Order }) => [a.order.id, a.order] as [string, Order]));
          return { orders: s.orders.map((o) => byId.get(o.id) ?? o) };
        });
      }
      if (normalized.failed) {
        useMessageStore
          .getState()
          .pushSystem(`Accept all: ${normalized.accepted} of ${ids.length} accepted`, `Skipped ${normalized.failed}: ${normalized.failures[0]?.code ?? 'error'}`, 'important');
      }
      return normalized;
    } catch (e) {
      if (e instanceof ApiError) {
        useMessageStore.getState().pushSystem('Accept all failed', e.message, 'important');
      }
      return null;
    }
  },

  rejectOrder: async (id, reason, reasonCode = 'OTHER') => {
    set((s) => ({ orders: optimistic(s.orders, id, { status: 'cancelled', cancelReason: reason, cancelledAt: Date.now() }) }));
    try {
      await api.post(
        `/orders/${id}/reject`,
        { reason, reasonCode } satisfies OrderRejectBody,
        { idempotencyKey: `reject:${id}:${Date.now()}` },
      );
    } catch {
      await get().hydrate();
    }
  },

  markReady: async (id) => {
    set((s) => ({ orders: optimistic(s.orders, id, { status: 'ready', readyAt: Date.now() }) }));
    try {
      // Contract state-advance op: POST /orders/{orderId}/status (body {status, note}).
      await api.post<OrderDto>(`/orders/${id}/status`, { status: 'ready' }, { idempotencyKey: `ready:${id}:${Date.now()}` });
    } catch {
      await get().hydrate();
    }
  },

  startPreparing: async (id) => {
    set((s) => ({ orders: optimistic(s.orders, id, { status: 'preparing' }) }));
    try {
      const res = await api.post<OrderDto>(`/orders/${id}/status`, { status: 'preparing' }, { idempotencyKey: `start-prep:${id}:${Date.now()}` });
      set((s) => ({ orders: s.orders.map((o) => (o.id === id ? res : o)) }));
    } catch (e) {
      await get().hydrate();
      throw e;
    }
  },

  completeOrder: async (id) => {
    set((s) => ({ orders: optimistic(s.orders, id, { status: 'completed', completedAt: Date.now(), seen: true }) }));
    try {
      await api.post<OrderDto>(`/orders/${id}/status`, { status: 'completed' }, { idempotencyKey: `complete:${id}:${Date.now()}` });
    } catch {
      await get().hydrate();
    }
  },

  requestRefund: async (id, reason) => {
    try {
      const res = await api.post<{ order: Order }>(`/orders/${id}/refund`, { reason });
      set((s) => ({ orders: s.orders.map((o) => (o.id === id ? res.order : o)) }));
    } catch {
      await get().hydrate();
    }
  },

  decideRefund: async (id, approve) => {
    const order = get().orders.find((o) => o.id === id);
    const refundId = order?.refund ? `rf_${id}` : undefined;
    set((s) => ({
      orders: optimistic(s.orders, id, {
        refund: { ts: order?.refund?.ts ?? Date.now(), reason: order?.refund?.reason ?? '', amount: order?.refund?.amount ?? 0, status: approve ? 'approved' : 'declined' },
      }),
    }));
    try {
      if (refundId) {
        await api.post(`/refunds/${refundId}/decide`, { approve }, { idempotencyKey: `refund:${id}:${Date.now()}` });
      }
    } catch {
      await get().hydrate();
    }
  },

  replyRush: async (id, message) => {
    const msg = (message ?? '').slice(0, 300);
    set((s) => ({ orders: optimistic(s.orders, id, { rushReplied: true }) }));
    try {
      const res = await api.post<{ order: Order; rushOrder: RushOrderDto }>(`/orders/${id}/rush-reply`, { message: msg }, { idempotencyKey: `rush:${id}:${Date.now()}` });
      set((s) => ({ orders: s.orders.map((o) => (o.id === id ? res.order : o)) }));
    } catch {
      await get().hydrate();
      throw new ApiError(409, 'RUSH_REPLY_FAILED', 'Could not send the rush reply');
    }
  },

  markSeen: (id) => {
    set((s) => ({ orders: optimistic(s.orders, id, { seen: true }) }));
    api.post(`/orders/${id}/seen`, {}, { retries: 0 }).catch(() => undefined);
  },

  markAllSeen: () => {
    set((s) => ({ orders: s.orders.map((o) => ({ ...o, seen: true })) }));
    const { orders } = get();
    orders.filter((o) => !o.seen).forEach((o) => api.post(`/orders/${o.id}/seen`, {}, { retries: 0 }).catch(() => undefined));
  },

  /* ---- P2: orders ops (contract /orders*) ---- */

  searchOrders: async (params) => {
    set({ searchLoaded: false });
    try {
      const qs = new URLSearchParams();
      if (params.q) qs.set('q', params.q);
      if (params.status && params.status !== 'all') qs.set('status', params.status);
      if (params.from) qs.set('from', params.from);
      if (params.to) qs.set('to', params.to);
      if (params.customerPhone) qs.set('customerPhone', params.customerPhone);
      const res = await api.get<OrderDto[]>(`/orders/search?${qs.toString()}`, { retries: 1 });
      set({ searchResults: res, searchLoaded: true });
    } catch (e) {
      set({ searchLoaded: true });
      throw e;
    }
  },

  setQueueMode: (mode) => set({ queueMode: mode }),

  hydrateRush: async (status = 'open') => {
    try {
      const res = await api.get<RushOrderDto[]>(`/orders/rush?status=${status}`, { retries: 1 });
      set({ rushOrders: res });
    } catch {
      /* keep stale */
    }
  },

  hydrateEnterprise: async (status = 'all') => {
    try {
      const res = await api.get<EnterpriseOrderDto[]>(`/orders/enterprise?status=${status}`, { retries: 1 });
      set({ enterpriseOrders: res });
    } catch {
      /* keep stale */
    }
  },

  hydrateOrderTimeline: async (id) => {
    const res = await api.get<{ events: OrderTimelineEventDto[] }>(`/orders/${id}/timeline`, { retries: 1 });
    return res.events;
  },

  trackOrder: async (id) => {
    try {
      return await api.get<TrackingEventDto>(`/orders/${id}/track`, { retries: 1 });
    } catch {
      return null;
    }
  },

  fetchWaybill: async (id) => {
    try {
      return await api.get<WaybillDto>(`/orders/${id}/waybill`, { retries: 1 });
    } catch {
      return null;
    }
  },

  fetchRoute: async (id) => {
    try {
      return await api.get<RouteSegmentDto[]>(`/orders/${id}/route`, { retries: 1 });
    } catch {
      return [];
    }
  },

  cancelOrder: async (id, reason) => {
    const res = await api.post<CancelOrderResult>(`/orders/${id}/cancel`, { reason }, { idempotencyKey: `cancel:${id}:${Date.now()}` });
    set((s) => ({ orders: s.orders.map((o) => (o.id === id ? res : o)) }));
    return res;
  },

  holdOrder: async (id, reason) => {
    const res = await api.post<Order>(`/orders/${id}/hold`, { reason }, { idempotencyKey: `hold:${id}:${Date.now()}` });
    set((s) => ({ orders: s.orders.map((o) => (o.id === id ? res : o)) }));
  },

  unholdOrder: async (id) => {
    const res = await api.post<Order>(`/orders/${id}/unhold`, {}, { idempotencyKey: `unhold:${id}:${Date.now()}` });
    set((s) => ({ orders: s.orders.map((o) => (o.id === id ? res : o)) }));
  },

  rescheduleOrder: async (id, scheduledAt, reason) => {
    const res = await api.post<Order>(`/orders/${id}/reschedule`, { scheduledAt, reason }, { idempotencyKey: `reschedule:${id}:${Date.now()}` });
    set((s) => ({ orders: s.orders.map((o) => (o.id === id ? res : o)) }));
  },

  transferOrder: async (id, reason) => {
    await api.post<{ transferId: string; status: string }>(`/orders/${id}/transfer`, { reason }, { idempotencyKey: `transfer:${id}:${Date.now()}` });
  },

  addTip: async (id, amountTZS, note) => {
    const res = await api.post<Order>(`/orders/${id}/tip`, { amountTZS, note }, { idempotencyKey: `tip:${id}:${Date.now()}` });
    set((s) => ({ orders: s.orders.map((o) => (o.id === id ? res : o)) }));
  },

  addItems: async (id, items, reason) => {
    await api.post<{ requestId: string; status: string }>(`/orders/${id}/add-items`, { items, reason }, { idempotencyKey: `add-items:${id}:${Date.now()}` });
  },

  damageOrder: async (id, body) => {
    await api.post<{ id: string }>(`/orders/${id}/damage`, body, { idempotencyKey: `damage:${id}:${Date.now()}` });
  },

  failedDelivery: async (id, body) => {
    const res = await api.post<Order>(`/orders/${id}/failed-delivery`, body, { idempotencyKey: `failed:${id}:${Date.now()}` });
    set((s) => ({ orders: s.orders.map((o) => (o.id === id ? res : o)) }));
  },

  handoff: async (id, body) => {
    await api.post<{ id: string }>(`/orders/${id}/handoff`, body, { idempotencyKey: `handoff:${id}:${Date.now()}` });
  },

  proofOfDelivery: async (id, body) => {
    await api.post<{ id: string }>(`/orders/${id}/proof-of-delivery`, body, { idempotencyKey: `pod:${id}:${Date.now()}` });
  },

  advanceHandoff: async (id) => {
    const order = get().orders.find((o) => o.id === id);
    const res = await api.post<OrderDto>(`/orders/me/advance`, { orderId: id, expectedVersion: order?.version }, { idempotencyKey: `advance:${id}:${Date.now()}` });
    set((s) => ({ orders: s.orders.map((o) => (o.id === id ? res : o)) }));
  },

  batchRejectOrder: async (ids, reason) => {
    return await api.post<BatchResultDto>(
      '/orders/batch/reject',
      { orderIds: ids.slice(0, 50), reason },
      { idempotencyKey: `batch-reject:${Date.now()}` },
    );
  },

  fetchReceiptRows: async () => {
    return await api.get<ReceiptRowDto[]>('/orders/receipts?limit=20', { retries: 1 });
  },

  reprintReceipt: async (orderId) => {
    await api.post<{ id: string }>(
      '/print-jobs',
      { jobType: 'receipt', orderIds: [orderId], copies: 1 },
      { idempotencyKey: `reprint:${orderId}:${Date.now()}` },
    );
  },
}));

export type { OrderStatus };
