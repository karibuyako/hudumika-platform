/* M13 — Flash deals (神抢手-lite) + curated lists (必吃榜-lite): pure
 * selectors (src/lib/flash.ts, src/lib/lists.ts) plus the seeded seam —
 * every curated-list merchant id must exist in the deterministic mock store. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState, getState } from '@/repos/mock/mockState';
import { MockMerchantsRepository } from '@/repos/mock/merchants';
import { FLASH_WINDOW_MS, selectFlashDeals } from '@/lib/flash';
import { CURATED_LISTS, getCuratedList, resolveList } from '@/lib/lists';
import { GroupBuyStatus } from '@hudumika/contract';
import type { GroupBuyDeal } from '@hudumika/contract';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function makeDeal(id: string, endsInMs: number, status: GroupBuyDeal['status'] = 'live'): GroupBuyDeal {
  return {
    id,
    merchantId: 'm_1',
    title: `Deal ${id}`,
    priceTZS: 10000,
    originalPriceTZS: 20000,
    quantity: 10,
    salesStartAt: new Date(NOW - HOUR).toISOString(),
    salesEndAt: new Date(NOW + endsInMs).toISOString(),
    status,
  };
}

beforeEach(() => {
  resetMockState();
});

/* ---------------- selectFlashDeals ---------------- */

test('selectFlashDeals keeps live deals ending within the window, soonest first', () => {
  const deals = [
    makeDeal('a', 2 * DAY),
    makeDeal('b', 1 * DAY),
    makeDeal('c', 10 * DAY),
  ];
  const out = selectFlashDeals(deals, NOW, 3 * DAY);
  assert.deepEqual(out.map((d) => d.id), ['b', 'a']);
});

test('selectFlashDeals excludes deals that have already ended (exact now excluded)', () => {
  const deals = [
    makeDeal('ended', 0),
    makeDeal('past', -HOUR),
  ];
  assert.deepEqual(selectFlashDeals(deals, NOW, DAY), []);
});

test('selectFlashDeals keeps the exact upper window boundary (inclusive)', () => {
  const deals = [makeDeal('edge', 3 * DAY)];
  const out = selectFlashDeals(deals, NOW, 3 * DAY);
  assert.equal(out.length, 1);
});

test('selectFlashDeals drops deals past the window', () => {
  const deals = [makeDeal('far', 4 * DAY), makeDeal('soon', HOUR)];
  const out = selectFlashDeals(deals, NOW, 3 * DAY);
  assert.deepEqual(out.map((d) => d.id), ['soon']);
});

test('selectFlashDeals keeps only live status (contract GroupBuyStatus)', () => {
  const deals = [
    makeDeal('live', HOUR, 'live'),
    makeDeal('draft', HOUR, 'draft'),
    makeDeal('extended', HOUR, 'extended'),
    makeDeal('ended', HOUR, 'ended'),
    makeDeal('delisted', HOUR, 'delisted'),
    makeDeal('rejected', HOUR, 'rejected'),
    makeDeal('pending_review', HOUR, 'pending_review'),
  ];
  const out = selectFlashDeals(deals, NOW, DAY);
  assert.deepEqual(out.map((d) => d.id), ['live']);
});

test('selectFlashDeals empty input → empty; default window is FLASH_WINDOW_MS', () => {
  assert.deepEqual(selectFlashDeals([], NOW), []);
  const far = makeDeal('far', 29 * DAY);
  assert.equal(selectFlashDeals([far], NOW).length, 1);
  assert.equal(selectFlashDeals([far], NOW, 28 * DAY).length, 0);
});

test('selectFlashDeals skips deals with unparseable salesEndAt', () => {
  const bad = { ...makeDeal('bad', HOUR), salesEndAt: 'not-a-date' };
  assert.deepEqual(selectFlashDeals([bad], NOW, DAY), []);
});

/* ---------------- resolveList / seed seam ---------------- */

test('resolveList returns ranked merchants filtered to those present', () => {
  const list = CURATED_LISTS[0];
  const [a, b, c] = list.merchantIds;
  const merchants = [
    { id: a, businessName: 'One', rating: 4.5, reviewCount: 10, isOpen: true },
    { id: b, businessName: 'Two', rating: 4.0, reviewCount: 20, isOpen: true },
    { id: c, businessName: 'Three', rating: 3.5, reviewCount: 5, isOpen: false },
  ];
  const resolved = resolveList(list.id, merchants);
  assert.ok(resolved, 'resolves a known list');
  assert.equal(resolved.list.id, list.id);
  assert.deepEqual(resolved.merchants.map((m) => m.id), [a, b, c], 'seed rank order preserved');
});

test('resolveList drops seed ids absent from the merchant list, keeping rank order', () => {
  const list = CURATED_LISTS[0];
  const [a, b, c] = list.merchantIds;
  const merchants = [
    { id: a, businessName: 'One', rating: 4.5, reviewCount: 10, isOpen: true },
    { id: c, businessName: 'Three', rating: 3.5, reviewCount: 5, isOpen: false },
  ];
  const resolved = resolveList(list.id, merchants);
  assert.ok(resolved, 'resolves a known list');
  assert.deepEqual(resolved.merchants.map((m) => m.id), [a, c], 'rank order preserved with absent id dropped');
});

test('resolveList unknown listId → null', () => {
  assert.equal(resolveList('does_not_exist', []), null);
  assert.equal(getCuratedList('does_not_exist'), undefined);
});

test('seed seam: every curated-list merchant id exists in the mock store', () => {
  const merchants = new Set(getState().merchants.map((m) => m.id));
  for (const list of CURATED_LISTS) {
    assert.ok(list.merchantIds.length >= 3, `list ${list.id} has ranked merchants`);
    for (const id of list.merchantIds) {
      assert.ok(merchants.has(id), `list ${list.id} references seeded merchant ${id}`);
    }
  }
});

test('seed seam: resolving seeded lists against the merchants repo returns ranked merchants', async () => {
  const repo = new MockMerchantsRepository();
  const all = await repo.list();
  for (const list of CURATED_LISTS) {
    const resolved = resolveList(list.id, all);
    assert.ok(resolved, `list ${list.id} resolves`);
    assert.equal(resolved.merchants.length, list.merchantIds.length, `list ${list.id} fully resolves against the seed`);
    assert.deepEqual(resolved.merchants.map((m) => m.id), list.merchantIds, `list ${list.id} keeps seed rank order`);
  }
});

test('seeded group buys satisfy the flash window (default FLASH_WINDOW_MS)', () => {
  const live = getState().groupBuys.filter((g) => g.status === GroupBuyStatus.live);
  assert.ok(live.length >= 2, 'seed has live group buys');
  assert.ok(
    live.every((g) => selectFlashDeals([g]).length === 1),
    'every seeded live deal lands inside the default flash window',
  );
});
