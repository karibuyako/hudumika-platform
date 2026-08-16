/* Live API delivery repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /orders/me?scope=active|completed (contract: status filter; scope is
 *        resolved client-side over the owned-order list)
 *   GET  /orders/{orderId}                      → Order
 *   GET  /orders/{orderId}/track                → TrackingEvent
 *   GET  /orders/{orderId}/fare                 → FareBreakdown
*  POST /orders/{orderId}/status               {status, note?}
 *   POST /orders/{orderId}/proof-of-delivery    {ProofOfDelivery}
 *   POST /orders/{orderId}/failed-delivery      {reason}
 *   POST /orders/{orderId}/reschedule           {scheduledAt, reason}
 *   POST /orders/{orderId}/transfer             {reason}
 *   POST /orders/{orderId}/masked-call          → MaskedCallSession
 */
import { api } from '@/api/client';
import type { DeliveryRepository, RiderAdvanceableStatus } from '../index';
import type {
  AdvanceOrderBody,
  FailDeliveryBody,
  FailDeliveryBodyReason,
  FareBreakdown,
  MaskedCallSession,
  Order,
  OrderDetail,
  ProofOfDelivery,
  RescheduleOrderBody,
  TrackingEvent,
  TransferOrderBody,
} from '@hudumika/contract';

const ACTIVE_STATUSES = ['rider_assigned', 'rider_arrived_pickup', 'picked_up', 'delivering', 'rider_arrived_dropoff', 'rescheduled'];
const TERMINAL_STATUSES = ['delivered', 'completed', 'failed_delivery', 'cancelled', 'refunded', 'timed_out', 'returning'];

const KNOWN_FAIL_REASONS: FailDeliveryBodyReason[] = ['customer_unavailable', 'wrong_address', 'refused', 'damaged', 'other'];

export class ApiDeliveryRepository implements DeliveryRepository {
  async listMyOrders(scope: 'active' | 'completed'): Promise<Order[]> {
    const orders = await api.get<Order[]>('/orders/me');
    const wanted = scope === 'active' ? ACTIVE_STATUSES : TERMINAL_STATUSES;
    return orders.filter((o) => wanted.includes(o.status));
  }

  async getOrder(orderId: string): Promise<OrderDetail> {
    return api.get<OrderDetail>(`/orders/${orderId}`);
  }

  async track(orderId: string): Promise<TrackingEvent> {
    return api.get<TrackingEvent>(`/orders/${orderId}/track`);
  }

  async getFare(orderId: string): Promise<FareBreakdown> {
    return api.get<FareBreakdown>(`/orders/${orderId}/fare`);
  }

  async advance(orderId: string, status: RiderAdvanceableStatus, opts?: { note?: string; pickupCode?: string }): Promise<Order> {
    const body: AdvanceOrderBody = {
      status,
      ...(opts?.note ? { note: opts.note } : {}),
    };
    return api.post<Order>(`/orders/${orderId}/status`, body);
  }

  async submitPOD(orderId: string, pod: ProofOfDelivery): Promise<Order> {
    return api.post<Order>(`/orders/${orderId}/proof-of-delivery`, pod);
  }

  async failDelivery(orderId: string, reason: string): Promise<Order> {
    const body: FailDeliveryBody = {
      reason: (KNOWN_FAIL_REASONS as string[]).includes(reason) ? (reason as FailDeliveryBodyReason) : 'other',
      note: reason,
    };
    return api.post<Order>(`/orders/${orderId}/failed-delivery`, body);
  }

  async reschedule(orderId: string, requestedSlot: string): Promise<Order> {
    const body: RescheduleOrderBody = { scheduledAt: requestedSlot, reason: 'Rider requested reschedule' };
    return api.post<Order>(`/orders/${orderId}/reschedule`, body);
  }

  async transfer(orderId: string, reason: string): Promise<Order> {
    const body: TransferOrderBody = { reason };
    return api.post<Order>(`/orders/${orderId}/transfer`, body);
  }

  async createMaskedCall(orderId: string): Promise<MaskedCallSession> {
    return api.post<MaskedCallSession>(`/orders/${orderId}/masked-call`);
  }
}