/* M16i — Rider tips (POST /orders/{id}/tip, contract TipRiderBody): status
 * gate (delivered/completed only), amount/method validation, idempotency,
 * and the tip rendering on the order detail. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState, rejectsApiError } from './helpers';
import { MockOrdersRepository, resetMockOrdersState } from '@/repos/mock/orders';
import { getState } from '@/repos/mock/mockState';
import { TipRiderBodyMethod } from '@hudumika/contract';

const orders = new MockOrdersRepository();

beforeEach(() => {
  resetMockState();
  resetMockOrdersState();
});

test('tipping a delivered order records tipTZS, an event, and returns the updated order', async () => {
  const res = await orders.tip('ord_completed_004', { amountTZS: 5000, method: 'mpesa', note: 'Asante' }, 'm16i-tip-1');
  assert.equal(res.tipTZS, 5000);
  const detail = await orders.get('ord_completed_004');
  assert.equal(detail.tipTZS, 5000, 'the tip rides the contract Order.tipTZS field');
  const ev = detail.events.at(-1)!;
  assert.equal(ev.by, 'customer');
  assert.equal(ev.status, detail.status, 'the event mirrors the order status (house event pattern)');
  assert.ok((ev.note ?? '').includes('Tip TZS 5000'));
  assert.equal(detail.totals.totalTZS, getState().orders.find((o) => o.id === 'ord_completed_004')!.totals.totalTZS, 'totals are untouched by the tip');
  assert.equal(detail.status, 'delivered', 'tipping never changes the order status');
});

test('tipping a completed order also succeeds', async () => {
  const res = await orders.tip('ord_completed_005', { amountTZS: 1000, method: 'wallet' }, 'm16i-tip-2');
  assert.equal(res.tipTZS, 1000);
  const detail = await orders.get('ord_completed_005');
  assert.equal(detail.status, 'completed');
});

test('every contract tip method value is accepted', async () => {
  for (const method of Object.values(TipRiderBodyMethod)) {
    resetMockState(); // one tip per order — start each case clean
    const res = await orders.tip('ord_completed_004', { amountTZS: 2000, method }, `m16i-tip-method-${method}`);
    assert.equal(res.tipTZS, 2000, `${method} is accepted`);
  }
});

test('tipping before delivery is rejected 409 TIP_NOT_ALLOWED', async () => {
  await rejectsApiError(orders.tip('ord_active_001', { amountTZS: 5000, method: 'mpesa' }, 'm16i-tip-3'), 409, 'TIP_NOT_ALLOWED');
  await rejectsApiError(orders.tip('ord_intercity_002', { amountTZS: 5000, method: 'mpesa' }, 'm16i-tip-4'), 409, 'TIP_NOT_ALLOWED');
  assert.equal((await orders.get('ord_active_001')).tipTZS, undefined, 'nothing is recorded on rejection');
});

test('an amount below 1 or a non-integer amount is rejected 422 VALIDATION_FAILED', async () => {
  await rejectsApiError(orders.tip('ord_completed_004', { amountTZS: 0, method: 'mpesa' }, 'm16i-tip-5'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(orders.tip('ord_completed_004', { amountTZS: -500, method: 'mpesa' }, 'm16i-tip-6'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(orders.tip('ord_completed_004', { amountTZS: 500.5, method: 'mpesa' }, 'm16i-tip-7'), 422, 'VALIDATION_FAILED');
  assert.equal((await orders.get('ord_completed_004')).tipTZS, undefined);
});

test('a method outside the contract enum is rejected 422 VALIDATION_FAILED', async () => {
  await rejectsApiError(orders.tip('ord_completed_004', { amountTZS: 1000, method: 'bitcoin' as never }, 'm16i-tip-8'), 422, 'VALIDATION_FAILED');
});

test('a note longer than the contract maxLength (200) is rejected 422 VALIDATION_FAILED', async () => {
  await rejectsApiError(orders.tip('ord_completed_004', { amountTZS: 1000, method: 'mpesa', note: 'x'.repeat(201) }, 'm16i-tip-9'), 422, 'VALIDATION_FAILED');
});

test('tipping an unknown order is 404 ORDER_NOT_FOUND', async () => {
  await rejectsApiError(orders.tip('ord_nope_999', { amountTZS: 1000, method: 'mpesa' }, 'm16i-tip-10'), 404, 'ORDER_NOT_FOUND');
});

test('the same idempotency key replays the same result and never double-tips', async () => {
  const first = await orders.tip('ord_completed_004', { amountTZS: 3000, method: 'wallet' }, 'm16i-tip-key');
  const replay = await orders.tip('ord_completed_004', { amountTZS: 3000, method: 'wallet' }, 'm16i-tip-key');
  assert.equal(replay.tipTZS, first.tipTZS, 'replay returns the recorded tip');
  const tipEvents = (await orders.get('ord_completed_004')).events.filter((e) => (e.note ?? '').startsWith('Tip TZS'));
  assert.equal(tipEvents.length, 1, 'the replay does not append a second event');
});

test('a second tip with a fresh key is rejected 409 CONFLICT', async () => {
  await orders.tip('ord_completed_004', { amountTZS: 2000, method: 'mpesa' }, 'm16i-tip-11');
  await rejectsApiError(orders.tip('ord_completed_004', { amountTZS: 2000, method: 'mpesa' }, 'm16i-tip-12'), 409, 'CONFLICT');
});

test('the tip renders as recorded on the order detail (repo level)', async () => {
  await orders.tip('ord_completed_004', { amountTZS: 10000, method: 'card', note: 'For the long wait' }, 'm16i-tip-13');
  const detail = await orders.get('ord_completed_004');
  assert.equal(detail.tipTZS, 10000, 'the detail carries the tip amount for the confirmed UI state');
  const tipEvent = detail.events.find((e) => (e.note ?? '').includes('Tip TZS 10000'));
  assert.ok(tipEvent, 'the timeline carries the tip event');
  assert.equal(tipEvent?.by, 'customer');
});
