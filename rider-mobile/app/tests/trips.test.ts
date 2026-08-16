/* Contract tests for the batch-trips (P10c) mock repository.
 *
 * The trip derives from the rider's live orders (buildTripFromState), so the
 * lifecycle tests drive it through the real accept → advance → deliver flow.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '@/api/client';
import { resetMockState, MOCK_PICKUP_CODE } from '@/repos/mock/mockState';
import { MockJobsRepository } from '@/repos/mock/jobs';
import { MockDeliveryRepository } from '@/repos/mock/delivery';
import { MockTripsRepository, MOCK_TRIP_ID } from '@/repos/mock/trips';

const jobs = new MockJobsRepository();
const delivery = new MockDeliveryRepository();
const trips = new MockTripsRepository();

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

/** Accept the first N offers so the rider owns active orders. */
async function acceptOffers(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const feed = await jobs.listAvailableOrders();
    const res = await jobs.respondOffer(feed[0].orderId, 'accept');
    assert.equal(res.accepted, true);
    ids.push(feed[0].orderId);
  }
  return ids;
}

async function deliverOrder(orderId: string): Promise<void> {
  for (const status of ['rider_arrived_pickup', 'picked_up', 'delivering', 'rider_arrived_dropoff'] as const) {
    await delivery.advance(orderId, status, status === 'picked_up' ? { pickupCode: MOCK_PICKUP_CODE } : undefined);
  }
  await delivery.submitPOD(orderId, { type: 'photo', note: 'photo on file', gpsStamp: { lat: -6.79, lon: 39.2 } });
}

test('no active trip when the rider has no accepted orders', async () => {
  assert.equal(await trips.getActiveTrip(), null);
});

test('active trip groups accepted orders with per-stop statuses and server earnings', async () => {
  const [first, second] = await acceptOffers(2);
  await delivery.advance(first, 'rider_arrived_pickup');
  await delivery.advance(second, 'rider_arrived_pickup');
  await delivery.advance(second, 'picked_up', { pickupCode: MOCK_PICKUP_CODE });

  const trip = await trips.getActiveTrip();
  assert.ok(trip);
  assert.equal(trip.status, 'active');
  assert.equal(trip.orderIds.length, 2);
  assert.equal(trip.stops.length, 4);
  assert.ok(Number.isInteger(trip.earningsTZS ?? 0));
  assert.ok((trip.earningsTZS ?? 0) > 0);

  const byOrder = new Map(trip.stops.map((s) => [`${s.orderId}:${s.stopType}`, s]));
  assert.equal(byOrder.get(`${first}:pickup`)?.status, 'arrived');
  assert.equal(byOrder.get(`${second}:pickup`)?.status, 'done');
  assert.equal(byOrder.get(`${first}:dropoff`)?.status, 'pending');
});

test('getTrip resolves the active trip id and 404s on unknown ids', async () => {
  await acceptOffers(1);
  const trip = await trips.getActiveTrip();
  assert.ok(trip);
  const byId = await trips.getTrip(MOCK_TRIP_ID);
  assert.equal(byId.id, MOCK_TRIP_ID);
  await rejectsApiError(trips.getTrip('trip_missing'), 404, 'TRIP_NOT_FOUND');
});

test('reorderStops persists the manual sequence and returns the reordered trip', async () => {
  await acceptOffers(3);
  const before = await trips.getActiveTrip();
  assert.ok(before);
  assert.equal(new Set(before.orderIds).size, 3);

  const reordered = await trips.reorderStops(MOCK_TRIP_ID, [before.orderIds[2], before.orderIds[0], before.orderIds[1]]);
  assert.deepEqual(reordered.orderIds, [before.orderIds[2], before.orderIds[0], before.orderIds[1]]);
  assert.deepEqual(
    reordered.stops.map((s) => s.orderId),
    [before.orderIds[2], before.orderIds[2], before.orderIds[0], before.orderIds[0], before.orderIds[1], before.orderIds[1]],
  );

  const after = await trips.getActiveTrip();
  assert.deepEqual(after?.orderIds, [before.orderIds[2], before.orderIds[0], before.orderIds[1]]);
});

test('reorderStops rejects non-subset and duplicate sequences with 409', async () => {
  const ids = await acceptOffers(2);
  await rejectsApiError(trips.reorderStops(MOCK_TRIP_ID, [ids[0], 'order_unknown']), 409, 'INVALID_TRIP_SEQUENCE');
  await rejectsApiError(trips.reorderStops(MOCK_TRIP_ID, [ids[0], ids[0]]), 409, 'INVALID_TRIP_SEQUENCE');
  await rejectsApiError(trips.reorderStops('trip_missing', [ids[0]]), 404, 'TRIP_NOT_FOUND');
});

test('trip completes when the last order leaves the active set; summary stays readable', async () => {
  const [first, second] = await acceptOffers(2);
  await deliverOrder(first);
  const stillActive = await trips.getActiveTrip();
  assert.ok(stillActive);
  assert.equal(stillActive.orderIds.length, 1);

  await deliverOrder(second);
  assert.equal(await trips.getActiveTrip(), null);

  const completed = await trips.getTrip(MOCK_TRIP_ID);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);
  assert.equal(completed.stops.filter((s) => s.status === 'done').length, completed.stops.length);
  assert.ok(Number.isInteger(completed.earningsTZS ?? 0));

  await rejectsApiError(trips.reorderStops(MOCK_TRIP_ID, completed.orderIds), 409, 'TRIP_ALREADY_COMPLETED');
});