/* M16k — FAVORITES ORGANIZATION (lists) + curated Lists resource
 * (OPERATIONS-COVERAGE #120, docs/CONTRACT-ADDITIONS.md #14):
 *
 * Favorites lists (mock-only-until-adopted /favorites/lists surface):
 * listLists/createList/addToList/removeFromList/deleteList round-trip against
 * the module-local registry, idempotency (same key replays the stored list,
 * a key reuse with a different name → 422), and validation (empty name →
 * 422 VALIDATION_FAILED; unknown list/merchant → 404 NOT_FOUND).
 *
 * Curated lists (必吃榜-lite, GET /lists + /lists/{id}): the mock serves the
 * same seed the home rail renders from src/lib/lists.ts, and the pure
 * resolveList helper resolves the list's merchant ids against the merchants
 * repo (seed rank order preserved). */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState, getState } from '@/repos/mock/mockState';
import { MockFavoritesRepository, resetMockFavoritesListsState, favoriteListsForTests } from '@/repos/mock/favorites';
import { MockListsRepository } from '@/repos/mock/lists';
import { MockMerchantsRepository } from '@/repos/mock/merchants';
import { CURATED_LISTS, resolveList } from '@/lib/lists';
import { ApiError } from '@/api/client';

beforeEach(() => {
  resetMockState();
  resetMockFavoritesListsState();
});

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

function seededMerchantIds(count: number): string[] {
  return getState().merchants.slice(0, count).map((m) => m.id);
}

/* ---------------- favorites lists round-trip ---------------- */

test('seed: listLists returns the default "My favorites" list seeded from the existing favorites', async () => {
  const repo = new MockFavoritesRepository();
  const [a, b] = seededMerchantIds(2);
  await repo.add(a, 'fav-a');
  await repo.add(b, 'fav-b');
  const lists = await repo.listLists();
  assert.equal(lists.length, 1, 'fresh state seeds exactly the default list');
  assert.equal(lists[0].id, 'flist_my_favorites');
  assert.equal(lists[0].name, 'My favorites');
  assert.deepEqual(lists[0].merchantIds, [a, b], 'default list snapshots the favorites that exist at first access');
  assert.ok(Number.isFinite(Date.parse(lists[0].createdAt)), 'createdAt is an ISO timestamp');
});

test('createList adds a list (newest first) and appears in listLists', async () => {
  const repo = new MockFavoritesRepository();
  const created = await repo.createList({ name: 'Weekend eats' }, 'key-1');
  assert.equal(created.name, 'Weekend eats');
  assert.deepEqual(created.merchantIds, []);
  assert.match(created.id, /^flist_/);
  const lists = await repo.listLists();
  assert.equal(lists.length, 2);
  assert.equal(lists[0].id, created.id, 'newest list first');
});

test('createList with merchantIds keeps only existing favorites (unknown ids dropped)', async () => {
  const repo = new MockFavoritesRepository();
  const [a] = seededMerchantIds(1);
  await repo.add(a, 'fav-a');
  const created = await repo.createList({ name: 'Lunch spots', merchantIds: [a, 'merchant_nope'] }, 'key-1');
  assert.deepEqual(created.merchantIds, [a], 'unknown merchant ids are dropped server-side');
});

test('createList idempotency: same key replays the stored list; a key reuse with a different name → 422', async () => {
  const repo = new MockFavoritesRepository();
  const first = await repo.createList({ name: 'Weekend eats' }, 'key-1');
  const replay = await repo.createList({ name: 'Weekend eats' }, 'key-1');
  assert.equal(replay.id, first.id, 'same key + same name replays the same list — never a duplicate');
  assert.equal((await repo.listLists()).filter((l) => l.id === first.id).length, 1);
  await rejectsApiError(repo.createList({ name: 'Different name' }, 'key-1'), 422, 'VALIDATION_FAILED');
});

test('addToList adds a favorite merchant and is a no-op for a duplicate', async () => {
  const repo = new MockFavoritesRepository();
  const created = await repo.createList({ name: 'Lunch spots' }, 'key-1');
  const [a, b] = seededMerchantIds(2);
  await repo.add(a, 'fav-a');
  await repo.add(b, 'fav-b');

  const afterFirst = await repo.addToList(created.id, a, 'add-1');
  assert.deepEqual(afterFirst.merchantIds, [a], 'merchant appended in add order');
  const afterSecond = await repo.addToList(created.id, b, 'add-2');
  assert.deepEqual(afterSecond.merchantIds, [a, b]);
  const dup = await repo.addToList(created.id, a, 'add-3');
  assert.deepEqual(dup.merchantIds, [a, b], 'adding a merchant already in the list is a no-op (idempotent)');
});

test('removeFromList removes a merchant; removing one not in the list is a no-op', async () => {
  const repo = new MockFavoritesRepository();
  const created = await repo.createList({ name: 'Lunch spots' }, 'key-1');
  const [a, b] = seededMerchantIds(2);
  await repo.add(a, 'fav-a');
  await repo.add(b, 'fav-b');
  await repo.addToList(created.id, a, 'add-1');
  await repo.addToList(created.id, b, 'add-2');

  const after = await repo.removeFromList(created.id, a, 'remove-1');
  assert.deepEqual(after.merchantIds, [b]);
  const noop = await repo.removeFromList(created.id, a, 'remove-2');
  assert.deepEqual(noop.merchantIds, [b], 'removing a merchant not in the list is a no-op');
});

test('deleteList removes the list from listLists', async () => {
  const repo = new MockFavoritesRepository();
  const created = await repo.createList({ name: 'Temp' }, 'key-1');
  await repo.deleteList(created.id, 'del-1');
  const lists = await repo.listLists();
  assert.equal(lists.some((l) => l.id === created.id), false);
  assert.equal(lists.length, 1, 'the seeded default list remains');
});

test('favoriteListsForTests exposes the module-local registry (deep clone)', async () => {
  const repo = new MockFavoritesRepository();
  await repo.createList({ name: 'Weekend eats' }, 'key-1');
  const snapshot = favoriteListsForTests();
  snapshot[0].name = 'mutated';
  const fresh = favoriteListsForTests();
  assert.equal(fresh[0].name, 'Weekend eats', 'test hook returns clones — never the live registry');
});

/* ---------------- favorites lists validation ---------------- */

test('createList with an empty or whitespace-only name → 422 VALIDATION_FAILED', async () => {
  const repo = new MockFavoritesRepository();
  await rejectsApiError(repo.createList({ name: '' }, 'k1'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(repo.createList({ name: '   ' }, 'k2'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(repo.createList({ name: '' }, 'k1'), 422, 'VALIDATION_FAILED');
});

test('createList name over 40 characters → 422 VALIDATION_FAILED', async () => {
  const repo = new MockFavoritesRepository();
  await rejectsApiError(repo.createList({ name: 'x'.repeat(41) }, 'k1'), 422, 'VALIDATION_FAILED');
  const ok = await repo.createList({ name: 'x'.repeat(40) }, 'k2');
  assert.equal(ok.name.length, 40);
});

test('addToList with an unknown list → 404 NOT_FOUND', async () => {
  const repo = new MockFavoritesRepository();
  const [a] = seededMerchantIds(1);
  await rejectsApiError(repo.addToList('flist_nope', a, 'k1'), 404, 'NOT_FOUND');
});

test('addToList with an unknown merchant → 404 NOT_FOUND', async () => {
  const repo = new MockFavoritesRepository();
  const created = await repo.createList({ name: 'Lunch spots' }, 'key-1');
  await rejectsApiError(repo.addToList(created.id, 'merchant_nope', 'k1'), 404, 'NOT_FOUND');
});

test('removeFromList with an unknown list or unknown merchant → 404 NOT_FOUND', async () => {
  const repo = new MockFavoritesRepository();
  const created = await repo.createList({ name: 'Lunch spots' }, 'key-1');
  const [a] = seededMerchantIds(1);
  await rejectsApiError(repo.removeFromList('flist_nope', a, 'k1'), 404, 'NOT_FOUND');
  await rejectsApiError(repo.removeFromList(created.id, 'merchant_nope', 'k2'), 404, 'NOT_FOUND');
});

test('deleteList with an unknown list → 404 NOT_FOUND', async () => {
  const repo = new MockFavoritesRepository();
  await rejectsApiError(repo.deleteList('flist_nope', 'k1'), 404, 'NOT_FOUND');
});

/* ---------------- curated lists repo (必吃榜-lite) ---------------- */

test('listCurated returns the seeded curated lists (seed rank order)', async () => {
  const repo = new MockListsRepository();
  const lists = await repo.listCurated();
  assert.equal(lists.length, CURATED_LISTS.length);
  assert.deepEqual(lists.map((l) => l.id), CURATED_LISTS.map((l) => l.id));
  assert.ok(lists.every((l) => l.merchantIds.length >= 3), 'every seeded list has ranked merchants');
});

test('getCurated returns one seeded list; an unknown id → 404 NOT_FOUND', async () => {
  const repo = new MockListsRepository();
  const list = await repo.getCurated('list_dar_top_rated');
  assert.equal(list.id, 'list_dar_top_rated');
  assert.equal(list.titleKey, 'lists.darTopRated');
  assert.deepEqual(list.merchantIds, CURATED_LISTS[0].merchantIds);
  await rejectsApiError(repo.getCurated('does_not_exist'), 404, 'NOT_FOUND');
});

test('list detail resolves merchants through the pure resolveList helper (rank order preserved)', async () => {
  const lists = new MockListsRepository();
  const merchants = new MockMerchantsRepository();
  const list = await lists.getCurated('list_dar_top_rated');
  const all = await merchants.list();
  const resolved = resolveList(list.id, all);
  assert.ok(resolved, 'list resolves against the seeded merchants');
  assert.deepEqual(
    resolved.merchants.map((m) => m.id),
    list.merchantIds,
    'every seed merchant exists in the store and keeps the seed rank order',
  );
});

test('every seeded curated merchant id exists in the deterministic mock store', async () => {
  const repo = new MockListsRepository();
  const seeded = new Set(getState().merchants.map((m) => m.id));
  for (const list of await repo.listCurated()) {
    for (const id of list.merchantIds) {
      assert.ok(seeded.has(id), `curated list ${list.id} references seeded merchant ${id}`);
    }
  }
});
