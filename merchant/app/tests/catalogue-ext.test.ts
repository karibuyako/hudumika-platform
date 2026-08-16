import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';
import { http as rawHttp } from 'msw';

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

let ownerToken: string | null = null;

async function loginAs(phone: string) {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: phone, purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  return ok.body.accessToken;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

before(async () => {
  server.use(rawHttp.get('http://localhost/api/ping', () => Response.json({ pong: true })));
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

/* ================= P8: barcodes ================= */

test('GET /barcodes/formats returns the 6 contract formats', async () => {
  const res = await call('GET', '/barcodes/formats');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 6);
  const codes = new Set(res.body.map((f: any) => f.code));
  for (const c of ['ean13', 'ean8', 'upca', 'code128', 'code39', 'qr']) {
    assert.ok(codes.has(c), `${c} listed`);
  }
  for (const f of res.body) {
    assert.equal(typeof f.label, 'string');
    assert.ok(f.label.length > 0);
  }
});

test('GET /barcodes/{code} lookup: seeded code resolves to product; unknown -> 404', async () => {
  const found = await call('GET', '/barcodes/6900000000017');
  assert.equal(found.status, 200);
  assert.equal(found.body.catalogueItemId, 'p1');
  assert.equal(found.body.name, 'Signature Lamb Skewer');
  assert.equal(typeof found.body.priceTZS, 'number');
  assert.equal(Number.isInteger(found.body.priceTZS), true, 'priceTZS is an integer');
  assert.equal(typeof found.body.available, 'boolean');
  assert.equal(typeof found.body.stockOnHand, 'number');

  const missing = await call('GET', '/barcodes/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

test('GET /barcodes/{code}/history returns seeded scan history newest first', async () => {
  const res = await call('GET', '/barcodes/6900000000017/history');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  const actions = new Set(res.body.map((h: any) => h.action));
  assert.ok(actions.has('generated'));
  assert.ok(actions.has('scanned'));
  for (const h of res.body) {
    assert.equal(typeof h.at, 'number');
  }
  assert.ok(res.body[0].at >= res.body[1].at, 'sorted newest first');
});

test('POST /products/{itemId}/barcode/generate creates 201 + lists under the item; bad format 400', async () => {
  const created = await call('POST', '/products/p1/barcode/generate', { body: { format: 'ean13' } });
  assert.equal(created.status, 201);
  const barcode = created.body;
  assert.match(barcode.code, /^\d{13}$/, 'ean13 code has 13 digits');
  assert.equal(barcode.format, 'ean13');
  assert.equal(barcode.catalogueItemId, 'p1');
  assert.equal(typeof barcode.id, 'string');

  const list = await call('GET', '/products/p1/barcodes');
  assert.equal(list.status, 200);
  assert.ok(list.body.some((b: any) => b.code === barcode.code), 'generated code listed for the item');

  const bad = await call('POST', '/products/p1/barcode/generate', { body: { format: 'pdf417' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_BARCODE_FORMAT');

  const missing = await call('POST', '/products/nope/barcode/generate', { body: { format: 'qr' } });
  assert.equal(missing.status, 404);
});

test('POST /barcodes/batch imports in bulk (202) with accepted/rejected counts', async () => {
  const res = await call('POST', '/barcodes/batch', {
    body: {
      entries: [
        { code: '6900000000001', catalogueItemId: 'p2' },
        { code: '6900000000002', catalogueItemId: 'p3' },
        { code: '6900000000001', catalogueItemId: 'p4' }, // duplicate code in batch
        { code: '6900000000003', catalogueItemId: 'ghost' }, // unknown item
        { code: '6900000000017', catalogueItemId: 'p1' }, // already exists
      ],
    },
  });
  assert.equal(res.status, 202);
  assert.equal(typeof res.body.jobId, 'string');
  assert.equal(res.body.accepted, 2);
  assert.equal(res.body.rejected, 3);

  const list = await call('GET', '/products/p2/barcodes');
  assert.ok(list.body.some((b: any) => b.code === '6900000000001'), 'batch code listed for p2');
});

test('DELETE /products/{itemId}/barcode/{code} removes the barcode + history; lookup 404 after', async () => {
  const created = await call('POST', '/products/p5/barcode/generate', { body: { format: 'code128' } });
  assert.equal(created.status, 201);
  const code = created.body.code;

  const del = await call('DELETE', `/products/p5/barcode/${code}`, {});
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);

  const lookup = await call('GET', `/barcodes/${code}`);
  assert.equal(lookup.status, 404, 'deleted barcode no longer resolves');

  const miss = await call('DELETE', '/products/p5/barcode/no-such-code', {});
  assert.equal(miss.status, 404);
});

/* ================= P8: combos ================= */

test('GET /combos lists the 2 seeded combos with contract items shape', async () => {
  const res = await call('GET', '/combos');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  const combo = res.body.find((c: any) => c.id === 'combo_seed_1');
  assert.equal(combo.name, 'BBQ Family Skewer Set');
  assert.equal(Number.isInteger(combo.priceTZS), true, 'priceTZS integer');
  assert.equal(typeof combo.available, 'boolean');
  assert.equal(Array.isArray(combo.items), true);
  for (const it of combo.items) {
    assert.equal(typeof it.catalogueItemId, 'string');
    assert.equal(Number.isInteger(it.quantity), true);
    assert.ok(it.quantity >= 1);
  }
});

test('POST /combos creates a combo (201); validation errors 400', async () => {
  const created = await call('POST', '/combos', {
    body: {
      name: 'Student Lunch',
      description: 'Skewer, rice and a soda',
      items: [
        { catalogueItemId: 'p6', quantity: 2 },
        { catalogueItemId: 'p15', quantity: 1 },
      ],
      priceTZS: 12000,
      available: true,
    },
  });
  assert.equal(created.status, 201);
  const combo = created.body;
  assert.equal(combo.name, 'Student Lunch');
  assert.equal(combo.priceTZS, 12000);
  assert.equal(combo.items.length, 2);
  assert.equal(combo.available, true);
  assert.equal(typeof combo.id, 'string');

  const list = await call('GET', '/combos');
  assert.ok(list.body.some((c: any) => c.id === combo.id), 'created combo listed');

  const noName = await call('POST', '/combos', { body: { name: '  ', items: [{ catalogueItemId: 'p1', quantity: 1 }] } });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error.code, 'NAME_REQUIRED');

  const noItems = await call('POST', '/combos', { body: { name: 'Empty', items: [] } });
  assert.equal(noItems.status, 400);
  assert.equal(noItems.body.error.code, 'INVALID_COMBO_ITEMS');

  const ghost = await call('POST', '/combos', { body: { name: 'Ghost', items: [{ catalogueItemId: 'nope', quantity: 1 }] } });
  assert.equal(ghost.status, 404);

  const floatPrice = await call('POST', '/combos', { body: { name: 'Float', items: [{ catalogueItemId: 'p1', quantity: 1 }], priceTZS: 12.5 } });
  assert.equal(floatPrice.status, 400);
  assert.equal(floatPrice.body.error.code, 'INVALID_PRICE_TZS');
});

test('PATCH /combos/{comboId} partial update round-trip; DELETE -> 204', async () => {
  const patched = await call('PATCH', '/combos/combo_seed_2', { body: { priceTZS: 30000, available: false } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.priceTZS, 30000);
  assert.equal(patched.body.available, false);
  assert.equal(patched.body.name, 'Date Night Grill', 'untouched fields preserved');

  const readBack = await call('GET', '/combos');
  const combo2 = readBack.body.find((c: any) => c.id === 'combo_seed_2');
  assert.equal(combo2.priceTZS, 30000, 'PATCH persists');

  const items = await call('PATCH', '/combos/combo_seed_2', {
    body: { items: [{ catalogueItemId: 'p5', quantity: 3 }], priceTZS: 25000 },
  });
  assert.equal(items.status, 200);
  assert.equal(items.body.items.length, 1);
  assert.equal(items.body.items[0].quantity, 3);

  await call('PATCH', '/combos/combo_seed_2', { body: { priceTZS: 28000, available: true, items: [{ catalogueItemId: 'p5', quantity: 2 }, { catalogueItemId: 'p16', quantity: 1 }, { catalogueItemId: 'p20', quantity: 2 }] } });

  const created = await call('POST', '/combos', { body: { name: 'Temp Combo', items: [{ catalogueItemId: 'p1', quantity: 1 }] } });
  const del = await call('DELETE', `/combos/${created.body.id}`, {});
  assert.equal(del.status, 204, 'DELETE returns 204');
  const after = await call('GET', '/combos');
  assert.ok(!after.body.some((c: any) => c.id === created.body.id), 'deleted combo gone');

  const missing = await call('DELETE', '/combos/does-not-exist', {});
  assert.equal(missing.status, 404);
});

/* ================= P8: menus ================= */

test('GET /menus lists the seeded multi-store menu', async () => {
  const res = await call('GET', '/menus');
  assert.equal(res.status, 200);
  const menu = res.body.find((m: any) => m.id === 'menu_seed_1');
  assert.equal(menu.name, 'Weekday BBQ Menu');
  assert.deepEqual(menu.storeIds, ['s_demo', 's_demo_2']);
  assert.equal(menu.active, true);
  assert.ok(menu.sections.length >= 3);
  assert.equal(Array.isArray(menu.sections[0].itemIds), true);
});

test('POST /menus creates (201); invalid storeIds 400', async () => {
  const created = await call('POST', '/menus', {
    body: {
      name: 'Weekend Grill Menu',
      storeIds: ['s_demo'],
      sections: [{ name: 'Skewers', itemIds: ['p1', 'p5'] }],
      active: true,
    },
  });
  assert.equal(created.status, 201);
  const menu = created.body;
  assert.equal(menu.name, 'Weekend Grill Menu');
  assert.deepEqual(menu.storeIds, ['s_demo']);
  assert.equal(menu.sections[0].itemIds.length, 2);

  const list = await call('GET', '/menus');
  assert.ok(list.body.some((m: any) => m.id === menu.id));

  const badStore = await call('POST', '/menus', { body: { name: 'X', storeIds: ['s_other_merchant'] } });
  assert.equal(badStore.status, 400);
  assert.equal(badStore.body.error.code, 'INVALID_STORE_IDS');

  const noName = await call('POST', '/menus', { body: { name: '', storeIds: ['s_demo'] } });
  assert.equal(noName.status, 400);
});

test('PUT /menus/{menuId} replaces the whole menu (rename + sections + stores)', async () => {
  const replaced = await call('PUT', '/menus/menu_seed_1', {
    body: {
      name: 'Weekday BBQ Menu v2',
      storeIds: ['s_demo_2'],
      sections: [{ name: 'Drinks', itemIds: ['p19'] }],
      active: false,
    },
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.name, 'Weekday BBQ Menu v2');
  assert.deepEqual(replaced.body.storeIds, ['s_demo_2'], 'PUT replaces storeIds');
  assert.equal(replaced.body.sections.length, 1, 'PUT replaces sections');
  assert.equal(replaced.body.active, false);

  const readBack = await call('GET', '/menus');
  const menu = readBack.body.find((m: any) => m.id === 'menu_seed_1');
  assert.equal(menu.sections[0].name, 'Drinks', 'replacement persisted');

  const del = await call('DELETE', '/menus/menu_seed_1', {});
  assert.equal(del.status, 204);
  const after = await call('GET', '/menus');
  assert.ok(!after.body.some((m: any) => m.id === 'menu_seed_1'), 'deleted menu gone');
});

/* ================= P8: videos ================= */

test('POST /videos adds a video (201, active), listed; invalid url 400', async () => {
  const created = await call('POST', '/videos', {
    body: { title: 'Behind the grill', url: 'https://example.com/videos/grill.mp4', catalogueItemId: 'p1' },
  });
  assert.equal(created.status, 201);
  const video = created.body;
  assert.equal(video.title, 'Behind the grill');
  assert.equal(video.url, 'https://example.com/videos/grill.mp4');
  assert.equal(video.catalogueItemId, 'p1');
  assert.equal(video.views, 0);

  const list = await call('GET', '/videos');
  assert.equal(list.status, 200);
  assert.ok(list.body.some((v: any) => v.id === video.id), 'created video listed');
  assert.ok(list.body.some((v: any) => v.id === 'video_seed_1'), 'seeded video listed');

  const badUrl = await call('POST', '/videos', { body: { title: 'x', url: 'not-a-url' } });
  assert.equal(badUrl.status, 400);
  assert.equal(badUrl.body.error.code, 'INVALID_VIDEO_URL');

  const noTitle = await call('POST', '/videos', { body: { title: '', url: 'https://example.com/v.mp4' } });
  assert.equal(noTitle.status, 400);
  assert.equal(noTitle.body.error.code, 'TITLE_REQUIRED');
});

test('DELETE /videos/{videoId} -> 204; unknown -> 404', async () => {
  const del = await call('DELETE', '/videos/video_seed_1', {});
  assert.equal(del.status, 204);
  const list = await call('GET', '/videos');
  assert.ok(!list.body.some((v: any) => v.id === 'video_seed_1'), 'deleted video gone');

  const missing = await call('DELETE', '/videos/does-not-exist', {});
  assert.equal(missing.status, 404);
});

/* ================= P8: bulk operations ================= */

test('POST /bulk-operations creates (202, queued); list + status poll advances to completed', async () => {
  const created = await call('POST', '/bulk-operations', {
    body: {
      type: 'price_update',
      storeIds: ['s_demo', 's_demo_2'],
      payload: { itemId: 'p1', priceTZS: 12000 },
    },
  });
  assert.equal(created.status, 202);
  const op = created.body;
  assert.equal(op.type, 'price_update');
  assert.equal(op.status, 'queued');
  assert.deepEqual(op.storeIds, ['s_demo', 's_demo_2']);
  assert.equal(op.results.length, 0);
  assert.equal(typeof op.id, 'string');

  const list = await call('GET', '/bulk-operations');
  assert.equal(list.status, 200);
  assert.ok(list.body.some((o: any) => o.id === op.id), 'created operation listed');
  assert.ok(list.body.some((o: any) => o.id === 'bulk_seed_1'), 'seeded operation listed');

  let status = 'queued';
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const detail = await call('GET', `/bulk-operations/${op.id}`);
    assert.equal(detail.status, 200);
    status = detail.body.status;
    if (status === 'completed') break;
  }
  assert.equal(status, 'completed', 'bulk operation advances to completed on poll');
  const done = await call('GET', `/bulk-operations/${op.id}`);
  assert.equal(done.body.results.length, 2);
  assert.ok(done.body.results.every((r: any) => r.ok === true), 'both stores applied');

  const missing = await call('GET', '/bulk-operations/does-not-exist');
  assert.equal(missing.status, 404);

  const badType = await call('POST', '/bulk-operations', { body: { type: 'nuke', storeIds: ['s_demo'] } });
  assert.equal(badType.status, 400);
  assert.equal(badType.body.error.code, 'INVALID_BULK_TYPE');

  const emptyStores = await call('POST', '/bulk-operations', { body: { type: 'price_update', storeIds: [] } });
  assert.equal(emptyStores.status, 400);
});

test('POST /bulk-operations requires store:manage (staff 403)', async () => {
  token = await loginAs('+255700000003');
  const res = await call('POST', '/bulk-operations', {
    body: { type: 'price_update', storeIds: ['s_demo'], payload: {} },
  });
  assert.equal(res.status, 403);
});

/* ================= P8: chain ================= */

test('GET /chain/dashboard returns the ChainDashboard yaml shape', async () => {
  const res = await call('GET', '/chain/dashboard');
  assert.equal(res.status, 200);
  const dash = res.body;
  assert.match(dash.date, ISO_RE, 'date is yyyy-mm-dd');
  for (const key of ['orders', 'revenueTZS', 'activeOrders', 'lowStockAlerts']) {
    assert.equal(typeof dash.totals[key], 'number', `totals.${key} numeric`);
    assert.equal(Number.isInteger(dash.totals[key]), true, `totals.${key} integer`);
  }
  assert.ok(dash.stores.length >= 2, 'both seeded stores appear');
  for (const s of dash.stores) {
    assert.equal(typeof s.storeId, 'string');
    assert.equal(typeof s.businessName, 'string');
    assert.equal(Number.isInteger(s.revenueTZS), true, 'revenueTZS integer');
    assert.equal(Number.isInteger(s.orderCount), true);
    assert.equal(typeof s.conversionRate, 'number');
    assert.equal(typeof s.isOpen, 'boolean');
    assert.equal(Number.isInteger(s.lowStockCount), true);
    assert.ok(s.rating === null || typeof s.rating === 'number');
  }
  const totalOrders = dash.stores.reduce((s: number, x: any) => s + x.orderCount, 0);
  assert.equal(dash.totals.orders, totalOrders, 'totals.orders equals the store sum');
});

test('POST /chain/reports exports a download (200) with expiresInSeconds 900; bad type 400', async () => {
  const res = await call('POST', '/chain/reports', {
    body: { reportType: 'financial', from: '2026-08-01', to: '2026-08-15' },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.downloadUrl.startsWith('data:application/json'), 'downloadUrl is a data URL');
  assert.equal(res.body.expiresInSeconds, 900);

  const filtered = await call('POST', '/chain/reports', {
    body: { reportType: 'orders', from: '2026-08-01', to: '2026-08-15', storeIds: ['s_demo'] },
  });
  assert.equal(filtered.status, 200);

  const bad = await call('POST', '/chain/reports', { body: { reportType: 'tax', from: '2026-08-01', to: '2026-08-15' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_REPORT_TYPE');

  const badDate = await call('POST', '/chain/reports', { body: { reportType: 'orders', from: '01/08/2026', to: '2026-08-15' } });
  assert.equal(badDate.status, 400);
  assert.equal(badDate.body.error.code, 'INVALID_DATE');

  const inverted = await call('POST', '/chain/reports', { body: { reportType: 'orders', from: '2026-08-15', to: '2026-08-01' } });
  assert.equal(inverted.status, 400);
});
