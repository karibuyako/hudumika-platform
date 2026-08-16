/* In-memory payments repository — POST /payments/intent, /payments/{id}/confirm,
 * GET /payments/methods, GET /payments/history.
 *
 * State changes come from "webhooks" (the mock flips pending → paid); the app
 * never trusts a client callback. Refunds are server-triggered only.
 *
 * PaymentIntentCreate.orderId accepts an order OR a booking id ("Order or
 * booking id" per contract): booking intents are linked through the bookings
 * mock's intent map and confirm() flips the booking to `paid` alongside the
 * intent (mock "webhook").
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, findOrder, getState, nowIso, type MockIntent } from './mockState';
import { bookingIdForIntent, bookingIntent, linkBookingIntent } from './bookings';
import type { PaymentIntent, PaymentIntentStatus } from '@hudumika/contract';
import { PaymentIntentStatus as S, PaymentIntentCreateMethod } from '@hudumika/contract';
import type { OrderPaymentIntent, PaymentMethodRecord, PaymentsRepository } from '../index';

// Contract ListPaymentMethods200Item.available — all demo methods are live.
// card is shown unavailable so the status pill has a real data path (the mock
// intent flow still accepts it; checkout does not read `available`).
// isDefault marks the smart-default pick (§37) — an app-layer extension; the
// contract ListPaymentMethods200Item only carries method + available.
//
// Module-local registry (CONTRACT-ADDITIONS.md #7): add/remove/set-default
// mutations below mutate this list — the same "the mock is the server"
// pattern as mock/auth.ts. resetMockState() covers mockState only; tests call
// resetMockPaymentsState() between cases.
let METHODS: PaymentMethodRecord[] = [
  { id: 'pm_1', method: 'mpesa', label: 'M-Pesa', available: true, isDefault: true },
  { id: 'pm_2', method: 'tigo_pesa', label: 'Tigo Pesa', available: true },
  { id: 'pm_3', method: 'airtel_money', label: 'Airtel Money', available: true },
  { id: 'pm_4', method: 'card', label: 'Card', available: false },
  { id: 'pm_5', method: 'cod', label: 'Cash on delivery', available: true },
];

/** Replays for addPaymentMethod — same key never double-adds (the payment
 * methods mutation carries an idempotency key like every other mutation). */
const addReplays = new Map<string, PaymentMethodRecord>();

/** Tests re-seed the payments module between cases (mockState reset covers
 * the shared store; this clears the module-local method registry + replays). */
export function resetMockPaymentsState(): void {
  METHODS = [
    { id: 'pm_1', method: 'mpesa', label: 'M-Pesa', available: true, isDefault: true },
    { id: 'pm_2', method: 'tigo_pesa', label: 'Tigo Pesa', available: true },
    { id: 'pm_3', method: 'airtel_money', label: 'Airtel Money', available: true },
    { id: 'pm_4', method: 'card', label: 'Card', available: false },
    { id: 'pm_5', method: 'cod', label: 'Cash on delivery', available: true },
  ];
  addReplays.clear();
}

function labelFor(method: string): string {
  return method
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const NOT_PAYABLE_BOOKING = ['cancelled', 'refunded', 'no_show', 'declined', 'completed', 'disputed', 'customer_cancelled', 'provider_cancelled'];

export class MockPaymentsRepository implements PaymentsRepository {
  async createIntent(orderId: string, method: string, idempotencyKey: string): Promise<PaymentIntent> {
    const state = getState();
    const replay = state.intentReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    // Dine-in bills pay through the same intent flow (DINE-IN.md): open →
    // billing on "request bill" (mock server), → paid via the confirm "webhook".
    const dineInOrder = state.dineInOrders.find((o) => o.id === orderId);
    if (dineInOrder) {
      if (dineInOrder.status === 'paid' || dineInOrder.status === 'closed' || dineInOrder.status === 'cancelled') {
        throw new ApiError(409, 'DINE_IN_BILL_NOT_PAYABLE', 'This bill cannot be paid yet');
      }
      const existing = state.intentForOrder.get(orderId);
      if (existing) {
        if (existing.status === 'paid') throw new ApiError(409, 'PAYMENT_ALREADY_PAID', 'This bill is already paid');
        return clone(existing);
      }
      const intent: MockIntent = {
        id: uid('intent'),
        status: S.created,
        amountTZS: dineInOrder.totals.totalTZS,
        method,
        orderId,
      };
      state.intents.push(intent);
      state.intentForOrder.set(orderId, intent);
      state.intentReplays.set(idempotencyKey, intent);
      if (dineInOrder.status === 'open') dineInOrder.status = 'billing';
      return clone(intent);
    }
    const booking = state.bookings.find((b) => b.id === orderId);
    if (booking) {
      // The booking carries its intent from create(); recreate/confirm is
      // idempotent through the same linkage.
      const existing = bookingIntent(booking.id);
      if (existing) {
        if (existing.status === 'paid') throw new ApiError(409, 'PAYMENT_ALREADY_PAID', 'This booking is already paid');
        return clone(existing);
      }
      if (NOT_PAYABLE_BOOKING.includes(booking.status)) {
        throw new ApiError(409, 'BOOKING_STATUS_CONFLICT', 'This booking is no longer payable');
      }
      const intent: MockIntent = {
        id: uid('intent'),
        status: S.created,
        amountTZS: booking.price?.totalTZS ?? 0,
        method,
      };
      state.intents.push(intent);
      linkBookingIntent(booking.id, intent);
      state.intentReplays.set(idempotencyKey, intent);
      return clone(intent);
    }
    const order = findOrder(orderId);
    if (order.status === 'cancelled' || order.status === 'refunded' || order.status === 'failed') {
      throw new ApiError(409, 'ORDER_NOT_PAYABLE', 'This order is no longer payable');
    }
    const existing = state.intentForOrder.get(orderId);
    if (existing) {
      if (existing.status === 'paid') throw new ApiError(409, 'PAYMENT_ALREADY_PAID', 'This order is already paid');
      return clone(existing);
    }
    const status: PaymentIntentStatus = method === 'cod' ? S.paid : S.created;
    const intent: OrderPaymentIntent = {
      id: uid('intent'),
      status,
      amountTZS: order.totals.totalTZS,
      method,
      orderId,
      providerReference: status === S.paid ? `PR-${Math.floor(100000 + Math.random() * 900000)}-${method.toUpperCase()}` : undefined,
      paidAt: status === S.paid ? nowIso() : undefined,
    };
    state.intents.push(intent);
    state.intentForOrder.set(orderId, intent);
    state.intentReplays.set(idempotencyKey, intent);
    if (status === S.paid) order.status = 'paid';
    return clone(intent);
  }

  async confirm(intentId: string, _idempotencyKey: string): Promise<PaymentIntent> {
    const state = getState();
    if (state.paymentFailure) {
      const failure = state.paymentFailure;
      state.paymentFailure = null;
      throw new ApiError(
        429,
        failure.code,
        'Payment provider unreachable',
        true,
        { retryAfterSeconds: failure.retryAfterSeconds },
      );
    }
    const intent = state.intents.find((i) => i.id === intentId);
    if (!intent) throw new ApiError(404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found');
    if (intent.status === 'paid') return clone(intent);
    if (intent.status === 'refunded' || intent.status === 'partially_refunded') {
      throw new ApiError(409, 'PAYMENT_ALREADY_PAID', 'This payment is already settled');
    }
    // Dine-in: the bill may have been closed/cancelled while the intent was
    // pending — a stale action (DINE_IN_ORDER_STATUS_CONFLICT → refetch).
    const dineInOrder = state.dineInOrders.find((o) => state.intentForOrder.get(o.id)?.id === intentId);
    if (dineInOrder && (dineInOrder.status === 'closed' || dineInOrder.status === 'cancelled')) {
      throw new ApiError(409, 'DINE_IN_ORDER_STATUS_CONFLICT', 'This bill changed — refresh it');
    }
    intent.status = 'paid';
    intent.providerReference = `PR-${Math.floor(100000 + Math.random() * 900000)}-${intent.method.toUpperCase()}`;
    intent.paidAt = nowIso();
    // Mock "webhook": a dine-in intent flips the bill to paid + paidAt.
    if (dineInOrder) {
      dineInOrder.status = 'paid';
      dineInOrder.paidAt = nowIso();
    }
    // Mock "webhook": a booking-linked intent flips the booking too.
    const bookingId = bookingIdForIntent(intentId);
    if (bookingId) {
      const booking = state.bookings.find((b) => b.id === bookingId);
      if (booking && booking.status === 'pending_payment') {
        booking.status = 'paid';
        booking.events.push({ status: 'paid', at: nowIso(), by: 'system', note: 'Paid via mobile money' });
        booking.updatedAt = nowIso();
      }
    }
    const order = state.orders.find((o) => state.intentForOrder.get(o.id)?.id === intentId);
    if (order) order.status = 'paid';
    return clone(intent);
  }

  async getPaymentMethods(): Promise<PaymentMethodRecord[]> {
    return clone(METHODS);
  }

  async getHistory(): Promise<OrderPaymentIntent[]> {
    return clone(getState().intents);
  }

  // Mock-only mutations (docs/CONTRACT-ADDITIONS.md #7): the contract has
  // only GET /payments/methods — add/remove/set-default are app-only until
  // Team 6 ships them. The mock is the server: the method value is validated
  // against the contract PaymentIntentCreateMethod enum and the registry
  // carries the isDefault flag the live list cannot.
  async addPaymentMethod(method: string, idempotencyKey: string): Promise<PaymentMethodRecord> {
    const replay = addReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    if (!Object.values(PaymentIntentCreateMethod).includes(method as PaymentIntentCreateMethod)) {
      throw new ApiError(422, 'VALIDATION_FAILED', `${method} is not a supported payment method`);
    }
    const existing = METHODS.find((m) => m.method === method);
    if (existing) {
      throw new ApiError(409, 'CONFLICT', 'This payment method is already added');
    }
    const record: PaymentMethodRecord = {
      id: uid('pm'),
      method,
      label: labelFor(method),
      available: true,
      isDefault: METHODS.length === 0,
    };
    METHODS.push(record);
    addReplays.set(idempotencyKey, record);
    return clone(record);
  }

  async removePaymentMethod(methodId: string, _idempotencyKey: string): Promise<void> {
    const idx = METHODS.findIndex((m) => m.id === methodId);
    if (idx === -1) throw new ApiError(404, 'NOT_FOUND', 'Payment method not found');
    const wasDefault = METHODS[idx].isDefault === true;
    METHODS.splice(idx, 1);
    // Removing the default promotes the next available method (server rule —
    // the customer always has one default to fall back to at checkout).
    if (wasDefault && METHODS.length > 0) {
      const promoted = METHODS.find((m) => m.available !== false) ?? METHODS[0];
      promoted.isDefault = true;
    }
  }

  async setDefaultPaymentMethod(methodId: string, _idempotencyKey: string): Promise<PaymentMethodRecord> {
    const target = METHODS.find((m) => m.id === methodId);
    if (!target) throw new ApiError(404, 'NOT_FOUND', 'Payment method not found');
    for (const m of METHODS) {
      m.isDefault = m.id === methodId;
    }
    return clone(target);
  }
}
