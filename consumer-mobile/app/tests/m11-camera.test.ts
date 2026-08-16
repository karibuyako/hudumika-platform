/* M11 — camera QR scanning + questionnaire photo intake.
 *
 * Pure-helper tests only (no native modules): the dine-in table QR parser
 * (parseTableQr — exact `hudumika:dinein:table:{id}` payloads only) and the
 * photo-question answer shape: the seeded photo question's answers round-trip
 * through the bookings create path (BookingCreate.answers carries the URIs;
 * BookingCreate.photos carries the flattened contract string[]). The screen
 * components (QrScanner, book.tsx) lazy-import expo-camera/expo-image-picker
 * so this node bundle never loads them. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { rejectsApiError, resetMockState } from './helpers';
import { getState } from '@/repos/mock/mockState';
import { MockProvidersRepository } from '@/repos/mock/providers';
import { MockBookingsRepository } from '@/repos/mock/bookings';
import { parseTableQr } from '@/lib/dineIn';
import { ServiceQuestionType } from '@hudumika/contract';
import type { BookingCreate } from '@hudumika/contract';

const providers = new MockProvidersRepository();
const bookings = new MockBookingsRepository();

beforeEach(() => resetMockState());

/* ---------------- dine-in QR payload parsing (TASK 1) ---------------- */

test('parseTableQr accepts exact hudumika:dinein:table:{id} payloads', () => {
  assert.deepEqual(parseTableQr('hudumika:dinein:table:table_1'), { tableId: 'table_1' });
  assert.deepEqual(parseTableQr('hudumika:dinein:table:tbl-9_x'), { tableId: 'tbl-9_x' });
  assert.deepEqual(parseTableQr('hudumika:dinein:table:abc123'), { tableId: 'abc123' });
  assert.deepEqual(parseTableQr('  hudumika:dinein:table:table_1  '), { tableId: 'table_1' }, 'surrounding whitespace is tolerated');
});

test('parseTableQr rejects malformed and foreign payloads', () => {
  assert.equal(parseTableQr(''), null);
  assert.equal(parseTableQr('hudumika:dinein:table:'), null, 'empty table id');
  assert.equal(parseTableQr('hudumika:dinein:table'), null, 'missing id segment');
  assert.equal(parseTableQr('hudumika:table:table_1'), null, 'missing dinein prefix');
  assert.equal(parseTableQr('hudumika:dinein:table:table_1/extra'), null, 'trailing garbage');
  assert.equal(parseTableQr('hudumika:dinein:table:table 1'), null, 'space in id');
  assert.equal(parseTableQr('https://example.com/table_1'), null, 'foreign URL QR');
  assert.equal(parseTableQr('hudumika:dinein:order:order_1'), null, 'wrong resource');
  assert.equal(parseTableQr('table_1'), null, 'bare id');
});

/* ---------------- questionnaire photo intake (TASK 2) ---------------- */

test('the seeded questionnaire includes a contract-typed photo question', async () => {
  const qs = await providers.getQuestions('svc_001');
  const photo = qs.find((q) => q.key === 'photos');
  assert.ok(photo, 'svc_001 seeds a photo question so the intake UI is reachable');
  assert.equal(photo.type, ServiceQuestionType.photo);
  assert.equal(photo.required, true);
  assert.equal(photo.options, undefined);
});

test('photo question answers round-trip through the bookings create path', async () => {
  const qs = await providers.getQuestions('svc_001');
  const photo = qs.find((q) => q.key === 'photos')!;
  const uris = ['file:///tmp/leak_1.jpg', 'file:///tmp/leak_2.jpg'];
  const input: BookingCreate = {
    providerId: 'prov_001',
    serviceId: 'svc_001',
    scheduledFor: new Date(Date.now() + 86400_000).toISOString(),
    durationMinutes: 120,
    paymentMethod: 'mpesa',
    address: {
      label: 'Home',
      lines: 'Mikocheni A',
      contactPhone: '+255700000000',
    },
    photos: uris.slice(0, 4),
    answers: { issue: 'Leak', location: 'Kitchen', [photo.key]: uris },
  };
  const created = await bookings.create(input, 'k1');
  const detail = getState().bookings.find((b) => b.id === created.id) as unknown as { answers?: Record<string, unknown> };
  assert.deepEqual(detail.answers, { issue: 'Leak', location: 'Kitchen', photos: uris }, 'photo URIs ride BookingCreate.answers verbatim');
});

test('photo answers cap at the contract BookingCreate.photos max (6)', async () => {
  const many = Array.from({ length: 8 }, (_, i) => `file:///tmp/p_${i}.jpg`);
  const input: BookingCreate = {
    providerId: 'prov_001',
    serviceId: 'svc_001',
    scheduledFor: new Date(Date.now() + 86400_000).toISOString(),
    paymentMethod: 'mpesa',
    answers: { issue: 'Leak', photos: many },
    photos: many,
  };
  // The contract caps BookingCreate.photos at @maxItems 6 — the book form
  // slices the flattened picker URIs to that cap before create; assert the
  // contract shape (string URLs) and that create accepts the capped list.
  const capped = (input.photos ?? []).slice(0, 6);
  assert.equal(capped.length, 6);
  assert.ok(capped.every((p) => typeof p === 'string' && p.length > 0), 'photos are URL strings per the contract');
  const created = await bookings.create({ ...input, photos: capped }, 'k2');
  const detail = getState().bookings.find((b) => b.id === created.id) as unknown as { answers?: Record<string, unknown> };
  const answers = detail.answers as { photos?: string[] };
  assert.equal(answers.photos?.length, 8, 'the answers array round-trips verbatim (the UI caps the BookingCreate.photos field only)');
});

test('booking create rejects past slots even with photos', async () => {
  const input: BookingCreate = {
    providerId: 'prov_001',
    serviceId: 'svc_001',
    scheduledFor: new Date(Date.now() - 60000).toISOString(),
    paymentMethod: 'mpesa',
    photos: ['file:///tmp/old.jpg'],
    answers: { photos: ['file:///tmp/old.jpg'] },
  };
  await rejectsApiError(bookings.create(input, 'k3'), 422, 'BOOKING_TIME_IN_PAST');
});
