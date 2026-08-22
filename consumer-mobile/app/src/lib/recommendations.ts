/* Live behavior event tracker for recommendations — fire-and-forget POST /users/me/events.
 * The server computes daypart and handles cold/warm start; the client passes
 * type, merchantId, query, cityId, lat/lon where available. Never blocks UI.
 */
import { api } from '@/api/client';
import { useLocationStore } from '@/store/location';

type EventType = 'view_merchant' | 'search' | 'cart_add' | 'heart' | 'order_paid' | 'booking';

export function trackRecommendationEvent(type: EventType, opts: { merchantId?: string; query?: string } = {}) {
  const cityId = useLocationStore.getState().city?.id;
  const payload: Record<string, unknown> = { type };
  if (opts.merchantId) payload.merchantId = opts.merchantId;
  if (opts.query) payload.query = opts.query;
  if (cityId) payload.cityId = cityId;
  // lat/lon omitted for now; future: use Geolocation.getCurrentPosition
  // Fire-and-forget: never throw, never block, best-effort.
  api.post('/users/me/events', payload, { retries: 0 }).catch(() => {});
}
