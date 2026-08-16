import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let base = 'http://localhost';
let token: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; idem?: string } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
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

let ownerToken: string | null = null;

async function loginAs(phone: string) {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: phone, purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  return ok.body.accessToken;
}

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  ownerToken = await loginAs('+255700000000');
});

beforeEach(() => {
  token = ownerToken;
});

after(() => {
  server.close();
});

/* ================= Inventory ================= */

test('inventory items: seeded list with contract shapes and per-store filter', async () => {
  const res = await call('GET', '/inventory/items');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body), 'GET /inventory/items returns an array');
  assert.ok(res.body.length >= 20, `seeded items for the demo catalogue (got ${res.body.length})`);
  const p1 = res.body.find((i: any) => i.catalogueItemId === 'p1');
  assert.ok(p1, 'p1 seeded as an inventory item');
  assert.equal(p1.stockOnHand, 200);
  assert.equal(p1.reserved, 0);
  assert.equal(p1.available, 200, 'available = stockOnHand - reserved, server-computed');
  for (const item of res.body) {
    assert.equal(typeof item.catalogueItemId, 'string');
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.stockOnHand, 'number');
    assert.equal(typeof item.lowStockThreshold, 'number');
    assert.ok(Number.isInteger(item.stockOnHand));
    assert.equal(item.available, item.stockOnHand - item.reserved, 'available is always stockOnHand - reserved');
  }
  const perStore = await call('GET', `/inventory/items?storeId=${encodeURIComponent('s_demo')}`);
  assert.equal(perStore.status, 200);
  assert.ok(perStore.body.length > 0);
  assert.ok(perStore.body.every((i: any) => i.storeId === 's_demo'));
  const lowOnly = await call('GET', '/inventory/items?lowStockOnly=true');
  assert.equal(lowOnly.status, 200);
  assert.ok(lowOnly.body.length > 0, 'p3 (stock 6 ≤ threshold 10) is low-stock');
  assert.ok(lowOnly.body.every((i: any) => i.stockOnHand <= i.lowStockThreshold));
});

test('inventory adjust: delta + reason round-trip, history row, 422/409 guards', async () => {
  const before = await call('GET', '/inventory/items');
  const p1 = before.body.find((i: any) => i.catalogueItemId === 'p1');
  const start = p1.stockOnHand;

  const missing = await call('POST', '/inventory/items/p1/adjust', { body: { delta: -5 } });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.code, 'INVENTORY_ADJUSTMENT_REASON_REQUIRED');

  const bad = await call('POST', '/inventory/items/p1/adjust', { body: { delta: 0, reason: 'no-op' } });
  assert.equal(bad.status, 422);

  const adj = await call('POST', '/inventory/items/p1/adjust', { body: { delta: -5, reason: 'damaged during service' } });
  assert.equal(adj.status, 200);
  assert.equal(adj.body.stockOnHand, start - 5);
  assert.equal(adj.body.available, adj.body.stockOnHand - adj.body.reserved);

  const oos = await call('POST', '/inventory/items/p7/adjust', { body: { delta: -1, reason: 'spill' } });
  assert.equal(oos.status, 409, 'stock can never go negative');
  assert.equal(oos.body.error.code, 'INVENTORY_NEGATIVE_STOCK');

  const history = await call('GET', '/inventory/adjustments');
  assert.equal(history.status, 200);
  assert.ok(history.body.length >= 1);
  const row = history.body.find((a: any) => a.itemId === 'p1' && a.delta === -5);
  assert.ok(row, 'adjustment appended to history');
  assert.equal(row.reason, 'damaged during service');
  assert.equal(typeof row.at, 'number');
  assert.equal(typeof row.by, 'string');
});

test('inventory adjustments: seeded history rows with full contract shape', async () => {
  const res = await call('GET', '/inventory/adjustments');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  const seed = res.body.find((a: any) => a.id === 'ia_seed_1');
  assert.ok(seed, 'seeded stock_in adjustment present');
  assert.equal(seed.itemId, 'p1');
  assert.equal(seed.delta, 40);
  assert.equal(seed.reason, 'stock_in · purchase order receive');
  assert.ok(seed.by);
  for (const a of res.body) {
    for (const k of ['id', 'itemId', 'delta', 'reason', 'at', 'by']) assert.ok(k in a, `adjustment has ${k}`);
  }
});

test('inventory alerts: low + out_of_stock levels with suggested reorder', async () => {
  const res = await call('GET', '/inventory/alerts');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  const low = res.body.find((a: any) => a.catalogueItemId === 'p3');
  assert.ok(low, 'p3 seeded below threshold → low alert');
  assert.equal(low.level, 'low');
  assert.equal(low.stockOnHand, 6);
  assert.equal(typeof low.suggestedReorderQty, 'number');
  assert.ok(low.suggestedReorderQty > 0);
  const oos = res.body.find((a: any) => a.catalogueItemId === 'p7');
  assert.ok(oos, 'p7 seeded at zero → out_of_stock alert');
  assert.equal(oos.level, 'out_of_stock');
  assert.equal(oos.stockOnHand, 0);
  assert.ok(['low', 'out_of_stock'].includes(res.body[0].level));
});

test('inventory sync-config: GET default, PUT round-trip, invalid master 422, sync-disabled guard', async () => {
  const initial = await call('GET', '/inventory/sync-config');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.enabled, false);
  assert.equal(initial.body.masterSource, 'platform');
  assert.ok(Array.isArray(initial.body.channels));

  const bad = await call('PUT', '/inventory/sync-config', { body: { enabled: true, masterSource: 'sap', channels: [] } });
  assert.equal(bad.status, 422);

  const put = await call('PUT', '/inventory/sync-config', { body: { enabled: true, masterSource: 'pos', channels: ['pos', 'dine_in'] } });
  assert.equal(put.status, 200);
  assert.equal(put.body.enabled, true);
  assert.equal(put.body.masterSource, 'pos');
  assert.deepEqual(put.body.channels, ['pos', 'dine_in']);
  assert.equal(typeof put.body.lastSyncedAt, 'number', 'enabled config stamps lastSyncedAt');

  const after = await call('GET', '/inventory/sync-config');
  assert.equal(after.body.masterSource, 'pos', 'PUT persists across GET');

  // pos/erp master is staged: manual adjustments fail with INVENTORY_SYNC_DISABLED
  const guarded = await call('POST', '/inventory/items/p2/adjust', { body: { delta: 1, reason: 'count fix' } });
  assert.equal(guarded.status, 409);
  assert.equal(guarded.body.error.code, 'INVENTORY_SYNC_DISABLED');

  // restore the seeded config so later suites are unaffected
  const restore = await call('PUT', '/inventory/sync-config', { body: { enabled: false, masterSource: 'platform', channels: ['platform_orders', 'dine_in'] } });
  assert.equal(restore.status, 200);
  assert.equal(restore.body.enabled, false);
});

/* ================= Suppliers ================= */

test('suppliers: seeded list, create, duplicate phone 409, patch, deactivate 204 + 404', async () => {
  const list = await call('GET', '/suppliers');
  assert.equal(list.status, 200);
  assert.ok(list.body.length >= 2);
  assert.equal(list.body.find((s: any) => s.id === 'sup_seed_1').status, 'active');
  assert.equal(list.body.find((s: any) => s.id === 'sup_seed_2').contactPhone, '+255754002002');

  const created = await call('POST', '/suppliers', { body: { name: 'Arusha Poultry Traders', contactPhone: '+255765003003', categories: ['poultry'] }, idem: 'sc-sup-1' });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'active');
  assert.equal(typeof created.body.id, 'string');
  assert.equal(typeof created.body.createdAt, 'number');

  const dup = await call('POST', '/suppliers', { body: { name: 'Duplicate Poultry', contactPhone: '+255765003003' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'SUPPLIER_EXISTS');

  const missingReason = await call('POST', '/suppliers', { body: { contactPhone: '+255700999999' } });
  assert.equal(missingReason.status, 422, 'name required');

  const patched = await call('PATCH', `/suppliers/${created.body.id}`, { body: { name: 'Arusha Poultry & Eggs', contactPhone: '+255765003003', paymentTerms: 'Net 14' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, 'Arusha Poultry & Eggs');
  assert.equal(patched.body.paymentTerms, 'Net 14');

  const stalePatch = await call('PATCH', '/suppliers/nope', { body: { name: 'x', contactPhone: '+255700000009' } });
  assert.equal(stalePatch.status, 404);
  assert.equal(stalePatch.body.error.code, 'SUPPLIER_NOT_FOUND');

  const del = await call('DELETE', `/suppliers/${created.body.id}`);
  assert.equal(del.status, 204);
  assert.equal(del.body, null, 'DELETE is 204 with no body');

  const afterList = await call('GET', '/suppliers');
  const suspended = afterList.body.find((s: any) => s.id === created.body.id);
  assert.ok(suspended, 'soft deactivate keeps history — record still present');
  assert.equal(suspended.status, 'suspended', 'deactivate flips status to suspended (status pill)');

  const staleDel = await call('DELETE', `/suppliers/${created.body.id}`);
  assert.equal(staleDel.status, 204, 'repeat deactivate is an idempotent replay (204)');
});

test('suppliers: suspended supplier blocks new purchase orders (SUPPLIER_SUSPENDED)', async () => {
  const created = await call('POST', '/suppliers', { body: { name: 'Suspended Wholesale', contactPhone: '+255766004004' } });
  assert.equal(created.status, 201);
  await call('DELETE', `/suppliers/${created.body.id}`);
  const po = await call('POST', '/purchase-orders', { body: { supplierId: created.body.id, items: [{ catalogueItemId: 'p1', quantity: 5 }] } });
  assert.equal(po.status, 409);
  assert.equal(po.body.error.code, 'SUPPLIER_SUSPENDED');
});

/* ================= Purchase orders ================= */

test('purchase orders: seeded list + detail, create → send → receive → cancel lifecycle', async () => {
  const list = await call('GET', '/purchase-orders');
  assert.equal(list.status, 200);
  assert.ok(list.body.length >= 2);
  const draft = list.body.find((p: any) => p.id === 'po_seed_draft');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.totalCostTZS, 40 * 3000 + 25 * 4000);
  const sent = list.body.find((p: any) => p.id === 'po_seed_sent');
  assert.equal(sent.status, 'sent');

  const filtered = await call('GET', '/purchase-orders?status=draft');
  assert.ok(filtered.body.every((p: any) => p.status === 'draft'));

  const detail = await call('GET', '/purchase-orders/po_seed_draft');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.supplierId, 'sup_seed_1');
  assert.equal(detail.body.items[0].receivedQuantity, 0);

  const missing = await call('GET', '/purchase-orders/nope');
  assert.equal(missing.status, 404);

  // create → draft
  const p1Before = (await call('GET', '/inventory/items')).body.find((i: any) => i.catalogueItemId === 'p1').stockOnHand;
  const created = await call('POST', '/purchase-orders', {
    body: { supplierId: 'sup_seed_2', items: [{ catalogueItemId: 'p1', quantity: 10 }], note: 'restock skewers' },
    idem: 'sc-po-1',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'draft');
  assert.equal(created.body.items[0].name, 'Signature Lamb Skewer', 'item name resolved from catalogue');
  assert.equal(created.body.items[0].quantity, 10);
  assert.equal(created.body.totalCostTZS, created.body.items[0].quantity * created.body.items[0].unitCostTZS, 'totalCostTZS = Σ qty × unitCostTZS (integer TZS)');

  const id = created.body.id;

  // receive on a draft → conflict
  const receiveDraft = await call('POST', `/purchase-orders/${id}/receive`, { body: { items: [{ catalogueItemId: 'p1', quantity: 1 }] } });
  assert.equal(receiveDraft.status, 409);
  assert.equal(receiveDraft.body.error.code, 'PURCHASE_ORDER_STATUS_CONFLICT');

  // send: draft → sent
  const sentPo = await call('POST', `/purchase-orders/${id}/send`);
  assert.equal(sentPo.status, 200);
  assert.equal(sentPo.body.status, 'sent');

  // send again → conflict
  const resend = await call('POST', `/purchase-orders/${id}/send`);
  assert.equal(resend.status, 409);
  assert.equal(resend.body.error.code, 'PURCHASE_ORDER_STATUS_CONFLICT');

  // partial receive → partially_received
  const partial = await call('POST', `/purchase-orders/${id}/receive`, { body: { items: [{ catalogueItemId: 'p1', quantity: 4 }] } });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.status, 'partially_received');
  assert.equal(partial.body.items[0].receivedQuantity, 4);

  // over-receive → 409
  const over = await call('POST', `/purchase-orders/${id}/receive`, { body: { items: [{ catalogueItemId: 'p1', quantity: 7 }] } });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'PURCHASE_ORDER_RECEIPT_EXCEEDS_QTY');

  // cancel on partially received → 409 PURCHASE_ORDER_CANCELLED
  const cancelPartial = await call('POST', `/purchase-orders/${id}/cancel`, { body: { reason: 'changed mind' } });
  assert.equal(cancelPartial.status, 409);
  assert.equal(cancelPartial.body.error.code, 'PURCHASE_ORDER_CANCELLED');

  // full receive → received, stock_in side effects
  const full = await call('POST', `/purchase-orders/${id}/receive`, { body: { items: [{ catalogueItemId: 'p1', quantity: 6 }] } });
  assert.equal(full.status, 200);
  assert.equal(full.body.status, 'received');
  assert.equal(full.body.items[0].receivedQuantity, 10);
  assert.equal(typeof full.body.receivedAt, 'number');

  const p1After = (await call('GET', '/inventory/items')).body.find((i: any) => i.catalogueItemId === 'p1').stockOnHand;
  assert.equal(p1After, p1Before + 10, 'PO receiving increases stock server-side');

  const history = await call('GET', '/inventory/adjustments');
  const stockIn = history.body.filter((a: any) => a.itemId === 'p1' && a.reason === 'stock_in · purchase order receive');
  const seedIn = stockIn.filter((a: any) => a.id === 'ia_seed_1').reduce((sum: number, a: any) => sum + a.delta, 0);
  const totalIn = stockIn.reduce((sum: number, a: any) => sum + a.delta, 0) - seedIn;
  assert.equal(totalIn, 10, 'stock_in deltas sum to the received quantity (seed 40 excluded)');

  // cancel on received → 409 PURCHASE_ORDER_CANCELLED
  const cancelReceived = await call('POST', `/purchase-orders/${id}/cancel`, { body: { reason: 'late' } });
  assert.equal(cancelReceived.status, 409);
  assert.equal(cancelReceived.body.error.code, 'PURCHASE_ORDER_CANCELLED');
});

test('purchase orders: cancel with reason (draft), missing reason 422', async () => {
  const created = await call('POST', '/purchase-orders', {
    body: { supplierId: 'sup_seed_1', items: [{ catalogueItemId: 'p2', quantity: 3 }] },
    idem: 'sc-po-2',
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const noReason = await call('POST', `/purchase-orders/${id}/cancel`, { body: {} });
  assert.equal(noReason.status, 422, 'cancellation requires a reason');

  const cancelled = await call('POST', `/purchase-orders/${id}/cancel`, { body: { reason: 'no longer needed' } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');

  const again = await call('POST', `/purchase-orders/${id}/cancel`, { body: { reason: 'still no' } });
  assert.equal(again.status, 200, 'cancel replay is idempotent');
  assert.equal(again.body.status, 'cancelled');
});

/* ================= Supplier returns ================= */

test('supplier returns: create → 201 {id, status, createdAt}; validation guards', async () => {
  const created = await call('POST', '/supplier-returns', {
    body: { supplierId: 'sup_seed_1', items: [{ catalogueItemId: 'p2', quantity: 3 }], reason: 'Over-ripe produce in last delivery' },
    idem: 'sc-sr-1',
  });
  assert.equal(created.status, 201);
  assert.equal(typeof created.body.id, 'string');
  assert.equal(created.body.status, 'pending');
  assert.equal(typeof created.body.createdAt, 'number');

  const noReason = await call('POST', '/supplier-returns', { body: { supplierId: 'sup_seed_1', items: [{ catalogueItemId: 'p2', quantity: 1 }] } });
  assert.equal(noReason.status, 422);

  const unknownSupplier = await call('POST', '/supplier-returns', { body: { supplierId: 'nope', items: [{ catalogueItemId: 'p2', quantity: 1 }], reason: 'x' } });
  assert.equal(unknownSupplier.status, 404);
  assert.equal(unknownSupplier.body.error.code, 'SUPPLIER_NOT_FOUND');

  const unknownItem = await call('POST', '/supplier-returns', { body: { supplierId: 'sup_seed_1', items: [{ catalogueItemId: 'nope', quantity: 1 }], reason: 'x' } });
  assert.equal(unknownItem.status, 404);
});

test('supplier returns: list (pending/processed/rejected pills) + process reduces stock + reject with reason', async () => {
  const list = await call('GET', '/supplier-returns');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  const pending = list.body.find((r: any) => r.id === 'sr_seed_1');
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.items, [{ catalogueItemId: 'p3', quantity: 5 }]);
  assert.equal(pending.reason, 'Damaged carton received with the weekly delivery');
  assert.ok(list.body.some((r: any) => r.id === 'sr_seed_2' && r.status === 'processed'), 'processed pill state seeded');
  assert.ok(list.body.some((r: any) => r.id === 'sr_seed_3' && r.status === 'rejected'), 'rejected pill state seeded');

  const p3Before = (await call('GET', '/inventory/items')).body.find((i: any) => i.catalogueItemId === 'p3').stockOnHand;

  const processed = await call('POST', '/supplier-returns/sr_seed_1/process', { idem: 'sc-sr-proc-1' });
  assert.equal(processed.status, 200);
  assert.equal(processed.body.status, 'processed');
  assert.equal(typeof processed.body.processedAt, 'number');

  const p3After = (await call('GET', '/inventory/items')).body.find((i: any) => i.catalogueItemId === 'p3').stockOnHand;
  assert.equal(p3After, p3Before - 5, 'processed returns reduce stock server-side');

  const reprocess = await call('POST', '/supplier-returns/sr_seed_1/process');
  assert.equal(reprocess.status, 409);
  assert.equal(reprocess.body.error.code, 'SUPPLIER_RETURN_STATUS_CONFLICT');

  const fresh = await call('POST', '/supplier-returns', {
    body: { supplierId: 'sup_seed_1', items: [{ catalogueItemId: 'p1', quantity: 1 }], reason: 'wrong batch' },
    idem: 'sc-sr-rej-0',
  });
  const noReason = await call('POST', `/supplier-returns/${fresh.body.id}/reject`, { body: {} });
  assert.equal(noReason.status, 422, 'rejection requires a reason');

  const rejected = await call('POST', `/supplier-returns/${fresh.body.id}/reject`, { body: { reason: 'Supplier dispute — photos did not match' }, idem: 'sc-sr-rej-1' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, 'rejected');
  assert.equal(rejected.body.rejectionReason, 'Supplier dispute — photos did not match');

  const stale = await call('POST', '/supplier-returns/nope/process');
  assert.equal(stale.status, 404);
  assert.equal(stale.body.error.code, 'SUPPLIER_RETURN_NOT_FOUND');

  const restocked = await call('GET', '/supplier-returns');
  assert.equal(restocked.body.find((r: any) => r.id === 'sr_seed_1').status, 'processed', 'list refresh shows the new pill');
});

test('supplier returns: process guard when stock would go negative', async () => {
  const created = await call('POST', '/supplier-returns', {
    body: { supplierId: 'sup_seed_1', items: [{ catalogueItemId: 'p7', quantity: 5 }], reason: 'returning unsellable stock' },
  });
  assert.equal(created.status, 201);
  const res = await call('POST', `/supplier-returns/${created.body.id}/process`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'INVENTORY_NEGATIVE_STOCK');
});

/* ================= Warehouses ================= */

test('warehouses: seeded list (with totalUnits) + detail, create, patch, 404s', async () => {
  const list = await call('GET', '/warehouses');
  assert.equal(list.status, 200);
  assert.ok(list.body.length >= 2);
  const wh1 = list.body.find((w: any) => w.id === 'wh_seed_1');
  assert.equal(wh1.status, 'active');
  assert.equal(wh1.servingCities.length, 2);
  assert.equal(wh1.totalUnits, 100 + 60 + 80 + 8, 'totalUnits server-computed (p3 low-stock row included)');
  const wh2 = list.body.find((w: any) => w.id === 'wh_seed_2');
  assert.equal(wh2.status, 'maintenance');

  const detail = await call('GET', '/warehouses/wh_seed_1');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.name, 'Dar es Salaam — Kariakoo Forward Stock');
  const p1row = detail.body.stock.find((s: any) => s.catalogueItemId === 'p1');
  assert.equal(p1row.quantity, 100);
  assert.equal(detail.body.totalUnits, 248, 'detail carries the server-computed totalUnits');

  const missing = await call('GET', '/warehouses/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'WAREHOUSE_NOT_FOUND');

  const created = await call('POST', '/warehouses', {
    body: { name: 'Mwanza Lakeside Hub', cityId: 'city_mwanza', address: 'Capri Point Road', servingCities: ['city_mwanza'] },
    idem: 'sc-wh-1',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'active', 'status defaults to active');
  assert.deepEqual(created.body.stock, []);

  const patched = await call('PATCH', `/warehouses/${created.body.id}`, { body: { name: 'Mwanza Lakeside Hub 2', cityId: 'city_mwanza', status: 'full' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, 'Mwanza Lakeside Hub 2');
  assert.equal(patched.body.status, 'full');
});

test('warehouses: stock PUT (bulk inbound), negative guard, fulfill decrements stock', async () => {
  const order = db.table('orders').find('o_seed_0') as any;
  const orderItems: { catalogueItemId: string; qty: number }[] = order.items.map((it: any) => ({ catalogueItemId: it.productId, qty: it.qty }));

  // bulk inbound: positive deltas for every order line so fulfill can succeed
  const inbound = await call('PUT', '/warehouses/wh_seed_1/stock', {
    body: { items: orderItems.map((it) => ({ catalogueItemId: it.catalogueItemId, delta: it.qty + 10 })) },
    idem: 'sc-wh-stock-1',
  });
  assert.equal(inbound.status, 200);
  const p1StockAfterInbound = inbound.body.stock.find((s: any) => s.catalogueItemId === 'p1')?.quantity ?? 100;
  for (const it of orderItems) {
    const row = inbound.body.stock.find((s: any) => s.catalogueItemId === it.catalogueItemId);
    const seeded = (it.catalogueItemId === 'p1' ? 100 : it.catalogueItemId === 'p2' ? 60 : it.catalogueItemId === 'p6' ? 80 : 0);
    assert.equal(row.quantity, seeded + it.qty + 10, 'delta added to warehouse stock');
  }

  // negative delta below zero → 409 INVENTORY_NEGATIVE_STOCK
  const negative = await call('PUT', '/warehouses/wh_seed_1/stock', { body: { items: [{ catalogueItemId: 'p1', delta: -999999 }], reason: 'write-off' } });
  assert.equal(negative.status, 409);
  assert.equal(negative.body.error.code, 'INVENTORY_NEGATIVE_STOCK');

  // negative delta without a reason → 422 (ISC L154-156)
  const noReason = await call('PUT', '/warehouses/wh_seed_1/stock', { body: { items: [{ catalogueItemId: 'p1', delta: -2 }] } });
  assert.equal(noReason.status, 422);
  assert.equal(noReason.body.error.code, 'VALIDATION_FAILED');

  // negative delta with a reason → applied + logged
  const writeOff = await call('PUT', '/warehouses/wh_seed_1/stock', {
    body: { items: [{ catalogueItemId: 'p1', delta: -2 }], reason: 'write-off — damaged during handling' },
    idem: 'sc-wh-writeoff-1',
  });
  assert.equal(writeOff.status, 200);
  assert.equal(writeOff.body.stock.find((s: any) => s.catalogueItemId === 'p1').quantity, p1StockAfterInbound - 2, 'write-off delta applied');

  // fulfill: nearest-warehouse order tag → stock decremented by ordered qty
  const beforeFulfill = (await call('GET', '/warehouses/wh_seed_1')).body.stock;
  const fulfill = await call('POST', '/warehouses/wh_seed_1/fulfill', { body: { orderId: 'o_seed_0' }, idem: 'sc-wh-fulfill-1' });
  assert.equal(fulfill.status, 200);
  assert.equal(fulfill.body.id, 'o_seed_0', 'fulfill returns the Order');
  const afterFulfill = (await call('GET', '/warehouses/wh_seed_1')).body.stock;
  for (const it of orderItems) {
    const b = beforeFulfill.find((s: any) => s.catalogueItemId === it.catalogueItemId);
    const a = afterFulfill.find((s: any) => s.catalogueItemId === it.catalogueItemId);
    assert.equal(a.quantity, b.quantity - it.qty, 'fulfill decrements warehouse stock by ordered quantity');
  }

  // no stock at all → WAREHOUSE_STOCK_UNAVAILABLE (fresh warehouse)
  const empty = await call('POST', '/warehouses', { body: { name: 'Empty Hub', cityId: 'city_dar' } });
  assert.equal(empty.status, 201);
  const unavailable = await call('POST', `/warehouses/${empty.body.id}/fulfill`, { body: { orderId: 'o_seed_0' } });
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.body.error.code, 'WAREHOUSE_STOCK_UNAVAILABLE');

  // maintenance warehouse never fulfills → WAREHOUSE_OUT_OF_SERVICE
  const oos = await call('POST', '/warehouses/wh_seed_2/fulfill', { body: { orderId: 'o_seed_0' } });
  assert.equal(oos.status, 409);
  assert.equal(oos.body.error.code, 'WAREHOUSE_OUT_OF_SERVICE');

  // unknown order → 404
  const noOrder = await call('POST', '/warehouses/wh_seed_1/fulfill', { body: { orderId: 'nope' } });
  assert.equal(noOrder.status, 404);
});

/* ================= RBAC ================= */

test('RBAC: staff token cannot mutate supply chain (403), reads allowed', async () => {
  token = await loginAs('+255700000003'); // Kai — staff: orders:accept + redemption

  const createSupplier = await call('POST', '/suppliers', { body: { name: 'x', contactPhone: '+255700000010' } });
  assert.equal(createSupplier.status, 403);
  const adjust = await call('POST', '/inventory/items/p1/adjust', { body: { delta: 1, reason: 'x' } });
  assert.equal(adjust.status, 403);
  const sendPo = await call('POST', '/purchase-orders/po_seed_draft/send');
  assert.equal(sendPo.status, 403);
  const createWh = await call('POST', '/warehouses', { body: { name: 'x', cityId: 'city_dar' } });
  assert.equal(createWh.status, 403);

  const items = await call('GET', '/inventory/items');
  assert.equal(items.status, 200, 'inventory reads are allowed for staff');
  const suppliers = await call('GET', '/suppliers');
  assert.equal(suppliers.status, 200);
  const pos = await call('GET', '/purchase-orders');
  assert.equal(pos.status, 200);
  const whs = await call('GET', '/warehouses');
  assert.equal(whs.status, 200);
});
