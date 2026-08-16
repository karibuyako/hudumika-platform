/* M9 — Notifications depth + realtime: category filter helper, locked
 * preference rows + PREFERENCE_INVALID_EVENT, widened event catalog,
 * tracking refetch on intercity events, app-foreground unread refresh,
 * voucher expiring-soon marker. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { rejectsApiError, resetMockState } from './helpers';
import { MockNotificationsRepository } from '@/repos/mock/notifications';
import { MockOrdersRepository } from '@/repos/mock/orders';
import { eventBus, TRACKING_EVENTS, BOOKING_EVENTS, ORDER_TAB_EVENTS, type ServerEventType } from '@/store/events';
import { simulateIntercityDelay, getState } from '@/repos/mock/mockState';
import { handleAppForeground } from '@/lib/appLifecycle';
import {
  filterNotificationsByCategory,
  notificationCategories,
  notificationCategory,
  voucherExpiresWithin,
} from '@/lib/notifications';
import type { Notification, Voucher } from '@hudumika/contract';

const notifications = new MockNotificationsRepository();
const orders = new MockOrdersRepository();

beforeEach(() => resetMockState());

/* ---------------- Task 1 — category filters ---------------- */

test('notificationCategory groups namespaced types by prefix and keeps plain types', () => {
  assert.equal(notificationCategory('order.delivering'), 'order');
  assert.equal(notificationCategory('payment.success'), 'payment');
  assert.equal(notificationCategory('promotion'), 'promotion');
  assert.equal(notificationCategory('booking.no_show'), 'booking');
});

test('notificationCategories are distinct and ordered by first appearance', () => {
  const items = [
    { type: 'order.delivering' },
    { type: 'payment.success' },
    { type: 'order.delivered' },
    { type: 'promotion' },
    { type: 'payment.failed' },
  ] as Notification[];
  assert.deepEqual(notificationCategories(items), ['order', 'payment', 'promotion']);
});

test('filterNotificationsByCategory returns only matching rows; null returns all', () => {
  const items = [
    { id: 'a', type: 'order.delivering', title: 'x', body: 'y', deepLink: null, read: false, createdAt: new Date().toISOString() },
    { id: 'b', type: 'payment.success', title: 'x', body: 'y', deepLink: null, read: true, createdAt: new Date().toISOString() },
    { id: 'c', type: 'promotion', title: 'x', body: 'y', deepLink: null, read: false, createdAt: new Date().toISOString() },
  ] as Notification[];
  assert.deepEqual(filterNotificationsByCategory(items, 'order').map((n) => n.id), ['a']);
  assert.deepEqual(filterNotificationsByCategory(items, 'promotion').map((n) => n.id), ['c']);
  assert.deepEqual(filterNotificationsByCategory(items, 'payment').map((n) => n.id), ['b']);
  assert.equal(filterNotificationsByCategory(items, null).length, 3);
  assert.equal(filterNotificationsByCategory(items, 'security').length, 0);
});

test('seeded feed derives its three categories and filters each', async () => {
  const feed = await notifications.list();
  assert.deepEqual(notificationCategories(feed), ['order', 'payment', 'promotion']);
  for (const c of ['order', 'payment', 'promotion']) {
    const rows = filterNotificationsByCategory(feed, c);
    assert.ok(rows.length > 0, `category ${c} has rows`);
    assert.ok(rows.every((n) => notificationCategory(n.type) === c), `category ${c} rows only`);
  }
});

/* ---------------- Task 2 — locked security rows + PREFERENCE_INVALID_EVENT ---------------- */

test('security preferences are locked: the repo rejects disabling them with PREFERENCE_INVALID_EVENT', async () => {
  const prefs = await notifications.getPreferences();
  prefs.push = { ...(prefs.push ?? {}), 'security.otp': false };
  await rejectsApiError(notifications.putPreferences(prefs, 'k1'), 422, 'PREFERENCE_INVALID_EVENT');
  const reloaded = await notifications.getPreferences();
  assert.equal(reloaded.sms?.['security.otp'], true, 'security stays on after the rejected save');
});

test('unknown preference events are rejected with a typed PREFERENCE_INVALID_EVENT (422)', async () => {
  const prefs = await notifications.getPreferences();
  prefs.sms = { ...(prefs.sms ?? {}), 'order.teleport': true };
  const err = await rejectsApiError(notifications.putPreferences(prefs, 'k2'), 422, 'PREFERENCE_INVALID_EVENT');
  assert.match(err.message, /order\.teleport/, 'the invalid key surfaces in the message for row highlighting');
  const reloaded = await notifications.getPreferences();
  assert.equal(reloaded.sms?.['order.teleport'], undefined, 'rollback: nothing persisted');
});

test('valid preference updates still round-trip', async () => {
  const prefs = await notifications.getPreferences();
  prefs.push = { ...(prefs.push ?? {}), 'payment.failed': true };
  const saved = await notifications.putPreferences(prefs, 'k3');
  assert.equal(saved.push?.['payment.failed'], true);
});

/* ---------------- Task 3 — widened event catalog + mock publisher ---------------- */

// Compile-time catalog pin: every customer event from the audit must be
// accepted by the bus (the union widened to the blueprint §25 catalog).
const CUSTOMER_CATALOG: ServerEventType[] = [
  'order.created', 'order.updated', 'order.delivered', 'order.cancelled',
  'order.rejected', 'order.rush_requested', 'order.scheduled_reminder',
  'payment.captured', 'payment.failed', 'refund.processed',
  'notification.created', 'chat.message', 'message.received', 'conversation.blocked',
  'quote.issued', 'booking.requested', 'booking.accepted', 'booking.declined',
  'booking.reminder', 'booking.arrived', 'booking.no_show', 'booking.completed',
  'reservation.requested', 'reservation.confirmed', 'reservation.reminder',
  'review.received', 'review.moderated', 'ticket.reply',
  'dispute.opened', 'dispute.resolved',
  'intercity.eta_updated', 'waybill.updated',
  'leg.started', 'leg.completed', 'handoff.completed',
  'consignment.departed', 'consignment.arrived',
  'delivery.delayed', 'shipment.frozen', 'plan.replanned',
  'campaign.updated', 'coupon.claimed', 'membership.tier_up', 'warehouse.fulfilled',
  'platform.announcement', 'platform.campaign',
];

test('event bus accepts and delivers the customer catalog (incl. booking.* / platform.*)', () => {
  const got: string[] = [];
  const unsub = eventBus.subscribe((type) => got.push(type));
  for (const t of CUSTOMER_CATALOG) eventBus.publish(t);
  unsub();
  assert.deepEqual(got, CUSTOMER_CATALOG, 'every catalog event reaches a subscriber');
  assert.equal(eventBus.size, 0, 'subscription cleaned up');
});

test('simulateIntercityDelay publishes intercity.eta_updated + waybill.updated on the bus', () => {
  const got: string[] = [];
  const unsub = eventBus.subscribe((type, payload) => {
    if (type === 'intercity.eta_updated' || type === 'waybill.updated') {
      got.push(`${type}:${String(payload?.orderId)}`);
    }
  });
  simulateIntercityDelay(getState(), 2);
  unsub();
  assert.deepEqual(got, ['intercity.eta_updated:ord_intercity_002', 'waybill.updated:ord_intercity_002']);
});

test('simulateIntercityDelay also publishes delivery.delayed so the full tracking set has a demo path', () => {
  const got: string[] = [];
  const unsub = eventBus.subscribe((type) => got.push(type));
  simulateIntercityDelay(getState(), 2);
  unsub();
  assert.deepEqual(got, ['delivery.delayed', 'intercity.eta_updated', 'waybill.updated']);
});

/* ---------------- realtime subscription breadth (ORDER-FLOW + NOTIFICATIONS) ---------------- */

// The widened catalog names typed into the ServerEventType union
// (typechecked in src/store/events.ts — the union + constants compile there).
const WIDENED_CATALOG: ServerEventType[] = [
  'package.scanned',
  'trip.departed',
  'trip.arrived',
  'job.started',
  'job.completed',
  'proof_of_service.submitted',
  'invoice.issued',
  'warranty.issued',
  'dine_in.order_opened',
  'dine_in.paid',
];

test('event bus accepts and delivers the widened logistics/document/dine-in catalog', () => {
  const got: string[] = [];
  const unsub = eventBus.subscribe((type) => got.push(type));
  for (const ev of WIDENED_CATALOG) eventBus.publish(ev);
  unsub();
  assert.deepEqual(got, WIDENED_CATALOG, 'every widened event reaches a subscriber');
  assert.equal(eventBus.size, 0, 'subscription cleaned up');
});

test('TRACKING_EVENTS covers the full customer logistics set', () => {
  const required = [
    'intercity.eta_updated', 'waybill.updated', 'leg.started', 'leg.completed',
    'handoff.completed', 'consignment.departed', 'consignment.arrived',
    'delivery.delayed', 'shipment.frozen', 'plan.replanned', 'warehouse.fulfilled',
    'package.scanned',
  ];
  for (const ev of required) assert.ok(TRACKING_EVENTS.includes(ev), `TRACKING_EVENTS covers ${ev}`);
});

test('BOOKING_EVENTS covers the quote lifecycle, jobs and document events', () => {
  const required = [
    'quote.issued', 'booking.accepted', 'booking.declined', 'booking.reminder',
    'booking.arrived', 'booking.no_show', 'booking.completed',
    'job.started', 'job.completed',
    'proof_of_service.submitted', 'invoice.issued', 'warranty.issued',
  ];
  for (const ev of required) assert.ok(BOOKING_EVENTS.includes(ev), `BOOKING_EVENTS covers ${ev}`);
});

test('ORDER_TAB_EVENTS extends the tab subscription with payment/dispute events', () => {
  for (const ev of ['payment.failed', 'refund.processed', 'dispute.opened', 'dispute.resolved']) {
    assert.ok(ORDER_TAB_EVENTS.includes(ev), `ORDER_TAB_EVENTS covers ${ev}`);
  }
  // The pre-existing order + booking rows stay subscribed.
  for (const ev of ['order.updated', 'order.created', 'order.delivered', 'payment.captured', 'booking.no_show']) {
    assert.ok(ORDER_TAB_EVENTS.includes(ev), `ORDER_TAB_EVENTS keeps ${ev}`);
  }
});

test('publishing intercity.eta_updated triggers the tracking data path (bus + mock repo)', async () => {
  // Mirror tracking.tsx: the live subscription refetches route/waybill/phases.
  let refetches = 0;
  const unsub = eventBus.subscribe((type) => {
    if (type === 'intercity.eta_updated' || type === 'waybill.updated') refetches += 1;
  });

  const before = (await orders.getRoute('ord_intercity_002')).find((l) => l.type === 'linehaul')!.etaAt!;
  const phasesBefore = (await orders.getTrackingPhases('ord_intercity_002')).length;
  const waybillBefore = (await orders.getWaybill('ord_intercity_002')).events.length;

  simulateIntercityDelay(getState(), 2);

  const after = (await orders.getRoute('ord_intercity_002')).find((l) => l.type === 'linehaul')!.etaAt!;
  const waybillAfter = (await orders.getWaybill('ord_intercity_002')).events;

  assert.ok(Date.parse(after) > Date.parse(before), 'the linehaul ETA moved later on refetch');
  assert.equal(waybillAfter.length, waybillBefore + 1, 'waybill trail gained the exception row');
  assert.equal(waybillAfter[waybillAfter.length - 1].type, 'exception');
  assert.ok((await orders.getTrackingPhases('ord_intercity_002')).length === phasesBefore);
  assert.equal(refetches, 2, 'both events fired the refetch handler');
  unsub();
});

/* ---------------- Task 5 — app-foreground unread refresh ---------------- */

test('handleAppForeground refetches both counters and tolerates failures', async () => {
  const calls: string[] = [];
  const counts = await handleAppForeground({
    notifications: async () => {
      calls.push('notifications');
      return 3;
    },
    conversations: async () => {
      calls.push('conversations');
      return 7;
    },
  });
  assert.deepEqual(calls, ['notifications', 'conversations']);
  assert.deepEqual(counts, { notifications: 3, conversations: 7 });
});

test('handleAppForeground keeps last-known counts when a refetcher fails', async () => {
  const counts = await handleAppForeground({
    notifications: async () => {
      throw new Error('offline');
    },
    conversations: async () => 2,
  });
  assert.deepEqual(counts, { conversations: 2 }, 'the failing refetcher contributes nothing');
});

test('foreground refresh pipeline reads real repo counts', async () => {
  const state = getState();
  const unreadBefore = state.notifications.filter((n) => !n.read).length;
  const counts = await handleAppForeground({
    notifications: async () => (await notifications.list({ unreadOnly: true })).length,
    conversations: async () => 0,
  });
  assert.equal(counts.notifications, unreadBefore);
});

/* ---------------- Task 6 — voucher expiring-soon marker ---------------- */

const voucher = (over: Partial<Voucher>): Voucher => ({
  code: 'GB-ABCD-1234',
  groupBuyId: 'gb_001',
  title: 'Deal',
  priceTZS: 12000,
  status: 'unused',
  purchasedAt: new Date(Date.now() - 86400_000).toISOString(),
  ...over,
});

test('voucherExpiresWithin flags only unused vouchers expiring inside the window', () => {
  const within72h = voucher({ expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString() });
  assert.equal(voucherExpiresWithin(within72h, 72 * 3600_000), true);
  assert.equal(voucherExpiresWithin(within72h, 24 * 3600_000), false, 'outside the window');
  const farOut = voucher({ expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() });
  assert.equal(voucherExpiresWithin(farOut, 72 * 3600_000), false);
});

test('voucherExpiresWithin never flags non-unused or expired vouchers', () => {
  const redeemed = voucher({ status: 'redeemed', expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString() });
  assert.equal(voucherExpiresWithin(redeemed, 72 * 3600_000), false, 'redeemed never expires-soon');
  const alreadyExpired = voucher({ status: 'expired', expiresAt: new Date(Date.now() - 86400_000).toISOString() });
  assert.equal(voucherExpiresWithin(alreadyExpired, 72 * 3600_000), false);
  const missingExpiry = voucher({ expiresAt: undefined });
  assert.equal(voucherExpiresWithin(missingExpiry, 72 * 3600_000), false);
});

test('the seeded unused voucher is far from expiry (no hint on the demo row)', () => {
  const seeded = getState().vouchers.find((v) => v.status === 'unused')!;
  assert.equal(voucherExpiresWithin(seeded, 72 * 3600_000), false);
});
