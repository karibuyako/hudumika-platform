/* In-memory delivery repository. Mirrors GET /orders/me, GET /orders/{orderId},
 * GET /orders/{orderId}/track|fare, POST /orders/{orderId}/status,
 * POST /orders/{orderId}/proof-of-delivery, failed-delivery, reschedule,
 * transfer, masked-call.
 *
 * Behavior modeled:
 *  - advance() enforces the 5-step rider flow (rider_arrived_pickup → picked_up
 *    → delivering → rider_arrived_dropoff → delivered) starting from
 *    rider_assigned, bumps Order.version, and honors an optional expectedVersion
 *    (stale version → 409 VERSION_CONFLICT).
 *  - submitPOD() only at rider_arrived_dropoff (else 409), sets delivered and
 *    credits a +delivery_fee ledger entry.
 *  - transfer() hands the order back to dispatch (riderId null, re-offered).
 *  - reschedule() sets scheduledAt and status rescheduled.
 */
import { ApiError } from '@/api/client';
import { getState, clone, nowIso, trackFor, createMaskedCall, creditDelivery, buildFare, recordShiftCod, MOCK_PICKUP_CODE, ACTIVE_STATUSES, TERMINAL_STATUSES } from './mockState';
import type { AdvanceOrderOptions, DeliveryRepository, RiderAdvanceableStatus } from '../index';
import type { FareBreakdown, MaskedCallSession, Order, OrderDetail, ProofOfDelivery, TrackingEvent } from '@hudumika/contract';

const RIDER_FLOW: RiderAdvanceableStatus[] = ['rider_arrived_pickup', 'picked_up', 'delivering', 'rider_arrived_dropoff', 'delivered'];

/** Mock-only customer code accepted by submitPOD for type 'otp'. */
export const MOCK_CUSTOMER_OTP = '123456';

export class MockDeliveryRepository implements DeliveryRepository {
  async listMyOrders(scope: 'active' | 'completed'): Promise<Order[]> {
    const state = getState();
    const wanted = scope === 'active' ? ACTIVE_STATUSES : TERMINAL_STATUSES;
    return clone(state.orders.filter((o) => wanted.includes(o.status)));
  }

  async getOrder(orderId: string): Promise<OrderDetail> {
    const state = getState();
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found`);
    return clone(order);
  }

  async track(orderId: string): Promise<TrackingEvent> {
    const state = getState();
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found`);
    return clone(trackFor(order));
  }

  async getFare(orderId: string): Promise<FareBreakdown> {
    const state = getState();
    const fare = state.fares.get(orderId);
    if (!fare) throw new ApiError(404, 'FARE_NOT_AVAILABLE', `No fare available for order ${orderId}`);
    return clone(fare);
  }

  async advance(orderId: string, status: RiderAdvanceableStatus, opts?: AdvanceOrderOptions & { expectedVersion?: number }): Promise<Order> {
    const state = getState();
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found`);
    if (opts?.expectedVersion !== undefined && opts.expectedVersion !== (order.version ?? 0)) {
      throw new ApiError(409, 'VERSION_CONFLICT', `Stale version ${opts.expectedVersion}, current ${order.version ?? 0}`);
    }
    const step = RIDER_FLOW.indexOf(status);
    if (step === -1) throw new ApiError(422, 'INVALID_STATUS', `Not a rider-advanceable status: ${status}`);
    const previous = step === 0 ? 'rider_assigned' : RIDER_FLOW[step - 1];
    if (order.status !== previous) {
      throw new ApiError(409, 'INVALID_STATUS_TRANSITION', `Cannot advance ${order.status} → ${status}`);
    }
    if (status === 'picked_up') {
      if (opts?.pickupCode) {
        const mockCode = state.pickupCodes[orderId] ?? MOCK_PICKUP_CODE;
        if (opts.pickupCode !== mockCode) {
          throw new ApiError(422, 'PICKUP_CODE_INVALID', 'Incorrect pickup code — ask the merchant to confirm');
        }
      } else if (!opts?.note) {
        throw new ApiError(422, 'PICKUP_CODE_REQUIRED', 'Pickup code required — enter the merchant code or confirm manually with a note');
      }
    }
    order.status = status;
    order.version = (order.version ?? 0) + 1;
    order.updatedAt = nowIso();
    order.events.push({ status, at: nowIso(), by: 'rider', note: opts?.note });
    if (status === 'delivered') {
      order.completedAt = nowIso();
      const fare = state.fares.get(orderId) ?? buildFare(orderId, false);
      creditDelivery(order, fare.totalTZS);
      recordShiftCod(order);
    }
    return clone(order);
  }

  async submitPOD(orderId: string, pod: ProofOfDelivery): Promise<Order> {
    const state = getState();
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found`);
    if (state.podSubmitted.has(orderId)) {
      throw new ApiError(409, 'POD_ALREADY_SUBMITTED', `Proof of delivery already submitted for order ${orderId}`);
    }
    if (order.status !== 'rider_arrived_dropoff') {
      throw new ApiError(409, 'INVALID_STAGE', `POD only at rider_arrived_dropoff, order is ${order.status}`);
    }
    if (pod.type === 'otp' && pod.value !== MOCK_CUSTOMER_OTP) {
      throw new ApiError(422, 'POD_OTP_INVALID', 'Incorrect customer code — try again');
    }
    if (pod.type === 'photo' && pod.dropoffOption === 'leave_at_door' && !pod.gpsStamp) {
      throw new ApiError(422, 'POD_INVALID', 'Leave-at-door requires a photo with a GPS stamp');
    }
    state.podSubmitted.add(orderId);
    order.status = 'delivered';
    order.version = (order.version ?? 0) + 1;
    order.updatedAt = nowIso();
    order.completedAt = nowIso();
    if (pod.itemIds?.length) order.itemsChecked = true;
    order.events.push({ status: 'delivered', at: nowIso(), by: 'rider', note: 'Proof of delivery submitted' });
    const fare = state.fares.get(orderId) ?? buildFare(orderId, false);
    creditDelivery(order, fare.totalTZS);
    recordShiftCod(order);
    return clone(order);
  }

  async failDelivery(orderId: string, reason: string): Promise<Order> {
    const state = getState();
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found`);
    order.status = 'failed_delivery';
    order.version = (order.version ?? 0) + 1;
    order.updatedAt = nowIso();
    order.rejectReason = reason;
    order.rejectReasonCode = reason;
    order.events.push({ status: 'failed_delivery', at: nowIso(), by: 'rider', note: reason });
    return clone(order);
  }

  async reschedule(orderId: string, requestedSlot: string): Promise<Order> {
    const state = getState();
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found`);
    order.status = 'rescheduled';
    order.scheduledAt = requestedSlot;
    order.version = (order.version ?? 0) + 1;
    order.updatedAt = nowIso();
    order.events.push({ status: 'rescheduled', at: nowIso(), by: 'rider', note: `Rescheduled to ${requestedSlot}` });
    return clone(order);
  }

  async transfer(orderId: string, reason: string): Promise<Order> {
    const state = getState();
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found`);
    order.riderId = null;
    order.status = 'preparing';
    order.version = (order.version ?? 0) + 1;
    order.updatedAt = nowIso();
    order.events.push({ status: 'preparing', at: nowIso(), by: 'rider', note: `Transferred: ${reason}` });
    const cod = (state.fares.get(orderId)?.codFeeTZS ?? 0) > 0;
    state.feed.push({
      orderId,
      offer: {
        orderId,
        pickup: { lat: -6.79, lon: 39.2, address: 'Pickup point', merchantName: 'Sunrise Kitchen' },
        dropoff: { lat: -6.81, lon: 39.21, address: 'Dropoff' },
        distanceKm: 2.5,
        predictedPrepMinutes: 15,
        estimatedEarningsTZS: order.totals.deliveryFeeTZS + order.totals.platformFeeTZS,
        itemsSummary: (order.items ?? []).slice(0, 2).map((it) => it.name).join(', ') || 'Order items',
        paymentMethod: cod ? 'cod' : 'mpesa',
        expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      },
      expiresAt: Date.now() + 20 * 60 * 1000,
    });
    return clone(order);
  }

  async createMaskedCall(orderId: string): Promise<MaskedCallSession> {
    const state = getState();
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found`);
    return clone(createMaskedCall(orderId));
  }
}