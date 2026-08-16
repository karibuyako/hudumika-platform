/* M8 — Super-app surfaces (P6b–P6c) + masked calls + the live event bus:
 * group-buy purchase → vouchers, reservations validation, dine-in QR bill,
 * masked-call session shape, and the events bus (guarded off under mocks). */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { rejectsApiError, resetMockState } from './helpers';
import { getState, simulateIntercityDelay } from '@/repos/mock/mockState';
import { MockGroupBuyRepository, mockVoucherCode } from '@/repos/mock/groupBuy';
import { MockVouchersRepository } from '@/repos/mock/vouchers';
import { MockReservationsRepository } from '@/repos/mock/reservations';
import { MockDineInRepository } from '@/repos/mock/dineIn';
import { MockPaymentsRepository } from '@/repos/mock/payments';
import { MockOrdersRepository } from '@/repos/mock/orders';
import { MockHomeRepository } from '@/repos/mock/home';
import { eventBus } from '@/store/events';
import { isEventsEnabled } from '@/api/events';
import { useUiStore } from '@/store/ui';
import { formatDealCountdown, shouldUseRelativeTime } from '@/lib/dates';
import { groupSubtotal, useCartStore } from '@/store/cart';
import type { OrderDetail } from '@hudumika/contract';

const groupBuy = new MockGroupBuyRepository();
const vouchers = new MockVouchersRepository();
const reservations = new MockReservationsRepository();
const dineIn = new MockDineInRepository();
const payments = new MockPaymentsRepository();
const orders = new MockOrdersRepository();
const home = new MockHomeRepository();

beforeEach(() => resetMockState());

test('group-buy purchase issues vouchers into the wallet and bumps soldCount', async () => {
  const deal = getState().groupBuys.find((g) => g.status === 'live')!;
  const before = deal.soldCount ?? 0;
  const issued = await groupBuy.purchase(deal.id!, 2, 'key-1');
  assert.equal(issued.length, 2);
  assert.ok(issued.every((v) => v.status === 'unused' && v.groupBuyId === deal.id));
  assert.equal(deal.soldCount, before + 2);
  const mine = await vouchers.list();
  assert.ok(mine.length >= 2);
});

test('group-buy get() returns the deal by id; unknown ids 404', async () => {
  const live = getState().groupBuys.find((g) => g.status === 'live')!;
  const got = await groupBuy.get(live.id!);
  assert.equal(got.id, live.id);
  assert.equal(got.status, 'live');
  await rejectsApiError(groupBuy.get('gb_missing'), 404, 'GROUP_BUY_NOT_FOUND');
});

test('group-buy guards: ended deal, status conflict and out-of-range quantity', async () => {
  const deal = getState().groupBuys[0];
  await rejectsApiError(groupBuy.purchase('gb_missing', 1, 'k'), 404, 'GROUP_BUY_NOT_FOUND');
  await rejectsApiError(groupBuy.purchase(deal.id!, 21, 'k'), 422, 'GROUP_BUY_QUANTITY_EXCEEDED');
  // An ended deal still resolves on get() (terminal detail) but never purchases.
  deal.status = 'ended';
  const ended = await groupBuy.get(deal.id!);
  assert.equal(ended.status, 'ended');
  await rejectsApiError(groupBuy.purchase(deal.id!, 1, 'k'), 422, 'GROUP_BUY_ENDED');
  // A draft/pending_review deal is not purchasable either (status conflict).
  deal.status = 'pending_review';
  await rejectsApiError(groupBuy.purchase(deal.id!, 1, 'k'), 409, 'GROUP_BUY_STATUS_CONFLICT');
});

test('voucher wallet data: GB-XXXX-XXXX codes and per-status rendering fields', async () => {
  const mine = await vouchers.list();
  assert.ok(mine.length >= 5, 'wallet seeds one voucher per status');
  for (const v of mine) assert.match(v.code, /^GB-[A-Z0-9]{4}-[A-Z0-9]{4}$/, `code ${v.code} matches GB-XXXX-XXXX`);
  assert.ok(mine.some((v) => v.status === 'unused' && v.expiresAt));
  const redeemed = mine.find((v) => v.status === 'redeemed');
  assert.ok(redeemed?.redeemedAt, 'redeemed vouchers carry redeemedAt');
  assert.ok(redeemed?.redeemedByMerchantId, 'redeemed vouchers carry redeemedByMerchantId');
  assert.ok(mine.some((v) => v.status === 'expired'));
  assert.ok(mine.some((v) => v.status === 'refunded'));
  assert.ok(mine.some((v) => v.status === 'void'));
  assert.match(mockVoucherCode(), /^GB-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
});

test('reservations: create validates the 1–50 contract bound and status is pending, then cancel', async () => {
  const merchant = getState().merchants[0];
  await rejectsApiError(reservations.create({ merchantId: merchant.id, partySize: 0, scheduledFor: new Date(Date.now() + 3600_000).toISOString() }, 'k1'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(reservations.create({ merchantId: merchant.id, partySize: 51, scheduledFor: new Date(Date.now() + 3600_000).toISOString() }, 'k2'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(reservations.create({ merchantId: merchant.id, partySize: 4, scheduledFor: new Date(Date.now() - 3600_000).toISOString() }, 'k3'), 422, 'RESERVATION_TIME_IN_PAST');
  const made = await reservations.create({ merchantId: merchant.id, partySize: 50, scheduledFor: new Date(Date.now() + 5 * 3600_000).toISOString() }, 'k4');
  assert.equal(made.partySize, 50);
  assert.equal(made.status, 'pending', '201 → pending');
  const mine = await reservations.list();
  assert.ok(mine.some((r) => r.id === made.id));
  const cancelled = await reservations.cancel(made.id, 'k5');
  assert.equal(cancelled.status, 'cancelled');
});

test('dine-in: QR resolve → table menu → open order → bill detail → pay', async () => {
  const tables = getState().dineInTables;
  const free = tables[1];
  const item = getState().catalogues.get(free.merchantId)!.items.find((i) => i.available !== false)!;

  // 1. Resolve the table QR — the server returns the merchant context.
  const resolved = await dineIn.resolveTable(free.tableId);
  assert.equal(resolved.qrPayload, `hudumika:dinein:table:${free.tableId}`);
  assert.equal(resolved.merchantId, free.merchantId);
  assert.ok(resolved.menuUrl.length > 0);

  // 2. Open the bill with real menu lines.
  const bill = await dineIn.openOrder(resolved.merchantId, free.tableId, [{ catalogueItemId: item.id!, quantity: 2 }], 'k1');
  assert.equal(bill.status, 'open');
  assert.equal(bill.tableId, free.tableId);
  assert.equal(bill.merchantId, free.merchantId);
  assert.equal(bill.totals.totalTZS, bill.totals.subtotalTZS);
  assert.ok(bill.totals.totalTZS > 0, 'server computes the total');
  assert.ok((bill.items ?? []).length === 1 && bill.items![0].quantity === 2);

  // 3. Bill detail round-trips.
  const detail = await dineIn.getOrder(bill.id);
  assert.equal(detail.id, bill.id);
  assert.equal(detail.totals.totalTZS, bill.totals.totalTZS);

  // 4. The same table now reports DINE_IN_TABLE_IN_USE (one open bill per table).
  await rejectsApiError(dineIn.resolveTable(free.tableId), 409, 'DINE_IN_TABLE_IN_USE');
  await rejectsApiError(dineIn.openOrder(resolved.merchantId, free.tableId, [{ catalogueItemId: item.id!, quantity: 1 }], 'k2'), 409, 'DINE_IN_TABLE_IN_USE');

  // 5. Pay the bill through the intent flow → paid + paidAt (mock "webhook").
  const intent = await payments.createIntent(bill.id, 'mpesa', 'k3');
  assert.equal(intent.amountTZS, bill.totals.totalTZS);
  const paid = await payments.confirm(intent.id, 'k4');
  assert.equal(paid.status, 'paid');
  const after = await dineIn.getOrder(bill.id);
  assert.equal(after.status, 'paid');
  assert.ok(after.paidAt, 'paidAt is set');
  // A paid bill is no longer payable.
  await rejectsApiError(payments.createIntent(bill.id, 'mpesa', 'k5'), 409, 'DINE_IN_BILL_NOT_PAYABLE');

  const mine = await dineIn.listMyOrders();
  assert.ok(mine.some((b) => b.id === bill.id));
});

test('dine-in guards: unknown table/order, empty bill, wrong merchant', async () => {
  const tables = getState().dineInTables;
  const merchant = getState().merchants[0];
  const item = getState().catalogues.get(tables[1].merchantId)!.items.find((i) => i.available !== false)!;
  await rejectsApiError(dineIn.resolveTable('table_missing'), 404, 'DINE_IN_TABLE_NOT_FOUND');
  await rejectsApiError(dineIn.getOrder('dine_missing'), 404, 'DINE_IN_ORDER_NOT_FOUND');
  await rejectsApiError(dineIn.openOrder(tables[1].merchantId, tables[1].tableId, [], 'k1'), 422, 'VALIDATION_FAILED');
  await rejectsApiError(dineIn.openOrder(merchant.id, tables[1].tableId, [{ catalogueItemId: item.id!, quantity: 1 }], 'k2'), 404, 'DINE_IN_TABLE_NOT_FOUND');
});

test('home feed recentOrders feed the reorder quick action: cart groups per merchant with integer TZS subtotal', async () => {
  const feed = await home.getHomeFeed();
  const recent = (feed.recentOrders ?? [])[0] as OrderDetail;
  assert.ok(recent, 'reorder needs a recent order on the feed');
  assert.ok((recent.items ?? []).length > 0, 'the recent order carries line items');

  useCartStore.setState({ groups: [] });
  for (const item of recent.items ?? []) {
    useCartStore.getState().addItem(
      { merchantId: recent.merchantId, merchantName: 'Merchant' },
      { catalogueItemId: item.catalogueItemId, name: item.name, unitPriceTZS: item.unitPriceTZS, quantity: item.quantity },
    );
  }
  const groups = useCartStore.getState().groups;
  assert.equal(groups.length, 1, 'one order = one merchant group');
  assert.equal(groups[0].merchantId, recent.merchantId);
  const subtotal = groupSubtotal(groups[0]);
  assert.ok(Number.isInteger(subtotal), 'cart subtotal stays integer TZS');
  assert.equal(subtotal, recent.totals.subtotalTZS, 'cart subtotal matches the order subtotal');
});

test('masked call sessions hide real numbers and expire', async () => {
  const active = getState().orders.find((o) => o.status === 'delivering') ?? getState().orders[0];
  const session = await orders.createMaskedCall(active.id, 'k1');
  assert.match(session.maskedNumber, /^\*|\*/);
  assert.equal(session.direction, 'customer_to_rider');
  assert.ok(Date.parse(session.expiresAt) > Date.now());
  await rejectsApiError(orders.createMaskedCall('ord_nope', 'k2'), 404, 'ORDER_NOT_FOUND');
});

test('intercity delay simulation shifts the linehaul window and stamps an exception (P8)', () => {
  const before = getState().routes.get('ord_intercity_002')!.find((l) => l.type === 'linehaul')!.etaAt!;
  simulateIntercityDelay(getState(), 2);
  const after = getState().routes.get('ord_intercity_002')!.find((l) => l.type === 'linehaul')!.etaAt!;
  assert.ok(Date.parse(after) > Date.parse(before));
  const wb = getState().waybills.get('ord_intercity_002')!;
  assert.equal(wb.events[wb.events.length - 1].type, 'exception');
});

test('event bus: subscribers receive only matching types and unsubscribe cleanly', () => {
  const got: string[] = [];
  const unsub = eventBus.subscribe((type) => got.push(type));
  eventBus.publish('order.updated', { orderId: 'o1' });
  eventBus.publish('chat.message');
  unsub();
  eventBus.publish('order.updated');
  assert.deepEqual(got, ['order.updated', 'chat.message']);
  assert.equal(eventBus.size, 0);
});

test('the /events stream stays off under the default mock env (no phantom server)', () => {
  assert.equal(isEventsEnabled(), false);
});

test('toast store shows and dismisses (DESIGN-SYSTEM Toast)', () => {
  const store = useUiStore;
  store.getState().showToast('hello');
  assert.equal(store.getState().toast?.message, 'hello');
  assert.equal(store.getState().toast?.kind, 'success');
  store.getState().showToast('bad', 'error');
  assert.equal(store.getState().toast?.kind, 'error');
  store.getState().dismissToast();
  assert.equal(store.getState().toast, null);
});

test('group-buy sale countdown: future → text, past/now → null (ended)', () => {
  const now = Date.parse('2026-08-15T12:00:00Z');
  assert.ok(formatDealCountdown('2026-08-15T14:00:00Z', now), 'future end renders a countdown string');
  assert.match(formatDealCountdown('2026-08-16T12:00:00Z', now)!, /^\d+d \d+h$/);
  assert.match(formatDealCountdown('2026-08-15T12:30:00Z', now)!, /^\d+m$/);
  assert.equal(formatDealCountdown('2026-08-15T11:59:59Z', now), null, 'past end → ended');
  assert.equal(formatDealCountdown('2026-08-15T12:00:00Z', now), null, 'exactly now → ended');
  assert.equal(formatDealCountdown(null, now), null);
  assert.equal(formatDealCountdown('nope', now), null);
});

test('notification rows: relative time under 24h, absolute at/over 24h', () => {
  const now = Date.parse('2026-08-15T12:00:00Z');
  assert.equal(shouldUseRelativeTime('2026-08-15T11:59:00Z', now), true, 'just under 24h → relative');
  assert.equal(shouldUseRelativeTime('2026-08-14T12:00:00Z', now), false, 'exactly 24h → absolute');
  assert.equal(shouldUseRelativeTime('2026-08-13T12:00:00Z', now), false, 'over 24h → absolute');
  assert.equal(shouldUseRelativeTime(null, now), false);
});

test('search view mode store: defaults to list, toggles grid/list (blueprint §6)', () => {
  const store = useUiStore;
  assert.equal(store.getState().searchViewMode, 'list');
  store.getState().setSearchViewMode('grid');
  assert.equal(store.getState().searchViewMode, 'grid');
  store.getState().setSearchViewMode('list');
  assert.equal(store.getState().searchViewMode, 'list');
});
