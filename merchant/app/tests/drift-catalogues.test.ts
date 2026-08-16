/* Drift elimination — catalogue module (drift-a).
 *
 * For every contract path in the catalogue module the app now calls (or will
 * call), assert the contract path behaves IDENTICALLY to the legacy path:
 * same success shape (key fields), same 4xx/5xx codes, auth required.
 *
 * Legacy paths must keep working (contract.test.ts asserts them), so these
 * tests call BOTH paths and compare.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

const base = 'http://localhost';
let token: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth !== false) headers.authorization = `Bearer ${token ?? ''}`;
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

async function login() {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: '+255700000000', purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  token = ok.body.session?.accessToken ?? ok.body.accessToken ?? null;
  assert.ok(token);
}

before(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  seedDatabase();
  await login();
});

after(() => server.close());

/* ================= 1. GET /merchants/me ≡ GET /auth/me ================= */

test('drift: GET /merchants/me serves the same session bundle as /auth/me; auth required', async () => {
  const contract = await call('GET', '/merchants/me');
  const legacy = await call('GET', '/auth/me');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200, 'legacy /auth/me alias kept');
  assert.equal(contract.body.me.merchant.id, legacy.body.me.merchant.id);
  assert.equal(contract.body.me.store.id, legacy.body.me.store.id);
  assert.equal(contract.body.me.staff.id, legacy.body.me.staff.id);
  assert.deepEqual(contract.body.me.permissions, legacy.body.me.permissions);
  assert.equal(contract.body.me.merchant.phone, '+255700000000');

  const unauth = await call('GET', '/merchants/me', { auth: false });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.body.error.code, 'UNAUTHORIZED');
});

/* ================= 2. GET /catalogues/me ≡ store menu payload ================= */

test('drift: GET /catalogues/me items match the session store menu payload', async () => {
  const contract = await call('GET', '/catalogues/me');
  assert.equal(contract.status, 200);
  assert.equal(contract.body.merchantId, 'm_demo');
  assert.ok(Array.isArray(contract.body.items));
  assert.ok(contract.body.items.length >= 10);

  const menu = await call('GET', '/stores/s_demo/menu');
  assert.equal(menu.status, 200);
  const byId = new Map(contract.body.items.map((i: any) => [i.id, i]));
  assert.ok(menu.body.products.length > 0, 'seeded store menu present');
  for (const p of menu.body.products) {
    const item = byId.get(p.id);
    assert.ok(item, `menu product ${p.id} appears in the own catalogue`);
    assert.equal(item.name, p.name);
    assert.equal(item.priceTZS, Math.round(p.price));
    assert.equal(item.available, p.visible, `availability reflects visibility for ${p.id}`);
  }

  const unauth = await call('GET', '/catalogues/me', { auth: false });
  assert.equal(unauth.status, 401);
});

/* ================= 3. Catalogue items: POST / PATCH / logs ≡ products paths ================= */

test('drift: POST /catalogue-items creates identically to POST /products (shape + validation)', async () => {
  const payload = { name: 'Drift Skewer', price: 15, categoryId: 'c1', stock: 7, visible: true };
  const contract = await call('POST', '/catalogue-items', { body: payload });
  const legacy = await call('POST', '/products', { body: payload });
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  for (const r of [contract, legacy]) {
    assert.ok(r.body.product.id, 'created id returned');
    assert.equal(r.body.product.name, 'Drift Skewer');
    assert.equal(r.body.product.price, 15);
    assert.equal(r.body.product.stock, 7);
    assert.equal(r.body.product.visible, true);
    assert.equal(r.body.product.storeId, 's_demo');
    assert.equal(r.body.product.categoryId, 'c1');
  }
  const rowC = db.table('products').find(contract.body.product.id);
  const rowL = db.table('products').find(legacy.body.product.id);
  assert.equal(rowC.name, rowL.name);
  assert.equal(rowC.price, rowL.price);
  assert.equal(rowC.stock, rowL.stock);

  const listed = await call('GET', '/products');
  assert.ok(listed.body.products.some((p: any) => p.id === contract.body.product.id), 'contract-created item listable via legacy list');

  const noName = await call('POST', '/catalogue-items', { body: { price: 10 } });
  const noNameL = await call('POST', '/products', { body: { price: 10 } });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error.code, 'NAME_REQUIRED');
  assert.equal(noNameL.status, 400);
  assert.equal(noNameL.body.error.code, 'NAME_REQUIRED');

  const badPrice = await call('POST', '/catalogue-items', { body: { name: 'X', price: 0 } });
  const badPriceL = await call('POST', '/products', { body: { name: 'X', price: 0 } });
  assert.equal(badPrice.status, 400);
  assert.equal(badPrice.body.error.code, 'INVALID_PRICE');
  assert.equal(badPriceL.status, 400);
  assert.equal(badPriceL.body.error.code, 'INVALID_PRICE');

  const unauth = await call('POST', '/catalogue-items', { auth: false, body: payload });
  assert.equal(unauth.status, 401);
});

test('drift: PATCH /catalogue-items/{itemId} patches identically to PATCH /products/{id}', async () => {
  const created = await call('POST', '/products', { body: { name: 'Patch Target', price: 10, categoryId: 'c1' } });
  const id = created.body.product.id;

  const contract = await call('PATCH', `/catalogue-items/${id}`, { body: { price: 12, visible: false, name: 'Patch Target 2' } });
  assert.equal(contract.status, 200);
  assert.equal(contract.body.product.price, 12);
  assert.equal(contract.body.product.visible, false);
  assert.equal(contract.body.product.name, 'Patch Target 2');

  const legacy = await call('PATCH', `/products/${id}`, { body: { price: 14 } });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.product.price, 14);
  assert.equal(db.table('products').find(id).price, 14, 'patch persisted');

  const missing = await call('PATCH', '/catalogue-items/nope', { body: { price: 5 } });
  const missingL = await call('PATCH', '/products/nope', { body: { price: 5 } });
  assert.equal(missing.status, 404);
  assert.equal(missingL.status, 404);
  assert.equal(missing.body.error.code, missingL.body.error.code);

  const bad = await call('PATCH', `/catalogue-items/${id}`, { body: { price: 0 } });
  const badL = await call('PATCH', `/products/${id}`, { body: { price: 0 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_PRICE');
  assert.equal(badL.status, 400);
  assert.equal(badL.body.error.code, 'INVALID_PRICE');

  const unauth = await call('PATCH', `/catalogue-items/${id}`, { auth: false, body: { price: 5 } });
  assert.equal(unauth.status, 401);
});

test('drift: DELETE /catalogue-items/{itemId} ≡ DELETE /products/{id}', async () => {
  const contract = await call('POST', '/catalogue-items', { body: { name: 'Delete Parity', price: 8, categoryId: 'c1' } });
  const id = contract.body.product.id;

  const del = await call('DELETE', `/catalogue-items/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);
  const again = await call('DELETE', `/catalogue-items/${id}`);
  assert.equal(again.status, 404);

  const legacy = await call('POST', '/products', { body: { name: 'Delete Parity L', price: 8, categoryId: 'c1' } });
  const idL = legacy.body.product.id;
  const delL = await call('DELETE', `/products/${idL}`);
  assert.equal(delL.status, 200);
  assert.equal(delL.body.product.deleted, true);
});

test('drift: GET /catalogue-items/{itemId}/logs ≡ GET /products/logs?productId=', async () => {
  const created = await call('POST', '/catalogue-items', { body: { name: 'Log Parity', price: 9, categoryId: 'c3', stock: 3 } });
  const id = created.body.product.id;
  await call('PATCH', `/catalogue-items/${id}`, { body: { price: 11 } });

  const contract = await call('GET', `/catalogue-items/${id}/logs`);
  const legacy = await call('GET', `/products/logs?productId=${id}&limit=300`);
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.ok(contract.body.logs.length >= 2, 'create + update logged');
  assert.equal(contract.body.logs.length, legacy.body.logs.length, 'same log rows as legacy filter');
  assert.deepEqual(
    contract.body.logs.map((l: any) => l.action).sort(),
    legacy.body.logs.map((l: any) => l.action).sort(),
  );
  for (const l of contract.body.logs) assert.equal(l.productId, id, 'contract logs scoped to the item');
  const priceLog = contract.body.logs.find((l: any) => l.action === 'product:update' && l.field === 'price');
  assert.ok(priceLog, 'price update logged with field');
  assert.equal(priceLog.after, 11);

  const unauth = await call('GET', `/catalogue-items/${id}/logs`, { auth: false });
  assert.equal(unauth.status, 401);
});

/* ================= 4. Product templates ≡ /templates ================= */

test('drift: GET /product-templates ≡ GET /templates', async () => {
  const contract = await call('GET', '/product-templates');
  const legacy = await call('GET', '/templates');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.deepEqual(
    contract.body.templates.map((t: any) => t.id).sort(),
    legacy.body.templates.map((t: any) => t.id).sort(),
  );
  assert.ok(contract.body.templates.some((t: any) => t.id === 'tpl1'), 'seeded template present');

  const unauth = await call('GET', '/product-templates', { auth: false });
  assert.equal(unauth.status, 401);
});

test('drift: POST /product-templates creates identically to POST /templates (shape + validation)', async () => {
  const contract = await call('POST', '/product-templates', { body: { name: 'Drift Template', productId: 'p3' } });
  const legacy = await call('POST', '/templates', { body: { name: 'Drift Template L', productId: 'p3' } });
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  const sourceName = db.table('products').find('p3')?.name;
  assert.equal(contract.body.template.draft.name, sourceName, 'draft snapshots source product');
  assert.equal(legacy.body.template.draft.name, sourceName);
  assert.equal(contract.body.template.draft.id, undefined, 'draft strips identity fields');
  assert.equal(contract.body.template.draft.stock, undefined);
  assert.ok(contract.body.template.id);
  assert.equal(contract.body.template.merchantId, 'm_demo');
  assert.ok(db.table('templates').find(contract.body.template.id), 'contract-created template persisted');

  const noName = await call('POST', '/product-templates', { body: { productId: 'p3' } });
  const noNameL = await call('POST', '/templates', { body: { productId: 'p3' } });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error.code, 'NAME_REQUIRED');
  assert.equal(noNameL.status, 400);
  assert.equal(noNameL.body.error.code, 'NAME_REQUIRED');

  const missingProd = await call('POST', '/product-templates', { body: { name: 'X', productId: 'nope' } });
  const missingProdL = await call('POST', '/templates', { body: { name: 'X', productId: 'nope' } });
  assert.equal(missingProd.status, 404);
  assert.equal(missingProdL.status, 404);
  assert.equal(missingProd.body.error.code, missingProdL.body.error.code);

  const unauth = await call('POST', '/product-templates', { auth: false, body: { name: 'X', productId: 'p3' } });
  assert.equal(unauth.status, 401);
});

test('drift: POST /product-templates/{templateId}/apply ≡ POST /templates/{id}/apply', async () => {
  const created = await call('POST', '/product-templates', { body: { name: 'Apply Parity', productId: 'p1' } });
  const id = created.body.template.id;

  const apply = await call('POST', `/product-templates/${id}/apply`, { body: { storeIds: ['s_demo_2', 'ghost-store'] } });
  const applyL = await call('POST', `/templates/${id}/apply`, { body: { storeIds: ['s_demo_2', 'ghost-store'] } });
  assert.equal(apply.status, 200);
  assert.equal(applyL.status, 200);
  assert.equal(apply.body.created.length, applyL.body.created.length);
  assert.equal(apply.body.failed.length, applyL.body.failed.length);
  assert.equal(apply.body.failed[0].reason, applyL.body.failed[0].reason);
  assert.equal(apply.body.failed[0].reason, 'INVALID_STORE');

  const newId = apply.body.created[0].productId;
  const product = db.table('products').find(newId);
  assert.equal(product.storeId, 's_demo_2', 'template product created in the target store');
  const menu2 = await call('GET', '/stores/s_demo_2/menu');
  assert.ok(menu2.body.products.some((p: any) => p.id === newId), 'template product live in store 2');

  const missing = await call('POST', '/product-templates/tpl_nope/apply', { body: { storeIds: ['s_demo_2'] } });
  const missingL = await call('POST', '/templates/tpl_nope/apply', { body: { storeIds: ['s_demo_2'] } });
  assert.equal(missing.status, 404);
  assert.equal(missingL.status, 404);
  assert.equal(missing.body.error.code, missingL.body.error.code);

  const unauth = await call('POST', `/product-templates/${id}/apply`, { auth: false, body: { storeIds: ['s_demo_2'] } });
  assert.equal(unauth.status, 401);
});

/* ================= 5. Inventory adjust (contract path already registered by supply-chain module) ================= */

test('drift: POST /inventory/items/{itemId}/adjust behaves like /products/stock-adjust', async () => {
  const before = db.table('products').find('p5').stock;

  const legacy = await call('POST', '/products/stock-adjust', { body: { items: [{ id: 'p5', delta: -5 }] } });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.updated[0].stock, before - 5);

  const contract = await call('POST', '/inventory/items/p5/adjust', { body: { delta: -3, reason: 'drift parity test' } });
  assert.equal(contract.status, 200);
  /* legacy mutates products.stock, contract mutates inventoryItems.stockOnHand —
   * both tables are seeded in sync, so an equal delta yields an equal level. */
  assert.equal(contract.body.stockOnHand, before - 3, 'contract adjust applies the same delta math');
  assert.equal(contract.body.catalogueItemId, 'p5');
  assert.ok(contract.body.name);

  const missing = await call('POST', '/inventory/items/p_unknown/adjust', { body: { delta: -1, reason: 'x' } });
  const missingL = await call('POST', '/products/stock-adjust', { body: { items: [{ id: 'p_unknown', delta: -1 }] } });
  assert.equal(missing.status, 404);
  assert.equal(missingL.status, 404);

  const unauth = await call('POST', '/inventory/items/p5/adjust', { auth: false, body: { delta: -1, reason: 'x' } });
  const unauthL = await call('POST', '/products/stock-adjust', { auth: false, body: { items: [{ id: 'p5', delta: -1 }] } });
  assert.equal(unauth.status, 401);
  assert.equal(unauthL.status, 401);

  const invalid = await call('POST', '/inventory/items/p5/adjust', { body: { delta: -1 } });
  const invalidL = await call('POST', '/products/stock-adjust', { body: { items: [{ id: 'p5' }] } });
  assert.ok([400, 422].includes(invalid.status), 'contract path validates reason');
  assert.ok([400, 422].includes(invalidL.status), 'legacy path validates item payload');
});

/* ================= 6. GET /merchants/me/stores ≡ GET /stores ================= */

test('drift: GET /merchants/me/stores lists the same stores as /stores; auth required', async () => {
  const contract = await call('GET', '/merchants/me/stores');
  const legacy = await call('GET', '/stores');
  assert.equal(contract.status, 200);
  assert.equal(legacy.status, 200);
  assert.equal(contract.body.stores.length, legacy.body.stores.length);
  const byId = new Map(contract.body.stores.map((s: any) => [s.id, s]));
  for (const s of legacy.body.stores) {
    const other = byId.get(s.id);
    assert.ok(other, `store ${s.id} present on both paths`);
    assert.equal(other.name, s.name);
    assert.equal(other.address, s.address);
    assert.equal(other.open, s.open);
    assert.equal(other.productCount, s.productCount);
  }
  assert.ok(byId.has('s_demo_2'), 'chain store seeded');

  const unauth = await call('GET', '/merchants/me/stores', { auth: false });
  assert.equal(unauth.status, 401);
});
