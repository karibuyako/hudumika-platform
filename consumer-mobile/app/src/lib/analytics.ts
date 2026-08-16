/* Analytics (INSTRUCTIONS §7, MASTER-BLUEPRINT §26): instrument the
 * conversion funnel with entity ids and statuses ONLY — never money details,
 * PII, notification bodies, or idempotency keys. The catalog below is the
 * single source of truth: every name has a typed payload and every typed
 * payload appears in the catalog (asserted in tests/m7-hardening.test.ts).
 */
export const ANALYTICS_EVENTS = [
  'home_viewed',
  'search_started',
  'search_submitted',
  'category_opened',
  'merchant_viewed',
  'product_viewed',
  'cart_item_added',
  'checkout_started',
  'payment_started',
  'order_created',
  'order_cancelled',
  'tracking_viewed',
  'review_submitted',
  'support_opened',
  'coupon_claimed',
  'app_open',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

export type AnalyticsEvent =
  | { name: 'app_open' }
  | { name: 'home_viewed'; cityId?: string }
  | { name: 'search_started' }
  | { name: 'search_submitted'; query: string; category?: string; results?: number }
  | { name: 'category_opened'; category: string }
  | { name: 'merchant_viewed'; merchantId: string }
  | { name: 'product_viewed'; merchantId: string; catalogueItemId: string }
  | { name: 'cart_item_added'; merchantId: string; catalogueItemId: string; quantity: number }
  | { name: 'checkout_started'; merchantId: string }
  | { name: 'payment_started'; method: string }
  | { name: 'order_created'; orderId: string; status: string }
  | { name: 'order_cancelled'; orderId: string; reason: string }
  | { name: 'tracking_viewed'; orderId: string }
  | { name: 'review_submitted'; targetType: string; targetId: string }
  | { name: 'support_opened' }
  | { name: 'coupon_claimed'; couponId: string }
  | { name: 'group_buy_purchased'; entityId: string; quantity: number }
  | { name: 'reservation_created'; entityId: string }
  | { name: 'dine_in_opened'; entityId: string }
  | { name: 'group_order_started'; merchantId: string; groupOrderId: string }
  | { name: 'group_order_finalized'; groupOrderId: string; orderId: string };

/**
 * Analytics sink — pluggable behind a tiny interface so a real provider
 * (Segment, PostHog, Amplitude) can be wired in without touching any screen:
 *
 *   import { setAnalyticsSink } from '@/lib/analytics';
 *   setAnalyticsSink({ track: (e) => posthog.capture(e.name, e) });
 *
 * Default behaviour: dev builds log to the console; production is a safe
 * no-op until a sink is installed. The payload is sanitised by the event
 * union above — never add money or PII fields to it.
 */
export interface AnalyticsSink {
  track(event: AnalyticsEvent): void;
}

let configuredSink: AnalyticsSink | null = null;

export function setAnalyticsSink(sink: AnalyticsSink | null): void {
  configuredSink = sink;
}

export function track(event: AnalyticsEvent): void {
  if (configuredSink) {
    configuredSink.track(event);
    return;
  }
  if (process.env.EXPO_PUBLIC_ENV === 'production') return;
  console.info(`[analytics] ${event.name}`, event);
}
