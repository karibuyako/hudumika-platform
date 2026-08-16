/* Contract tests for the rider mock repositories.
 *
 * These import the MOCK implementations directly (src/repos/mock/*) — the
 * factories switch on env vars and are exercised by the app, not here.
 *
 * Every case resets the shared mock store (seed 20260813) in beforeEach.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setFixturesSeed, fixtureRiderProfile } from '@hudumika/contract/fixtures';
import { ApiError } from '@/api/client';
import { resetMockState, expireOffer, MOCK_PICKUP_CODE } from '@/repos/mock/mockState';
import { MockAuthRepository } from '@/repos/mock/auth';
import { MockRiderRepository } from '@/repos/mock/rider';
import { MockJobsRepository } from '@/repos/mock/jobs';
import { MockDeliveryRepository } from '@/repos/mock/delivery';
import { MockEarningsRepository } from '@/repos/mock/earnings';
import { MockNotificationsRepository } from '@/repos/mock/notifications';
import { MockSupportRepository } from '@/repos/mock/support';
import { MockPaymentRepository } from '@/repos/mock/payments';
import type { RiderAdvanceableStatus } from '@/repos';

const auth = new MockAuthRepository();
const rider = new MockRiderRepository();
const jobs = new MockJobsRepository();
const delivery = new MockDeliveryRepository();
const earnings = new MockEarningsRepository();
const notifications = new MockNotificationsRepository();
const support = new MockSupportRepository();
const payments = new MockPaymentRepository();

const RIDER_FLOW: RiderAdvanceableStatus[] = ['rider_arrived_pickup', 'picked_up', 'delivering', 'rider_arrived_dropoff', 'delivered'];

beforeEach(() => resetMockState());

async function firstOrderId(): Promise<string> {
  const feed = await jobs.listAvailableOrders();
  assert.ok(feed.length > 0, 'feed should be seeded');
  return feed[0].orderId;
}

async function acceptFirst(): Promise<string> {
  const orderId = await firstOrderId();
  const res = await jobs.respondOffer(orderId, 'accept');
  assert.equal(res.accepted, true);
  assert.ok(res.order);
  return orderId;
}

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

test('fixtures are deterministic per seed', () => {
  setFixturesSeed(1);
  const a = fixtureRiderProfile();
  setFixturesSeed(1);
  const b = fixtureRiderProfile();
  assert.deepEqual(a, b);
});

test('requestOtp returns requestId, 6-digit debugCode and demo flag', async () => {
  const res = await auth.requestOtp('+255700000000', 'login');
  assert.ok(res.requestId.length > 0);
  assert.match(res.debugCode ?? '', /^\d{6}$/);
  assert.equal(res.demo, true);
  assert.ok(res.expiresInSeconds > 0);
});

test('verifyOtp with a wrong code throws ApiError 401 OTP_INVALID', async () => {
  const req = await auth.requestOtp('+255700000000', 'login');
  await rejectsApiError(auth.verifyOtp(req.requestId, '000000', 'login'), 401, 'OTP_INVALID');
});

test('verifyOtp with the debugCode returns a session with a rider profile', async () => {
  const req = await auth.requestOtp('+255700000000', 'login');
  const session = await auth.verifyOtp(req.requestId, req.debugCode ?? '', 'login');
  assert.ok(session.accessToken.startsWith('mock_at_'));
  assert.equal(session.user.role, 'rider');
  assert.ok(session.rider, 'session should carry the rider profile');
  assert.equal(session.rider.online, false);
  const me = await auth.me();
  assert.equal(me.user.id, session.rider.id);
  await auth.logout();
});

test('getProfile returns a RiderPrivate that is offline by default', async () => {
  const profile = await rider.getProfile();
  assert.equal(profile.online, false);
  assert.ok(profile.id.length > 0);
  assert.ok(profile.verification.length > 0);
});

test('setAvailability(true) flips the rider online', async () => {
  await rider.setAvailability(true);
  const profile = await rider.getProfile();
  assert.equal(profile.online, true);
  assert.ok(profile.onlineSince);
  await rider.setAvailability(false);
  const back = await rider.getProfile();
  assert.equal(back.online, false);
  assert.equal(back.onlineSince, null);
});

test('being offline does not hide the dispatch feed', async () => {
  assert.equal((await rider.getProfile()).online, false);
  const feed = await jobs.listAvailableOrders();
  assert.equal(feed.length, 5);
  for (const item of feed) {
    assert.ok(item.orderId.length > 0);
    assert.ok(item.offer.estimatedEarningsTZS > 0);
    assert.ok(item.expiresAt > Date.now());
  }
});

test('accepting an offer creates a rider_assigned order and removes it from the feed', async () => {
  const orderId = await acceptFirst();
  const order = await delivery.getOrder(orderId);
  assert.equal(order.status, 'rider_assigned');
  assert.equal(order.riderId, (await rider.getProfile()).id);
  assert.equal(order.version, 1);
  const feed = await jobs.listAvailableOrders();
  assert.equal(feed.some((i) => i.orderId === orderId), false);
});

test('rejecting an offer keeps it out of the feed and records the reason', async () => {
  const orderId = await firstOrderId();
  const res = await jobs.respondOffer(orderId, 'reject', 'Traffic');
  assert.equal(res.accepted, false);
  const feed = await jobs.listAvailableOrders();
  assert.equal(feed.length, 4);
  assert.equal(feed.some((i) => i.orderId === orderId), false);
  const order = await delivery.getOrder(orderId);
  assert.ok(['paid', 'merchant_accepted', 'preparing'].includes(order.status));
  assert.equal(order.rejectReason, 'Traffic');
});

test('advance() walks the full 5-step rider flow', async () => {
  const orderId = await acceptFirst();
  for (const status of RIDER_FLOW) {
    const order = await delivery.advance(orderId, status, { pickupCode: MOCK_PICKUP_CODE });
    assert.equal(order.status, status);
  }
  const done = await delivery.getOrder(orderId);
  assert.equal(done.status, 'delivered');
  assert.ok(done.completedAt);
});

test('advance() out of sequence throws ApiError 409', async () => {
  const orderId = await acceptFirst();
  await rejectsApiError(delivery.advance(orderId, 'picked_up'), 409, 'INVALID_STATUS_TRANSITION');
});

test('advance() with a stale expectedVersion throws ApiError 409 VERSION_CONFLICT', async () => {
  const orderId = await acceptFirst();
  await rejectsApiError(delivery.advance(orderId, 'rider_arrived_pickup', { expectedVersion: 0 }), 409, 'VERSION_CONFLICT');
  await delivery.advance(orderId, 'rider_arrived_pickup', { expectedVersion: 1 });
  await rejectsApiError(delivery.advance(orderId, 'picked_up', { expectedVersion: 1, pickupCode: MOCK_PICKUP_CODE }), 409, 'VERSION_CONFLICT');
  const order = await delivery.advance(orderId, 'picked_up', { expectedVersion: 2, pickupCode: MOCK_PICKUP_CODE });
  assert.equal(order.version, 3);
});

/* ---------- pickup confirmation (mock-only merchant code) ---------- */

test('picked_up without a code or note throws 422 PICKUP_CODE_REQUIRED', async () => {
  const orderId = await acceptFirst();
  await delivery.advance(orderId, 'rider_arrived_pickup');
  const err = await rejectsApiError(delivery.advance(orderId, 'picked_up'), 422, 'PICKUP_CODE_REQUIRED');
  assert.equal(err.details?.expectedTZS, undefined);
  assert.equal((await delivery.getOrder(orderId)).status, 'rider_arrived_pickup');
});

test('picked_up with a wrong code throws 422 PICKUP_CODE_INVALID and keeps the stage', async () => {
  const orderId = await acceptFirst();
  await delivery.advance(orderId, 'rider_arrived_pickup');
  await rejectsApiError(delivery.advance(orderId, 'picked_up', { pickupCode: '0000' }), 422, 'PICKUP_CODE_INVALID');
  assert.equal((await delivery.getOrder(orderId)).status, 'rider_arrived_pickup');
});

test('picked_up with the merchant code succeeds', async () => {
  const orderId = await acceptFirst();
  await delivery.advance(orderId, 'rider_arrived_pickup');
  const order = await delivery.advance(orderId, 'picked_up', { pickupCode: MOCK_PICKUP_CODE });
  assert.equal(order.status, 'picked_up');
});

test('picked_up with a manual note succeeds without a code and records the note', async () => {
  const orderId = await acceptFirst();
  await delivery.advance(orderId, 'rider_arrived_pickup');
  const order = await delivery.advance(orderId, 'picked_up', { note: 'Merchant could not provide the code' });
  assert.equal(order.status, 'picked_up');
  const event = order.events.find((e) => e.status === 'picked_up');
  assert.equal(event?.note, 'Merchant could not provide the code');
});

/* ---------- collection QR (COD) ---------- */

test('createCollectionQr defaults to the order total and is COD-shaped', async () => {
  const orderId = await acceptFirst();
  const order = await delivery.getOrder(orderId);
  const qr = await payments.createCollectionQr(orderId);
  assert.equal(qr.qrPayload, `mock-qr-payload-${orderId}`);
  assert.equal(qr.provider, 'mpesa');
  assert.equal(qr.amountTZS, order.totals.totalTZS);
  assert.ok(qr.merchantRef.length > 0);
  assert.ok(new Date(qr.expiresAt).getTime() > Date.now());
});

test('createCollectionQr honours an explicit amount', async () => {
  const orderId = await acceptFirst();
  const qr = await payments.createCollectionQr(orderId, { amountTZS: 1500 });
  assert.equal(qr.amountTZS, 1500);
});

test('createCollectionQr on an unknown order throws 404 ORDER_NOT_FOUND', async () => {
  await rejectsApiError(payments.createCollectionQr('order_nope'), 404, 'ORDER_NOT_FOUND');
});

test('fare breakdown satisfies the sum rule with integer TZS', async () => {
  const orderId = await acceptFirst();
  const fare = await delivery.getFare(orderId);
  const parts = [fare.baseTZS, fare.distanceTZS, fare.timeTZS, fare.surgeTZS, fare.tipTZS, fare.codFeeTZS, fare.waitPayTZS, fare.bonusTZS];
  const sum = parts.reduce((acc, p) => acc + (p ?? 0), 0);
  assert.equal(sum, fare.totalTZS);
  for (const p of parts) assert.ok(Number.isInteger(p));
  assert.ok(Number.isInteger(fare.totalTZS));
  assert.ok(fare.totalTZS > 0);
  assert.equal(fare.orderId, orderId);
});

test('submitPOD at the wrong stage throws ApiError 409', async () => {
  const orderId = await acceptFirst();
  await rejectsApiError(delivery.submitPOD(orderId, { type: 'photo', value: 'data:image/png;base64,abc' }), 409, 'INVALID_STAGE');
});

test('submitPOD at rider_arrived_dropoff delivers and credits a delivery_fee ledger entry', async () => {
  const orderId = await acceptFirst();
  await delivery.advance(orderId, 'rider_arrived_pickup');
  await delivery.advance(orderId, 'picked_up', { pickupCode: MOCK_PICKUP_CODE });
  await delivery.advance(orderId, 'delivering');
  await delivery.advance(orderId, 'rider_arrived_dropoff');
  const before = await earnings.getStatement();
  const order = await delivery.submitPOD(orderId, { type: 'otp', value: '123456', dropoffOption: 'hand_to_customer' });
  assert.equal(order.status, 'delivered');
  const after = await earnings.getStatement();
  const newEntries = after.slice(0, Math.max(0, after.length - before.length));
  const credit = newEntries.find((e) => e.type === 'delivery_fee' && e.referenceId === orderId);
  assert.ok(credit, 'expected a +delivery_fee ledger entry for this order');
  assert.ok(credit.amountTZS > 0);
  const wallet = await earnings.getWallet();
  assert.ok(wallet.balanceTZS > 0);
});

test('failDelivery marks the order failed with the reason', async () => {
  const orderId = await acceptFirst();
  const order = await delivery.failDelivery(orderId, 'Customer unreachable');
  assert.equal(order.status, 'failed_delivery');
  assert.equal(order.rejectReason, 'Customer unreachable');
});

test('reschedule sets scheduledAt and status rescheduled', async () => {
  const orderId = await acceptFirst();
  const order = await delivery.reschedule(orderId, '2026-08-14T12:00:00Z');
  assert.equal(order.status, 'rescheduled');
  assert.equal(order.scheduledAt, '2026-08-14T12:00:00Z');
});

test('transfer hands the order back to dispatch', async () => {
  const orderId = await acceptFirst();
  await delivery.advance(orderId, 'rider_arrived_pickup');
  await delivery.advance(orderId, 'picked_up', { pickupCode: MOCK_PICKUP_CODE });
  const order = await delivery.transfer(orderId, 'Bike breakdown');
  assert.equal(order.riderId, null);
  assert.equal(order.status, 'preparing');
  const feed = await jobs.listAvailableOrders();
  assert.equal(feed.some((i) => i.orderId === orderId), true);
});

test('clock in/out lifecycle produces an active then a completed shift with earnings', async () => {
  const current = await rider.listShifts('current');
  assert.equal(current.length, 0);
  const active = await rider.clockIn();
  assert.equal(active.status, 'active');
  assert.ok(active.clockedInAt);
  const currentAfter = await rider.listShifts('current');
  assert.equal(currentAfter.length, 1);
  const done = await rider.clockOut();
  assert.equal(done.status, 'completed');
  assert.ok(done.clockedOutAt);
  assert.ok(done.earningsTZS !== undefined && Number.isInteger(done.earningsTZS) && done.earningsTZS >= 0);
  const history = await rider.listShifts('history');
  assert.equal(history.length, 1);
  assert.equal(history[0].id, done.id);
});

test('missions are contract-shaped and expose canClaim', async () => {
  const missions = await rider.listMissions();
  assert.ok(missions.length >= 3);
  const claimable = missions.find((m) => m.canClaim === true);
  assert.ok(claimable, 'expected at least one claimable mission');
  assert.equal(claimable.status, 'active');
  assert.ok(claimable.rewardTZS > 0);
  for (const m of missions) {
    assert.ok(m.id.length > 0 && m.title.length > 0);
    assert.equal(typeof m.targetDeliveries, 'number');
    assert.ok(['active', 'completed', 'expired'].includes(m.status));
  }
});

test('requestPayout succeeds within balance and throws 422 beyond it', async () => {
  const wallet = await earnings.getWallet();
  const amount = Math.max(1, Math.floor(wallet.availableTZS / 2));
  await earnings.requestPayout(amount);
  const walletAfter = await earnings.getWallet();
  assert.equal(walletAfter.availableTZS, wallet.availableTZS - amount);
  assert.equal(walletAfter.balanceTZS, wallet.balanceTZS - amount);
  const payouts = await earnings.listPayouts();
  assert.equal(payouts[0].amountTZS, amount);
  await rejectsApiError(earnings.requestPayout(walletAfter.availableTZS + 1), 422, 'INSUFFICIENT_BALANCE');
});

test('notifications list, markRead and markAllRead behave', async () => {
  const items = await notifications.list();
  assert.ok(items.length >= 3);
  const unread = items.find((n) => !n.read);
  assert.ok(unread);
  assert.ok(unread.deepLink, 'seeded notifications carry deep links');
  await notifications.markRead(unread.id);
  const after = await notifications.list();
  assert.equal(after.find((n) => n.id === unread.id)?.read, true);
  await notifications.markAllRead();
  for (const n of await notifications.list()) assert.equal(n.read, true);
});

test('reject-reasons are non-empty strings and masked calls are shaped', async () => {
  const reasons = await rider.listRejectReasons();
  assert.ok(reasons.length >= 3);
  for (const r of reasons) assert.ok(typeof r === 'string' && r.length > 0);
  const orderId = await acceptFirst();
  const call = await delivery.createMaskedCall(orderId);
  assert.match(call.maskedNumber, /^\+2557\d{9}$/);
  assert.equal(call.orderId, orderId);
  assert.ok(call.sessionId.length > 0);
});

test('derived data: today summary, performance and heatmap are well-formed', async () => {
  const summary = await earnings.getTodaySummary();
  assert.ok(Number.isInteger(summary.earningsTZS) && summary.earningsTZS >= 0);
  assert.ok(Number.isInteger(summary.deliveries) && summary.deliveries >= 0);
  assert.ok(Number.isInteger(summary.onlineMinutes) && summary.onlineMinutes >= 0);

  const perf = await rider.getPerformance();
  assert.ok(perf.acceptanceRate >= 0 && perf.acceptanceRate <= 100);
  assert.ok(perf.onTimePct >= 0 && perf.onTimePct <= 100);
  assert.ok(perf.ratingAverage > 0);
  assert.ok(perf.completedOrders > 0);

  const zones = await jobs.getHeatmap();
  assert.ok(zones.length >= 3);
  for (const zone of zones) {
    assert.ok(zone.zoneId.length > 0 && zone.name.length > 0);
    assert.ok(['low', 'medium', 'high', 'critical'].includes(zone.demandLevel));
    assert.ok(zone.surgeMultiplier !== undefined && zone.surgeMultiplier >= 1);
    for (const point of zone.polygon ?? []) {
      const [lat, lon] = point.split(',').map(Number);
      assert.ok(Number.isFinite(lat) && Number.isFinite(lon));
    }
  }
});

/* ---------- M3: offer expiry ---------- */

test('expired offers are dropped from the feed', async () => {
  const feed = await jobs.listAvailableOrders();
  const target = feed[0].orderId;
  expireOffer(target);
  const after = await jobs.listAvailableOrders();
  assert.equal(after.length, feed.length - 1);
  assert.equal(after.some((i) => i.orderId === target), false);
});

test('accepting an expired offer throws 409 OFFER_NOT_AVAILABLE', async () => {
  const orderId = await firstOrderId();
  expireOffer(orderId);
  await rejectsApiError(jobs.respondOffer(orderId, 'accept'), 409, 'OFFER_NOT_AVAILABLE');
});

/* ---------- M3: POD states ---------- */

async function toDropoff(orderId: string): Promise<void> {
  await delivery.advance(orderId, 'rider_arrived_pickup');
  await delivery.advance(orderId, 'picked_up', { pickupCode: MOCK_PICKUP_CODE });
  await delivery.advance(orderId, 'delivering');
  await delivery.advance(orderId, 'rider_arrived_dropoff');
}

test('submitPOD with a wrong OTP throws 422 POD_OTP_INVALID and keeps the draft', async () => {
  const orderId = await acceptFirst();
  await toDropoff(orderId);
  await rejectsApiError(
    delivery.submitPOD(orderId, { type: 'otp', value: '000000', dropoffOption: 'hand_to_customer' }),
    422,
    'POD_OTP_INVALID',
  );
  const still = await delivery.getOrder(orderId);
  assert.equal(still.status, 'rider_arrived_dropoff');
  const done = await delivery.submitPOD(orderId, { type: 'otp', value: '123456', dropoffOption: 'hand_to_customer' });
  assert.equal(done.status, 'delivered');
});

test('submitPOD leave_at_door photo requires a gpsStamp (422 POD_INVALID)', async () => {
  const orderId = await acceptFirst();
  await toDropoff(orderId);
  const pod = { type: 'photo' as const, value: 'data:image/png;base64,abc', dropoffOption: 'leave_at_door' as const };
  await rejectsApiError(delivery.submitPOD(orderId, pod), 422, 'POD_INVALID');
  assert.equal((await delivery.getOrder(orderId)).status, 'rider_arrived_dropoff');
  const done = await delivery.submitPOD(orderId, {
    ...pod,
    gpsStamp: { lat: -6.7924, lon: 39.2083, at: new Date().toISOString() },
  });
  assert.equal(done.status, 'delivered');
});

test('second submitPOD after success throws 409 POD_ALREADY_SUBMITTED', async () => {
  const orderId = await acceptFirst();
  await toDropoff(orderId);
  await delivery.submitPOD(orderId, { type: 'otp', value: '123456', dropoffOption: 'hand_to_customer' });
  await rejectsApiError(
    delivery.submitPOD(orderId, { type: 'otp', value: '123456', dropoffOption: 'hand_to_customer' }),
    409,
    'POD_ALREADY_SUBMITTED',
  );
});

test('getFare on a completed order throws 404 FARE_NOT_AVAILABLE', async () => {
  const completed = await delivery.listMyOrders('completed');
  assert.ok(completed.length > 0);
  await rejectsApiError(delivery.getFare(completed[0].id), 404, 'FARE_NOT_AVAILABLE');
});

/* ---------- M3: shift cash reconciliation ---------- */

test('clock-out on a COD shift requires cash reconciliation (SHIFT_CASH_MISMATCH)', async () => {
  await rider.clockIn();
  const orderId = await acceptFirst();
  for (const status of RIDER_FLOW) await delivery.advance(orderId, status, { pickupCode: MOCK_PICKUP_CODE });
  const expected = (await delivery.getOrder(orderId)).totals.totalTZS;
  assert.ok(expected > 0, 'COD order total should be positive');
  const err = await rejectsApiError(rider.clockOut(), 409, 'SHIFT_CASH_MISMATCH');
  assert.equal(err.details?.expectedTZS, expected);
  const wrong = await rejectsApiError(
    rider.clockOut(undefined, { cashCollectedTZS: expected + 1000, cashReconciled: true }),
    409,
    'SHIFT_CASH_MISMATCH',
  );
  assert.equal(wrong.details?.expectedTZS, expected);
  const current = await rider.listShifts('current');
  assert.equal(current.length, 1);
  assert.equal(current[0].status, 'active');
  const done = await rider.clockOut(undefined, { cashCollectedTZS: expected, cashReconciled: true });
  assert.equal(done.status, 'completed');
  assert.equal(done.cashReconciled, true);
  assert.equal(done.cashCollectedTZS, expected);
});

test('clockIn twice throws 409 SHIFT_ALREADY_ACTIVE', async () => {
  await rider.clockIn();
  await rejectsApiError(rider.clockIn(), 409, 'SHIFT_ALREADY_ACTIVE');
  const current = await rider.listShifts('current');
  assert.equal(current.length, 1);
});

/* ---------- M3: auth rate limit ---------- */

test('requestOtp twice within the resend window throws 429 RATE_LIMITED with retryAfterSeconds', async () => {
  await auth.requestOtp('+255700000000', 'login');
  const err = await rejectsApiError(auth.requestOtp('+255700000000', 'login'), 429, 'RATE_LIMITED');
  assert.ok(typeof err.details?.retryAfterSeconds === 'number');
  assert.ok((err.details.retryAfterSeconds as number) >= 1);
});

/* ---------- M3: support tickets ---------- */

test('support repository creates an open ticket that persists and is listable', async () => {
  const ticket = await support.createTicket('Payout issue — po_1', 'My payout failed', 'payment');
  assert.ok(ticket.id.length > 0);
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.subject, 'Payout issue — po_1');
  const list = await support.listTickets();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, ticket.id);
  assert.equal(list[0].status, 'open');
});