/* M12d — Consumer dispute API (mock-first, docs/CONTRACT-ADDITIONS.md #8).
 *
 * The consumer contract exposes NO dispute endpoints (verified: generated
 * endpoints carry only admin voucher-dispute tooling), so DisputesRepository
 * (list/raise) is mock-only-until-adopted: GET /disputes/me + POST /disputes
 * live in the parity allow-list. Seeds derive from the states the contract
 * DOES carry — the disputed order, the disputed booking seed and the
 * refunded order (whose refund closes a resolved dispute).
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState } from '@/repos/mock/mockState';
import { MockDisputesRepository, resetMockDisputesState } from '@/repos/mock/disputes';
import { rejectsApiError } from './helpers';

const disputes = new MockDisputesRepository();

beforeEach(() => {
  resetMockState();
  resetMockDisputesState();
});

test('list returns the seeded disputes — open, resolving and resolved across orders and bookings', async () => {
  const all = await disputes.list();
  assert.equal(all.length, 3);

  const orderDisp = all.find((d) => d.referenceType === 'order' && d.referenceId === 'ord_disputed_007')!;
  assert.equal(orderDisp.status, 'open');
  assert.equal(orderDisp.reason, 'missing_item');
  assert.ok(orderDisp.description.length > 0);
  assert.ok(orderDisp.id.startsWith('disp_'));
  assert.ok(Date.parse(orderDisp.createdAt) <= Date.now());
  assert.equal(orderDisp.resolution, undefined, 'open dispute has no resolution yet');

  const bookingDisp = all.find((d) => d.referenceId === 'bk_disputed_101')!;
  assert.equal(bookingDisp.referenceType, 'booking');
  assert.equal(bookingDisp.status, 'resolving');
  assert.equal(bookingDisp.reason, 'service_not_completed');

  const resolved = all.find((d) => d.referenceId === 'ord_refunded_006')!;
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.resolution, 'resolved dispute carries its resolution');
  assert.equal(resolved.resolution!.outcome, 'refunded');
  assert.ok(Date.parse(resolved.resolution!.at) <= Date.now());
  assert.ok(resolved.resolution!.note!.length > 0);
});

test('raise creates a dispute record linked to a real order', async () => {
  const before = await disputes.list();
  const record = await disputes.raise(
    { orderId: 'ord_active_001', reason: 'damaged', description: 'Food arrived damaged' },
    'key-1',
  );
  assert.equal(record.referenceType, 'order');
  assert.equal(record.referenceId, 'ord_active_001');
  assert.equal(record.status, 'open');
  assert.equal(record.reason, 'damaged');
  assert.equal(record.description, 'Food arrived damaged');
  assert.ok(record.id.startsWith('disp_'));
  assert.ok(Date.parse(record.createdAt) <= Date.now());

  const after = await disputes.list();
  assert.equal(after.length, before.length + 1, 'the raised record lands in list()');
  assert.ok(after.some((d) => d.id === record.id));
});

test('raise accepts booking references and replays the same record per idempotency key', async () => {
  const first = await disputes.raise(
    { bookingId: 'bk_active_001', reason: 'service_not_completed', description: 'Job not finished' },
    'key-2',
  );
  assert.equal(first.referenceType, 'booking');
  assert.equal(first.referenceId, 'bk_active_001');
  // Same key replays the SAME record (never double-creates), even with a
  // different body — the server owns the first write.
  const replay = await disputes.raise(
    { bookingId: 'bk_active_001', reason: 'other', description: 'changed my mind' },
    'key-2',
  );
  assert.equal(replay.id, first.id, 'idempotent replay returns the original record');
  assert.equal(replay.reason, 'service_not_completed');
  assert.equal((await disputes.list()).length, 4, 'no duplicate created');
  // A fresh key creates a fresh record.
  const second = await disputes.raise(
    { bookingId: 'bk_disputed_101', reason: 'other', description: 'follow-up' },
    'key-3',
  );
  assert.notEqual(second.id, first.id);
});

test('raise 404s for unknown references and 422s for ambiguous or missing references', async () => {
  await rejectsApiError(disputes.raise({ orderId: 'ord_nope', reason: 'other', description: 'x' }, 'key-4'), 404, 'NOT_FOUND');
  await rejectsApiError(disputes.raise({ bookingId: 'bk_nope', reason: 'other', description: 'x' }, 'key-5'), 404, 'NOT_FOUND');
  await rejectsApiError(
    disputes.raise({ orderId: 'ord_active_001', bookingId: 'bk_active_001', reason: 'other', description: 'x' }, 'key-6'),
    422,
    'VALIDATION_FAILED',
  );
  await rejectsApiError(disputes.raise({ reason: 'other', description: 'x' }, 'key-7'), 422, 'VALIDATION_FAILED');
  assert.equal((await disputes.list()).length, 3, 'failed raises never mutate the list');
});

test('status transitions exist in the seed set (open → resolving → resolved)', async () => {
  const all = await disputes.list();
  const statuses = all.map((d) => d.status);
  assert.ok(statuses.includes('open'), 'a fresh dispute starts open');
  assert.ok(statuses.includes('resolving'), 'in-review seed exists');
  assert.ok(statuses.includes('resolved'), 'terminal resolved seed exists');
  const resolved = all.find((d) => d.status === 'resolved')!;
  assert.equal(resolved.resolution!.outcome, 'refunded');
  assert.ok(Date.parse(resolved.resolution!.at) >= Date.parse(resolved.createdAt), 'resolution comes after creation');
});
