/* M15b — Group ordering (拼单, Meituan shared-order parity,
 * docs/CONTRACT-ADDITIONS.md #11): create/get with the seeded invited member,
 * catalogue validation (ORDER_ITEM_UNAVAILABLE / ORDER_PRICE_CHANGED),
 * add/remove item, finalize → a real order (status, integer TZS totals,
 * orders list, mock-only member contributions), expiry rejection (CONFLICT),
 * per-key idempotency, and the deep-link allow-list entry. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '@/api/client';
import { deepLinkHref, parseAndValidateDeepLink } from '@/lib/deep-link';
import { expireGroupOrder, MockGroupOrdersRepository, resetMockGroupOrdersState, SEED_GROUP_ORDER_ID } from '@/repos/mock/groupOrders';
import { getState, resetMockState } from '@/repos/mock/mockState';
import { MockOrdersRepository } from '@/repos/mock/orders';

const repo = new MockGroupOrdersRepository();
const ordersRepo = new MockOrdersRepository();

beforeEach(() => {
  resetMockState();
  resetMockGroupOrdersState();
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

const merchantId = () => getState().merchants[0].id;
const itemId = (i: number) => `citem_${merchantId().slice(-6)}_${i}`;
const LOCAL_MEMBER = getState().user.fullName;

async function openSession(): Promise<string> {
  const session = await repo.create({ merchantId: merchantId() }, 'key-create');
  return session.id;
}

test('create returns an open session with the local user + a seeded invited member', async () => {
  const session = await repo.create({ merchantId: merchantId() }, 'key-create');
  assert.equal(session.status, 'open');
  assert.equal(session.merchantId, merchantId());
  assert.equal(session.title, getState().merchants[0].businessName, 'title defaults to the merchant business name');
  assert.equal(session.members.length, 2);
  const me = session.members.find((m) => m.name === LOCAL_MEMBER);
  const juma = session.members.find((m) => m.name === 'Juma');
  assert.ok(me, 'the local user is a member');
  assert.ok(juma, 'the invited member is seeded');
  assert.equal(me!.items.length, 0);
  assert.equal(juma!.items.length, 2, 'the invited member has a couple of items pre-added');
  assert.ok(juma!.subtotalTZS > 0 && Number.isInteger(juma!.subtotalTZS));
  // Totals mirror buildOrderFrom pricing: subtotal + 2500 delivery + 800 platform.
  assert.ok(Number.isInteger(session.totals.totalTZS));
  assert.equal(session.totals.totalTZS, session.totals.subtotalTZS + session.totals.deliveryFeeTZS + session.totals.platformFeeTZS);
  assert.ok(Date.parse(session.expiresAt) > Date.now());
  // get() round-trips the same session.
  const fetched = await repo.get(session.id);
  assert.deepEqual(fetched, session);
});

test('create validates the merchant and the expiry window', async () => {
  await rejectsApiError(repo.create({ merchantId: 'mer_nope' }, 'k1'), 404, 'NOT_FOUND');
  await rejectsApiError(repo.create({ merchantId: merchantId(), expiresInMinutes: 0 }, 'k2'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(repo.create({ merchantId: merchantId(), expiresInMinutes: 1.5 }, 'k3'), 422, 'VALIDATION_FAILED');
});

test('same create key replays the same session (idempotent)', async () => {
  const a = await repo.create({ merchantId: merchantId() }, 'key-create');
  const b = await repo.create({ merchantId: merchantId(), title: 'different' }, 'key-create');
  assert.equal(a.id, b.id);
  assert.equal(b.title, a.title);
});

test('addItem validates the catalogue: unavailable item and price change', async () => {
  const id = await openSession();
  // Catalogue item index 3 is seeded unavailable (mockState buildCatalogue).
  await rejectsApiError(
    repo.addItem(id, LOCAL_MEMBER, { catalogueItemId: itemId(3), quantity: 1 }, 'k-unavail'),
    422,
    'ORDER_ITEM_UNAVAILABLE',
  );
  // A stale client price trips the base-price check (server is the authority).
  await rejectsApiError(
    repo.addItem(id, LOCAL_MEMBER, { catalogueItemId: itemId(0), quantity: 1, unitPriceTZS: 100 }, 'k-price'),
    422,
    'ORDER_PRICE_CHANGED',
  );
  // Unknown member / unknown session are 404s.
  await rejectsApiError(repo.addItem(id, 'Nobody', { catalogueItemId: itemId(0), quantity: 1 }, 'k-member'), 404, 'NOT_FOUND');
  await rejectsApiError(repo.addItem('gor_nope', LOCAL_MEMBER, { catalogueItemId: itemId(0), quantity: 1 }, 'k-session'), 404, 'NOT_FOUND');
});

test('addItem merges quantities and recomputes the member subtotal', async () => {
  const id = await openSession();
  const after = await repo.addItem(id, LOCAL_MEMBER, { catalogueItemId: itemId(0), quantity: 2 }, 'k-add-1');
  const me = after.members.find((m) => m.name === LOCAL_MEMBER)!;
  assert.equal(me.items.length, 1);
  assert.equal(me.items[0].quantity, 2);
  assert.equal(me.items[0].unitPriceTZS, 12000, 'line price is the catalogue base');
  const merged = await repo.addItem(id, LOCAL_MEMBER, { catalogueItemId: itemId(0), quantity: 1 }, 'k-add-2');
  const meAfter = merged.members.find((m) => m.name === LOCAL_MEMBER)!;
  assert.equal(meAfter.items[0].quantity, 3);
  assert.equal(meAfter.subtotalTZS, 36000);
  assert.equal(merged.totals.subtotalTZS, 33000 + 36000, 'session subtotal sums both members');
});

test('same addItem key does not double-add (idempotent)', async () => {
  const id = await openSession();
  const a = await repo.addItem(id, LOCAL_MEMBER, { catalogueItemId: itemId(0), quantity: 2 }, 'k-add');
  const b = await repo.addItem(id, LOCAL_MEMBER, { catalogueItemId: itemId(0), quantity: 2 }, 'k-add');
  assert.deepEqual(b, a, 'replay returns the recorded result');
  const me = (await repo.get(id)).members.find((m) => m.name === LOCAL_MEMBER)!;
  assert.equal(me.items[0].quantity, 2);
});

test('removeItem removes only the named member line and recomputes totals', async () => {
  const id = await openSession();
  await repo.addItem(id, LOCAL_MEMBER, { catalogueItemId: itemId(0), quantity: 2 }, 'k-add');
  const after = await repo.removeItem(id, LOCAL_MEMBER, itemId(0), 'k-remove');
  const me = after.members.find((m) => m.name === LOCAL_MEMBER)!;
  assert.equal(me.items.length, 0);
  assert.equal(me.subtotalTZS, 0);
  assert.equal(after.totals.subtotalTZS, 33000, 'Juma contribution stays');
  await rejectsApiError(repo.removeItem(id, LOCAL_MEMBER, itemId(0), 'k-remove-2'), 404, 'NOT_FOUND');
});

test('finalize converts the shared cart into a real order with member contributions', async () => {
  const id = await openSession();
  await repo.addItem(id, LOCAL_MEMBER, { catalogueItemId: itemId(0), quantity: 1 }, 'k-add');
  const order = await repo.finalize(id, 'cod', getState().orders[0].deliveryAddress, 'k-finalize');
  assert.equal(order.status, 'paid', 'COD finalizes as paid');
  assert.equal(order.merchantId, merchantId());
  assert.equal(order.source, 'app');
  assert.ok(Number.isInteger(order.totals.subtotalTZS) && Number.isInteger(order.totals.totalTZS));
  assert.equal(order.totals.totalTZS, order.totals.subtotalTZS + order.totals.deliveryFeeTZS + order.totals.platformFeeTZS - order.totals.discountTZS);
  // Mock-only contributions ledger: one per member with items.
  const contributions = order.groupOrderContributions;
  assert.ok(contributions, 'finalize records the member contributions (mock-only field)');
  assert.equal(contributions!.length, 2);
  assert.equal(contributions!.find((c) => c.memberName === LOCAL_MEMBER)!.subtotalTZS, 12000);
  assert.equal(contributions!.find((c) => c.memberName === 'Juma')!.items.length, 2);
  // The order lands in /orders/me and the session flips to 'ordered'.
  const listed = await ordersRepo.list();
  assert.ok(listed.some((o) => o.id === order.id), 'finalized order appears in the orders list');
  const session = await repo.get(id);
  assert.equal(session.status, 'ordered');
  assert.equal(session.orderId, order.id);
  // Mutations are rejected once ordered.
  await rejectsApiError(repo.addItem(id, LOCAL_MEMBER, { catalogueItemId: itemId(1), quantity: 1 }, 'k-add-2'), 409, 'CONFLICT');
});

test('finalize without a wallet payment method leaves the order pending payment', async () => {
  const id = await openSession();
  const order = await repo.finalize(id, 'mpesa', getState().orders[0].deliveryAddress, 'k-finalize');
  assert.equal(order.status, 'pending_payment');
  assert.equal(order.totals.totalTZS, 36300, 'Juma 33000 + 2500 delivery + 800 platform');
});

test('finalize rejects an empty session (ORDER_EMPTY) and a closed merchant', async () => {
  const id = await openSession();
  await repo.removeItem(id, 'Juma', itemId(0), 'k-rem-1');
  await repo.removeItem(id, 'Juma', itemId(1), 'k-rem-2');
  await rejectsApiError(repo.finalize(id, 'mpesa', getState().orders[0].deliveryAddress, 'k-fin-empty'), 422, 'ORDER_EMPTY');

  const merchant = getState().merchants[1];
  merchant.isOpen = false;
  const session = await repo.create({ merchantId: merchant.id }, 'k-create');
  await rejectsApiError(repo.finalize(session.id, 'mpesa', getState().orders[0].deliveryAddress, 'k-fin'), 422, 'ORDER_MERCHANT_CLOSED');
  merchant.isOpen = true;
});

test('a seeded demo session is readable out of the box (deep-link target)', async () => {
  const seed = await repo.get(SEED_GROUP_ORDER_ID);
  assert.equal(seed.status, 'open');
  assert.equal(seed.merchantId, merchantId());
  assert.equal(seed.members.length, 2);
  const juma = seed.members.find((m) => m.name === 'Juma');
  assert.ok(juma && juma.items.length === 2);
  const me = seed.members.find((m) => m.name === LOCAL_MEMBER);
  assert.ok(me && me.items.length === 1);
});

test('expired sessions reject mutations with CONFLICT and render as expired', async () => {
  const id = await openSession();
  expireGroupOrder(id);
  const session = await repo.get(id);
  assert.equal(session.status, 'expired');
  await rejectsApiError(repo.addItem(id, LOCAL_MEMBER, { catalogueItemId: itemId(0), quantity: 1 }, 'k-add'), 409, 'CONFLICT');
  await rejectsApiError(repo.removeItem(id, LOCAL_MEMBER, itemId(0), 'k-remove'), 409, 'CONFLICT');
  await rejectsApiError(repo.finalize(id, 'cod', getState().orders[0].deliveryAddress, 'k-finalize'), 409, 'CONFLICT');
});

test('deep-link allow-list accepts hudumika://group-order/{id} and maps to the route', () => {
  assert.equal(parseAndValidateDeepLink('hudumika://group-order/gor_abc'), 'group-order/gor_abc');
  assert.equal(parseAndValidateDeepLink('https://app.hudumika.tz/group-order/gor_abc'), 'group-order/gor_abc');
  assert.equal(parseAndValidateDeepLink('group-order/gor_abc'), 'group-order/gor_abc');
  assert.equal(parseAndValidateDeepLink('hudumika://nope/xyz'), null, 'unknown routes stay rejected');
  const href = deepLinkHref('group-order/gor_abc');
  assert.deepEqual(href, { pathname: '/group-order/[groupId]', params: { groupId: 'gor_abc' } });
});
