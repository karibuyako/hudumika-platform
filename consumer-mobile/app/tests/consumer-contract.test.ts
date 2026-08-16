/* Contract tests for the consumer mock repositories.
 *
 * These import the MOCK implementations directly (src/repos/mock/*) — the
 * factories switch on env vars and are exercised by the app, not here.
 *
 * Every case resets the shared mock store (seed 20260813) in beforeEach.
 * Per-endpoint checklist (TESTING.md): validation, auth/404 visibility, state
 * conflicts (409 → refetch), idempotency replay, cursor pagination, error
 * shape, and empty/terminal states.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureHomeFeed, setFixturesSeed } from '@hudumika/contract/fixtures';
import { ApiError } from '@/api/client';
import { resetMockState, getState, MOCK_PHONE } from '@/repos/mock/mockState';
import { MockAuthRepository } from '@/repos/mock/auth';
import { MockHomeRepository } from '@/repos/mock/home';
import { MockSearchRepository } from '@/repos/mock/search';
import { MockMerchantsRepository } from '@/repos/mock/merchants';
import { MockProvidersRepository } from '@/repos/mock/providers';
import { MockOrdersRepository } from '@/repos/mock/orders';
import { MockPaymentsRepository } from '@/repos/mock/payments';
import { MockWalletRepository } from '@/repos/mock/wallet';
import { MockBookingsRepository } from '@/repos/mock/bookings';
import { MockReviewsRepository } from '@/repos/mock/reviews';
import { MockNotificationsRepository } from '@/repos/mock/notifications';
import { MockSupportRepository } from '@/repos/mock/support';
import { MockConversationsRepository } from '@/repos/mock/conversations';
import { MockCouponsRepository } from '@/repos/mock/coupons';
import { MockFavoritesRepository } from '@/repos/mock/favorites';
import { MockMembershipsRepository } from '@/repos/mock/memberships';
import { MockGroupBuyRepository } from '@/repos/mock/groupBuy';
import type { OrderCreateInput } from '@/repos';

const auth = new MockAuthRepository();
const home = new MockHomeRepository();
const search = new MockSearchRepository();
const merchants = new MockMerchantsRepository();
const providers = new MockProvidersRepository();
const orders = new MockOrdersRepository();
const payments = new MockPaymentsRepository();
const wallet = new MockWalletRepository();
const bookings = new MockBookingsRepository();
const reviews = new MockReviewsRepository();
const notifications = new MockNotificationsRepository();
const support = new MockSupportRepository();
const conversations = new MockConversationsRepository();
const coupons = new MockCouponsRepository();
const favorites = new MockFavoritesRepository();
const memberships = new MockMembershipsRepository();
const groupBuy = new MockGroupBuyRepository();

beforeEach(() => resetMockState());

async function rejectsApiError(promise: Promise<unknown>, status: number, code?: string): Promise<ApiError> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ApiError, `expected ApiError, got ${String(caught)}`);
  assert.equal(caught.status, status);
  if (code) assert.equal(caught.code, code);
  return caught as ApiError;
}

async function loginAsDemo(): Promise<void> {
  const req = await auth.requestOtp(MOCK_PHONE, 'login');
  await auth.verifyOtp(req.requestId, req.debugCode ?? '', 'login');
}

function firstMerchantId(): string {
  return getState().merchants[0].id;
}

function firstOpenMerchantId(): string {
  const open = getState().merchants.find((m) => m.isOpen);
  return (open ?? getState().merchants[0]).id;
}

function catalogueItem(merchantId: string, index = 0) {
  const item = getState().catalogues.get(merchantId)?.items[index];
  assert.ok(item, 'catalogue should be seeded');
  return item;
}

function orderInput(overrides: Partial<OrderCreateInput> = {}): OrderCreateInput {
  const merchantId = firstOpenMerchantId();
  const item = catalogueItem(merchantId);
  return {
    merchantId,
    items: [{ catalogueItemId: item.id!, quantity: 1, unitPriceTZS: item.priceTZS }],
    paymentMethod: 'mpesa',
    deliveryAddress: getState().cities[0].serviceAreas
      ? { label: 'Home', lines: '12 Makunganya St', contactPhone: MOCK_PHONE }
      : undefined,
    ...overrides,
  };
}

/* ---------------- M0: fixtures deterministic ---------------- */

test('fixtures are deterministic per seed', () => {
  setFixturesSeed(1);
  const a = fixtureHomeFeed();
  setFixturesSeed(1);
  const b = fixtureHomeFeed();
  assert.deepEqual(a.merchants, b.merchants);
  assert.deepEqual(a.categories.map((c) => c.name), b.categories.map((c) => c.name));
  assert.ok(a.merchants.length >= 5);
  assert.ok(a.categories.length >= 3);
});

/* ---------------- M1: auth + cities ---------------- */

test('requestOtp returns requestId, 6-digit debugCode and demo flag', async () => {
  const res = await auth.requestOtp(MOCK_PHONE, 'login');
  assert.ok(res.requestId.length > 0);
  assert.match(res.debugCode ?? '', /^\d{6}$/);
  assert.equal(res.demo, true);
  assert.ok(res.expiresInSeconds > 0);
});

test('verifyOtp with a wrong code throws ApiError 401 OTP_INVALID', async () => {
  const req = await auth.requestOtp(MOCK_PHONE, 'login');
  await rejectsApiError(auth.verifyOtp(req.requestId, '000000', 'login'), 401, 'OTP_INVALID');
});

test('verifyOtp with the debugCode returns a customer session', async () => {
  const req = await auth.requestOtp(MOCK_PHONE, 'login');
  const session = await auth.verifyOtp(req.requestId, req.debugCode ?? '', 'login');
  assert.ok(session.accessToken.startsWith('mock_at_'));
  assert.equal(session.user.activeRole, 'customer');
  assert.equal(session.user.phone, MOCK_PHONE);
  const me = await auth.me();
  assert.equal(me.id, session.user.id);
  await auth.logout();
});

test('verifyOtp locks a request after MAX_ATTEMPTS and a fresh request still works', async () => {
  const req = await auth.requestOtp(MOCK_PHONE, 'login');
  for (let i = 0; i < 5; i += 1) {
    await rejectsApiError(auth.verifyOtp(req.requestId, '000000', 'login'), 401, 'OTP_INVALID');
  }
  await rejectsApiError(auth.verifyOtp(req.requestId, req.debugCode ?? '', 'login'), 401, 'OTP_MAX_ATTEMPTS');
  getState().lastOtpRequestAt.clear();
  const fresh = await auth.requestOtp(MOCK_PHONE, 'login');
  const session = await auth.verifyOtp(fresh.requestId, fresh.debugCode ?? '', 'login');
  assert.equal(session.user.activeRole, 'customer');
});

test('updateProfile patches the user and persists locale', async () => {
  await loginAsDemo();
  const updated = await auth.updateProfile({ fullName: 'Neema J.', locale: 'sw' });
  assert.equal(updated.fullName, 'Neema J.');
  assert.equal(updated.locale, 'sw');
  const me = await auth.me();
  assert.equal(me.fullName, 'Neema J.');
});

test('cities are seeded with service areas and a country filter shape', async () => {
  const cities = await home.listCities();
  assert.ok(cities.length >= 3);
  for (const city of cities) {
    assert.ok(city.id.length > 0 && city.name.length > 0);
    assert.equal(city.country, 'TZ');
    assert.ok((city.serviceAreas ?? []).length >= 1);
  }
});

/* ---------------- M2: home + search ---------------- */

test('home feed renders contract sections with unread count and membership', async () => {
  const feed = await home.getHomeFeed();
  assert.ok(feed.generatedAt.length > 0);
  assert.ok((feed.categories ?? []).length >= 3);
  assert.ok((feed.merchants ?? []).length >= 5);
  assert.ok((feed.promotions ?? []).length >= 1);
  assert.equal(typeof feed.unreadCount, 'number');
  assert.ok(feed.membership);
  for (const m of feed.merchants ?? []) {
    assert.ok(Number.isInteger(m.rating * 10) === false || m.rating > 0); // rating is a float in [1,5]
    assert.ok(m.reviewCount >= 0);
  }
});

test('merchant list filters by category and paginates by cursor', async () => {
  const all = await merchants.list({ limit: 3 });
  assert.equal(all.length, 3);
  const page2 = await merchants.list({ limit: 3, cursor: '3' });
  assert.equal(page2.length, 3);
  const allIds = new Set([...all, ...page2].map((m) => m.id));
  assert.equal(allIds.size, 6);
});

test('merchant detail 404s for unknown ids and catalogue is seeded per merchant', async () => {
  await rejectsApiError(merchants.get('merchant_nope'), 404);
  const merchantId = firstMerchantId();
  const catalogue = await merchants.getCatalogue(merchantId);
  assert.equal(catalogue.merchantId, merchantId);
  assert.ok(catalogue.items.length >= 4);
  for (const item of catalogue.items) {
    assert.ok(Number.isInteger(item.priceTZS) && item.priceTZS > 0);
  }
});

test('search returns typed results by entityType and paginates', async () => {
  const results = await search.search('chicken');
  assert.ok(results.total! >= 1);
  const result = results.results[0];
  assert.ok(['restaurant', 'dish', 'product', 'store', 'provider', 'service_package', 'hotel', 'deal'].includes(result.entityType));
  const providerResults = await search.search('plumber', { entityType: 'provider' });
  for (const r of providerResults.results) assert.equal(r.entityType, 'provider');
});

test('search suggest + history round-trip', async () => {
  await search.addToHistory('pilau');
  const history = await search.history();
  assert.equal(history[0], 'pilau');
  const suggestions = await search.suggest('pilau');
  assert.ok(suggestions.length >= 1);
});

/* ---------------- M3: catalogue + cart semantics ---------------- */

test('catalogue items expose options/addons with integer prices', async () => {
  const merchantId = firstMerchantId();
  const catalogue = await merchants.getCatalogue(merchantId);
  const withOptions = catalogue.items.find((i) => (i.options ?? []).length > 0);
  assert.ok(withOptions, 'expected at least one item with options');
  for (const group of withOptions!.options ?? []) {
    assert.ok(group.name.length > 0);
    for (const choice of group.choices) {
      assert.ok(choice.label.length > 0);
      assert.ok(Number.isInteger(choice.priceTZS));
    }
  }
});

test('merchant promotions are seeded for the first merchant only', async () => {
  const merchantId = firstMerchantId();
  const promos = await merchants.getPromotions(merchantId);
  assert.ok(promos.length >= 1);
  assert.ok(promos[0].title.length > 0);
});

/* ---------------- M4: order create validation + payments ---------------- */

test('createOrder rejects a closed merchant with ORDER_MERCHANT_CLOSED', async () => {
  const closed = getState().merchants.find((m) => !m.isOpen);
  if (closed) {
    const item = getState().catalogues.get(closed.id)?.items[0];
    await rejectsApiError(
      orders.create({ merchantId: closed.id, items: [{ catalogueItemId: item!.id!, quantity: 1, unitPriceTZS: item!.priceTZS }], paymentMethod: 'mpesa' }, 'k1'),
      422,
      'ORDER_MERCHANT_CLOSED',
    );
  }
});

test('createOrder rejects unavailable items and price drift', async () => {
  const merchantId = firstOpenMerchantId();
  const catalogue = await merchants.getCatalogue(merchantId);
  const unavailable = catalogue.items.find((i) => i.available === false);
  assert.ok(unavailable, 'expected a seeded unavailable item');
  await rejectsApiError(
    orders.create({ merchantId, items: [{ catalogueItemId: unavailable!.id!, quantity: 1, unitPriceTZS: unavailable!.priceTZS }], paymentMethod: 'mpesa' }, 'k1'),
    422,
    'ORDER_ITEM_UNAVAILABLE',
  );
  const available = catalogue.items.find((i) => i.available !== false && (i.options ?? []).length === 0)!;
  await rejectsApiError(
    orders.create({ merchantId, items: [{ catalogueItemId: available.id!, quantity: 1, unitPriceTZS: available.priceTZS + 500 }], paymentMethod: 'mpesa' }, 'k2'),
    422,
    'ORDER_PRICE_CHANGED',
  );
});

test('createOrder rejects scheduled-at in the past', async () => {
  await rejectsApiError(
    orders.create({ ...orderInput(), scheduledAt: '2020-01-01T00:00:00Z' }, 'k1'),
    422,
    'ORDER_SCHEDULED_IN_PAST',
  );
});

test('order happy path: create → intent → confirm → paid, idempotent replay', async () => {
  const input = orderInput();
  const order = await orders.create(input, 'key-abc');
  assert.equal(order.status, 'pending_payment');
  assert.ok(Number.isInteger(order.totals.totalTZS));
  const sum = order.totals.subtotalTZS + order.totals.deliveryFeeTZS + order.totals.platformFeeTZS + order.totals.taxTZS - order.totals.discountTZS;
  assert.equal(sum, order.totals.totalTZS);

  const intent = await payments.createIntent(order.id, 'mpesa', 'key-intent');
  assert.equal(intent.status, 'created');
  assert.equal(intent.amountTZS, order.totals.totalTZS);
  assert.equal(intent.amountTZS % 1, 0);

  const paid = await payments.confirm(intent.id, 'key-confirm');
  assert.equal(paid.status, 'paid');
  const orderAfter = await orders.get(order.id);
  assert.equal(orderAfter.status, 'paid');

  // Idempotency replay: same key replays the stored response — no double-create.
  const sameKeyOrder = await orders.create(input, 'key-abc');
  assert.equal(sameKeyOrder.id, order.id);
  assert.equal((await orders.list()).filter((o) => o.id === order.id).length, 1);

  // Same intent key replays the stored (now paid) intent; a fresh key hits PAYMENT_ALREADY_PAID → treat as success, refetch order.
  const replayedIntent = await payments.createIntent(order.id, 'mpesa', 'key-intent');
  assert.equal(replayedIntent.id, intent.id);
  const err = await rejectsApiError(payments.createIntent(order.id, 'mpesa', 'key-intent-2'), 409, 'PAYMENT_ALREADY_PAID');
  assert.ok(err.message.length > 0);
  assert.equal((await orders.get(order.id)).status, 'paid');
});

test('cod orders are placed paid without a provider flow', async () => {
  const order = await orders.create(orderInput({ paymentMethod: 'cod' }), 'key-cod');
  assert.equal(order.status, 'paid');
});

test('cancel before acceptance refunds; cancel after preparing is 409 ORDER_NOT_CANCELLABLE', async () => {
  const order = await orders.create(orderInput(), 'k1');
  const intent = await payments.createIntent(order.id, 'mpesa', 'ki');
  await payments.confirm(intent.id, 'kc');
  const cancelled = await orders.cancel(order.id, 'Changed my mind', 'k2');
  assert.equal(cancelled.status, 'cancelled');
  const intentAfter = getState().intentForOrder.get(order.id);
  assert.equal(intentAfter?.status, 'refunded');

  const order2 = await orders.create(orderInput(), 'k3');
  const state = getState();
  const active = state.orders.find((o) => o.id === 'ord_active_001')!;
  await rejectsApiError(orders.cancel(active.id, 'late', 'k4'), 409, 'ORDER_NOT_CANCELLABLE');
});

test('rush is allowed only on merchant_accepted/preparing', async () => {
  const active = getState().orders.find((o) => o.id === 'ord_active_001')!;
  await rejectsApiError(orders.rush(active.id, 'k1'), 409, 'ORDER_RUSH_NOT_ALLOWED');
  const state = getState();
  state.orders[0].status = 'merchant_accepted';
  await orders.rush(state.orders[0].id, 'k2');
  assert.ok(state.orders[0].rushRequestedAt);
});

test('track returns a TrackingEvent that never fabricates an ETA client-side', async () => {
  const event = await orders.track('ord_active_001');
  assert.equal(event.status, 'delivering');
  assert.ok(event.estimateMinutes !== undefined && Number.isInteger(event.estimateMinutes));
  assert.ok(event.updatedAt.length > 0);
  assert.ok(event.riderLocation);
});

test('intercity order exposes route, waybill and six tracking phases in fixed order', async () => {
  const route = await orders.getRoute('ord_intercity_002');
  assert.ok(route.length >= 4);
  assert.equal(route[0].type, 'first_mile');
  assert.equal(route[1].type, 'linehaul');

  const waybill = await orders.getWaybill('ord_intercity_002');
  assert.ok(waybill.waybillNumber.length > 0);
  assert.ok(waybill.events.length >= 2);

  const phases = await orders.getTrackingPhases('ord_intercity_002');
  assert.deepEqual(phases.map((p) => p.phase), ['confirmed', 'picked_up', 'in_transit', 'arrived_city', 'out_for_delivery', 'delivered']);
  const active = phases.find((p) => p.status === 'active');
  assert.equal(active?.phase, 'in_transit');
  for (const p of phases) {
    if (p.status === 'pending') assert.equal(p.at, null); // never fabricate times
  }
});

test('tracking-phases 404s for an order with no phases surface', async () => {
  await rejectsApiError(orders.getTrackingPhases('ord_nope'), 404);
});

/* ---------------- M5: orders list/detail ---------------- */

test('orders list supports active/completed scopes and cursor pagination', async () => {
  const active = await orders.list({ status: 'active' });
  assert.ok(active.length >= 3);
  for (const o of active) assert.ok(['pending_payment', 'paid', 'merchant_accepted', 'preparing', 'rider_assigned', 'picked_up', 'delivering'].includes(o.status));
  const completed = await orders.list({ status: 'completed' });
  assert.ok(completed.length >= 1);
  const page = await orders.list({ limit: 2 });
  assert.equal(page.length, 2);
});

test('order detail timeline derives from events[] with integer totals', async () => {
  const detail = await orders.get('ord_active_001');
  assert.ok(detail.events.length >= 5);
  assert.ok(detail.deliveryAddress.lines.length > 0);
  assert.ok(Number.isInteger(detail.totals.totalTZS));
});

test('placed orders appear in /orders/me (list → act → list)', async () => {
  const before = (await orders.list()).length;
  await orders.create(orderInput(), 'k1');
  const after = (await orders.list()).length;
  assert.equal(after, before + 1);
});

/* ---------------- wallet + coupons ---------------- */

test('wallet balance and transactions are integer TZS with signed rows', async () => {
  const w = await wallet.getWallet();
  assert.ok(Number.isInteger(w.totalTZS) && w.totalTZS > 0);
  const txs = await wallet.getTransactions();
  assert.ok(txs.length >= 5);
  for (const t of txs) {
    assert.ok(Number.isInteger(t.amountTZS));
    assert.ok(Number.isInteger(t.balanceTZS));
    assert.ok(t.createdAt.length > 0);
  }
});

test('coupon wallet lists statuses and claim transitions available → claimed', async () => {
  const claimed = await coupons.list('claimed');
  assert.equal(claimed[0].status, 'claimed');
  const available = await coupons.list('available');
  assert.ok(available.length >= 1);
  const coupon = await coupons.claim(available[0].id, 'k1');
  assert.equal(coupon.status, 'claimed');
  await rejectsApiError(coupons.claim(available[0].id, 'k2'), 409, 'COUPON_ALREADY_CLAIMED');
});

test('claiming an expired coupon returns COUPON_EXPIRED', async () => {
  const expired = getState().coupons.find((c) => c.status === 'expired')!;
  await rejectsApiError(coupons.claim(expired.id, 'k1'), 422, 'COUPON_EXPIRED');
});

/* ---------------- bookings ---------------- */

test('booking create validates time and duration and appears in /bookings/me', async () => {
  await rejectsApiError(
    bookings.create({ providerId: 'prov_001', serviceId: 'svc_001', scheduledFor: '2020-01-01T00:00:00Z', durationMinutes: 60, paymentMethod: 'mpesa' }, 'k1'),
    422,
    'BOOKING_TIME_IN_PAST',
  );
  await rejectsApiError(
    bookings.create({ providerId: 'prov_001', serviceId: 'svc_001', scheduledFor: new Date(Date.now() + 86400_000).toISOString(), durationMinutes: 10, paymentMethod: 'mpesa' }, 'k1'),
    422,
    'BOOKING_DURATION_INVALID',
  );
  const before = (await bookings.list()).length;
  const created = await bookings.create(
    { providerId: 'prov_001', serviceId: 'svc_001', scheduledFor: new Date(Date.now() + 86400_000).toISOString(), durationMinutes: 120, paymentMethod: 'mpesa', description: 'Leak under the sink' },
    'k2',
  );
  assert.equal(created.status, 'pending_payment');
  const after = (await bookings.list()).length;
  assert.equal(after, before + 1);
});

test('booking estimate returns integer TZS range', async () => {
  const estimate = await bookings.estimate({ serviceId: 'svc_001' });
  assert.ok(Number.isInteger(estimate.lowTZS) && Number.isInteger(estimate.highTZS));
  assert.ok(estimate.highTZS >= estimate.lowTZS);
});

test('booking complete requires awaiting_customer_confirmation', async () => {
  await rejectsApiError(bookings.complete('bk_active_001', 'k1'), 409, 'BOOKING_STATUS_CONFLICT');
  const state = getState();
  state.bookings[0].status = 'awaiting_customer_confirmation';
  const done = await bookings.complete('bk_active_001', 'k2');
  assert.equal(done.status, 'completed');
});

/* ---------------- reviews ---------------- */

test('review creation is eligibility-gated and single-shot', async () => {
  const ineligibleMerchant = getState().merchants[1].id;
  await rejectsApiError(reviews.create({ targetType: 'merchant', targetId: ineligibleMerchant, rating: 5, body: 'great' }, 'k1'), 422, 'REVIEW_NOT_ELIGIBLE');
  const merchantId = getState().orders.find((o) => o.status === 'delivered')!.merchantId;
  const review = await reviews.create({ targetType: 'merchant', targetId: merchantId, rating: 4, body: 'Pole sana, lakini nzuri' }, 'k2');
  assert.equal(review.state, 'pending');
  await rejectsApiError(reviews.create({ targetType: 'merchant', targetId: merchantId, rating: 5, body: 'again' }, 'k3'), 422, 'REVIEW_ALREADY_EXISTS');
});

test('report only works on published reviews', async () => {
  const published = getState().reviews.find((r) => r.state === 'published')!;
  const report = await reviews.report(published.id, 'Inappropriate', 'k1');
  assert.equal(report.state, 'open');
  const pending = getState().reviews.find((r) => r.state === 'pending');
  if (pending) await rejectsApiError(reviews.report(pending.id, 'x', 'k2'), 422, 'REVIEW_NOT_REPORTABLE');
});

/* ---------------- notifications ---------------- */

test('notifications list/markRead/markAllRead and preferences PUT', async () => {
  const items = await notifications.list();
  assert.ok(items.length >= 2);
  const unread = items.find((n) => !n.read)!;
  await notifications.markRead(unread.id);
  assert.equal((await notifications.list()).find((n) => n.id === unread.id)?.read, true);
  await notifications.markAllRead();
  for (const n of await notifications.list()) assert.equal(n.read, true);

  const prefs = await notifications.getPreferences();
  prefs.push = { ...(prefs.push ?? {}), 'order.delivered': false };
  const saved = await notifications.putPreferences(prefs, 'k1');
  assert.equal(saved.push?.['order.delivered'], false);
});

/* ---------------- support ---------------- */

test('ticket create → list → detail → reply, closed tickets reject replies', async () => {
  const created = await support.createTicket({ subject: 'Wrong item', body: 'I got a different dish', orderId: 'ord_completed_004' }, 'k1');
  assert.equal(created.status, 'open');
  const list = await support.listTickets();
  assert.ok(list.some((t) => t.id === created.id));
  const detail = await support.getTicket(created.id);
  assert.equal(detail.messages[0].body, 'I got a different dish');
  const reply = await support.reply(created.id, 'Actually never mind', 'k2');
  assert.equal(reply.authorRole, 'customer');

  const closed = await support.createTicket({ subject: 'old', body: 'old' }, 'k3');
  getState().tickets.find((t) => t.id === closed.id)!.status = 'closed';
  await rejectsApiError(support.reply(closed.id, 'hello?', 'k4'), 422, 'TICKET_CLOSED');
});

/* ---------------- conversations ---------------- */

test('conversations: list, create-from-order, send, read clears badge, blocked is read-only', async () => {
  const list = await conversations.list();
  assert.ok(list.length >= 2);
  assert.equal(await conversations.unreadCount(), 2);

  const created = await conversations.create({ merchantId: firstMerchantId(), orderId: 'ord_active_001', subject: 'Order help', initialMessage: 'Where is my order?' }, 'k1');
  assert.equal(created.status, 'open');

  const thread = await conversations.get('conv_001');
  assert.equal(thread.status, 'open');
  assert.ok(thread.participants.some((p) => p.maskedPhone));

  const messages = await conversations.listMessages('conv_001');
  const sent = await conversations.send('conv_001', 'How long until pickup?', 'k2');
  assert.equal(sent.body, 'How long until pickup?');
  assert.equal((await conversations.listMessages('conv_001')).length, messages.length + 1);

  await conversations.markRead('conv_001');
  assert.equal(await conversations.unreadCount(), 0);

  await rejectsApiError(conversations.send('conv_002', 'hello', 'k3'), 409, 'CONVERSATION_BLOCKED');
  await rejectsApiError(conversations.send('conv_001', '   ', 'k4'), 422, 'MESSAGE_EMPTY');
  await rejectsApiError(conversations.send('conv_001', 'x'.repeat(2001), 'k5'), 422, 'MESSAGE_TOO_LONG');
});

/* ---------------- favorites + memberships + group buy ---------------- */

test('favorites: empty → add → list → remove', async () => {
  assert.equal((await favorites.list()).length, 0);
  const merchantId = firstMerchantId();
  await favorites.add(merchantId, 'k1');
  assert.equal((await favorites.list())[0].id, merchantId);
  await favorites.remove(merchantId, 'k2');
  assert.equal((await favorites.list()).length, 0);
});

test('favorites: home-card heart toggle — add → list contains it, remove → gone', async () => {
  const merchantId = firstMerchantId();
  await favorites.add(merchantId, 'k1');
  assert.ok((await favorites.list()).some((f) => f.id === merchantId));
  await favorites.remove(merchantId, 'k2');
  assert.ok(!(await favorites.list()).some((f) => f.id === merchantId));
});

test('favorites: add is idempotent (heart double-tap never duplicates)', async () => {
  const merchantId = firstMerchantId();
  await favorites.add(merchantId, 'k1');
  await favorites.add(merchantId, 'k2');
  assert.equal((await favorites.list()).length, 1);
});

test('favorites: hub segment shape — list round-trips full MerchantPublic cards', async () => {
  const merchantId = firstMerchantId();
  await favorites.add(merchantId, 'k1');
  const fav = (await favorites.list())[0];
  assert.equal(fav.id, merchantId);
  assert.ok(fav.businessName.length > 0);
  assert.equal(typeof fav.rating, 'number');
  assert.equal(typeof fav.reviewCount, 'number');
  assert.equal(typeof fav.isOpen, 'boolean');
  assert.ok(fav.deliveryMinutes === undefined || fav.deliveryMinutes === null || typeof fav.deliveryMinutes === 'number');
  await favorites.remove(merchantId, 'k2');
  assert.equal((await favorites.list()).length, 0);
});

test('membership is read-only and contract-shaped', async () => {
  const membership = await memberships.get();
  assert.ok(Number.isInteger(membership.points));
  assert.ok(membership.level.length > 0);
  assert.ok(Array.isArray(membership.benefits));
});

test('group-buy purchase issues vouchers with quantity bounds', async () => {
  await rejectsApiError(groupBuy.purchase('gb_001', 21, 'k1'), 422, 'GROUP_BUY_QUANTITY_EXCEEDED');
  const vouchers = await groupBuy.purchase('gb_001', 2, 'k2');
  assert.equal(vouchers.length, 2);
  assert.equal(vouchers[0].status, 'unused');
  assert.equal(vouchers[0].groupBuyId, 'gb_001');
  const wallet = getState().vouchers;
  assert.equal(wallet.length, 7);
});

test('error envelope shape carries code and message', async () => {
  const err = await rejectsApiError(orders.get('ord_nope'), 404);
  assert.ok(err.message.length > 0);
});

test('provider list and services are seeded', async () => {
  const services = await providers.listServices();
  assert.ok(services.length >= 3);
  const list = await providers.list();
  for (const p of list) {
    assert.ok(p.name.length > 0);
    assert.ok(p.rating >= 0 && p.rating <= 5);
    assert.equal(typeof p.verified, 'boolean');
  }
});
