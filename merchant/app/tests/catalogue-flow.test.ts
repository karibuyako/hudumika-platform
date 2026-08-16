import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import type { CatalogueItemDto, GroupBuyDealInput, OrderDto, ProductRow } from '@/api/types';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

const base = 'http://localhost';
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

async function productsOf(): Promise<ProductRow[]> {
  const res = await call('GET', '/products?storeId=s_demo');
  assert.equal(res.status, 200);
  return res.body.products as ProductRow[];
}

async function findProduct(id: string): Promise<ProductRow | undefined> {
  return (await productsOf()).find((p) => p.id === id);
}

const OPTIONS = [
  {
    name: 'Size',
    choices: [
      { label: 'Regular', priceTZS: 0 },
      { label: 'Large', priceTZS: 2000 },
    ],
    required: true,
    min: 1,
    max: 1,
  },
];

const ADDONS = [
  { name: 'Extra chili', priceTZS: 1000, emoji: '🌶️' },
  { name: 'Fries', priceTZS: 2500 },
];

/* Product CRUD uses the app addon shape ({name, price, emoji}); the catalogue
 * contract paths use {name, priceTZS, emoji}. */
const APP_ADDONS = ADDONS.map((a) => ({ name: a.name, price: a.priceTZS, emoji: a.emoji }));

/* ================= M3: options/addons/comboItems round-trip ================= */

test('catalogue round-trip: product -> GET /catalogues/me -> publish -> product preserves options/addons/comboItems', async () => {
  const created = await call('POST', '/catalogue-items', {
    idem: 't-rt-create',
    body: {
      name: 'Round-trip platter',
      price: 12000,
      categoryId: 'c1',
      variants: [{ id: 'vx', name: 'Spicy', price: 500 }],
      options: OPTIONS,
      addons: APP_ADDONS,
      comboItems: [{ productId: 'p1', qty: 2, price: 9000 }],
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const product = created.body.product as ProductRow;
  assert.equal(product.options?.[0]?.name, 'Size');
  assert.equal(product.options?.[0]?.choices[1].priceTZS, 2000);
  assert.equal(product.addons.length, 2);
  assert.equal(product.comboItems.length, 1);

  const catalogue = await call('GET', '/catalogues/me');
  assert.equal(catalogue.status, 200);
  const item = (catalogue.body.items as CatalogueItemDto[]).find((i) => i.id === product.id);
  assert.ok(item, 'created product appears in own catalogue');
  assert.equal(item?.options?.[0]?.name, 'Size');
  assert.equal(item?.options?.[0]?.required, true, 'app-extension required flag survives the mapping');
  assert.deepEqual(
    item?.addons?.map((a) => ({ name: a.name, priceTZS: a.priceTZS, emoji: a.emoji ?? null })),
    ADDONS.map((a) => ({ name: a.name, priceTZS: a.priceTZS, emoji: a.emoji ?? null })),
    'addons map to contract shape with integer TZS',
  );
  assert.deepEqual(item?.comboItems, [{ catalogueItemId: 'p1', quantity: 2 }]);

  const published = await call('PUT', '/catalogues/me', { body: { merchantId: 'm_demo', items: catalogue.body.items } });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.ok(published.body.publishedAt, 'publish returns the new publishedAt');
  assert.equal(published.body.items.length, catalogue.body.items.length);

  const after = await findProduct(product.id);
  assert.equal(after?.options?.[0]?.name, 'Size');
  assert.equal(after?.options?.[0]?.choices[0].label, 'Regular');
  assert.equal(after?.options?.[0]?.required, true, 'required round-trips through publish');
  assert.equal(after?.addons.length, 2, 'addons survive publish');
  assert.equal(after?.comboItems.length, 1, 'comboItems survive publish');
  assert.equal(after?.variants[0]?.name, 'Spicy', 'variants are untouched by the catalogue path');
});

test('catalogue bulk: 202 {jobId, accepted} and rows preserve options/addons', async () => {
  const res = await call('POST', '/catalogue-items/bulk', {
    body: {
      items: [
        { name: 'Bulk skewer set', priceTZS: 8000, category: 'Grilled Skewers', options: OPTIONS, addons: ADDONS },
      ],
    },
  });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.ok(res.body.jobId);
  assert.equal(res.body.accepted, 1);
  assert.equal(res.body.rejected, 0);

  const products = await productsOf();
  const row = products.find((p) => p.name === 'Bulk skewer set');
  assert.ok(row, 'bulk row created a product');
  assert.equal(row?.options?.[0]?.choices[1].label, 'Large');
  assert.equal(row?.addons[0]?.name, 'Extra chili');
});

test('catalogue bulk: existing item keeps price unless overwritePrices', async () => {
  const without = await call('POST', '/catalogue-items/bulk', {
    body: { items: [{ id: 'p1', name: 'Signature Lamb Skewer', priceTZS: 999999, category: 'Grilled Skewers' }] },
  });
  assert.equal(without.status, 202);
  assert.equal(without.body.rejected, 1);
  assert.match(String(without.body.failures[0].reason), /OVERWRITE_PRICES_REQUIRED/);

  const withFlag = await call('POST', '/catalogue-items/bulk', {
    body: { items: [{ id: 'p1', name: 'Signature Lamb Skewer', priceTZS: 999999, category: 'Grilled Skewers' }], overwritePrices: true },
  });
  assert.equal(withFlag.status, 202);
  assert.equal(withFlag.body.accepted, 1);
  const row = await findProduct('p1');
  assert.equal(row?.price, 999999);
});

test('catalogue publish: 422 validation maps the failing row', async () => {
  const res = await call('PUT', '/catalogues/me', {
    body: { merchantId: 'm_demo', items: [{ name: '', priceTZS: 100, category: 'Grilled Skewers' }] },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  assert.equal(res.body.error.details.errors[0].field, 'items.0');
  assert.equal(res.body.error.details.errors[0].code, 'NAME_REQUIRED');
});

/* ================= M2: ORDER_PRICE_CHANGED guard ================= */

function orderWithItem(productId: string, status: string, id = 'o_guard_test'): OrderDto {
  return {
    id,
    merchantId: 'm_demo',
    storeId: 's_demo',
    no: 'MTGUARD1',
    status: status as OrderDto['status'],
    version: 1,
    items: [{ productId, name: 'Guard item', emoji: '🍢', qty: 1, price: 1000 }],
    customer: { name: 'Guard', phone: '138****0000', address: 'Test' },
    note: '',
    deliveryType: 'delivery',
    subtotal: 1000,
    deliveryFee: 0,
    total: 1000,
    createdAt: Date.now(),
    deadlineAt: Date.now() + 300000,
    seen: true,
    paymentId: 'pay_guard',
    timeline: [{ event: 'created', ts: Date.now(), actor: 'test' }],
  };
}

test('publish: price change on an item in an in-flight order -> 409 ORDER_PRICE_CHANGED', async () => {
  const created = await call('POST', '/catalogue-items', {
    idem: 't-guard-create',
    body: { name: 'Guard skewer', price: 5000, categoryId: 'c1' },
  });
  assert.equal(created.status, 200);
  const pid = (created.body.product as ProductRow).id;

  db.table('orders').insert(orderWithItem(pid, 'preparing'));

  const catalogue = await call('GET', '/catalogues/me');
  const items = (catalogue.body.items as CatalogueItemDto[]).map((i) =>
    i.id === pid ? { ...i, priceTZS: 7000 } : i,
  );
  const res = await call('PUT', '/catalogues/me', { body: { merchantId: 'm_demo', items } });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'ORDER_PRICE_CHANGED');
  assert.ok(Array.isArray(res.body.error.details.items));
  const hit = (res.body.error.details.items as { id: string; inFlightCount: number }[]).find((x) => x.id === pid);
  assert.ok(hit, 'affected item listed in details');
  assert.equal(hit!.inFlightCount, 1);

  const row = await findProduct(pid);
  assert.equal(row?.price, 5000, 'rejected publish does not mutate the price');
});

test('publish: same-price publish or completed orders pass the guard', async () => {
  const created = await call('POST', '/catalogue-items', {
    idem: 't-guard-ok',
    body: { name: 'Guard skewer two', price: 5000, categoryId: 'c1' },
  });
  assert.equal(created.status, 200);
  const pid = (created.body.product as ProductRow).id;

  const catalogue = await call('GET', '/catalogues/me');
  const samePrice = await call('PUT', '/catalogues/me', { body: { merchantId: 'm_demo', items: catalogue.body.items } });
  assert.equal(samePrice.status, 200, 'publishing the same prices is fine');

  db.table('orders').insert(orderWithItem(pid, 'preparing', 'o_guard_ok'));
  db.table('orders').update('o_guard_ok', { status: 'completed' });
  const after = await call('GET', '/catalogues/me');
  const items = (after.body.items as CatalogueItemDto[]).map((i) => (i.id === pid ? { ...i, priceTZS: 9000 } : i));
  const res = await call('PUT', '/catalogues/me', { body: { merchantId: 'm_demo', items } });
  assert.equal(res.status, 200, 'order is terminal, price change allowed');
  const row = await findProduct(pid);
  assert.equal(row?.price, 9000);
});

/* ================= M9: voucher 409 codes ================= */

test('voucher: malformed code format -> VOUCHER_INVALID_CODE (409)', async () => {
  const res = await call('POST', '/vouchers/NOT-A-CODE/verify', { body: { merchantId: 'm_demo' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'VOUCHER_INVALID_CODE');
});

test('voucher: well-formed unknown code -> VOUCHER_INVALID_CODE (409)', async () => {
  const res = await call('POST', '/vouchers/GB-ZZ99-0000/verify', { body: { merchantId: 'm_demo' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'VOUCHER_INVALID_CODE');
});

test('voucher: deal owned by another merchant -> VOUCHER_NOT_REDEEMABLE_AT_MERCHANT (409)', async () => {
  const res = await call('POST', '/vouchers/GB-4T6H-8P2M/verify', { body: { merchantId: 'm_demo' } });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'VOUCHER_NOT_REDEEMABLE_AT_MERCHANT');
});

test('voucher: refund in progress -> VOUCHER_REFUND_PENDING (409)', async () => {
  const res = await call('POST', '/vouchers/GB-5R9K-3VXW/verify', { body: { merchantId: 'm_demo' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'VOUCHER_REFUND_PENDING');
});

test('voucher: final refunded (no pending flag) and void are not redeemable', async () => {
  db.table<{ code: string } & Record<string, unknown>>('vouchers').update('GB-9W1R-2C6V', { status: 'refunded', refundPendingAt: null });
  const refunded = await call('POST', '/vouchers/GB-9W1R-2C6V/verify', { body: { merchantId: 'm_demo' } });
  assert.equal(refunded.status, 409);
  assert.equal(refunded.body.error.code, 'VOUCHER_INVALID_CODE');

  db.table<{ code: string } & Record<string, unknown>>('vouchers').update('GB-9W1R-2C6V', { status: 'void' });
  const voided = await call('POST', '/vouchers/GB-9W1R-2C6V/verify', { body: { merchantId: 'm_demo' } });
  assert.equal(voided.status, 409);
  assert.equal(voided.body.error.code, 'VOUCHER_INVALID_CODE');
});

test('voucher: redeemable code still verifies at the owning merchant', async () => {
  const res = await call('POST', '/vouchers/GB-3N8P-5TZ7/verify', { body: { merchantId: 'm_demo' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.voucher.status, 'redeemed');
  assert.equal(res.body.voucher.redeemedByMerchantId, 'm_demo');
});

/* ================= M7: deal imageUrl ================= */

const DEAL_BODY: GroupBuyDealInput = {
  title: 'Weekend platter deal',
  description: 'Shared platter for four.',
  priceTZS: 40000,
  originalPriceTZS: 60000,
  quantity: 30,
  validityDays: 45,
  salesStartAt: Date.now(),
  salesEndAt: Date.now() + 7 * 86400000,
};

test('deal: imageUrl accepted on create and round-trips through PATCH', async () => {
  const created = await call('POST', '/group-buys', {
    idem: 't-gb-img',
    body: { ...DEAL_BODY, imageUrl: 'https://example.com/deal/platter.jpg' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.deal.imageUrl, 'https://example.com/deal/platter.jpg');
  assert.equal(created.body.deal.merchantId, 'm_demo');

  const id = created.body.deal.id as string;
  const updated = await call('PATCH', `/group-buys/${id}`, {
    body: { ...DEAL_BODY, imageUrl: 'https://example.com/deal/platter-v2.jpg' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.deal.imageUrl, 'https://example.com/deal/platter-v2.jpg');

  const cleared = await call('PATCH', `/group-buys/${id}`, { body: { ...DEAL_BODY, imageUrl: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.deal.imageUrl, null, 'imageUrl can be cleared');
});

test('deal: invalid imageUrl -> 400 GROUP_BUY_IMAGE_URL_INVALID', async () => {
  const res = await call('POST', '/group-buys', { idem: 't-gb-img-bad', body: { ...DEAL_BODY, imageUrl: 'not-a-url' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'GROUP_BUY_IMAGE_URL_INVALID');
});

/* ================= M11: menu sections round-trip ================= */

test('menu: create with sections persists itemIds and survives PUT replace', async () => {
  const created = await call('POST', '/menus', {
    idem: 't-menu-sec',
    body: {
      name: 'Weekend menu',
      storeIds: ['s_demo'],
      active: true,
      sections: [{ name: 'Grills', itemIds: ['p1', 'p2'] }],
    },
  });
  assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created.body));
  const menu = created.body as { id: string; sections: { name: string; itemIds: string[] }[] };
  assert.equal(menu.sections.length, 1);
  assert.equal(menu.sections[0].name, 'Grills');
  assert.deepEqual(menu.sections[0].itemIds, ['p1', 'p2']);

  const replaced = await call('PUT', `/menus/${menu.id}`, {
    body: {
      name: 'Weekend menu v2',
      storeIds: ['s_demo', 's_demo_2'],
      active: true,
      sections: [
        { name: 'Grills', itemIds: ['p1'] },
        { name: 'Drinks', itemIds: ['p19', 'p20'] },
      ],
    },
  });
  assert.ok(replaced.status === 200 || replaced.status === 201, JSON.stringify(replaced.body));
  assert.equal(replaced.body.sections.length, 2);
  assert.deepEqual(replaced.body.sections[1].itemIds, ['p19', 'p20']);
});

/* ================= M12: merchants stores endpoint ================= */

test('menus store picker data: GET /merchants/me/stores returns seeded stores', async () => {
  const res = await call('GET', '/merchants/me/stores');
  assert.equal(res.status, 200);
  const rows = res.body.stores as { id: string; name: string; productCount: number }[];
  assert.ok(rows.length >= 1);
  assert.ok(rows.some((s) => s.id === 's_demo'), 'primary store listed');
  assert.equal(typeof rows[0].productCount, 'number');
});
