/* Live API orders repository — POST /orders (Idempotency-Key), /orders/me,
 * /orders/{id}, cancel, rush, modify-request, tip, track, route, waybill,
 * tracking-phases. */
import { api, ApiError } from '@/api/client';
import type { GetOrderWaybill200, MaskedCallSession, Order, OrderCreate, OrderDetail, RequestOrderModification202, RequestOrderModificationBody, RouteSegment, TipRiderBody, TrackingEvent, TrackingPhase } from '@hudumika/contract';
import type { OrderCreateInput, OrderModificationInput, OrderTipInput, OrdersRepository, DeliveryWindow, RouteCities, TrackingShare } from '../index';

export class ApiOrdersRepository implements OrdersRepository {
  async create(input: OrderCreateInput, idempotencyKey: string): Promise<Order> {
    const body: OrderCreate = {
      merchantId: input.merchantId,
      items: input.items,
      paymentMethod: input.paymentMethod,
      deliveryAddress: input.deliveryAddress,
      note: input.note,
      scheduledAt: input.scheduledAt,
      // Mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #10): couponId is
      // NOT in the generated OrderCreate yet. Passed through so a backend that
      // has shipped the field honors the discount; others ignore it. The mock
      // is the server that applies it today.
      ...(input.couponId !== undefined ? { couponId: input.couponId } : {}),
    };
    return api.post<Order>('/orders', body, { idempotencyKey });
  }

  async list(params?: { status?: string; cursor?: string; limit?: number }): Promise<Order[]> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    return api.get<Order[]>(`/orders/me${qs ? `?${qs}` : ''}`);
  }

  async get(orderId: string): Promise<OrderDetail> {
    return api.get<OrderDetail>(`/orders/${orderId}`);
  }

  async cancel(orderId: string, reason: string, idempotencyKey: string): Promise<Order> {
    return api.post<Order>(`/orders/${orderId}/cancel`, { reason }, { idempotencyKey });
  }

  async rush(orderId: string, idempotencyKey: string): Promise<void> {
    await api.post<void>(`/orders/${orderId}/rush`, {}, { idempotencyKey });
  }

  async modifyRequest(orderId: string, input: OrderModificationInput, idempotencyKey: string): Promise<RequestOrderModification202> {
    // Contract RequestOrderModificationBody: {type (enum), note (required,
    // maxLength 500), items?}. The UI only ever sends type + note.
    const body: RequestOrderModificationBody = { type: input.type, note: input.note ?? '' };
    return api.post<RequestOrderModification202>(`/orders/${orderId}/modify-request`, body, { idempotencyKey });
  }

  async tip(orderId: string, input: OrderTipInput, idempotencyKey: string): Promise<OrderDetail> {
    // Contract TipRiderBody: {amountTZS ≥ 1, method (enum), note maxLength
    // 200}. The wire returns Order; OrderDetail is the app-layer view (the
    // mock serves the full detail), so the read types widen.
    const body: TipRiderBody = { amountTZS: input.amountTZS, method: input.method, note: input.note };
    return api.post<OrderDetail>(`/orders/${orderId}/tip`, body, { idempotencyKey });
  }

  async track(orderId: string): Promise<TrackingEvent> {
    return api.get<TrackingEvent>(`/orders/${orderId}/track`);
  }

  async getRoute(orderId: string): Promise<RouteSegment[]> {
    return api.get<RouteSegment[]>(`/orders/${orderId}/route`);
  }

  async getWaybill(orderId: string): Promise<GetOrderWaybill200> {
    return api.get<GetOrderWaybill200>(`/orders/${orderId}/waybill`);
  }

  async getTrackingPhases(orderId: string): Promise<TrackingPhase[]> {
    return api.get<TrackingPhase[]>(`/orders/${orderId}/tracking-phases`);
  }

  // Mock-only until the contract ships deliveryWindowFrom/To and
  // originCityName/destinationCityName on order/tracking payloads
  // (docs/CONTRACT-ADDITIONS.md #5): the live wire does not carry them yet,
  // so both getters report null — the UI renders the window/city cards only
  // when the data exists.
  async getDeliveryWindow(_orderId: string): Promise<DeliveryWindow | null> {
    return null;
  }

  async getRouteCities(_orderId: string): Promise<RouteCities | null> {
    return null;
  }

  async createMaskedCall(orderId: string, idempotencyKey: string): Promise<MaskedCallSession> {
    return api.post<MaskedCallSession>(`/orders/${orderId}/masked-call`, { direction: 'customer_to_rider' }, { idempotencyKey });
  }

  // Mock-only until the contract ships a consumer tracking-share surface
  // (docs/CONTRACT-ADDITIONS.md #27, OPERATIONS-COVERAGE #77 PLANNED): the
  // generated contract exposes no /tracking-share path, so both calls hit the
  // not-yet-contract paths (parity harness allow-list) and a live backend
  // that has not adopted them degrades the recipient screen into its
  // "Tracking unavailable" state instead of erroring the app.
  async createTrackingShare(orderId: string, idempotencyKey: string): Promise<TrackingShare> {
    return api.post<TrackingShare>(`/orders/${orderId}/tracking-share`, {}, { idempotencyKey });
  }

  async resolveTrackingShare(token: string): Promise<{ orderId: string } | null> {
    try {
      return await api.get<{ orderId: string }>(`/tracking-share/${token}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
}
