/* Live API jobs (dispatch) repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET /dispatch/available-orders → DispatchOffer[]
 *   GET /dispatch/heatmap          → HeatmapZone[]
 *   POST /orders/{orderId}/accept  {expectedVersion} → Order
 *   POST /orders/{orderId}/reject  {reason}          → Order
 */
import { api } from '@/api/client';
import type { DispatchOfferFeedItem, JobsRepository } from '../index';
import type { AcceptOrderBody, DispatchOffer, HeatmapZone, Order, RejectOrderBody } from '@hudumika/contract';

export class ApiJobsRepository implements JobsRepository {
  async listAvailableOrders(): Promise<DispatchOfferFeedItem[]> {
    const offers = await api.get<DispatchOffer[]>('/dispatch/available-orders');
    return offers.map((offer) => ({ orderId: offer.orderId, offer, expiresAt: Date.parse(offer.expiresAt) }));
  }

  async getHeatmap(): Promise<HeatmapZone[]> {
    return api.get<HeatmapZone[]>('/dispatch/heatmap');
  }

  async respondOffer(orderId: string, decision: 'accept' | 'reject', reason?: string): Promise<{ accepted: boolean; order?: Order }> {
    if (decision === 'reject') {
      const body: RejectOrderBody = { reason: reason ?? 'Other' };
      await api.post<Order>(`/orders/${orderId}/reject`, body);
      return { accepted: false };
    }
    const order = await api.get<Order>(`/orders/${orderId}`);
    const body: AcceptOrderBody = { expectedVersion: order.version ?? 0 };
    const accepted = await api.post<Order>(`/orders/${orderId}/accept`, body);
    return { accepted: true, order: accepted };
  }
}