/* M16d — Entertainment vertical (concerts/shows + event tickets): list with
 * city/category filters + cursor, detail 404, purchase (EV-XXXX codes,
 * integer unit price, remaining decrement), sold-out 409 CONFLICT, bad
 * quantity 422 VALIDATION_FAILED, idempotent replay per key, my tickets
 * (created + the seeded used one). Contract: GET /entertainment/events,
 * GET /entertainment/events/{eventId}, POST /entertainment/event-tickets,
 * GET /entertainment/event-tickets/me. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState } from '@/repos/mock/mockState';
import { MockEventsRepository, resetMockEventsState, setEventTierRemainingForTests } from '@/repos/mock/events';
import { rejectsApiError } from './helpers';

const events = new MockEventsRepository();

beforeEach(() => {
  resetMockState();
  resetMockEventsState();
});

test('list returns the three seeded events — future startsAt, integer starting prices, city names', async () => {
  const { results, nextCursor } = await events.list();
  assert.equal(results.length, 3);
  assert.equal(nextCursor, null, 'three events fit one page — no next cursor');

  const ids = results.map((e) => e.id).sort();
  assert.deepEqual(ids, ['evt_concert_001', 'evt_festival_001', 'evt_theatre_001']);

  for (const e of results) {
    assert.ok(Date.parse(e.startsAt) > Date.now(), `${e.id} starts in the future`);
    assert.ok(Number.isInteger(e.startingPriceTZS), `${e.id} starting price is integer TZS`);
    assert.ok((e.startingPriceTZS ?? 0) > 0);
    assert.ok(e.venue, `${e.id} has a venue`);
    assert.ok(e.cityName, `${e.id} carries the city name`);
  }

  const concert = results.find((e) => e.id === 'evt_concert_001');
  assert.equal(concert?.category, 'music');
  assert.equal(concert?.cityId, 'city_dar');
});

test('list filters by cityId and category, and cursor-paginates', async () => {
  const dar = await events.list({ cityId: 'city_dar' });
  assert.equal(dar.results.length, 2, 'concert + theatre are in Dar');

  const music = await events.list({ category: 'music' });
  assert.equal(music.results.length, 1);
  assert.equal(music.results[0].id, 'evt_concert_001');

  const festival = await events.list({ category: 'festival' });
  assert.equal(festival.results.length, 1);
  assert.equal(festival.results[0].id, 'evt_festival_001');
  assert.equal(festival.results[0].cityId, 'city_mwanza');

  const mwanzaFestival = await events.list({ cityId: 'city_mwanza', category: 'festival' });
  assert.equal(mwanzaFestival.results.length, 1);

  const page1 = await events.list({ limit: 2 });
  assert.equal(page1.results.length, 2);
  assert.equal(page1.nextCursor, '2');
  const page2 = await events.list({ limit: 2, cursor: page1.nextCursor ?? undefined });
  assert.equal(page2.results.length, 1);
  assert.equal(page2.nextCursor, null);
  assert.notEqual(page1.results[0].id, page2.results[0].id, 'pages do not overlap');
});

test('get returns the detail with tiers; unknown id 404s with NOT_FOUND', async () => {
  const detail = await events.get('evt_concert_001');
  assert.equal(detail.event.title, 'Sauti za Bongo Night');
  assert.ok(detail.description);
  assert.equal(detail.tiers.length, 3, 'concert has three tiers');

  for (const tier of detail.tiers) {
    assert.ok(Number.isInteger(tier.priceTZS));
    assert.ok(tier.remaining !== undefined && tier.remaining > 0);
    assert.equal(tier.available, true);
  }
  assert.equal(detail.event.startingPriceTZS, Math.min(...detail.tiers.map((t) => t.priceTZS)));

  await rejectsApiError(events.get('evt_nope'), 404, 'NOT_FOUND');
});

test('purchase issues tickets with EV- codes, integer tier price, and decrements remaining', async () => {
  const before = await events.get('evt_concert_001');
  const tier = before.tiers.find((t) => t.id === 'tier_concert_regular');
  assert.ok(tier && tier.remaining !== undefined);
  const remainingBefore = tier.remaining;

  const issued = await events.purchase(
    { eventId: 'evt_concert_001', tierId: 'tier_concert_regular', quantity: 2 },
    'hk_evt_purchase_1',
  );
  assert.equal(issued.length, 2);
  for (const tkt of issued) {
    assert.match(tkt.code, /^EV-[A-Z0-9]{4}$/, 'ticket code follows EV-XXXX');
    assert.equal(tkt.eventId, 'evt_concert_001');
    assert.equal(tkt.eventTitle, 'Sauti za Bongo Night');
    assert.equal(tkt.tierName, 'Regular');
    assert.equal(tkt.priceTZS, 30000, 'unit price equals the tier price (integer TZS)');
    assert.ok(Number.isInteger(tkt.priceTZS));
    assert.equal(tkt.status, 'active');
    assert.ok(tkt.startsAt, 'ticket carries the event startsAt');
  }
  assert.notEqual(issued[0].code, issued[1].code, 'codes are unique within the batch');

  const after = await events.get('evt_concert_001');
  const tierAfter = after.tiers.find((t) => t.id === 'tier_concert_regular');
  assert.equal(tierAfter?.remaining, remainingBefore - 2, 'remaining decremented by the quantity');
});

test('sold-out and insufficient-remaining purchases 409 with CONFLICT', async () => {
  // Remaining below the requested quantity → 409 CONFLICT.
  setEventTierRemainingForTests('evt_festival_001', 'tier_festival_day', 5);
  await rejectsApiError(
    events.purchase({ eventId: 'evt_festival_001', tierId: 'tier_festival_day', quantity: 10 }, 'k_conflict_1'),
    409,
    'CONFLICT',
  );

  // A tier at exactly zero remaining is unavailable → 409 CONFLICT.
  setEventTierRemainingForTests('evt_festival_001', 'tier_festival_day', 0);
  const soldOut = await events.get('evt_festival_001');
  const tier = soldOut.tiers.find((t) => t.id === 'tier_festival_day');
  assert.equal(tier?.remaining, 0);
  assert.equal(tier?.available, false, 'tier flips to unavailable at zero remaining');
  await rejectsApiError(
    events.purchase({ eventId: 'evt_festival_001', tierId: 'tier_festival_day', quantity: 1 }, 'k_sold_out'),
    409,
    'CONFLICT',
  );

  // And a live purchase that drains a tier to zero flips available off.
  await events.purchase({ eventId: 'evt_concert_001', tierId: 'tier_concert_vvip', quantity: 10 }, 'k_drain');
  const drained = await events.get('evt_concert_001');
  const vvip = drained.tiers.find((t) => t.id === 'tier_concert_vvip');
  assert.equal(vvip?.remaining, 10);
  await events.purchase({ eventId: 'evt_concert_001', tierId: 'tier_concert_vvip', quantity: 10 }, 'k_drain_end');
  const afterDrain = await events.get('evt_concert_001');
  const vvipAfter = afterDrain.tiers.find((t) => t.id === 'tier_concert_vvip');
  assert.equal(vvipAfter?.remaining, 0);
  assert.equal(vvipAfter?.available, false);
});

test('invalid quantity (0, 11, non-integer) rejects with 422 VALIDATION_FAILED', async () => {
  for (const quantity of [0, 11, 2.5]) {
    await rejectsApiError(
      events.purchase({ eventId: 'evt_concert_001', tierId: 'tier_concert_regular', quantity }, `k_qty_${quantity}`),
      422,
      'VALIDATION_FAILED',
    );
  }
});

test('unknown event or tier 404s with NOT_FOUND', async () => {
  await rejectsApiError(events.purchase({ eventId: 'evt_nope', tierId: 'tier_concert_regular', quantity: 1 }, 'k_e404'), 404, 'NOT_FOUND');
  await rejectsApiError(events.purchase({ eventId: 'evt_concert_001', tierId: 'tier_nope', quantity: 1 }, 'k_t404'), 404, 'NOT_FOUND');
});

test('purchase is idempotent per key — replay returns the same tickets without decrementing again', async () => {
  const before = await events.get('evt_concert_001');
  const remainingBefore = before.tiers.find((t) => t.id === 'tier_concert_regular')?.remaining ?? 0;

  const first = await events.purchase({ eventId: 'evt_concert_001', tierId: 'tier_concert_regular', quantity: 3 }, 'hk_replay_key');
  const replay = await events.purchase({ eventId: 'evt_concert_001', tierId: 'tier_concert_regular', quantity: 3 }, 'hk_replay_key');
  assert.equal(replay.length, 3);
  assert.deepEqual(replay.map((t) => t.code), first.map((t) => t.code), 'replay returns the same codes');

  const after = await events.get('evt_concert_001');
  const remainingAfter = after.tiers.find((t) => t.id === 'tier_concert_regular')?.remaining ?? 0;
  assert.equal(remainingAfter, remainingBefore - 3, 'remaining decremented once only');
});

test('listMyTickets returns the seeded used ticket plus purchased ones, newest first', async () => {
  const before = await events.listMyTickets();
  assert.equal(before.length, 1);
  assert.equal(before[0].status, 'used');
  assert.equal(before[0].code, 'EV-9K2M');
  assert.equal(before[0].tierName, 'Regular');

  await events.purchase({ eventId: 'evt_theatre_001', tierId: 'tier_theatre_standard', quantity: 2 }, 'hk_my_tickets');
  const after = await events.listMyTickets();
  assert.equal(after.length, 3);
  assert.equal(after[0].eventId, 'evt_theatre_001', 'new tickets sit at the top');
  assert.equal(after[0].status, 'active');
  assert.equal(after[2].status, 'used', 'the seeded used ticket is still there');
});
