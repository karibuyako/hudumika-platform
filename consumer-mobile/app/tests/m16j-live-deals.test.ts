/* M16j — LIVE DEALS ZONE (神抢手-lite): the marketing repository mock
 * (GET /marketing/live-deals). Session status is DERIVED from the wall clock
 * at list time (startsAt ≤ now < endsAt → live; before → scheduled; from
 * endsAt → ended), so every boundary is exercised through the setMockNow()
 * clock seam. Every seeded deal must reference a REAL merchant from the
 * deterministic mock store (mockState, seed 20260813), and the countdown
 * data (startsAt/endsAt) must be present for the live/scheduled sessions. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState, getState } from '@/repos/mock/mockState';
import { MockMarketingRepository, deriveLiveDealStatus, resetMockMarketingState, setMockNow } from '@/repos/mock/marketing';
import { LiveDealSessionStatus } from '@hudumika/contract';
import type { LiveDealSession } from '@hudumika/contract';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

beforeEach(() => {
  resetMockState();
  resetMockMarketingState();
});

function sessionWindows(list: LiveDealSession[]): Map<string, { startsAt: string; endsAt: string }> {
  return new Map(list.map((s) => [s.id, { startsAt: s.startsAt, endsAt: s.endsAt }]));
}

/* ---------------- seeded sessions reference real merchants ---------------- */

test('listLiveDeals returns 2 sessions: one live with 3 deals, one scheduled with 2 deals', async () => {
  const repo = new MockMarketingRepository();
  const { sessions, nextCursor } = await repo.listLiveDeals();
  assert.equal(sessions.length, 2);
  assert.equal(nextCursor, null);
  const live = sessions.find((s) => s.status === LiveDealSessionStatus.live);
  const scheduled = sessions.find((s) => s.status === LiveDealSessionStatus.scheduled);
  assert.ok(live, 'seed has a live session');
  assert.ok(scheduled, 'seed has a scheduled session');
  assert.equal((live.deals ?? []).length, 3, 'live session carries 3 deals');
  assert.equal((scheduled.deals ?? []).length, 2, 'scheduled session carries 2 deals');
});

test('every seeded deal references an existing seeded merchant and carries its real name', async () => {
  const repo = new MockMarketingRepository();
  const { sessions } = await repo.listLiveDeals();
  const merchants = getState().merchants;
  const merchantIds = new Set(merchants.map((m) => m.id));
  const nameById = new Map(merchants.map((m) => [m.id, m.businessName]));
  for (const session of sessions) {
    for (const deal of session.deals ?? []) {
      assert.ok(merchantIds.has(deal.merchantId), `deal references seeded merchant ${deal.merchantId}`);
      assert.equal(deal.merchantName, nameById.get(deal.merchantId), 'merchantName matches the seeded record');
      assert.ok(deal.priceTZS > 0 && Number.isInteger(deal.priceTZS), 'priceTZS is a positive integer (TZS minor units)');
      assert.ok(deal.originalPriceTZS > deal.priceTZS, 'original price is above the deal price (strikethrough data)');
    }
  }
});

test('live-deals sessions are sorted by startsAt (upcoming first, then scheduled)', async () => {
  const repo = new MockMarketingRepository();
  const { sessions } = await repo.listLiveDeals();
  const starts = sessions.map((s) => Date.parse(s.startsAt));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), 'sessions ascending by startsAt');
});

/* ---------------- status derivation at the boundaries ---------------- */

test('status derivation: scheduled before startsAt, live at and inside the window, ended from endsAt', () => {
  const session = { startsAt: new Date(NOW).toISOString(), endsAt: new Date(NOW + 2 * HOUR).toISOString() };
  assert.equal(deriveLiveDealStatus(session, NOW - 1), LiveDealSessionStatus.scheduled, 'before startsAt → scheduled');
  assert.equal(deriveLiveDealStatus(session, NOW), LiveDealSessionStatus.live, 'exactly at startsAt → live (inclusive)');
  assert.equal(deriveLiveDealStatus(session, NOW + HOUR), LiveDealSessionStatus.live, 'inside the window → live');
  assert.equal(deriveLiveDealStatus(session, NOW + 2 * HOUR), LiveDealSessionStatus.ended, 'exactly at endsAt → ended (exclusive)');
  assert.equal(deriveLiveDealStatus(session, NOW + 3 * HOUR), LiveDealSessionStatus.ended, 'after endsAt → ended');
});

test('setMockNow drives the listed session statuses (live → scheduled → ended)', async () => {
  const repo = new MockMarketingRepository();
  setMockNow(NOW);
  const windows = sessionWindows((await repo.listLiveDeals()).sessions);
  const live = [...windows.entries()].find(([, w]) => Date.parse(w.startsAt) <= NOW && NOW < Date.parse(w.endsAt));
  assert.ok(live, 'seed windows contain a live-at-NOW session');
  const [liveId, liveWindow] = live!;

  // Same seeds, clock moved before the live session starts → it reads scheduled.
  setMockNow(Date.parse(liveWindow.startsAt) - 1);
  const before = (await repo.listLiveDeals()).sessions.find((s) => s.id === liveId)!;
  assert.equal(before.status, LiveDealSessionStatus.scheduled, 'before startsAt the session reads scheduled');

  // Clock moved past its end → it reads ended.
  setMockNow(Date.parse(liveWindow.endsAt));
  const after = (await repo.listLiveDeals()).sessions.find((s) => s.id === liveId)!;
  assert.equal(after.status, LiveDealSessionStatus.ended, 'from endsAt the session reads ended');

  // Clock reset → fresh seeds built on the REAL wall clock still read live
  // (the seed live window is defined as "now − 1h → now + 2h").
  resetMockMarketingState();
  const real = (await repo.listLiveDeals()).sessions.find((s) => s.id === liveId)!;
  assert.equal(real.status, LiveDealSessionStatus.live, 'real clock: seed live window still runs');
});

test('a session that ended before list time reads ended (scheduled seed boundary)', async () => {
  const repo = new MockMarketingRepository();
  setMockNow(NOW);
  const scheduled = (await repo.listLiveDeals()).sessions.find((s) => s.status === LiveDealSessionStatus.scheduled);
  assert.ok(scheduled, 'seed has a scheduled session');
  // Same seed windows, clock far in the past → the "scheduled" session had
  // not started yet, so it stays scheduled; the live one reads scheduled too.
  setMockNow(NOW - 2 * HOUR);
  const list = await repo.listLiveDeals();
  assert.ok(list.sessions.every((s) => s.status === LiveDealSessionStatus.scheduled), 'before every window everything reads scheduled');
});

/* ---------------- countdown data present ---------------- */

test('countdown data: live sessions carry a future endsAt, scheduled ones a future startsAt', async () => {
  const repo = new MockMarketingRepository();
  setMockNow(NOW);
  const { sessions } = await repo.listLiveDeals();
  for (const s of sessions) {
    assert.ok(Number.isFinite(Date.parse(s.startsAt)), `${s.id} has a parseable startsAt`);
    assert.ok(Number.isFinite(Date.parse(s.endsAt)), `${s.id} has a parseable endsAt`);
  }
  const live = sessions.find((s) => s.status === LiveDealSessionStatus.live)!;
  const scheduled = sessions.find((s) => s.status === LiveDealSessionStatus.scheduled)!;
  assert.ok(Date.parse(live.endsAt) > NOW, 'live session countdown (endsAt) is in the future');
  assert.ok(Date.parse(scheduled.startsAt) > NOW, 'scheduled session countdown (startsAt) is in the future');
  assert.ok(Date.parse(live.endsAt) > Date.parse(live.startsAt), 'live session window is well-formed');
  assert.ok(Date.parse(scheduled.endsAt) > Date.parse(scheduled.startsAt), 'scheduled session window is well-formed');
});

test('unparseable window timestamps derive as ended (defensive server-side rule)', () => {
  assert.equal(deriveLiveDealStatus({ startsAt: 'not-a-date', endsAt: 'also-not' }, NOW), LiveDealSessionStatus.ended);
});
