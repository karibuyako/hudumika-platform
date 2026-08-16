/* Contract tests for the rider safety + preferences mock repositories.
 *
 * These import the MOCK implementations directly (src/repos/mock/*) — the
 * factories switch on env vars and are exercised by the app, not here.
 * Every case resets the shared mock store (seed 20260813) in beforeEach.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '@/api/client';
import { resetMockState } from '@/repos/mock/mockState';
import { MockSafetyRepository } from '@/repos/mock/safety';
import { MockRiderRepository } from '@/repos/mock/rider';
import { MockJobsRepository } from '@/repos/mock/jobs';

const safety = new MockSafetyRepository();
const rider = new MockRiderRepository();
const jobs = new MockJobsRepository();

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

async function acceptedOrderId(): Promise<string> {
  const feed = await jobs.listAvailableOrders();
  assert.ok(feed.length > 0, 'feed should be seeded');
  const res = await jobs.respondOffer(feed[0].orderId, 'accept');
  assert.equal(res.accepted, true);
  return feed[0].orderId;
}

/* ---------------- SOS ---------------- */

test('createSos returns an open SosAlert and echoes type, note and lat/lon', async () => {
  const alert = await safety.createSos({ type: 'medical', note: 'flat tire', lat: -6.7924, lon: 39.2083 });
  assert.equal(alert.status, 'open');
  assert.equal(alert.type, 'medical');
  assert.equal(alert.note, 'flat tire');
  assert.equal(alert.lat, -6.7924);
  assert.equal(alert.lon, 39.2083);
  assert.ok(alert.id.length > 0);
  assert.ok(!Number.isNaN(Date.parse(alert.createdAt)));
});

test('a second createSos within 60 s throws 429 SOS_RATE_LIMITED with retryAfterSeconds', async () => {
  await safety.createSos({ type: 'safety' });
  const err = await rejectsApiError(safety.createSos({ type: 'safety' }), 429, 'SOS_RATE_LIMITED');
  assert.ok(typeof err.details?.retryAfterSeconds === 'number');
  assert.ok(err.details.retryAfterSeconds > 0);
});

/* ---------------- Trusted contacts ---------------- */

test('trusted contacts: add → listed with defaults', async () => {
  const added = await safety.addTrustedContact({ name: 'Neema Mwakyusa', phone: '+255712345678' });
  assert.ok(added.id, 'mock assigns an id');
  assert.equal(added.notifiedOnSos, true);
  assert.equal(added.shareLocation, true);
  const list = await safety.listTrustedContacts();
  assert.ok(list.some((c) => c.id === added.id));
});

test('trusted contacts: adding beyond 5 throws 422 CONTACT_LIMIT_REACHED', async () => {
  const seeded = (await safety.listTrustedContacts()).length;
  assert.ok(seeded > 0, 'contacts should be seeded');
  for (let i = 0; i < 5 - seeded; i += 1) {
    await safety.addTrustedContact({ name: `Contact ${i}`, phone: `+25570000000${i}` });
  }
  await rejectsApiError(safety.addTrustedContact({ name: 'Overflow', phone: '+255799999999' }), 422, 'CONTACT_LIMIT_REACHED');
});

test('trusted contacts: remove deletes the contact (204-equivalent)', async () => {
  const added = await safety.addTrustedContact({ name: 'Neema', phone: '+255712345678' });
  await safety.removeTrustedContact(added.id ?? '');
  const list = await safety.listTrustedContacts();
  assert.ok(!list.some((c) => c.id === added.id));
});

/* ---------------- Security score ---------------- */

test('getSecurityScore returns the contract shape', async () => {
  const security = await safety.getSecurityScore();
  assert.equal(typeof security.securityScore, 'number');
  assert.ok(security.securityScore >= 0 && security.securityScore <= 100);
  assert.ok(Array.isArray(security.alerts));
  for (const alert of security.alerts) {
    assert.equal(typeof alert.type, 'string');
    assert.ok(['low', 'medium', 'high'].includes(alert.severity));
    assert.ok(!Number.isNaN(Date.parse(alert.at)));
  }
});

/* ---------------- Trip share ---------------- */

test('shareTrip with 5 recipients returns a shareToken and a future expiresAt', async () => {
  const orderId = await acceptedOrderId();
  const share = await safety.shareTrip(orderId, ['+255700000001', '+255700000002', '+255700000003', '+255700000004', '+255700000005']);
  assert.ok(share.shareToken.length > 0);
  assert.ok(Date.parse(share.expiresAt) > Date.now());
});

test('shareTrip with 6 recipients throws 422', async () => {
  const orderId = await acceptedOrderId();
  await rejectsApiError(
    safety.shareTrip(orderId, Array(6).fill('+255700000001')),
    422,
    'CONTACT_LIMIT_REACHED',
  );
});

test('shareTrip on a non-shareable order throws 409 TRIP_SHARE_NOT_ALLOWED', async () => {
  const feed = await jobs.listAvailableOrders();
  await rejectsApiError(safety.shareTrip(feed[0].orderId, ['+255700000001']), 409, 'TRIP_SHARE_NOT_ALLOWED');
});

/* ---------------- Preferences ---------------- */

test('preferences: putPreferences round-trips wifiOnlyMaps, language and destinationFilters', async () => {
  const base = await rider.getPreferences();
  const updated = await rider.putPreferences({
    ...base,
    wifiOnlyMaps: true,
    language: 'sw',
    destinationFilters: ['Tegeta', 'Kariakoo'],
  });
  assert.equal(updated.wifiOnlyMaps, true);
  assert.equal(updated.language, 'sw');
  assert.deepEqual(updated.destinationFilters, ['Tegeta', 'Kariakoo']);
  const fetched = await rider.getPreferences();
  assert.deepEqual(fetched, updated);
});

test('preferences: more than 5 destination filters throws 422 PREFERENCES_INVALID', async () => {
  const base = await rider.getPreferences();
  const err = await rejectsApiError(
    rider.putPreferences({ ...base, destinationFilters: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    422,
    'PREFERENCES_INVALID',
  );
  assert.ok(err.message.length > 0);
});

test('preferences: a language outside en/sw throws 422 PREFERENCES_INVALID', async () => {
  const base = await rider.getPreferences();
  await rejectsApiError(rider.putPreferences({ ...base, language: 'fr' }), 422, 'PREFERENCES_INVALID');
});

test('preferences: invalid put does not mutate stored preferences', async () => {
  const base = await rider.getPreferences();
  await rejectsApiError(rider.putPreferences({ ...base, language: 'fr' }), 422);
  const after = await rider.getPreferences();
  assert.equal(after.language, base.language);
});
