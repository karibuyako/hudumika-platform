/* In-memory orders repository — POST /orders (Idempotency-Key), GET /orders/me,
 * /orders/{id}, cancel, rush, modify-request, tip, track, route, waybill,
 * tracking-phases.
 *
 * Placing an order mutates shared state so it shows up in /orders/me and the
 * tracking reflects the seeded TrackingEvent — the demo feels real.
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import type { GetOrderWaybill200, MaskedCallSession, Order, OrderDetail, RequestOrderModification202, RouteSegment, TrackingEvent, TrackingPhase } from '@hudumika/contract';
import { OrderStatus, TipRiderBodyMethod } from '@hudumika/contract';
import {
  clone,
  fixtureAddress,
  findCatalogueItem,
  findMerchant,
  findOrder,
  getState,
  nowIso,
  optionPriceFor,
  phaseForOrder,
  trackFor,
  validateOrderInput,
  buildOrderFrom,
} from './mockState';
import type { OrderModificationInput, OrderPaymentIntent, OrderCreateInput, OrderTipInput, OrdersRepository, DeliveryWindow, RouteCities, TrackingShare } from '../index';
import { earnOrderPoints } from './memberships';

const ACTIVE: OrderStatus[] = ['pending_payment', 'paid', 'merchant_accepted', 'preparing', 'rider_assigned', 'picked_up', 'delivering'];

/** Contract TipRiderBodyMethod values — the mock validates against the
 * enum exactly (422 VALIDATION_FAILED for anything else). */
const TIP_METHODS: TipRiderBodyMethod[] = Object.values(TipRiderBodyMethod);

/** Module-local modification requests — OrderDetail exposes no modification
 * field (events[] carries OrderStatus only, and there is no
 * modification_requested status), so the pending record lives here, keyed by
 * orderId. resetMockState() covers mockState only; tests call
 * resetMockOrdersState() between cases (same pattern as mock/auth.ts). */
const pendingModifications = new Map<string, RequestOrderModification202>();

/** Module-local tip replays — idempotent per key (same pattern as the
 * orderReplays map in mockState): the first key applies the tip and the
 * resulting order is stored; a retry with the same key returns it untouched. */
const tipReplays = new Map<string, OrderDetail>();

/* ---- Tracking shares (docs/CONTRACT-ADDITIONS.md #27, OPERATIONS-COVERAGE
 * #77 "Share live location — trip-share pattern", mock-only-until-adopted) ----
 * View-only tracking links: createTrackingShare issues a short-lived token
 * (ts_{order}_{randoms}) that the recipient resolves on /track-share/{token}
 * to a read-only tracking view. The registry is module-local (mockState.ts
 * untouched, same pattern as mock/splits.ts) and seeds one demo token so the
 * track-share screen renders on first load and headless smoke tests have a
 * target. Expiry rule: tokens live 2h (TRACKING_SHARE_TTL_MS) — the shared
 * link stops resolving after that, mirroring the rider app's trip-share
 * token expiry. */

interface TrackingShareRecord {
  token: string;
  orderId: string;
  expiresAt: number;
}

/** Trip-share token TTL — 2 hours (CONTRACT-ADDITIONS.md #27 expiry rule). */
export const TRACKING_SHARE_TTL_MS = 2 * 3600_000;

/** Seeded demo token — resolves to the seeded warehouse order
 * (ord_warehouse_003, status picked_up) whose tracking renders fully on the
 * recipient screen: rider location on the map, ETA, the six-phase strip and
 * the warehouse chip (mirrors mock/splits.ts SEED_SPLIT_ID; the active order
 * seed is a fixture fulfillmentType 'intercity' whose waybill fetch 404s, so
 * it would render the unavailable state instead). */
export const SEED_TRACKING_SHARE_TOKEN = 'ts_ord_warehouse_003_demo8f';

const trackingShares = new Map<string, TrackingShareRecord>();
const trackingShareReplays = new Map<string, string>();

/** Tests/dev re-seed between cases: clears the registry + per-key replays;
 * the seed is re-applied lazily on the next call (ensureSeeds, same pattern
 * as mock/splits.ts). */
function ensureTrackingShareSeeds(): void {
  if (trackingShares.has(SEED_TRACKING_SHARE_TOKEN)) return;
  trackingShares.set(SEED_TRACKING_SHARE_TOKEN, {
    token: SEED_TRACKING_SHARE_TOKEN,
    orderId: 'ord_warehouse_003',
    expiresAt: Date.now() + TRACKING_SHARE_TTL_MS,
  });
}

/** Test/dev hook: force a token past its expiry so the 410 TRIP_SHARE_EXPIRED
 * path is exercisable (same pattern as mockState.simulatePaymentFailure). */
export function expireTrackingShare(token: string): void {
  const rec = trackingShares.get(token);
  if (rec) rec.expiresAt = Date.now() - 1000;
}

/** Tests re-seed the orders module between cases (mockState reset covers the
 * shared store; this clears the module-local modification requests + tip
 * replays + tracking-share registry). */
export function resetMockOrdersState(): void {
  pendingModifications.clear();
  tipReplays.clear();
  trackingShares.clear();
  trackingShareReplays.clear();
}

export class MockOrdersRepository implements OrdersRepository {
  async create(input: OrderCreateInput, idempotencyKey: string): Promise<Order> {
    const state = getState();
    const replay = state.orderReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    const merchant = findMerchant(input.merchantId);
    const items = input.items.map((i) => ({
      catalogueItemId: i.catalogueItemId,
      quantity: i.quantity,
      unitPriceTZS: i.unitPriceTZS ?? findCatalogueItem(input.merchantId, i.catalogueItemId).priceTZS,
      options: i.options,
    }));
    validateOrderInput(merchant, items, input.scheduledAt);

    // Coupon at checkout (docs/CONTRACT-ADDITIONS.md #10): the server is the
    // authority — it validates status/minimum-spend and applies the discount
    // into totals.discountTZS, then marks the coupon used. A rejected coupon
    // throws BEFORE the order exists (nothing is created, nothing is used).
    // The contract codes exist in backend/ERROR-CODES.md (Promotions and
    // coupons section); couponId itself is a mock-only field until Team 6
    // adds it to OrderCreate.
    let couponDiscountTZS = 0;
    if (input.couponId) {
      const coupon = state.coupons.find((c) => c.id === input.couponId);
      if (!coupon) throw new ApiError(404, 'COUPON_CAMPAIGN_NOT_FOUND', 'Coupon not found');
      if (coupon.status === 'expired') throw new ApiError(422, 'COUPON_EXPIRED', 'This coupon has expired');
      if (coupon.status === 'used') throw new ApiError(409, 'COUPON_ALREADY_USED', 'This coupon has already been used');
      // Subtotal including option prices — the same computation the server
      // prices in buildOrderFrom (the base price is validated there too).
      const subtotalTZS = items.reduce((acc, i) => {
        const current = findCatalogueItem(input.merchantId, i.catalogueItemId);
        const extraTZS = (i.options ?? []).reduce((a, o) => a + (optionPriceFor(current, o) ?? 0), 0);
        return acc + (i.unitPriceTZS + extraTZS) * i.quantity;
      }, 0);
      if (subtotalTZS < (coupon.minimumSpendTZS ?? 0)) {
        throw new ApiError(422, 'COUPON_MINIMUM_SPEND_NOT_MET', `Minimum spend of ${coupon.minimumSpendTZS} not met`);
      }
      couponDiscountTZS = coupon.discountTZS ?? 0;
      coupon.status = 'used';
      coupon.usedAt = nowIso();
    }

    const cod = input.paymentMethod === 'cod';
    const order = buildOrderFrom({
      merchantId: input.merchantId,
      items,
      deliveryAddress: input.deliveryAddress ?? fixtureAddress(),
      note: input.note,
      scheduledAt: input.scheduledAt ?? null,
    }, cod, couponDiscountTZS);
    state.orders.unshift(order);
    state.orderReplays.set(idempotencyKey, order);
    // Points accrual (P6d, docs/CONTRACT-ADDITIONS.md #28): the mock is the
    // server — spend points accrue when an order reaches paid+. The orders
    // mock has no status-transition surface (orders never advance past create
    // here; the payments mock flips pending_payment → paid in mock/payments.ts,
    // outside this repo's hooks), so the honest, testable point is order
    // creation at the paid status — buildOrderFrom marks COD orders paid at
    // create. Replays short-circuit above, so a retry never double-accrues
    // (the engine is also idempotent per order id).
    if (order.status === 'paid') earnOrderPoints(order, state.membership);
    if (cod) {
      const intent: OrderPaymentIntent = {
        id: uid('intent'),
        status: 'paid',
        amountTZS: order.totals.totalTZS,
        method: 'cod',
        orderId: order.id,
        providerReference: `PR-COD-${Math.floor(100000 + Math.random() * 900000)}`,
        paidAt: nowIso(),
      };
      state.intents.push(intent);
      state.intentForOrder.set(order.id, intent);
    }
    return clone(order);
  }

  async list(params?: { status?: string; cursor?: string; limit?: number }): Promise<Order[]> {
    const state = getState();
    let list = state.orders;
    if (params?.status === 'active') list = list.filter((o) => ACTIVE.includes(o.status));
    if (params?.status === 'completed') list = list.filter((o) => !ACTIVE.includes(o.status));
    const offset = params?.cursor ? Number(params.cursor) : 0;
    const limit = params?.limit ?? 20;
    return clone(list.slice(offset, offset + limit));
  }

  async get(orderId: string): Promise<OrderDetail> {
    return clone(findOrder(orderId));
  }

  async modifyRequest(orderId: string, input: OrderModificationInput, _idempotencyKey: string): Promise<RequestOrderModification202> {
    const order = findOrder(orderId);
    if (!ACTIVE.includes(order.status)) {
      throw new ApiError(409, 'ORDER_MODIFICATION_NOT_ALLOWED', 'This order can no longer be changed', false);
    }
    if (pendingModifications.has(orderId)) {
      throw new ApiError(409, 'ORDER_MODIFICATION_PENDING', 'A change request is already pending for this order', false);
    }
    const record: RequestOrderModification202 = {
      requestId: uid('mreq'),
      status: 'pending_approval',
    };
    pendingModifications.set(orderId, record);
    order.events.push({ status: order.status, at: nowIso(), by: 'customer', note: `Modification requested (${input.type})${input.note ? `: ${input.note}` : ''}` });
    return clone(record);
  }

  async tip(orderId: string, input: OrderTipInput, idempotencyKey: string): Promise<OrderDetail> {
    const replay = tipReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    // Contract-first (backend/ERROR-CODES.md "Dispatch and delivery
    // exceptions"): TIP_NOT_ALLOWED gates on completion, TIP_EXCEEDS_LIMIT
    // covers per-tip amount limits. A repeat tip on the same order is
    // CONFLICT (house precedent: mock/redPackets.ts claim).
    const order = findOrder(orderId);
    if (order.status !== 'delivered' && order.status !== 'completed') {
      throw new ApiError(409, 'TIP_NOT_ALLOWED', 'You can only tip after delivery', false);
    }
    if (!Number.isInteger(input.amountTZS) || input.amountTZS < 1) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Tip amount must be at least TZS 1');
    }
    if (!TIP_METHODS.includes(input.method)) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Unknown tip payment method');
    }
    if ((input.note?.length ?? 0) > 200) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Tip note must be 200 characters or fewer');
    }
    if (order.tipTZS !== undefined && order.tipTZS > 0) {
      throw new ApiError(409, 'CONFLICT', 'A tip has already been given for this order', false);
    }
    // Contract Order.tipTZS ("Rider tip (打赏) received on this order") — the
    // tip rides the order payload and renders in the detail screen.
    order.tipTZS = input.amountTZS;
    order.updatedAt = nowIso();
    order.events.push({ status: order.status, at: nowIso(), by: 'customer', note: `Tip TZS ${input.amountTZS}${input.note ? ` — ${input.note}` : ''}` });
    tipReplays.set(idempotencyKey, order);
    return clone(order);
  }

  async cancel(orderId: string, reason: string, _idempotencyKey: string): Promise<Order> {
    const state = getState();
    const order = findOrder(orderId);
    const idx = ['paid', 'merchant_accepted'].indexOf(order.status);
    if (idx === -1 && order.status !== 'pending_payment') {
      throw new ApiError(409, 'ORDER_NOT_CANCELLABLE', 'This order can no longer be cancelled', false);
    }
    order.status = 'cancelled';
    order.events.push({ status: 'cancelled', at: nowIso(), by: 'customer', note: reason || undefined });
    order.updatedAt = nowIso();
    const intent = state.intentForOrder.get(orderId);
    if (intent && (intent.status === 'paid' || intent.status === 'pending')) {
      intent.status = 'refunded';
      intent.providerReference = intent.providerReference ?? `PR-${Math.floor(100000 + Math.random() * 900000)}-${intent.method.toUpperCase()}`;
      intent.paidAt = intent.paidAt ?? nowIso();
    }
    return clone(order);
  }

  async rush(orderId: string, _idempotencyKey: string): Promise<void> {
    const order = findOrder(orderId);
    if (order.status !== 'merchant_accepted' && order.status !== 'preparing') {
      throw new ApiError(409, 'ORDER_RUSH_NOT_ALLOWED', 'You cannot rush this order right now', false);
    }
    order.rushRequestedAt = nowIso();
    order.events.push({ status: order.status, at: nowIso(), by: 'customer', note: 'Rush requested' });
  }

  async track(orderId: string): Promise<TrackingEvent> {
    return clone(trackFor(findOrder(orderId)));
  }

  async getRoute(orderId: string): Promise<RouteSegment[]> {
    const order = findOrder(orderId);
    if (order.fulfillmentType !== 'intercity' && order.fulfillmentType !== 'relay') {
      throw new ApiError(404, 'ROUTE_NOT_FOUND', 'No route for this order yet');
    }
    const state = getState();
    return clone(state.routes.get(orderId) ?? []);
  }

  async getWaybill(orderId: string): Promise<GetOrderWaybill200> {
    const order = findOrder(orderId);
    if (!order.waybillNumber) {
      throw new ApiError(404, 'NOT_FOUND', 'No waybill for this order yet');
    }
    const state = getState();
    return clone(state.waybills.get(orderId) ?? { waybillNumber: order.waybillNumber, events: [] });
  }

  async getTrackingPhases(orderId: string): Promise<TrackingPhase[]> {
    findOrder(orderId);
    return clone(phaseForOrder(findOrder(orderId)));
  }

  /** Mock-only until the contract carries deliveryWindowFrom/To on order and
   * tracking payloads (CONTRACT-ADDITIONS.md #5): the seeded window rides the
   * mock route payload; orders without one (local, relay) → null. */
  async getDeliveryWindow(orderId: string): Promise<DeliveryWindow | null> {
    findOrder(orderId);
    const first = getState().routes.get(orderId)?.[0];
    if (!first?.deliveryWindowFrom || !first.deliveryWindowTo) return null;
    return { from: first.deliveryWindowFrom, to: first.deliveryWindowTo };
  }

  /** Mock-only until the contract carries originCityName/destinationCityName
   * on the tracking payload (CONTRACT-ADDITIONS.md #5): seeded for the
   * intercity route only; everything else → null. */
  async getRouteCities(orderId: string): Promise<RouteCities | null> {
    findOrder(orderId);
    const first = getState().routes.get(orderId)?.[0];
    if (!first?.originCityName || !first.destinationCityName) return null;
    return { origin: first.originCityName, destination: first.destinationCityName };
  }

  async createMaskedCall(orderId: string, _idempotencyKey: string): Promise<MaskedCallSession> {
    findOrder(orderId);
    return {
      sessionId: `msc_${Math.random().toString(36).slice(2, 10)}`,
      orderId,
      maskedNumber: '+2557******00',
      direction: 'customer_to_rider',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
  }

  /** Mock-only until the contract ships a consumer tracking-share surface
   * (docs/CONTRACT-ADDITIONS.md #27, OPERATIONS-COVERAGE #77): POST
   * /orders/{id}/tracking-share. The mock is the token authority — it
   * validates the order (404 ORDER_NOT_FOUND), issues ts_{order}_{randoms}
   * with a 2h expiry (TRACKING_SHARE_TTL_MS) and replays the stored token for
   * a repeated idempotency key. */
  async createTrackingShare(orderId: string, idempotencyKey: string): Promise<TrackingShare> {
    ensureTrackingShareSeeds();
    const replayToken = trackingShareReplays.get(idempotencyKey);
    if (replayToken) {
      const rec = trackingShares.get(replayToken);
      if (rec) return { token: rec.token, expiresAt: new Date(rec.expiresAt).toISOString() };
    }
    findOrder(orderId);
    const token = `ts_${orderId}_${Math.random().toString(36).slice(2, 10)}`;
    const expiresAt = Date.now() + TRACKING_SHARE_TTL_MS;
    trackingShares.set(token, { token, orderId, expiresAt });
    trackingShareReplays.set(idempotencyKey, token);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Mock-only path GET /tracking-share/{token} (#27): unknown token →
   * 404 NOT_FOUND; expired token → 410 TRIP_SHARE_EXPIRED (the ERROR-CODES.md
   * trip-share code — no 4xx "Gone" code exists in the registry, so the
   * documented 410 status rides the existing code). */
  async resolveTrackingShare(token: string): Promise<{ orderId: string } | null> {
    ensureTrackingShareSeeds();
    const rec = trackingShares.get(token);
    if (!rec) throw new ApiError(404, 'NOT_FOUND', 'Unknown tracking share token');
    if (Date.now() > rec.expiresAt) {
      throw new ApiError(410, 'TRIP_SHARE_EXPIRED', 'This tracking share link has expired', false);
    }
    return { orderId: rec.orderId };
  }
}
