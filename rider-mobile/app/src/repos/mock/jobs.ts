/* In-memory dispatch repository. Mirrors GET /dispatch/available-orders,
 * GET /dispatch/heatmap, POST /orders/{orderId}/accept, POST /orders/{orderId}/reject.
 *
 * Accepting an offer materializes the order in the rider's queue with status
 * rider_assigned and removes it from the feed; rejecting records the reason
 * and removes it from the feed too (server-side re-dispatch elsewhere).
 */
import { ApiError } from '@/api/client';
import { getState, clone, nowIso, buildFare } from './mockState';
import type { JobsRepository, DispatchOfferFeedItem } from '../index';
import type { HeatmapZone, Order, OrderDetail } from '@hudumika/contract';

export class MockJobsRepository implements JobsRepository {
  async listAvailableOrders(): Promise<DispatchOfferFeedItem[]> {
    const state = getState();
    const live = state.feed.filter((item) => item.expiresAt > Date.now());
    return clone(live);
  }

  async getHeatmap(): Promise<HeatmapZone[]> {
    return clone(getState().heatmap);
  }

  async respondOffer(orderId: string, decision: 'accept' | 'reject', reason?: string): Promise<{ accepted: boolean; order?: Order }> {
    const state = getState();
    const idx = state.feed.findIndex((item) => item.orderId === orderId);
    if (idx !== -1 && state.feed[idx].expiresAt <= Date.now()) {
      state.feed.splice(idx, 1);
      throw new ApiError(409, 'OFFER_NOT_AVAILABLE', `Offer for order ${orderId} has expired`);
    }
    if (idx === -1) {
      const order = state.orders.find((o) => o.id === orderId);
      if (order && decision === 'accept' && (order.riderId ?? null) === state.profile.id) {
        return { accepted: true, order: clone(order) };
      }
      throw new ApiError(409, 'OFFER_NOT_AVAILABLE', `Offer for order ${orderId} is not available`);
    }
    const [item] = state.feed.splice(idx, 1);
    if (decision === 'reject') {
      const source = state.orders.find((o) => o.id === orderId);
      if (source) {
        source.rejectReason = reason ?? 'Other';
        source.rejectReasonCode = reason;
      }
      return { accepted: false };
    }
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found in store`);
    const cod = item.offer.paymentMethod === 'cod';
    const assigned: OrderDetail = {
      ...order,
      status: 'rider_assigned',
      riderId: state.profile.id,
      version: 1,
      acceptedAt: nowIso(),
      updatedAt: nowIso(),
      events: [...(order.events ?? []), { status: 'rider_assigned', at: nowIso(), by: 'rider', note: 'Offer accepted' }],
    };
    state.fares.set(orderId, buildFare(orderId, cod));
    state.orders[state.orders.indexOf(order)] = assigned;
    return { accepted: true, order: clone(assigned) };
  }
}