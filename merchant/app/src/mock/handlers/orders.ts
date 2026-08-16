import type {
  AuditLog,
  CampaignDto,
  DamageClaimDto,
  EnterpriseOrderDto,
  FareBreakdownDto,
  HandoffDto,
  MaskedCallSessionDto,
  NotificationDto,
  OrderDto,
  OrderTimelineEventDto,
  Payment,
  ProductRow,
  ProofOfDeliveryDto,
  ReceiptRowDto,
  Refund,
  RouteSegmentDto,
  RushOrderDto,
  StoreServer,
  TrackingEventDto,
  TrackingPhaseDto,
  WaybillDto,
  WaybillEventDto,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, ok, pii, requirePerm, requireSession } from '@/mock/security';
import type { Session } from '@/mock/types-internal';
import {
  ApiHttpError,
  applyTransition,
  getMerchant,
  h,
  idemGet,
  idemKey,
  idemSet,
  INTERNAL_KEY,
  json,
  readJson,
  requireInternal,
} from '@/mock/handlers/common';

const CUSTOMERS = [
  { name: 'David Zhang', phone: '138****2210', address: 'Wangjing SOHO Tower 1, Floor 12' },
  { name: 'Lily Li', phone: '159****8843', address: '6 Fudong East Street' },
  { name: 'Kevin Wang', phone: '186****5329', address: '27 Zhongguancun Ave, Haidian' },
  { name: 'Mia Zhao', phone: '137****9076', address: 'Wangjing West 4th District' },
  { name: 'Emma Chen', phone: '139****6721', address: '10 Jiuxianqiao Rd' },
  { name: 'Frank Yang', phone: '187****1198', address: 'Huaqing Jiayuan, Wudaokou' },
];

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));

function nextOrderNo(): string {
  const orders = db.table<OrderDto>('orders').all();
  const max = orders.reduce((m, o) => Math.max(m, Number(o.no.replace('MT', '')) || 88000), 88000);
  return `MT${max + 1}`;
}

function notify(merchantId: string, n: Omit<NotificationDto, 'id' | 'merchantId' | 'ts' | 'read'>) {
  const note: NotificationDto = { ...n, id: uid('n'), merchantId, ts: Date.now(), read: false };
  db.table<NotificationDto>('notifications').insert(note);
  emit({ type: 'notification.created', notification: note, at: Date.now() });
}

function upsertOrder(o: OrderDto) {
  emit({ type: 'order.updated', order: o, at: Date.now() });
  return o;
}

/** Refund a captured payment for real: payment state, ledger debit, refund record. */
export function refundPayment(order: OrderDto, reason: string, reasonCode: string, decidedBy?: string) {
  const refund: Refund = {
    id: `rf_${order.id}`,
    merchantId: order.merchantId,
    orderId: order.id,
    paymentId: order.paymentId,
    amount: order.total,
    reason,
    reasonCode,
    status: 'approved',
    decidedBy,
    decidedAt: Date.now(),
    createdAt: Date.now(),
    ts: Date.now(),
  };
  const existing = db.table<Refund>('refunds').find(refund.id);
  if (existing) return; // already refunded — never double-debit
  const pay = db.table<Payment>('payments').find(order.paymentId);
  if (!pay || pay.status !== 'captured') return; // nothing captured — nothing to refund
  db.table<Refund>('refunds').insert(refund);
  if (pay) {
    db.table<Payment>('payments').update(pay.id, {
      status: 'refunded',
      refundedAmount: pay.refundedAmount + refund.amount,
      refunds: [...pay.refunds, refund.id],
    });
    emit({ type: 'payment.captured', payment: { ...pay, status: 'refunded' as const, refunds: [...pay.refunds, refund.id] }, at: Date.now() });
  }
  db.table('ledger').insert({
    id: uid('l'),
    merchantId: order.merchantId,
    type: 'refund',
    amount: -refund.amount,
    title: `Refund ${order.no} (${reasonCode})`,
    ts: Date.now(),
    status: 'completed',
    refType: 'order',
    refId: order.id,
  });
  // Merge against the FRESH row — the caller's object may be stale (e.g. an
  // auto-cancel timeline event added after the caller captured the reference).
  const fresh = db.table<OrderDto>('orders').find(order.id);
  if (!fresh) return;
  db.table<OrderDto>('orders').update(fresh.id, {
    refund: { ts: refund.createdAt, reason, amount: refund.amount, status: 'approved' },
    version: fresh.version + 1,
    timeline: [...(fresh.timeline ?? []), { event: 'refund-approved', ts: Date.now(), actor: decidedBy ?? 'system' }],
  });
}

/* ---------------- Customer platform: create order ---------------- */

function createPayment(order: OrderDto) {
  const store = db.table<StoreServer>('stores').find(order.storeId);
  const pm: Partial<StoreServer['paymentMethods']> = store?.paymentMethods ?? {};
  const method: Payment['method'] = pm.mpesa ? 'mpesa' : pm.airtel_money ? 'airtel_money' : 'mpesa';
  const pay: Payment = {
    id: `pay_${order.id}`,
    merchantId: order.merchantId,
    orderId: order.id,
    amount: order.total,
    method,
    provider: method === 'mpesa' ? 'mock-mpesa' : 'mock-airtel-money',
    status: 'pending',
    idempotencyKey: `pay-${order.id}`,
    createdAt: Date.now(),
    refundedAmount: 0,
    refunds: [],
  };
  db.table<Payment>('payments').insert(pay);
  setTimeout(() => {
    const current = db.table<Payment>('payments').find(pay.id);
    if (current && current.status === 'pending') {
      db.table<Payment>('payments').update(pay.id, { status: 'captured', capturedAt: Date.now() });
      emit({ type: 'payment.captured', payment: { ...current, status: 'captured' as const }, at: Date.now() });
    }
  }, 1800 + rand(0, 2500));
  return pay;
}

function buildOrderFromBody(body: Record<string, unknown>, actor: string): OrderDto {
  const products = db.table<ProductRow>('products');
  const store = db.table('stores').find('s_demo')!;
  const id = uid('o');
  const createdAt = Date.now();
  const preorder = !!body.scheduledAt;
  const scheduledAt = preorder ? Number(body.scheduledAt) : undefined;
  if (preorder && !store.orderSettings.preOrderEnabled) throw new ApiHttpError(409, 'PREORDERS_DISABLED', 'Pre-orders are currently disabled');
  if ((store.orderSettings?.requireNotes ?? 'optional') === 'required' && !String(body.note ?? '').trim()) {
    throw new ApiHttpError(400, 'NOTE_REQUIRED', 'Order notes are required by this store');
  }
  const autoCancelMinutes = store.orderSettings?.autoCancelMinutes ?? 5;

  const items = (body.items as { productId: string; qty: number; variants?: string[] }[]).map((it) => {
    const p = products.find(it.productId);
    if (!p) throw new ApiHttpError(400, 'BAD_PRODUCT', `Unknown product ${it.productId}`);
    if (p.stock <= 0 && !preorder) throw new ApiHttpError(409, 'OUT_OF_STOCK', `${p.name} is out of stock`);
    const variant = p.variants.find((v) => it.variants?.includes(v.name));
    return {
      productId: p.id,
      name: p.name,
      emoji: p.emoji,
      qty: Math.max(1, Math.min(9, it.qty)),
      price: variant ? p.price + variant.price : p.price,
      variants: variant ? [variant.name] : [],
    };
  });
  const subtotal = Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;
  if (subtotal < store.minOrder) throw new ApiHttpError(409, 'BELOW_MIN_ORDER', `Minimum order is ¥${store.minOrder}`);
  const deliveryType = body.deliveryType === 'pickup' ? 'pickup' : 'delivery';
  const freeDelivery = deliveryType === 'delivery' && (store.freeDeliveryThreshold ?? 0) > 0 && subtotal >= (store.freeDeliveryThreshold ?? 0);
  const deliveryFee = deliveryType === 'delivery' && !freeDelivery ? store.deliveryFee : 0;
  return {
    id,
    merchantId: store.merchantId,
    storeId: store.id,
    no: nextOrderNo(),
    status: 'new',
    version: 1,
    items,
    customer: CUSTOMERS[rand(0, CUSTOMERS.length)],
    note: String(body.note ?? ''),
    deliveryType,
    subtotal,
    deliveryFee,
    freeDelivery,
    total: Math.round((subtotal + deliveryFee) * 100) / 100,
    createdAt,
    deadlineAt: scheduledAt ?? createdAt + autoCancelMinutes * 60000,
    scheduledAt,
    seen: false,
    paymentId: '',
    deliveryEtaMin: store.deliveryEtaMin ?? 30,
    timeline: [{ event: 'created', ts: createdAt, actor }],
  };
}

/** Server-driven accept: status guard, stock check, transition, stock decrement, audit.
 *  Contract sequence: `new` → `merchant_accepted` (accepted, waiting for prep start)
 *  → `preparing`. The merchant app's accept action moves through the intermediate
 *  state; the timeline records the `accepted` step (mapped to merchant_accepted)
 *  and the row lands on `preparing` in ONE version bump, so replay semantics and
 *  version-optimistic concurrency stay unchanged for existing clients. */
export function performAccept(orderId: string, actorId: string, actorRole: string, actorName?: string): OrderDto | null {
  const order = db.table<OrderDto>('orders').find(orderId);
  if (!order) return null;
  // Idempotent replay: already accepted (or awaiting prep start) — never touch stock twice.
  if (order.status === 'preparing' || order.status === 'merchant_accepted') return order;
  // Stock check before accepting: never accept what we cannot fulfill.
  const products = db.table<ProductRow>('products');
  const short: string[] = [];
  for (const item of order.items) {
    const p = products.find(item.productId);
    if (p && p.stock < item.qty) short.push(`${p.name} (have ${p.stock}, need ${item.qty})`);
  }
  if (short.length) {
    throw new ApiHttpError(409, 'OUT_OF_STOCK', `Cannot accept ${order.no}: out of stock — ${short.join(', ')}`, false, { items: short });
  }
  const now = Date.now();
  const timeline = [
    ...(order.timeline ?? []),
    { event: 'accepted', ts: now, actor: actorId },
    { event: 'preparing', ts: now, actor: actorId },
  ];
  const updated = db
    .table<OrderDto>('orders')
    .update(order.id, { status: 'preparing', acceptedAt: now, seen: true, version: order.version + 1, timeline })!;
  emit({ type: 'order.updated', order: updated, at: now });
  for (const item of order.items) {
    const p = products.find(item.productId);
    if (p) products.update(p.id, { stock: Math.max(0, p.stock - item.qty), sold: p.sold + item.qty });
  }
  audit(order.merchantId, actorId, actorRole, 'orders:accept', 'order', order.id, `accepted ${order.no}${actorName ? ` by ${actorName}` : ''}`);
  return db.table<OrderDto>('orders').find(order.id)!;
}

/* ---------------- P2: orders ops (contract /orders*, /refunds*) ---------------- */

const ORDER_ISSUE_REASONS = [
  'customer_not_reachable',
  'wrong_address',
  'customer_refused',
  'items_damaged',
  'package_missing',
  'seal_broken',
  'delivery_area_restricted',
  'other',
];

/** Merchant-owned order lookup (404 for missing/foreign rows). */
function ownOrder(session: Session, id: string): OrderDto {
  const order = db.table<OrderDto>('orders').find(id);
  if (!order || order.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Order not found');
  return order;
}

/** App timeline rows -> contract OrderEvent[] (GET /orders/{orderId}/timeline). */
const TIMELINE_STATUS: Record<string, string> = {
  created: 'paid',
  accepted: 'merchant_accepted',
  preparing: 'preparing',
  ready: 'picked_up',
  delivered: 'delivered',
  cancelled: 'cancelled',
  disputed: 'disputed',
  'rush-requested': 'paid',
  'rush-replied': 'preparing',
  'refund-requested': 'refunded',
  'refund-approved': 'refunded',
  'refund-declined': 'refunded',
  held: 'preparing',
  unheld: 'preparing',
  rescheduled: 'rescheduled',
  'transfer-requested': 'preparing',
  'tip-added': 'completed',
  'failed-delivery': 'failed_delivery',
  'advance-handoff': 'preparing',
  'modify-requested': 'preparing',
};

/** Raw timeline actor -> human role label (ORDER-FLOW.md:16 — timeline `by` is a
 *  role, never a raw staff id). Staff rows resolve to owner/manager/cashier/
 *  kitchen/waiter via the staff roster; system/rider/customer are contract roles. */
function timelineActorLabel(actor: string): string {
  if (!actor) return 'system';
  if (actor === 'customer-platform' || actor.startsWith('customer')) return 'customer';
  if (actor === 'system-auto-cancel' || actor === 'system-auto' || actor === 'system') return 'system';
  if (actor === 'rider' || actor.startsWith('r_')) return 'rider';
  const legacy = db.table<{ id: string; role: string }>('staff').find(actor);
  if (legacy) return legacy.role === 'staff' ? 'merchant' : legacy.role;
  const roster = db.table<{ id: string; role: string }>('merchantStaff').find(actor);
  if (roster) return roster.role;
  return 'merchant';
}

/** Server-computed cancellation fee (ORDER-FLOW.md): 0 before merchant acceptance;
 *  after acceptance an applicable fee applies (integer TZS, informational). */
function cancelFeeFor(order: OrderDto): number {
  if (order.status === 'new' || order.status === 'cancelled' || order.status === 'refunded' || order.status === 'completed' || order.status === 'failed' || order.status === 'disputed') return 0;
  // 10% of the order total, never above the total itself (demo orders are small).
  return Math.max(0, Math.min(Math.round(Math.round(order.total) * 0.1), Math.round(order.total)));
}

export function orderTimelineEvents(order: OrderDto): OrderTimelineEventDto[] {
  const rows = order.timeline ?? [];
  const events: OrderTimelineEventDto[] = rows.map((ev) => ({
    status: (TIMELINE_STATUS[ev.event] ?? 'paid') as OrderTimelineEventDto['status'],
    at: ev.ts,
    by: timelineActorLabel(ev.actor),
    note: ev.event === 'cancelled' ? order.cancelReason : undefined,
  }));
  if (!events.length) {
    events.push({ status: 'paid', at: order.createdAt, by: 'customer' });
    if (order.acceptedAt) events.push({ status: 'merchant_accepted', at: order.acceptedAt, by: 'merchant' });
    if (order.readyAt) events.push({ status: 'picked_up', at: order.readyAt, by: 'merchant' });
    if (order.completedAt) events.push({ status: 'delivered', at: order.completedAt, by: 'rider' });
  }
  return events;
}

/** Order route — stored routeSegments or a deterministic default (last mile). */
function orderRoute(order: OrderDto): RouteSegmentDto[] {
  if (order.routeSegments?.length) return order.routeSegments;
  const inFlight = order.status === 'ready' || order.status === 'completed';
  const completed = order.status === 'completed';
  return [
    {
      legId: `leg_${order.id}_1`,
      sequence: 1,
      type: 'last_mile',
      mode: 'motorcycle',
      handledBy: order.riderId ?? 'rider',
      status: completed ? 'completed' : inFlight ? 'in_progress' : 'pending',
      plannedStartAt: order.readyAt,
      plannedEndAt: order.completedAt ?? (order.readyAt ? order.readyAt + 45 * 60000 : null),
      etaAt: order.completedAt ?? (order.readyAt ? order.readyAt + 45 * 60000 : null),
      startedAt: order.readyAt,
      completedAt: order.completedAt,
    },
  ];
}

/** Contract status mapping for merchant-visible orders. */
const CONTRACT_STATUS: Record<string, string> = {
  new: 'paid',
  merchant_accepted: 'merchant_accepted',
  preparing: 'preparing',
  ready: 'picked_up',
  completed: 'delivered',
  cancelled: 'cancelled',
  refunded: 'refunded',
  failed: 'failed',
  disputed: 'disputed',
};

function contractStatus(order: OrderDto): TrackingEventDto['status'] {
  return (CONTRACT_STATUS[order.status] ?? order.status) as TrackingEventDto['status'];
}

/** Live tracking payload (GET /orders/{orderId}/track). */
function trackingEvent(order: OrderDto): TrackingEventDto {
  const rider = db.table<{ id: string; lat: number; lng: number; updatedAt: number }>('riders').find(order.riderId ?? '');
  const eta = order.deliveryEtaMin ?? 30;
  return {
    status: contractStatus(order),
    riderLocation: rider ? { lat: rider.lat, lon: rider.lng } : undefined,
    updatedAt: order.completedAt ?? order.readyAt ?? order.createdAt,
    estimateMinutes: order.status === 'completed' ? 0 : eta,
    stageEtas:
      order.status === 'ready'
        ? { merchantArrival: null, pickup: Math.round(eta / 2), dropoff: eta }
        : { merchantArrival: null, pickup: null, dropoff: order.status === 'completed' ? 0 : eta },
  };
}

/** Logical phases (GET /orders/{orderId}/tracking-phases). */
function trackingPhases(order: OrderDto): TrackingPhaseDto[] {
  const ready = order.status === 'ready' || order.status === 'completed';
  const done = order.status === 'completed';
  return [
    { phase: 'confirmed', label: 'Order confirmed', status: 'completed', at: order.createdAt, eta: null },
    { phase: 'picked_up', label: 'Picked up from merchant', status: ready ? 'completed' : 'pending', at: ready ? (order.readyAt ?? order.acceptedAt) : null, eta: null },
    { phase: 'in_transit', label: 'In transit', status: done ? 'completed' : ready ? 'active' : 'pending', at: done ? (order.completedAt ?? order.readyAt) : null, eta: order.deliveryEtaMin ?? null },
    { phase: 'arrived_city', label: 'Arrived in your city', status: 'pending', at: null, eta: null },
    { phase: 'out_for_delivery', label: 'Out for delivery', status: done ? 'completed' : ready ? 'active' : 'pending', at: done ? (order.completedAt ?? order.readyAt) : null, eta: order.deliveryEtaMin ?? null },
    { phase: 'delivered', label: 'Delivered', status: done ? 'completed' : 'pending', at: order.completedAt ?? null, eta: done ? order.completedAt : null },
  ];
}

/** Scan/event trail (GET /orders/{orderId}/waybill). */
function orderWaybill(order: OrderDto): WaybillDto {
  const events: WaybillEventDto[] = [
    { at: order.createdAt, type: 'scanned', location: 'Merchant', actor: 'merchant', note: `${order.no} manifested` },
  ];
  if (order.acceptedAt) events.push({ at: order.acceptedAt, type: 'loaded', location: 'Merchant', actor: 'merchant', note: 'Accepted and packed' });
  if (order.readyAt) events.push({ at: order.readyAt, type: 'departed', location: 'Merchant pickup', actor: 'rider', note: null });
  if (order.completedAt) events.push({ at: order.completedAt, type: 'delivered', location: 'Customer', actor: 'rider', note: null });
  for (const leg of order.routeSegments ?? []) {
    if (leg.startedAt) events.push({ at: leg.startedAt, type: 'arrived', location: `Leg ${leg.sequence}`, actor: 'rider', note: null });
    if (leg.completedAt) events.push({ at: leg.completedAt, type: 'handoff', location: `Leg ${leg.sequence}`, actor: 'rider', note: null });
  }
  events.sort((a, b) => a.at - b.at);
  return { waybillNumber: order.waybillNumber ?? `WB-${order.no}`, events };
}

/** Rider fare (GET /orders/{orderId}/fare) — integer TZS. */
function fareBreakdown(order: OrderDto): FareBreakdownDto {
  const baseTZS = 2000;
  const distanceTZS = 1500;
  const timeTZS = 500;
  const codFeeTZS = order.deliveryType === 'pickup' ? 0 : 500;
  const tipTZS = order.tipTZS ?? 0;
  return {
    orderId: order.id,
    baseTZS,
    distanceTZS,
    timeTZS,
    surgeMultiplier: 1.0,
    surgeTZS: 0,
    tipTZS,
    codFeeTZS,
    waitPayTZS: 0,
    bonusTZS: 0,
    totalTZS: baseTZS + distanceTZS + timeTZS + codFeeTZS + tipTZS,
    currency: 'TZS',
  };
}

/** P2: shared cancel/reject mutation (refund on captured payment, honest notify). */
function performCancel(session: Session, order: OrderDto, reason: string): OrderDto {
  if (order.status === 'cancelled') return order; // idempotent replay — no double refund
  const pay = db.table<Payment>('payments').find(order.paymentId ?? '');
  const captured = pay?.status === 'captured';
  applyTransition(order, 'cancelled', session.staffId, { cancelReason: reason, cancelledAt: Date.now(), seen: true }, 'cancelled');
  if (captured) refundPayment(order, reason, 'MERCHANT_CANCEL', session.staffId);
  notify(order.merchantId, {
    type: 'order',
    title: `Order ${order.no} cancelled`,
    body: captured ? `Customer refunded ${order.total.toFixed(2)} TZS · reason: ${reason}` : `No charge was made · reason: ${reason}`,
    orderId: order.id,
  });
  audit(order.merchantId, session.staffId, session.role, 'orders:cancel', 'order', order.id, `cancelled ${order.no} (${reason})${captured ? ' — refunded' : ' — no charge'}`);
  const updated = db.table<OrderDto>('orders').find(order.id)!;
  emit({ type: 'orders.cancelled', order: updated, at: Date.now() });
  return updated;
}

/** App order row -> contract Order shape (adds integer-TZS PriceBreakdown). */
function toContractOrder(o: OrderDto) {
  return {
    ...o,
    totals: {
      subtotalTZS: Math.round(o.subtotal),
      deliveryFeeTZS: Math.round(o.deliveryFee),
      platformFeeTZS: 0,
      taxTZS: 0,
      discountTZS: 0,
      totalTZS: Math.round(o.total),
    },
    cancelFeeTZS: cancelFeeFor(o),
  };
}

/** Default merchant route for new orders (used by handoff + leg advance). */
function ensureRouteSegments(order: OrderDto): RouteSegmentDto[] {
  if (order.routeSegments?.length) return order.routeSegments;
  const segments = orderRoute(order);
  db.table<OrderDto>('orders').update(order.id, { routeSegments: segments });
  return segments;
}

export const orderHandlers = [
  /* ---- List orders (merchant session OR internal customer-platform) ---- */
  h.get('/api/orders', ({ request }) => {
    const internal = request.headers.get('x-internal-key');
    const session = internal === INTERNAL_KEY ? undefined : requireSession(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const storeId = url.searchParams.get('storeId');
    const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 100));
    const m = session ? getMerchant(session) : 'm_demo';
    let list = db.table<OrderDto>('orders').where((o) => o.merchantId === m);
    if (storeId) list = list.filter((o) => o.storeId === storeId);
    if (status) list = list.filter((o) => o.status === status);
    if (q) {
      list = list.filter(
        (o) =>
          o.no.toLowerCase().includes(q) ||
          o.customer.name.toLowerCase().includes(q) ||
          o.customer.phone.includes(q) ||
          o.items.some((i) => i.name.toLowerCase().includes(q)),
      );
    }
    list = [...list].sort((a, b) => b.createdAt - a.createdAt);
    return ok({ orders: list.slice(0, limit).map((o) => ({ ...o, cancelFeeTZS: cancelFeeFor(o) })), total: list.length });
  }),

  /* ---- Receipts — batch print preview (?ids=, app extension) OR the contract
       reprint list (GET /orders/receipts → [{orderId, printedAt, jobId}]) ---- */
  h.get('/api/orders/receipts', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
    if (ids.length) {
      if (!ids.length) throw new ApiHttpError(400, 'IDS_REQUIRED', 'Select at least one order to print');
      const store = db.table('stores').find('s_demo');
      const receipts = ids
        .map((id) => db.table<OrderDto>('orders').find(id))
        .filter((o): o is OrderDto => !!o && o.merchantId === session.merchantId)
        .map((o) => ({
          order: o,
          payment: db.table<Payment>('payments').find(o.paymentId ?? ''),
          store: store ? { id: store.id, name: store.name, phone: store.phone, address: store.address } : undefined,
        }));
      if (receipts.length) {
        audit(session.merchantId, session.staffId, session.role, 'orders:print', 'receipt', receipts.map((r) => r.order.id).join(','), `printed ${receipts.length} receipt(s)`);
      }
      return ok({ receipts });
    }
    // Contract shape: recently printed receipts (rows recorded when a receipt
    // print job completes — see src/mock/sweeper.ts print-job lifecycle).
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
    const rows = db
      .table<ReceiptRowDto & { merchantId: string; id: string }>('orderReceipts')
      .where((r) => r.merchantId === session.merchantId)
      .sort((a, b) => b.printedAt - a.printedAt)
      .slice(0, limit)
      .map(({ merchantId: _m, id: _i, ...row }) => row);
    return ok(rows);
  }),

  /* ---- Reject reasons catalog ---- */
  h.get('/api/orders/reject-reasons', ({ request }) => {
    requireSession(request);
    return ok({
      reasons: [
        { code: 'STORE_BUSY', label: 'Store too busy' },
        { code: 'OUT_OF_INGREDIENTS', label: 'Out of ingredients' },
        { code: 'CLOSING_SOON', label: 'Closing soon' },
        { code: 'DRIVER_UNAVAILABLE', label: 'Driver unavailable' },
        { code: 'OTHER', label: 'Other' },
      ],
    });
  }),

  /* ---- GET /orders/me — merchant list (contract: bare Order[] + cursor pagination) ---- */
  h.get('/api/orders/me', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
    const offset = Math.max(0, Number(url.searchParams.get('cursor') ?? 0));
    let list = db.table<OrderDto>('orders').where((o) => o.merchantId === session.merchantId);
    if (status && status !== 'all') list = list.filter((o) => o.status === status);
    list = [...list].sort((a, b) => b.createdAt - a.createdAt);
    return ok(list.slice(offset, offset + limit).map(toContractOrder));
  }),
  /* ---- GET /orders/search — keyword/status/date/customer search ---- */
  h.get('/api/orders/search', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (q.length > 120) throw new ApiHttpError(400, 'ORDER_SEARCH_INVALID', 'Search query too long (max 120)');
    const status = url.searchParams.get('status');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const customerPhone = (url.searchParams.get('customerPhone') ?? '').trim();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
    const offset = Math.max(0, Number(url.searchParams.get('cursor') ?? 0));
    const fromMs = from ? new Date(`${from}T00:00:00`).getTime() : 0;
    const toMs = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
    if ((from && !Number.isFinite(fromMs)) || (to && !Number.isFinite(toMs))) throw new ApiHttpError(400, 'ORDER_SEARCH_INVALID', 'Malformed date filter');
    let list = db.table<OrderDto>('orders').where((o) => o.merchantId === session.merchantId);
    if (status && status !== 'all') list = list.filter((o) => o.status === status);
    if (fromMs || toMs !== Infinity) list = list.filter((o) => o.createdAt >= fromMs && o.createdAt <= toMs);
    if (customerPhone) list = list.filter((o) => o.customer.phone.includes(customerPhone));
    if (q) {
      list = list.filter(
        (o) =>
          o.no.toLowerCase().includes(q) ||
          o.customer.name.toLowerCase().includes(q) ||
          o.customer.phone.includes(q) ||
          o.items.some((i) => i.name.toLowerCase().includes(q)),
      );
    }
    list = [...list].sort((a, b) => b.createdAt - a.createdAt);
    return ok(list.slice(offset, offset + limit).map(toContractOrder));
  }),
  /* ---- GET /orders/enterprise — B2B/corporate orders ---- */
  h.get('/api/orders/enterprise', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
    const offset = Math.max(0, Number(url.searchParams.get('cursor') ?? 0));
    let list = db.table<OrderDto>('orders').where((o) => o.merchantId === session.merchantId && !!o.enterprise);
    if (status && status !== 'all') list = list.filter((o) => o.status === status);
    const rows: EnterpriseOrderDto[] = [...list]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(offset, offset + limit)
      .map((o) => ({ ...toContractOrder(o), companyName: o.enterprise?.companyName ?? '', costCenter: o.enterprise?.costCenter ?? null, billingRef: o.enterprise?.billingRef ?? null }));
    return ok(rows);
  }),
  /* ---- GET /orders/rush — rush (hurry-up) queue ---- */
  h.get('/api/orders/rush', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status') ?? 'open';
    const terminal = (o: OrderDto) => o.status === 'completed' || o.status === 'cancelled';
    const rows: RushOrderDto[] = db
      .table<OrderDto>('orders')
      .where((o) => o.merchantId === session.merchantId && !!o.rushAt && (status === 'all' || ((status === 'open' ? !o.rushReplied && !terminal(o) : status === 'replied' ? !!o.rushReplied && !terminal(o) : terminal(o)))))
      .sort((a, b) => (a.rushAt ?? 0) - (b.rushAt ?? 0))
      .map((o) => {
        const dwell = Date.now() - (o.rushAt ?? o.createdAt);
        const urgency = dwell < 2 * 60000 ? 'low' : dwell < 5 * 60000 ? 'medium' : dwell < 10 * 60000 ? 'high' : 'critical';
        return {
          orderId: o.id,
          urgency,
          status: terminal(o) ? 'resolved' : o.rushReplied ? 'replied' : 'open',
          requestedAt: o.rushAt ?? o.createdAt,
          repliedAt: o.rushReplied ? (o.timeline?.find((e) => e.event === 'rush-replied')?.ts ?? null) : null,
          replyMessage: (o as OrderDto & { replyMessage?: string }).replyMessage ?? null,
        } satisfies RushOrderDto;
      });
    return ok(rows);
  }),
  /* ---- GET /orders/issue-reasons — rider order-issue reason catalog ---- */
  h.get('/api/orders/issue-reasons', ({ request }) => {
    requireSession(request);
    return ok(ORDER_ISSUE_REASONS);
  }),
  /* ---- GET /orders/me/advance?date= — scheduled orders for the merchant day ---- */
  h.get('/api/orders/me/advance', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const date = url.searchParams.get('date');
    if (!date) throw new ApiHttpError(400, 'DATE_REQUIRED', 'date query param is required (YYYY-MM-DD)');
    const dayStart = new Date(`${date}T00:00:00`).getTime();
    const dayEnd = dayStart + 86400000 - 1;
    if (!Number.isFinite(dayStart)) throw new ApiHttpError(400, 'DATE_REQUIRED', 'Malformed date');
    const rows = db
      .table<OrderDto>('orders')
      .where((o) => o.merchantId === session.merchantId && !!o.scheduledAt && o.scheduledAt >= dayStart && o.scheduledAt <= dayEnd)
      .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
    return ok(rows.map(toContractOrder));
  }),
  /* ---- Print jobs history ---- */
  h.get('/api/orders/print-jobs', ({ request }) => {
    const session = requireSession(request);
    const jobs = db
      .table<AuditLog>('auditLogs')
      .where((a) => a.merchantId === session.merchantId && a.action === 'orders:print')
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 50)
      .map((a) => ({ ts: a.ts, actor: a.actor, role: a.role, detail: a.detail, resourceId: a.resourceId }));
    return ok({ jobs });
  }),

  /* ---- Order detail (includes payment + store info) ---- */
  h.get('/api/orders/:id', ({ request, params }) => {
    const session = requireSession(request);
    const order = db.table<OrderDto>('orders').find(String(params.id));
    if (!order || order.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Order not found');
    const payment = db.table<Payment>('payments').find(order.paymentId ?? '');
    const store = db.table('stores').find(order.storeId);
    return ok({
      order: {
        ...order,
        cancelFeeTZS: cancelFeeFor(order),
        payment: payment
          ? { id: payment.id, method: payment.method, provider: payment.provider, status: payment.status, capturedAt: payment.capturedAt, refundedAmount: payment.refundedAmount }
          : undefined,
      },
      store: store ? { name: store.name, phone: store.phone, address: store.address } : undefined,
    });
  }),

  /* ---- Customer platform: create order (internal) ---- */
  h.post('/api/orders', async ({ request }) => {
    const { actor } = requireInternal(request);
    const store = db.table<StoreServer>('stores').find('s_demo')!;
    const body = await readJson(request);
    if (!store.open && !(store.orderSettings.acceptWhileClosed === true && !!body.scheduledAt)) {
      throw new ApiHttpError(409, 'STORE_CLOSED', 'Store is currently closed — orders cannot be placed');
    }
    const order = buildOrderFromBody(body, actor);
    db.table<OrderDto>('orders').insert(order);
    const best = db
      .table<CampaignDto>('campaigns')
      .where((c) => c.merchantId === order.merchantId && c.status === 'active' && c.end > Date.now())
      .sort((a, b) => b.spent - a.spent)[0];
    if (best) {
      db.table<CampaignDto>('campaigns').update(best.id, {
        attributedOrders: (best.attributedOrders ?? 0) + 1,
        attributedRevenue: Math.round(((best.attributedRevenue ?? 0) + order.total) * 100) / 100,
      });
    }
    const pay = createPayment(order);
    db.table<OrderDto>('orders').update(order.id, { paymentId: pay.id });
    notify(order.merchantId, {
      type: 'order',
      title: `New order ${order.no}`,
      body: `${order.items.map((i) => `${i.name} ×${i.qty}`).join(', ')} · ¥${order.total.toFixed(2)}`,
      orderId: order.id,
    });
    emit({ type: 'order.created', order: { ...order, paymentId: pay.id }, at: Date.now() });
    return ok({ order: { ...order, paymentId: pay.id }, payment: pay });
  }),

  /* ---- Merchant: batch accept (registered before :id POST handlers) ---- */
  h.post('/api/orders/batch/accept', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:accept');
    const body = await readJson(request);
    const ids = (Array.isArray(body.ids) ? (body.ids as unknown[]).map(String).filter(Boolean) : []).slice(0, 50);
    if (!ids.length) throw new ApiHttpError(400, 'IDS_REQUIRED', 'Select at least one order to accept');
    const accepted: { id: string; order: OrderDto }[] = [];
    const failed: { id: string; code: string }[] = [];
    for (const id of ids) {
      try {
        const order = performAccept(id, session.staffId, session.role);
        if (!order) failed.push({ id, code: 'NOT_FOUND' });
        else accepted.push({ id, order });
      } catch (e) {
        failed.push({ id, code: e instanceof ApiHttpError ? e.code : 'INTERNAL' });
      }
    }
    audit(
      session.merchantId,
      session.staffId,
      session.role,
      'orders:accept-batch',
      'order',
      ids.join(','),
      `batch accept: ${accepted.length} accepted, ${failed.length} failed (${failed.map((f) => `${f.id}:${f.code}`).join(', ') || 'none'})`,
    );
    return ok({ accepted, failed, total: ids.length });
  }),

  /* ---- POST /orders/batch/reject — reject many with one reason (BatchResult) ---- */
  h.post('/api/orders/batch/reject', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const body = await readJson(request);
    const ids = Array.isArray(body.orderIds) ? (body.orderIds as unknown[]).map(String).filter(Boolean) : [];
    if (!ids.length) throw new ApiHttpError(400, 'BATCH_EMPTY', 'Select at least one order to reject');
    if (ids.length > 50) throw new ApiHttpError(400, 'BATCH_EXCEEDS_LIMIT', 'Batch reject supports at most 50 orders');
    const reason = String(body.reason ?? '').slice(0, 500);
    if (!reason) throw new ApiHttpError(400, 'REASON_REQUIRED', 'A reject reason is required');
    let rejected = 0;
    const failures: { orderId: string; code: string }[] = [];
    for (const id of ids) {
      const order = db.table<OrderDto>('orders').find(id);
      if (!order || order.merchantId !== session.merchantId) {
        failures.push({ orderId: id, code: 'NOT_FOUND' });
        continue;
      }
      if (order.status !== 'new') {
        failures.push({ orderId: id, code: order.status === 'cancelled' ? 'ORDER_ALREADY_REJECTED' : 'ORDER_REJECT_AFTER_ACCEPTANCE' });
        continue;
      }
      performCancel(session, order, reason);
      rejected += 1;
    }
    audit(
      session.merchantId,
      session.staffId,
      session.role,
      'orders:reject-batch',
      'order',
      ids.join(','),
      `batch reject: ${rejected} rejected, ${failures.length} failed (${failures.map((f) => `${f.orderId}:${f.code}`).join(', ') || 'none'})`,
    );
    return ok({ accepted: rejected, failed: failures.length, failures });
  }),
  /* ---- POST /orders/me/advance — advance-flow handoff (scheduled order into prep) ---- */
  h.post('/api/orders/me/advance', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:accept');
    const body = await readJson(request);
    const order = ownOrder(session, String(body.orderId ?? ''));
    if (!order.scheduledAt) throw new ApiHttpError(409, 'INVALID_TRANSITION', 'Advance handoff applies to scheduled orders only');
    if (order.status !== 'new') throw new ApiHttpError(409, 'INVALID_TRANSITION', `Cannot advance ${order.no} from ${order.status}`);
    const expected = Number(body.expectedVersion);
    if (Number.isFinite(expected) && expected !== order.version) {
      throw new ApiHttpError(409, 'VERSION_CONFLICT', 'Order changed on the server — refresh and retry', true, { currentVersion: order.version });
    }
    const updated = performAccept(order.id, session.staffId, session.role)!;
    db.table<OrderDto>('orders').update(order.id, {
      timeline: [...(updated.timeline ?? []), { event: 'advance-handoff', ts: Date.now(), actor: session.staffId, note: typeof body.note === 'string' ? body.note : undefined }],
    });
    const fresh = db.table<OrderDto>('orders').find(order.id)!;
    audit(order.merchantId, session.staffId, session.role, 'orders:advance', 'order', order.id, `advanced ${order.no} into preparation`);
    emit({ type: 'orders.advance_handoff', order: fresh, at: Date.now() });
    return ok(upsertOrder(fresh));
  }),
  /* ---- Merchant: accept ---- */
  h.post('/api/orders/:id/accept', async ({ request, params }) => {
    const session = requireSession(request);
    const staff = requirePerm(session, 'orders:accept');
    const key = idemKey(request);
    const replay = idemGet('accept', key);
    if (replay) return ok(replay);

    const order = db.table<OrderDto>('orders').find(String(params.id));
    if (!order || order.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Order not found');
    // A different-key re-accept of an already-accepted order is absorbed by the
    // state machine (idempotent replay — no double-apply, no version bump).
    if (order.status === 'preparing') return ok({ accepted: true, order });
    // OF-04: accept on an order that is no longer `paid` is a 409-grade conflict —
    // never a silent success (ORDER_STATUS_CONFLICT / ORDER_AUTO_CANCELLED).
    if (order.status !== 'new') {
      const autoCancelled = order.status === 'cancelled' && order.cancelReasonCode === 'AUTO_CANCEL';
      const code = autoCancelled ? 'ORDER_AUTO_CANCELLED' : 'ORDER_STATUS_CONFLICT';
      emit({ type: 'orders.status_conflict', orderId: order.id, code, at: Date.now() });
      throw new ApiHttpError(
        409,
        code,
        autoCancelled ? `${order.no} was auto-cancelled — the acceptance deadline passed` : `${order.no} was already transitioned by another device — refresh and retry`,
      );
    }

    const body = await readJson(request);
    const expected = Number(body.expectedVersion ?? order.version);
    if (expected !== order.version) {
      throw new ApiHttpError(409, 'VERSION_CONFLICT', 'Order changed on the server — refresh and retry', true, { currentVersion: order.version });
    }
    const updated = performAccept(order.id, session.staffId, session.role, staff.name);
    idemSet('accept', key, { accepted: true, order: updated });
    return ok({ accepted: true, order: updated });
  }),

  /* ---- Merchant: reject/decline (refunds the captured payment for real) ---- */
  h.post('/api/orders/:id/reject', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = db.table<OrderDto>('orders').find(String(params.id));
    if (!order || order.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Order not found');
    // Documented single-reject codes (ORDER-FLOW.md): double-reject → 409
    // ORDER_ALREADY_REJECTED (the UI disables the button after the first 200);
    // post-acceptance attempts → 409 ORDER_REJECT_AFTER_ACCEPTANCE. A replay of
    // the SAME reason (e.g. a queued op that already landed) is absorbed as ok.
    if (order.status === 'cancelled') {
      const body = await readJson(request).catch(() => ({} as Record<string, unknown>));
      if (String(body.reason ?? '') === (order.cancelReason ?? '')) return ok({ cancelled: true, order });
      throw new ApiHttpError(409, 'ORDER_ALREADY_REJECTED', `${order.no} was already rejected`);
    }
    if (order.status !== 'new') throw new ApiHttpError(409, 'ORDER_REJECT_AFTER_ACCEPTANCE', `${order.no} was already accepted — cancellation rules apply instead of rejection`);
    const body = await readJson(request);
    const expectedReject = Number(body.expectedVersion ?? order.version);
    if (expectedReject !== order.version) {
      throw new ApiHttpError(409, 'VERSION_CONFLICT', 'Order changed on the server — refresh and retry', true, { currentVersion: order.version });
    }
    const reason = String(body.reason ?? 'Store too busy');
    const reasonCode = String(body.reasonCode ?? 'STORE_BUSY');
    const pay = db.table<Payment>('payments').find(order.paymentId ?? '');
    const captured = pay?.status === 'captured';
    applyTransition(order, 'cancelled', session.staffId, { cancelReason: reason, cancelledAt: Date.now(), seen: true }, 'cancelled');
    db.table('orders').update(order.id, { cancelReasonCode: reasonCode });
    // The customer must actually be refunded (payment + ledger + record).
    refundPayment(order, reason, 'MERCHANT_DECLINE', session.staffId);
    notify(order.merchantId, {
      type: 'order',
      title: `Order ${order.no} declined`,
      body: captured ? `Customer refunded ¥${order.total.toFixed(2)} · reason: ${reason}` : `No charge was made — the customer was not billed · reason: ${reason}`,
      orderId: order.id,
    });
    audit(
      order.merchantId,
      session.staffId,
      session.role,
      'orders:reject',
      'order',
      order.id,
      captured
        ? `declined ${order.no} (${reason}) — refunded ${order.total.toFixed(2)} · ${reasonCode}`
        : `declined ${order.no} (${reason}) — no charge to refund · ${reasonCode}`,
    );
    return ok({ cancelled: true, order: db.table<OrderDto>('orders').find(order.id)! });
  }),

  /* ---- Merchant: mark ready (single dispatch — replay-safe) ---- */
  h.post('/api/orders/:id/ready', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = db.table<OrderDto>('orders').find(String(params.id));
    if (!order || order.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Order not found');
    if (order.status === 'ready') return ok({ ready: true, order }); // idempotent replay
    const bodyReady = await readJson(request);
    const expectedReady = Number(bodyReady.expectedVersion ?? order.version);
    if (expectedReady !== order.version) {
      throw new ApiHttpError(409, 'VERSION_CONFLICT', 'Order changed on the server — refresh and retry', true, { currentVersion: order.version });
    }
    const updated = applyTransition(order, 'ready', session.staffId, { readyAt: Date.now() }, 'ready');
    const rider = db.table('riders').where((r) => r.status === 'idle')[0] ?? db.table('riders').all()[0];
    if (rider) {
      db.table('riders').update(rider.id, { status: 'delivering', updatedAt: Date.now() });
      db.table<OrderDto>('orders').update(updated.id, { rider: rider.name, riderId: rider.id });
      audit(order.merchantId, session.staffId, session.role, 'logistics:dispatch', 'order', order.id, `dispatched rider ${rider.name}`);
    }
    return ok({ ready: true, order: db.table<OrderDto>('orders').find(order.id)! });
  }),

  /* ---- Merchant: complete (delivered) ---- */
  h.post('/api/orders/:id/complete', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = db.table<OrderDto>('orders').find(String(params.id));
    if (!order || order.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Order not found');
    if (order.status === 'completed') return ok({ completed: true, order }); // idempotent replay
    const bodyComplete = await readJson(request);
    const expectedComplete = Number(bodyComplete.expectedVersion ?? order.version);
    if (expectedComplete !== order.version) {
      throw new ApiHttpError(409, 'VERSION_CONFLICT', 'Order changed on the server — refresh and retry', true, { currentVersion: order.version });
    }
    const completedAt = Date.now();
    const updated = applyTransition(order, 'completed', session.staffId, { completedAt, seen: true, settledAt: completedAt }, 'delivered');
    const rider = db.table('riders').find(order.riderId ?? '');
    if (rider) db.table('riders').update(rider.id, { status: 'idle', updatedAt: completedAt });
    return ok({ completed: true, order: updated });
  }),

  /* ---- Merchant: reply to rush (body message ≤300; idempotent replay only for
       the identical message — a different second reply is RUSH_ALREADY_REPLIED) ---- */
  h.post('/api/orders/:id/rush-reply', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:accept');
    const order = db.table<OrderDto>('orders').find(String(params.id));
    if (!order || order.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Order not found');
    // The contract requires {message}; legacy clients (and the contract suite)
    // reply without a body — tolerate it and fall back to the default message.
    let body: Record<string, unknown> = {};
    try {
      body = await readJson(request);
    } catch {
      /* bodyless reply — default message below */
    }
    const message = String(body.message ?? '').slice(0, 300);
    const normalized = message || 'On it!';
    const repliedAt = order.timeline?.find((e) => e.event === 'rush-replied')?.ts ?? null;
    if (!order.rushAt || ['completed', 'cancelled', 'refunded', 'failed', 'disputed'].includes(order.status)) {
      throw new ApiHttpError(409, 'RUSH_NOT_OPEN', `${order.no} is no longer open for rush replies`);
    }
    if (order.rushReplied) {
      // Replay of the identical message is idempotent — deadline not re-extended.
      if ((order as OrderDto & { replyMessage?: string }).replyMessage === normalized) {
        return ok({
          replied: true,
          order,
          rushOrder: { orderId: order.id, status: 'replied', requestedAt: order.rushAt, repliedAt, replyMessage: (order as OrderDto & { replyMessage?: string }).replyMessage ?? null },
        });
      }
      throw new ApiHttpError(409, 'RUSH_ALREADY_REPLIED', 'This order was already replied to — refresh to see the latest state');
    }
    const updated = db
      .table<OrderDto>('orders')
      .update(order.id, {
        rushReplied: true,
        replyMessage: normalized,
        deadlineAt: (order.deadlineAt ?? Date.now()) + 5 * 60000,
        version: order.version + 1,
        timeline: [...(order.timeline ?? []), { event: 'rush-replied', ts: Date.now(), actor: session.staffId, note: normalized }],
      } as Partial<OrderDto> & { replyMessage?: string })!;
    audit(order.merchantId, session.staffId, session.role, 'orders:rush-reply', 'order', order.id, `replied to rush on ${order.no}: "${normalized}"`);
    return ok({
      replied: true,
      order: upsertOrder(updated),
      rushOrder: { orderId: order.id, status: 'replied', requestedAt: order.rushAt, repliedAt: Date.now(), replyMessage: normalized },
    });
  }),

  /* ---- Customer platform: customer rushes (internal) ---- */
  h.post('/api/orders/:id/rush', async ({ request, params }) => {
    requireInternal(request);
    const order = db.table<OrderDto>('orders').find(String(params.id));
    if (!order || (order.status !== 'new' && order.status !== 'preparing'))
      throw new ApiHttpError(409, 'INVALID_TRANSITION', 'Order is not pending acceptance or in preparation');
    // Rush cooldown: a recent rush (< 10 min) already bumped the deadline —
    // never double-extend. A stale rush (> 10 min) may be re-rushed.
    if (order.rushAt && Date.now() - order.rushAt < 10 * 60000) {
      return ok({ rushed: false, order });
    }
    const updated = db
      .table<OrderDto>('orders')
      .update(order.id, {
        rushAt: Date.now(),
        rushReplied: false,
        deadlineAt: order.deadlineAt + 2 * 60000,
        version: order.version + 1,
        timeline: [...(order.timeline ?? []), { event: 'rush-requested', ts: Date.now(), actor: 'customer-platform' }],
      })!;
    notify(order.merchantId, {
      type: 'order',
      title: `Customer rushing · ${order.no}`,
      body: 'The customer asked you to prioritize this order.',
      orderId: order.id,
    });
    return ok({ rushed: true, order: upsertOrder(updated) });
  }),

  /* ---- Refund request (merchant session OR customer-platform internal) ---- */
  h.post('/api/orders/:id/refund', async ({ request, params }) => {
    const internal = request.headers.get('x-internal-key');
    const session = internal === INTERNAL_KEY ? undefined : requireSession(request);
    if (session) requirePerm(session, 'orders:manage');
    const order = db.table<OrderDto>('orders').find(String(params.id));
    if (!order || (session && order.merchantId !== session.merchantId)) throw new ApiHttpError(404, 'NOT_FOUND', 'Order not found');
    if (order.status === 'cancelled') throw new ApiHttpError(409, 'ORDER_CANCELLED', 'Order was cancelled — the customer was already refunded if charged');
    if (order.refund) throw new ApiHttpError(409, 'REFUND_EXISTS', 'A refund request already exists for this order');
    if (!order.paymentId) throw new ApiHttpError(409, 'NO_PAYMENT', 'Order has no captured payment to refund');
    const body = await readJson(request);
    const reasonCode = String(body.reasonCode ?? 'CUSTOMER_REQUEST');
    const requested = Math.round(Number(body.amount ?? order.total) * 100) / 100;
    if (requested <= 0) throw new ApiHttpError(400, 'INVALID_AMOUNT', 'Refund amount must be greater than zero');
    const amount = Math.min(requested, order.total); // never refund more than the order total
    const refund: Refund = {
      // Deterministic id: the client (and seed data) reference rf_<orderId>.
      id: `rf_${order.id}`,
      merchantId: order.merchantId,
      orderId: order.id,
      paymentId: order.paymentId,
      amount,
      reason: String(body.reason ?? 'Customer request'),
      reasonCode,
      status: 'requested',
      createdAt: Date.now(),
      ts: Date.now(),
    };
    db.table<Refund>('refunds').insert(refund);
    db.table<OrderDto>('orders').update(order.id, {
      refund: { ts: refund.createdAt, reason: refund.reason, amount: refund.amount, status: 'requested' },
      version: order.version + 1,
      timeline: [...(order.timeline ?? []), { event: 'refund-requested', ts: Date.now(), actor: session ? session.staffId : 'customer-platform' }],
    });
    notify(order.merchantId, {
      type: 'order',
      title: `Refund request · ${order.no}`,
      body: `Customer requests ¥${refund.amount.toFixed(2)} · "${refund.reason}"`,
      orderId: order.id,
    });
    const updated = db.table<OrderDto>('orders').find(order.id)!;
    return ok({ refund, order: upsertOrder(updated) });
  }),

  /* ---- Merchant: decide refund (idempotent — single ledger debit) ---- */
  h.post('/api/refunds/:id/decide', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const refund = db.table<Refund>('refunds').find(String(params.id));
    if (!refund || refund.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Refund not found');
    if (refund.status !== 'requested') return ok({ refund, order: db.table<OrderDto>('orders').find(refund.orderId)! }); // idempotent replay
    const body = await readJson(request);
    const approve = body.approve === true;
    if (approve) {
      // Only captured payments hold money — approving against a pending/failed
      // payment would debit a ledger that never received funds.
      const pay = db.table<Payment>('payments').find(refund.paymentId);
      if (!pay || pay.status !== 'captured')
        throw new ApiHttpError(409, 'PAYMENT_NOT_CAPTURED', 'Payment was not captured — nothing to refund');
    }
    const decided: Refund = {
      ...refund,
      status: approve ? 'approved' : 'declined',
      decidedBy: session.staffId,
      decidedAt: Date.now(),
    };
    db.table<Refund>('refunds').update(refund.id, decided);

    const order = db.table<OrderDto>('orders').find(refund.orderId)!;
    db.table<OrderDto>('orders').update(order.id, {
      refund: { ts: refund.createdAt, reason: refund.reason, amount: refund.amount, status: decided.status },
      version: order.version + 1,
      timeline: [...(order.timeline ?? []), { event: approve ? 'refund-approved' : 'refund-declined', ts: Date.now(), actor: session.staffId }],
    });

    if (approve) {
      const pay = db.table<Payment>('payments').find(refund.paymentId);
      if (pay) {
        db.table<Payment>('payments').update(pay.id, {
          status: 'refunded',
          refundedAmount: pay.refundedAmount + refund.amount,
          refunds: [...pay.refunds, refund.id],
        });
        emit({ type: 'payment.captured', payment: { ...pay, status: 'refunded' as const, refunds: [...pay.refunds, refund.id] }, at: Date.now() });
      }
      db.table('ledger').insert({
        id: uid('l'),
        merchantId: session.merchantId,
        type: 'refund',
        amount: -refund.amount,
        title: `Refund ${order.no}`,
        ts: Date.now(),
        status: 'completed',
        refType: 'order',
        refId: order.id,
      });
      notify(order.merchantId, {
        type: 'order',
        title: `Refund approved · ${order.no}`,
        body: `¥${refund.amount.toFixed(2)} returned to the customer's wallet.`,
        orderId: order.id,
      });
    } else {
      notify(order.merchantId, {
        type: 'order',
        title: `Refund declined · ${order.no}`,
        body: 'The refund request was declined. The customer has been notified.',
        orderId: order.id,
      });
    }
    audit(order.merchantId, session.staffId, session.role, 'orders:refund-decide', 'order', order.id, `${approve ? 'approved' : 'declined'} refund ¥${refund.amount.toFixed(2)} on ${order.no}`);
    const updated = db.table<OrderDto>('orders').find(order.id)!;
    return ok({ refund: decided, order: upsertOrder(updated) });
  }),

  /* ---- Refund reason catalog ---- */
  h.get('/api/refunds/reasons', ({ request }) => {
    requireSession(request);
    return ok({
      reasons: [
        { code: 'WRONG_ITEM', label: 'Wrong item received' },
        { code: 'MISSING_ITEM', label: 'Missing side dish / item' },
        { code: 'COLD_FOOD', label: 'Item arrived cold' },
        { code: 'QUALITY', label: 'Quality issue / too spicy' },
        { code: 'LATE_DELIVERY', label: 'Delivered late' },
        { code: 'SPILLED', label: 'Food spilled in transit' },
        { code: 'CUSTOMER_REQUEST', label: 'Customer changed mind' },
      ],
    });
  }),

  /* ---- Merchant: mark order seen ---- */
  h.post('/api/orders/:id/seen', async ({ request, params }) => {
    const session = requireSession(request);
    const order = db.table<OrderDto>('orders').find(String(params.id));
    if (!order || order.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Order not found');
    db.table<OrderDto>('orders').update(order.id, { seen: true });
    return ok({ seen: true });
  }),

  /* ================= P2: orders ops (contract /orders*) ================= */
  /* ---- GET /orders/{orderId}/timeline ---- */
  h.get('/api/orders/:id/timeline', ({ request, params }) => {
    const session = requireSession(request);
    const order = ownOrder(session, String(params.id));
    return ok({ events: orderTimelineEvents(order) });
  }),

  /* ---- GET /orders/{orderId}/track ---- */
  h.get('/api/orders/:id/track', ({ request, params }) => {
    const session = requireSession(request);
    const order = ownOrder(session, String(params.id));
    return ok(trackingEvent(order));
  }),

  /* ---- GET /orders/{orderId}/tracking-phases ---- */
  h.get('/api/orders/:id/tracking-phases', ({ request, params }) => {
    const session = requireSession(request);
    const order = ownOrder(session, String(params.id));
    return ok(trackingPhases(order));
  }),

  /* ---- GET /orders/{orderId}/waybill ---- */
  h.get('/api/orders/:id/waybill', ({ request, params }) => {
    const session = requireSession(request);
    const order = ownOrder(session, String(params.id));
    return ok(orderWaybill(order));
  }),

  /* ---- GET /orders/{orderId}/fare ---- */
  h.get('/api/orders/:id/fare', ({ request, params }) => {
    const session = requireSession(request);
    const order = ownOrder(session, String(params.id));
    return ok(fareBreakdown(order));
  }),

  /* ---- GET /orders/{orderId}/route ---- */
  h.get('/api/orders/:id/route', ({ request, params }) => {
    const session = requireSession(request);
    const order = ownOrder(session, String(params.id));
    return ok(ensureRouteSegments(order));
  }),

  /* ---- POST /orders/{orderId}/status — contract state-advance (merchant scoped) ---- */
  h.post('/api/orders/:id/status', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    const body = await readJson(request);
    const status = String(body.status ?? '');
    const expected = Number(body.expectedVersion);
    if (Number.isFinite(expected) && expected !== order.version) {
      throw new ApiHttpError(409, 'VERSION_CONFLICT', 'Order changed on the server — refresh and retry', true, { currentVersion: order.version });
    }
    if (status === 'preparing') {
      if (order.status === 'preparing') return ok(order); // idempotent replay
      if (order.status === 'merchant_accepted') {
        // Accept already happened — advance through the intermediate state.
        return ok(applyTransition(order, 'preparing', session.staffId, {}));
      }
      if (order.status !== 'new') throw new ApiHttpError(409, 'INVALID_TRANSITION', `Cannot move ${order.no} from ${order.status} to preparing`);
      return ok(performAccept(order.id, session.staffId, session.role));
    }
    if (status === 'ready') {
      if (order.status === 'ready') return ok(order); // idempotent replay
      if (order.status !== 'preparing') throw new ApiHttpError(409, 'INVALID_TRANSITION', `Cannot move ${order.no} from ${order.status} to ready`);
      const updated = applyTransition(order, 'ready', session.staffId, { readyAt: Date.now() }, 'ready');
      const rider = db.table<{ id: string; name: string; status: string; updatedAt: number }>('riders').where((r) => r.status === 'idle')[0] ?? db.table<{ id: string; name: string; status: string; updatedAt: number }>('riders').all()[0];
      if (rider) {
        db.table('riders').update(rider.id, { status: 'delivering', updatedAt: Date.now() });
        db.table<OrderDto>('orders').update(updated.id, { rider: rider.name, riderId: rider.id });
        audit(order.merchantId, session.staffId, session.role, 'logistics:dispatch', 'order', order.id, `dispatched rider ${rider.name}`);
      }
      return ok(db.table<OrderDto>('orders').find(order.id)!);
    }
    if (status === 'completed') {
      if (order.status === 'completed') return ok(order); // idempotent replay
      if (order.status !== 'ready') throw new ApiHttpError(409, 'INVALID_TRANSITION', `Cannot move ${order.no} from ${order.status} to completed`);
      const completedAt = Date.now();
      const updated = applyTransition(order, 'completed', session.staffId, { completedAt, seen: true, settledAt: completedAt }, 'delivered');
      const rider = db.table<{ id: string; status: string; updatedAt: number }>('riders').find(order.riderId ?? '');
      if (rider) db.table('riders').update(rider.id, { status: 'idle', updatedAt: completedAt });
      audit(order.merchantId, session.staffId, session.role, 'orders:complete', 'order', order.id, `completed ${order.no}`);
      return ok(updated);
    }
    throw new ApiHttpError(409, 'INVALID_TRANSITION', `Cannot advance ${order.no} to "${status}" — not a merchant-owned transition`);
  }),

  /* ---- POST /orders/{orderId}/cancel ---- */
  h.post('/api/orders/:id/cancel', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    if (order.status === 'completed') throw new ApiHttpError(409, 'INVALID_TRANSITION', 'Completed orders cannot be cancelled');
    const body = await readJson(request);
    const reason = String(body.reason ?? '').slice(0, 500);
    if (!reason) throw new ApiHttpError(400, 'REASON_REQUIRED', 'A cancel reason is required');
    // Server-computed cancellation economics (ORDER-FLOW.md): the fee applies
    // after merchant acceptance; the customer gets totalTZS − fee back.
    // Computed on the PRE-cancel status — a cancelled order no longer carries one.
    const cancelFeeTZS = cancelFeeFor(order);
    const updated = performCancel(session, order, reason);
    const refundTZS = Math.round(updated.total) - cancelFeeTZS;
    return ok(upsertOrder({ ...updated, cancelFeeTZS, refundTZS }));
  }),

  /* ---- POST /orders/{orderId}/hold ---- */
  h.post('/api/orders/:id/hold', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    if (order.hold) return ok(order); // idempotent replay
    if (order.status !== 'preparing' && order.status !== 'ready')
      throw new ApiHttpError(409, 'INVALID_TRANSITION', 'Only in-flight orders (preparing/ready) can be held');
    const body = await readJson(request);
    const reason = String(body.reason ?? '').slice(0, 300);
    if (!reason) throw new ApiHttpError(400, 'REASON_REQUIRED', 'A hold reason is required');
    const until = Number.isFinite(Number(body.until)) ? Number(body.until) : null;
    const updated = db
      .table<OrderDto>('orders')
      .update(order.id, {
        hold: { at: Date.now(), reason, until },
        version: order.version + 1,
        timeline: [...(order.timeline ?? []), { event: 'held', ts: Date.now(), actor: session.staffId }],
      })!;
    audit(order.merchantId, session.staffId, session.role, 'orders:hold', 'order', order.id, `held ${order.no} (${reason})`);
    emit({ type: 'orders.held', order: updated, at: Date.now() });
    return ok(upsertOrder(updated));
  }),

  /* ---- POST /orders/{orderId}/unhold ---- */
  h.post('/api/orders/:id/unhold', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    if (!order.hold) throw new ApiHttpError(409, 'NOT_HELD', 'Order is not held');
    const updated = db
      .table<OrderDto>('orders')
      .update(order.id, {
        hold: undefined,
        version: order.version + 1,
        timeline: [...(order.timeline ?? []), { event: 'unheld', ts: Date.now(), actor: session.staffId }],
      })!;
    audit(order.merchantId, session.staffId, session.role, 'orders:unhold', 'order', order.id, `resumed ${order.no}`);
    emit({ type: 'orders.unheld', order: updated, at: Date.now() });
    return ok(upsertOrder(updated));
  }),

  /* ---- POST /orders/{orderId}/reschedule ---- */
  h.post('/api/orders/:id/reschedule', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    if (order.status !== 'new' && order.status !== 'preparing')
      throw new ApiHttpError(409, 'INVALID_TRANSITION', 'Only pending or in-preparation orders can be rescheduled');
    if (order.reschedule?.status === 'approved') throw new ApiHttpError(409, 'ALREADY_RESCHEDULED', 'Order was already rescheduled');
    const body = await readJson(request);
    const scheduledAt = Number(body.scheduledAt);
    if (!Number.isFinite(scheduledAt)) throw new ApiHttpError(400, 'SCHEDULED_AT_REQUIRED', 'scheduledAt (epoch ms) is required');
    const reason = String(body.reason ?? '').slice(0, 500);
    if (!reason) throw new ApiHttpError(400, 'REASON_REQUIRED', 'A reschedule reason is required');
    const updated = db
      .table<OrderDto>('orders')
      .update(order.id, {
        reschedule: { at: Date.now(), reason, status: 'approved', scheduledAt },
        version: order.version + 1,
        timeline: [...(order.timeline ?? []), { event: 'rescheduled', ts: Date.now(), actor: session.staffId }],
      })!;
    audit(order.merchantId, session.staffId, session.role, 'orders:reschedule', 'order', order.id, `rescheduled ${order.no} to ${new Date(scheduledAt).toISOString()} (${reason})`);
    emit({ type: 'orders.rescheduled', order: updated, at: Date.now() });
    return ok({ ...upsertOrder(updated), status: 'rescheduled' });
  }),

  /* ---- POST /orders/{orderId}/transfer ---- */
  h.post('/api/orders/:id/transfer', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    if (order.status !== 'preparing' && order.status !== 'ready')
      throw new ApiHttpError(409, 'INVALID_TRANSITION', 'Only in-flight orders can be transferred');
    if (order.transfer?.status === 'requested') throw new ApiHttpError(409, 'TRANSFER_ALREADY_REQUESTED', 'A transfer is already requested for this order');
    const body = await readJson(request);
    const reason = String(body.reason ?? '').slice(0, 500);
    if (!reason) throw new ApiHttpError(400, 'REASON_REQUIRED', 'A transfer reason is required');
    const transferId = uid('tr');
    const updated = db
      .table<OrderDto>('orders')
      .update(order.id, {
        transfer: { id: transferId, at: Date.now(), reason, status: 'requested' },
        version: order.version + 1,
        timeline: [...(order.timeline ?? []), { event: 'transfer-requested', ts: Date.now(), actor: session.staffId }],
      })!;
    audit(order.merchantId, session.staffId, session.role, 'orders:transfer', 'order', order.id, `transfer requested for ${order.no} (${reason})`);
    emit({ type: 'orders.transferred', order: updated, transferId, at: Date.now() });
    return json(202, { transferId, status: 'requested' });
  }),

  /* ---- POST /orders/{orderId}/tip ---- */
  h.post('/api/orders/:id/tip', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    if (order.status !== 'completed') throw new ApiHttpError(409, 'INVALID_TRANSITION', 'Tips apply to completed orders only');
    const body = await readJson(request);
    const amountTZS = Number(body.amountTZS);
    if (!Number.isInteger(amountTZS) || amountTZS < 1) throw new ApiHttpError(400, 'INVALID_AMOUNT', 'amountTZS must be a positive integer');
    const note = String(body.note ?? '').slice(0, 200);
    const tipTZS = (order.tipTZS ?? 0) + amountTZS;
    const updated = db
      .table<OrderDto>('orders')
      .update(order.id, {
        tipTZS,
        version: order.version + 1,
        timeline: [...(order.timeline ?? []), { event: 'tip-added', ts: Date.now(), actor: session.staffId, note: note || undefined }],
      })!;
    audit(order.merchantId, session.staffId, session.role, 'orders:tip', 'order', order.id, `tipped rider ${amountTZS} TZS on ${order.no}`);
    emit({ type: 'orders.tipped', order: updated, at: Date.now() });
    return ok(upsertOrder(updated));
  }),

  /* ---- POST /orders/{orderId}/add-items — rider add-on request (merchant approval) ---- */
  h.post('/api/orders/:id/add-items', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    if (order.status !== 'new' && order.status !== 'preparing')
      throw new ApiHttpError(409, 'INVALID_TRANSITION', 'Items can only be added to active orders');
    if (order.addItemsRequest && !['approved', 'declined', 'completed'].includes(order.addItemsRequest.status))
      throw new ApiHttpError(409, 'ITEMS_REQUEST_PENDING', 'An add-items request is already pending approval');
    const body = await readJson(request);
    const items = Array.isArray(body.items)
      ? (body.items as { catalogueItemId?: unknown; quantity?: unknown }[])
          .slice(0, 50)
          .filter((it) => typeof it.catalogueItemId === 'string' && Number.isInteger(Number(it.quantity)) && Number(it.quantity) >= 1)
          .map((it) => ({ catalogueItemId: it.catalogueItemId as string, quantity: Number(it.quantity) }))
      : [];
    if (!items.length) throw new ApiHttpError(400, 'INVALID_ITEMS', 'At least one item with a valid quantity is required');
    const reason = String(body.reason ?? '').slice(0, 300);
    if (!reason) throw new ApiHttpError(400, 'REASON_REQUIRED', 'A reason is required');
    const requestId = uid('ai');
    db.table<OrderDto>('orders').update(order.id, {
      addItemsRequest: { id: requestId, at: Date.now(), items, reason, status: 'pending_merchant_approval' },
      version: order.version + 1,
      timeline: [...(order.timeline ?? []), { event: 'add-items-requested', ts: Date.now(), actor: session.staffId }],
    });
    const updated = db.table<OrderDto>('orders').find(order.id)!;
    audit(order.merchantId, session.staffId, session.role, 'orders:add-items', 'order', order.id, `add-items request ${requestId} on ${order.no} (${items.length} item(s))`);
    emit({ type: 'orders.items_added', order: updated, requestId, at: Date.now() });
    return json(202, { requestId, status: 'pending_merchant_approval' });
  }),

  /* ---- POST /orders/{orderId}/damage — food damage claim ---- */
  h.post('/api/orders/:id/damage', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    const claims = db.table<DamageClaimDto>('damageClaims').where((c) => c.orderId === order.id);
    // A claim with a decision blocks resubmission (DAMAGE_CLAIM_ALREADY_DECIDED);
    // a duplicate while the claim is still open is DAMAGE_CLAIM_EXISTS.
    if (claims.some((c) => c.status !== 'open')) {
      throw new ApiHttpError(409, 'DAMAGE_CLAIM_ALREADY_DECIDED', 'This order already has a decided damage claim — resubmission is blocked');
    }
    if (claims.length) throw new ApiHttpError(409, 'DAMAGE_CLAIM_EXISTS', 'A damage claim already exists for this order');
    const body = await readJson(request);
    const type = String(body.type ?? '');
    if (!['spilled', 'missing', 'wrong_item', 'damaged_packaging', 'quality'].includes(type)) throw new ApiHttpError(400, 'INVALID_CLAIM_TYPE', 'Unknown damage type');
    const description = String(body.description ?? '').slice(0, 1000);
    if (!description) throw new ApiHttpError(400, 'DESCRIPTION_REQUIRED', 'A description is required');
    const images = Array.isArray(body.images) ? (body.images as string[]).filter((u) => typeof u === 'string').slice(0, 5) : [];
    const claim: DamageClaimDto = { id: uid('dc'), orderId: order.id, type: type as DamageClaimDto['type'], description, images, status: 'open', createdAt: Date.now() };
    db.table<DamageClaimDto>('damageClaims').insert(claim);
    audit(order.merchantId, session.staffId, session.role, 'orders:damage', 'order', order.id, `damage claim ${claim.id} (${type}) on ${order.no}`);
    emit({ type: 'orders.damage_reported', claim, at: Date.now() });
    return json(201, claim);
  }),

  /* ---- POST /orders/{orderId}/failed-delivery ---- */
  h.post('/api/orders/:id/failed-delivery', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    if (order.status !== 'preparing' && order.status !== 'ready')
      throw new ApiHttpError(409, 'INVALID_TRANSITION', 'Only in-flight orders can be marked failed');
    if (order.failedDelivery) throw new ApiHttpError(409, 'DELIVERY_ALREADY_FAILED', 'Delivery was already marked failed');
    const body = await readJson(request);
    const reason = String(body.reason ?? '');
    if (!['customer_unavailable', 'wrong_address', 'refused', 'damaged', 'other'].includes(reason)) throw new ApiHttpError(400, 'INVALID_REASON', 'Unknown failure reason');
    const note = String(body.note ?? '').slice(0, 500);
    const photoUrl = typeof body.photoUrl === 'string' ? body.photoUrl : null;
    const returnToMerchant = body.returnToMerchant !== false;
    const updated = db
      .table<OrderDto>('orders')
      .update(order.id, {
        failedDelivery: { at: Date.now(), reason, note, photoUrl, returnToMerchant },
        version: order.version + 1,
        timeline: [...(order.timeline ?? []), { event: 'failed-delivery', ts: Date.now(), actor: session.staffId, note: note || undefined }],
      })!;
    notify(order.merchantId, {
      type: 'system',
      title: `Delivery failed · ${order.no}`,
      body: returnToMerchant ? 'The order is being returned to your store.' : `Delivery failed (${reason}) — no return requested.`,
      orderId: order.id,
    });
    audit(order.merchantId, session.staffId, session.role, 'orders:failed-delivery', 'order', order.id, `failed delivery on ${order.no} (${reason})${returnToMerchant ? ' — returning' : ''}`);
    emit({ type: 'orders.failed_delivery', order: updated, at: Date.now() });
    return ok({ ...upsertOrder(updated), status: 'failed_delivery' });
  }),

  /* ---- POST /orders/{orderId}/handoff — custody transfer between legs ---- */
  h.post('/api/orders/:id/handoff', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    const body = await readJson(request);
    const fromLegId = String(body.fromLegId ?? '');
    const toLegId = String(body.toLegId ?? '');
    const segments = ensureRouteSegments(order);
    if (!segments.some((s) => s.legId === fromLegId) || !segments.some((s) => s.legId === toLegId))
      throw new ApiHttpError(409, 'INVALID_LEG', 'Unknown route leg in handoff');
    if (body.sealIntact !== true) throw new ApiHttpError(409, 'SEAL_BROKEN', 'Tamper-evident seal must be intact');
    const existing = db.table<HandoffDto>('handoffs').where((hnd) => hnd.fromLegId === fromLegId && hnd.toLegId === toLegId);
    if (existing.length) throw new ApiHttpError(409, 'HANDOFF_CONFLICT', 'A handoff already exists between these legs');
    const handoff: HandoffDto = {
      id: uid('hf'),
      fromLegId,
      toLegId,
      scanCode: String(body.scanCode ?? '').slice(0, 120),
      sealIntact: true,
      conditionPhotoUrl: typeof body.conditionPhotoUrl === 'string' ? body.conditionPhotoUrl : null,
      location: body.location && typeof body.location === 'object' ? (body.location as { lat: number; lon: number }) : undefined,
      from: typeof body.from === 'string' ? body.from : 'rider',
      to: typeof body.to === 'string' ? body.to : 'rider',
      at: Date.now(),
    };
    if (!handoff.scanCode) throw new ApiHttpError(400, 'SCAN_CODE_REQUIRED', 'A waybill scan code is required');
    db.table<HandoffDto>('handoffs').insert(handoff);
    db.table<OrderDto>('orders').update(order.id, {
      version: order.version + 1,
      timeline: [...(order.timeline ?? []), { event: 'handoff', ts: Date.now(), actor: session.staffId, note: `custody ${fromLegId} → ${toLegId}` }],
    });
    audit(order.merchantId, session.staffId, session.role, 'orders:handoff', 'order', order.id, `handoff on ${order.no} (${fromLegId} → ${toLegId}, seal ${handoff.sealIntact ? 'intact' : 'broken'})`);
    emit({ type: 'orders.handoff', handoff, at: Date.now() });
    return json(201, handoff);
  }),

  /* ---- POST /orders/{orderId}/masked-call — masked VoIP session ---- */
  h.post('/api/orders/:id/masked-call', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    if (order.status !== 'preparing' && order.status !== 'ready')
      throw new ApiHttpError(409, 'INVALID_TRANSITION', 'Masked calls are only available for in-flight orders');
    const active = db.table<MaskedCallSessionDto & { id: string }>('maskedCalls').where((c) => c.orderId === order.id && c.expiresAt > Date.now());
    if (active.length) throw new ApiHttpError(409, 'MASKED_CALL_ACTIVE', 'A masked call session is already active');
    const sessionRow: MaskedCallSessionDto = {
      sessionId: uid('mc'),
      orderId: order.id,
      maskedNumber: `+2557${String(Math.floor(100000 + Math.random() * 899999))}${String(Math.floor(1000 + Math.random() * 8999))}`,
      direction: 'rider_to_customer',
      expiresAt: Date.now() + 30 * 60000,
    };
    db.table<MaskedCallSessionDto & { id: string }>('maskedCalls').insert({ ...sessionRow, id: sessionRow.sessionId });
    audit(order.merchantId, session.staffId, session.role, 'orders:masked-call', 'order', order.id, `masked call session ${sessionRow.sessionId} on ${order.no}`);
    emit({ type: 'orders.masked_call', session: sessionRow, at: Date.now() });
    return json(201, sessionRow);
  }),

  /* ---- POST /orders/{orderId}/proof-of-delivery ---- */
  h.post('/api/orders/:id/proof-of-delivery', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    if (order.status !== 'ready' && order.status !== 'completed')
      throw new ApiHttpError(409, 'INVALID_TRANSITION', 'Proof of delivery applies to picked-up or completed orders');
    const existing = db.table<ProofOfDeliveryDto>('proofOfDeliveries').where((p) => p.orderId === order.id);
    if (existing.length) throw new ApiHttpError(409, 'POD_ALREADY_SUBMITTED', 'Proof of delivery already submitted for this order');
    const body = await readJson(request);
    const type = String(body.type ?? '');
    if (!['photo', 'signature', 'otp'].includes(type)) throw new ApiHttpError(400, 'INVALID_POD_TYPE', 'type must be photo | signature | otp');
    const value = String(body.value ?? '');
    if (!value) throw new ApiHttpError(400, 'VALUE_REQUIRED', 'A POD value (photo URL, signature, OTP) is required');
    const proof: ProofOfDeliveryDto = {
      id: uid('pod'),
      orderId: order.id,
      type: type as ProofOfDeliveryDto['type'],
      value,
      dropoffOption: body.dropoffOption === 'leave_at_door' ? 'leave_at_door' : 'hand_to_customer',
      itemIds: Array.isArray(body.itemIds) ? (body.itemIds as string[]).slice(0, 100) : undefined,
      documentUrl: typeof body.documentUrl === 'string' ? body.documentUrl : null,
      gpsStamp: body.gpsStamp && typeof body.gpsStamp === 'object' ? (body.gpsStamp as ProofOfDeliveryDto['gpsStamp']) : null,
      verified: false,
      submittedAt: Date.now(),
    };
    db.table<ProofOfDeliveryDto>('proofOfDeliveries').insert(proof);
    audit(order.merchantId, session.staffId, session.role, 'orders:proof-of-delivery', 'order', order.id, `POD ${proof.type} submitted on ${order.no}`);
    emit({ type: 'orders.proof_of_delivery', proof, at: Date.now() });
    return ok(proof);
  }),

  /* ---- POST /orders/{orderId}/modify-request ---- */
  h.post('/api/orders/:id/modify-request', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const order = ownOrder(session, String(params.id));
    if (order.status !== 'new' && order.status !== 'preparing')
      throw new ApiHttpError(409, 'INVALID_TRANSITION', 'Modifications only apply to active orders');
    const body = await readJson(request);
    const type = String(body.type ?? '');
    if (!['change_address', 'change_time', 'add_item', 'remove_item', 'other'].includes(type)) throw new ApiHttpError(400, 'INVALID_REQUEST_TYPE', 'Unknown modification type');
    const note = String(body.note ?? '').slice(0, 500);
    if (!note) throw new ApiHttpError(400, 'NOTE_REQUIRED', 'A modification note is required');
    const requestId = uid('mr');
    db.table<OrderDto>('orders').update(order.id, {
      modifyRequest: { id: requestId, at: Date.now(), type, note, status: 'pending_approval' },
      version: order.version + 1,
      timeline: [...(order.timeline ?? []), { event: 'modify-requested', ts: Date.now(), actor: session.staffId }],
    });
    const updated = db.table<OrderDto>('orders').find(order.id)!;
    audit(order.merchantId, session.staffId, session.role, 'orders:modify-request', 'order', order.id, `modify request ${requestId} (${type}) on ${order.no}`);
    emit({ type: 'orders.modify_requested', order: updated, at: Date.now() });
    return json(202, { requestId, status: 'pending_approval' });
  }),



  /* ---- POST /orders/{orderId}/legs/{legId}/advance — start/complete a route leg ---- */
  h.post('/api/orders/:orderId/legs/:legId/advance', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const orderId = String(params.orderId);
    if (!orderId) throw new ApiHttpError(400, 'ORDER_ID_REQUIRED', 'orderId path param is required');
    const order = ownOrder(session, orderId);
    const body = await readJson(request);
    const action = String(body.action ?? '');
    if (action !== 'start' && action !== 'complete') throw new ApiHttpError(400, 'INVALID_ACTION', 'action must be start | complete');
    const segments = ensureRouteSegments(order);
    const leg = segments.find((s) => s.legId === String(params.legId));
    if (!leg) throw new ApiHttpError(409, 'LEG_NOT_FOUND', `Unknown leg ${String(params.legId)}`);
    const now = Date.now();
    if (action === 'start') {
      if (leg.status !== 'pending') throw new ApiHttpError(409, 'INVALID_TRANSITION', `Leg ${leg.sequence} is ${leg.status} — only pending legs can start`);
      leg.status = 'in_progress';
      leg.startedAt = now;
    } else {
      if (leg.status !== 'in_progress') throw new ApiHttpError(409, 'INVALID_TRANSITION', `Leg ${leg.sequence} is ${leg.status} — only in-progress legs can complete`);
      leg.status = 'completed';
      leg.completedAt = now;
    }
    db.table<OrderDto>('orders').update(order.id, { routeSegments: segments });
    audit(order.merchantId, session.staffId, session.role, 'orders:leg-advance', 'order', order.id, `leg ${params.legId} ${action} on ${order.no}`);
    emit({ type: 'orders.route_updated', orderId: order.id, segments, at: now });
    return ok(segments);
  }),
];

export { pii };
