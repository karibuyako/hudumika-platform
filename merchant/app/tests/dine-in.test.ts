import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import { subscribe } from '@/mock/events';
import { createSession } from '@/mock/security';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let base = 'http://localhost';
let token: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; idem?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.auth !== false) headers.authorization = `Bearer ${token ?? ''}`;
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  const res = await fetch(`${base}${url}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body };
}

async function tableByName(name: string): Promise<{ id: string }> {
  const list = await call('GET', `/tables?storeId=s_demo`);
  const t = list.body.tables.find((x: any) => x.name === name);
  assert.ok(t, `seeded table ${name} exists`);
  return t;
}

function openBody(tableId: string, items: { catalogueItemId: string; quantity: number }[]) {
  return { merchantId: 'm_demo', tableId, items };
}

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: '+255700000000', purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  token = ok.body.accessToken;
});

after(() => {
  server.close();
});

/* ================= Dine-in bill lifecycle ================= */

test('dine-in: open bill on a free table -> 201, integer TZS totals, table claimed', async () => {
  const events: string[] = [];
  const unsub = subscribe((e) => {
    if (e.type === 'dine_in.bill_opened') events.push(e.type);
  });

  const table = await tableByName('A3');
  const p1 = db.table('products').find('p1')!;
  const res = await call('POST', '/dine-in/orders', {
    body: openBody(table.id, [{ catalogueItemId: 'p1', quantity: 2 }]),
    idem: 't-din-open-1',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const bill = res.body.bill;
  assert.equal(bill.status, 'open');
  assert.equal(bill.merchantId, 'm_demo');
  assert.equal(bill.tableId, table.id);
  assert.equal(bill.items.length, 1);
  assert.equal(bill.items[0].name, p1.name);
  assert.equal(bill.items[0].unitPriceTZS, p1.price);
  assert.equal(bill.items[0].quantity, 2);
  assert.equal(bill.totals.subtotalTZS, p1.price * 2, 'subtotal = unit price x qty');
  for (const v of Object.values(bill.totals)) assert.equal(Number.isInteger(v), true, `total field is integer TZS (${v})`);
  assert.equal(bill.totals.deliveryFeeTZS, 0);
  assert.equal(bill.totals.discountTZS, 0);
  assert.equal(bill.totals.totalTZS, bill.totals.subtotalTZS + bill.totals.taxTZS);
  assert.ok(bill.createdAt > 0);
  assert.equal(bill.paidAt, null);

  const tables = await call('GET', '/tables?storeId=s_demo');
  const claimed = tables.body.tables.find((t: any) => t.id === table.id);
  assert.equal(claimed.currentOrderId, bill.id, 'table carries currentOrderId');
  assert.equal(claimed.status, 'occupied', 'table marked occupied');

  assert.ok(events.includes('dine_in.bill_opened'), 'dine_in.bill_opened emitted');
  unsub();
});

test('dine-in: open on an occupied table is rejected 409 DINE_IN_TABLE_IN_USE', async () => {
  const table = await tableByName('A1');
  assert.ok(table.id);
  const res = await call('POST', '/dine-in/orders', {
    body: openBody(table.id, [{ catalogueItemId: 'p1', quantity: 1 }]),
    idem: 't-din-inuse',
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'DINE_IN_TABLE_IN_USE');
});

test('dine-in: idempotency-key dedupes open — replay returns the same bill, no second bill', async () => {
  const table = await tableByName('A4');
  const body = openBody(table.id, [{ catalogueItemId: 'p1', quantity: 1 }]);
  const first = await call('POST', '/dine-in/orders', { body, idem: 't-din-idem' });
  assert.equal(first.status, 201);
  const second = await call('POST', '/dine-in/orders', { body, idem: 't-din-idem' });
  assert.equal(second.status, 200, 'replay with same key returns 200');
  assert.equal(second.body.bill.id, first.body.bill.id, 'replay returns the same bill');
  const count = db.table('dineInOrders').where((b: any) => b.tableId === table.id).length;
  assert.equal(count, 1, 'only one bill created');
  const tables = await call('GET', '/tables?storeId=s_demo');
  assert.equal(tables.body.tables.find((t: any) => t.id === table.id).currentOrderId, first.body.bill.id);
});

test('dine-in: open without idempotency-key is rejected 400', async () => {
  const table = await tableByName('B1');
  const res = await call('POST', '/dine-in/orders', { body: openBody(table.id, [{ catalogueItemId: 'p1', quantity: 1 }]) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('dine-in: unknown bill detail is 404 DINE_IN_BILL_NOT_FOUND', async () => {
  const res = await call('GET', '/dine-in/orders/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'DINE_IN_BILL_NOT_FOUND');
});

test('dine-in: my bills list returns seeded bills; status filter narrows', async () => {
  const all = await call('GET', '/dine-in/orders/me');
  assert.equal(all.status, 200);
  const ids = all.body.bills.map((b: any) => b.id);
  assert.ok(ids.includes('dio_seed_1'), 'seeded billing bill listed');
  assert.ok(ids.includes('dio_seed_2'), 'seeded paid bill listed');

  const billing = await call('GET', '/dine-in/orders/me?status=billing');
  assert.ok(billing.body.bills.length >= 1);
  assert.ok(billing.body.bills.every((b: any) => b.status === 'billing'));
  assert.ok(billing.body.bills.some((b: any) => b.id === 'dio_seed_1'));

  const paid = await call('GET', '/dine-in/orders/me?status=paid');
  assert.ok(paid.body.bills.every((b: any) => b.status === 'paid'));
  assert.ok(paid.body.bills.some((b: any) => b.id === 'dio_seed_2'));
});

test('dine-in: seeded billing bill detail shape (items, PriceBreakdown, table, timestamps)', async () => {
  const res = await call('GET', '/dine-in/orders/dio_seed_1');
  assert.equal(res.status, 200);
  const bill = res.body.bill;
  assert.equal(bill.status, 'billing');
  assert.equal(bill.merchantId, 'm_demo');
  assert.ok(bill.tableId);
  assert.ok(bill.items.length >= 1);
  for (const it of bill.items) {
    assert.ok(it.catalogueItemId && it.name, 'item has catalogueItemId + name');
    assert.equal(Number.isInteger(it.quantity), true);
    assert.equal(Number.isInteger(it.unitPriceTZS), true, 'unitPriceTZS is integer TZS');
  }
  assert.deepEqual(Object.keys(bill.totals).sort(), ['deliveryFeeTZS', 'discountTZS', 'platformFeeTZS', 'subtotalTZS', 'taxTZS', 'totalTZS']);
  for (const v of Object.values(bill.totals)) assert.equal(Number.isInteger(v), true);
  assert.equal(bill.totals.totalTZS, bill.totals.subtotalTZS + bill.totals.taxTZS);
  assert.ok(bill.createdAt > 0);
  assert.equal(bill.paidAt, null);
});

test('dine-in: confirm-payment transitions billing -> paid, sets paidAt, emits event', async () => {
  const events: string[] = [];
  const unsub = subscribe((e) => {
    if (e.type === 'dine_in.payment_confirmed') events.push(e.type);
  });

  const res = await call('POST', '/dine-in/orders/dio_seed_1/confirm-payment', {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const bill = res.body.bill;
  assert.equal(bill.status, 'paid');
  assert.ok(bill.paidAt > 0, 'paidAt set on confirm');

  const detail = await call('GET', '/dine-in/orders/dio_seed_1');
  assert.equal(detail.body.bill.status, 'paid', 'paid persists');
  assert.ok(events.includes('dine_in.payment_confirmed'), 'dine_in.payment_confirmed emitted');
  unsub();
});

test('dine-in: confirming an already-paid bill is idempotent', async () => {
  const res = await call('POST', '/dine-in/orders/dio_seed_1/confirm-payment', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.bill.status, 'paid');
});

test('dine-in: close paid bill -> closed, table currentOrderId cleared, event emitted', async () => {
  const events: string[] = [];
  const unsub = subscribe((e) => {
    if (e.type === 'dine_in.bill_closed') events.push(e.type);
  });

  const table = await tableByName('B2');
  const opened = await call('POST', '/dine-in/orders', {
    body: openBody(table.id, [{ catalogueItemId: 'p1', quantity: 1 }]),
    idem: 't-din-close-open',
  });
  const billId = opened.body.bill.id;
  const paid = await call('POST', `/dine-in/orders/${billId}/confirm-payment`, {});
  assert.equal(paid.body.bill.status, 'paid');

  const closed = await call('POST', `/dine-in/orders/${billId}/close`, {});
  assert.equal(closed.status, 200);
  assert.equal(closed.body.bill.status, 'closed');

  const tables = await call('GET', '/tables?storeId=s_demo');
  const row = tables.body.tables.find((t: any) => t.id === table.id);
  assert.equal(row.currentOrderId, null, 'table currentOrderId cleared');
  assert.equal(row.status, 'idle', 'table freed');
  assert.ok(events.includes('dine_in.bill_closed'), 'dine_in.bill_closed emitted');
  unsub();
});

test('dine-in: double-close is idempotent (200, still closed)', async () => {
  const table = await tableByName('C2');
  const opened = await call('POST', '/dine-in/orders', {
    body: openBody(table.id, [{ catalogueItemId: 'p1', quantity: 1 }]),
    idem: 't-din-double-close',
  });
  const billId = opened.body.bill.id;
  await call('POST', `/dine-in/orders/${billId}/confirm-payment`, {});
  const first = await call('POST', `/dine-in/orders/${billId}/close`, {});
  assert.equal(first.status, 200);
  assert.equal(first.body.bill.status, 'closed');
  const second = await call('POST', `/dine-in/orders/${billId}/close`, {});
  assert.equal(second.status, 200);
  assert.equal(second.body.bill.status, 'closed', 'replay close is idempotent');
});

test('dine-in: closing an unpaid bill is 409 DINE_IN_ORDER_STATUS_CONFLICT', async () => {
  const table = await tableByName('B1');
  const opened = await call('POST', '/dine-in/orders', {
    body: openBody(table.id, [{ catalogueItemId: 'p1', quantity: 1 }]),
    idem: 't-din-conflict',
  });
  const billId = opened.body.bill.id;
  const res = await call('POST', `/dine-in/orders/${billId}/close`, {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'DINE_IN_ORDER_STATUS_CONFLICT');
});

test('dine-in: confirming a closed bill is 409 DINE_IN_BILL_NOT_PAYABLE', async () => {
  const table = await tableByName('C1');
  const opened = await call('POST', '/dine-in/orders', {
    body: openBody(table.id, [{ catalogueItemId: 'p1', quantity: 1 }]),
    idem: 't-din-notpayable',
  });
  const billId = opened.body.bill.id;
  await call('POST', `/dine-in/orders/${billId}/confirm-payment`, {});
  await call('POST', `/dine-in/orders/${billId}/close`, {});
  const res = await call('POST', `/dine-in/orders/${billId}/confirm-payment`, {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'DINE_IN_BILL_NOT_PAYABLE');
});

/* ================= Table QR ================= */

test('dine-in: table QR returns contract shape {qrPayload, menuUrl}', async () => {
  const table = await tableByName('C1');
  const res = await call('GET', `/dine-in/tables/${table.id}/qr`);
  assert.equal(res.status, 200);
  assert.equal(res.body.qrPayload, `hudumika:dinein:table:${table.id}`);
  assert.match(res.body.menuUrl, new RegExp(`^https://order\\.example\\.com/q/s_demo/${table.id}\\?t=`), 'menuUrl built from store urlPattern');
});

test('dine-in: QR for unknown table is 404 DINE_IN_TABLE_NOT_FOUND', async () => {
  const res = await call('GET', '/dine-in/tables/does-not-exist/qr');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'DINE_IN_TABLE_NOT_FOUND');
});

/* ================= Table shape (DI-02): contract label/active aliases ================= */

test('dine-in: tables list emits contract aliases (label = name, active = !disabled)', async () => {
  const res = await call('GET', '/dine-in/tables?storeId=s_demo');
  assert.equal(res.status, 200);
  assert.ok(res.body.tables.length >= 1);
  for (const tb of res.body.tables) {
    assert.equal(tb.label, tb.name, 'label mirrors name');
    assert.equal(tb.active, !tb.disabled, 'active mirrors !disabled');
    assert.ok(tb.label.length <= 40, 'label is at most 40 chars');
  }
});

test('dine-in: create table with label + default capacity 4; both aliases emitted', async () => {
  const res = await call('POST', '/dine-in/tables', { body: { storeId: 's_demo', label: 'X9' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const tb = res.body.table;
  assert.equal(tb.label, 'X9');
  assert.equal(tb.name, 'X9', 'name alias emitted');
  assert.equal(tb.capacity, 4, 'capacity defaults to 4');
  assert.equal(tb.active, true);
  assert.equal(tb.disabled, false);
});

test('dine-in: create with active:false is disabled; label > 40 is 422', async () => {
  const disabled = await call('POST', '/dine-in/tables', { body: { storeId: 's_demo', label: 'D1', active: false } });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.table.disabled, true);
  assert.equal(disabled.body.table.active, false);

  const tooLong = await call('POST', '/dine-in/tables', { body: { storeId: 's_demo', label: 'A'.repeat(41) } });
  assert.equal(tooLong.status, 422);
  assert.equal(tooLong.body.error.code, 'VALIDATION_FAILED');
});

test('dine-in: PATCH label updates both aliases; manual status patch is rejected (409)', async () => {
  const created = await call('POST', '/dine-in/tables', { body: { storeId: 's_demo', label: 'Y2' } });
  const id = created.body.table.id;

  const patched = await call('PATCH', `/dine-in/tables/${id}`, { body: { label: 'Y2 Renamed' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.table.label, 'Y2 Renamed');
  assert.equal(patched.body.table.name, 'Y2 Renamed');

  const statusPatch = await call('PATCH', `/dine-in/tables/${id}`, { body: { status: 'occupied' } });
  assert.equal(statusPatch.status, 409);
  assert.equal(statusPatch.body.error.code, 'DINE_IN_TABLE_IN_USE', 'occupancy cannot be fabricated via PATCH');

  const activePatch = await call('PATCH', `/dine-in/tables/${id}`, { body: { active: false } });
  assert.equal(activePatch.body.table.active, false);
  assert.equal(activePatch.body.table.disabled, true);
});

/* ================= open -> billing (DI-03) + payment evidence (DI-04) ================= */

test('dine-in: request-bill moves open -> billing and emits dine_in.bill_requested', async () => {
  const events: string[] = [];
  const unsub = subscribe((e) => {
    if (e.type === 'dine_in.bill_requested') events.push(e.type);
  });
  const table = await tableByName('B2');
  const opened = await call('POST', '/dine-in/orders', {
    body: openBody(table.id, [{ catalogueItemId: 'p1', quantity: 1 }]),
    idem: 't-din-bill-request-open',
  });
  const billId = opened.body.bill.id;
  assert.equal(opened.body.bill.status, 'open');

  const req = await call('POST', `/dine-in/orders/${billId}/request-bill`, {});
  assert.equal(req.status, 200, JSON.stringify(req.body));
  assert.equal(req.body.bill.status, 'billing');

  const replay = await call('POST', `/dine-in/orders/${billId}/request-bill`, {});
  assert.equal(replay.status, 200, 'request-bill on a billing bill is idempotent');
  assert.equal(replay.body.bill.status, 'billing');

  assert.ok(events.includes('dine_in.bill_requested'), 'dine_in.bill_requested emitted');
  unsub();
});

test('dine-in: request-bill on a paid/closed bill is 409 DINE_IN_ORDER_STATUS_CONFLICT', async () => {
  const table = await tableByName('C1');
  const opened = await call('POST', '/dine-in/orders', {
    body: openBody(table.id, [{ catalogueItemId: 'p1', quantity: 1 }]),
    idem: 't-din-bill-request-conflict',
  });
  const billId = opened.body.bill.id;
  await call('POST', `/dine-in/orders/${billId}/confirm-payment`, {});
  const res = await call('POST', `/dine-in/orders/${billId}/request-bill`, {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'DINE_IN_ORDER_STATUS_CONFLICT');
});

test('dine-in: confirm-payment records method + paidBy evidence and shows on detail', async () => {
  const table = await tableByName('C2');
  const opened = await call('POST', '/dine-in/orders', {
    body: openBody(table.id, [{ catalogueItemId: 'p1', quantity: 1 }]),
    idem: 't-din-evidence-open',
  });
  const billId = opened.body.bill.id;
  await call('POST', `/dine-in/orders/${billId}/request-bill`, {});

  const paid = await call('POST', `/dine-in/orders/${billId}/confirm-payment`, { body: { method: 'cod', paidBy: 'Kai' } });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.bill.paymentMethod, 'cod');
  assert.equal(paid.body.bill.paidBy, 'Kai');

  const detail = await call('GET', `/dine-in/orders/${billId}`);
  assert.equal(detail.body.bill.paymentMethod, 'cod');
  assert.equal(detail.body.bill.paidBy, 'Kai');
});

test('dine-in: confirm-payment rejects an unknown method silently (no evidence recorded)', async () => {
  const created = await call('POST', '/dine-in/tables', { body: { storeId: 's_demo', label: 'X9' } });
  const opened = await call('POST', '/dine-in/orders', {
    body: openBody(created.body.table.id, [{ catalogueItemId: 'p1', quantity: 1 }]),
    idem: 't-din-evidence-unknown',
  });
  const billId = opened.body.bill.id;
  const paid = await call('POST', `/dine-in/orders/${billId}/confirm-payment`, { body: { method: 'venmo', paidBy: 'Kai' } });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.bill.paymentMethod, undefined, 'unsupported method is not recorded');
  assert.equal(paid.body.bill.paidBy, 'Kai');
});

/* ================= Dual-screen POS role gate (DI-07): STAFF_ROLE_FORBIDDEN ================= */

test('dine-in: confirm-payment and close are STAFF_ROLE_FORBIDDEN for non-cashier roles', async () => {
  const created = await call('POST', '/dine-in/tables', { body: { storeId: 's_demo', label: 'Y2' } });
  const opened = await call('POST', '/dine-in/orders', {
    body: openBody(created.body.table.id, [{ catalogueItemId: 'p1', quantity: 1 }]),
    idem: 't-din-rolegate-open',
  });
  const billId = opened.body.bill.id;

  const staffSession = createSession('m_demo', 's3', 'staff');
  db.table('staff').insert({
    id: 's_k1',
    merchantId: 'm_demo',
    storeId: 's_demo',
    name: 'Kitchen',
    role: 'staff',
    phone: '+255700000099',
    permissions: ['dine_in:prep'],
    active: true,
  });
  const kitchenSession = createSession('m_demo', 's_k1', 'staff');

  const deniedPay = await call('POST', `/dine-in/orders/${billId}/confirm-payment`, { auth: false, headers: { authorization: `Bearer ${staffSession.token}` } });
  assert.equal(deniedPay.status, 403);
  assert.equal(deniedPay.body.error.code, 'STAFF_ROLE_FORBIDDEN');

  const kitchenPay = await call('POST', `/dine-in/orders/${billId}/confirm-payment`, { auth: false, headers: { authorization: `Bearer ${kitchenSession.token}` } });
  assert.equal(kitchenPay.status, 403);
  assert.equal(kitchenPay.body.error.code, 'STAFF_ROLE_FORBIDDEN');

  await call('POST', `/dine-in/orders/${billId}/confirm-payment`, { body: { method: 'mpesa' } });
  const deniedClose = await call('POST', `/dine-in/orders/${billId}/close`, { auth: false, headers: { authorization: `Bearer ${kitchenSession.token}` } });
  assert.equal(deniedClose.status, 403);
  assert.equal(deniedClose.body.error.code, 'STAFF_ROLE_FORBIDDEN');

  const ownerClose = await call('POST', `/dine-in/orders/${billId}/close`, {});
  assert.equal(ownerClose.status, 200);
  db.table('staff').remove('s_k1');
});